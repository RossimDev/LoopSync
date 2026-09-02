"use strict";

/**
 * LoopSync — media processing helpers.
 *
 * The only operation that is ever performed on the video is:
 *   repeat (when the video is shorter than the audio) and
 *   trim exactly to the audio duration (when the video is longer/equal).
 *
 * No filters, overlays, beat sync, transitions or creative edits are used.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");

const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;

const VIDEO_DURATION_TOLERANCE_MS = 250; // 0.25s
const MAX_OUTPUT_SECONDS_WARN = 24 * 60 * 60; // safety ceiling

/**
 * ffprobe a file and return normalised metadata.
 */
function getMediaInfo(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo não encontrado: ${filePath}`);
  }

  const probe = spawnSync(
    ffprobePath,
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );

  if (probe.status !== 0) {
    const message = (probe.stderr || "").trim() || "ffprobe falhou ao ler o arquivo";
    throw new Error(message);
  }

  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    throw new Error("Não foi possível analisar as informações do arquivo.");
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === "video") || null;
  const audio = streams.find((s) => s.codec_type === "audio") || null;

  const formatDuration = Number(parsed.format && parsed.format.duration);
  const videoDuration = Number(video && video.duration);
  const audioDuration = Number(audio && audio.duration);

  // Prefer the composition duration from the format block, but fall back to
  // the stream durations when needed (some containers only expose one).
  let duration = Number.isFinite(formatDuration) ? formatDuration : NaN;
  if (!Number.isFinite(duration)) {
    duration = Number.isFinite(videoDuration)
      ? videoDuration
      : Number.isFinite(audioDuration)
      ? audioDuration
      : NaN;
  }

  return {
    filePath,
    duration: Number.isFinite(duration) ? duration : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video ? String(video.codec_name || "") : "",
    audioCodec: audio ? String(audio.codec_name || "") : "",
    videoStream: video,
    audioStream: audio,
  };
}

/**
 * Build the ffmpeg argument list for LoopSync.
 *
 * Semantics:
 *   - The selected audio is mapped to the output as the only audio track.
 *   - The video is trimmed with `-t audioDuration`.
 *   - If the video is shorter than the audio it is looped first with
 *     `-stream_loop -1`, otherwise it is simply trimmed.
 *   - When `copyVideo` is true the original video packets are copied, so the
 *     content is never re-encoded. If that fails the caller retries with
 *     `copyVideo: false` (a transcode that preserves every frame).
 */
function buildArgs({
  videoPath,
  audioPath,
  outputPath,
  audioDuration,
  videoDuration,
  copyVideo = true,
  audioBitrate = "192k",
}) {
  const duration = Math.max(0, Number(audioDuration) || 0);
  const loopVideo = videoDuration < duration && duration > 0;

  const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"];

  if (loopVideo) {
    args.push("-stream_loop", "-1");
  }

  args.push("-i", videoPath);
  args.push("-i", audioPath);

  args.push("-map", "0:v:0");
  args.push("-map", "1:a:0");

  if (copyVideo) {
    args.push("-c:v", "copy");
  } else {
    args.push("-c:v", "libx264");
    args.push("-preset", "fast");
    args.push("-crf", "20");
    args.push("-pix_fmt", "yuv420p");
  }

  args.push("-c:a", "aac");
  args.push("-b:a", audioBitrate);

  if (duration > 0) {
    args.push("-t", String(duration));
  }

  args.push("-movflags", "+faststart");
  args.push(outputPath);

  return { args, loopVideo };
}

function runFFmpeg(args, { timeoutMs = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    let settled = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;

    let lastOutTimeSec = 0;

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (typeof onProgress === "function") {
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          const us = line.match(/^out_time_us=(\d+)/);
          const ms = line.match(/^out_time_ms=(\d+)/);
          const raw = line.match(/^out_time=(\d+(?:\.\d+)?)/);
          if (us) {
            lastOutTimeSec = Number(us[1]) / 1000000;
          } else if (ms) {
            // ffmpeg reports out_time_ms in microseconds.
            lastOutTimeSec = Number(ms[1]) / 1000000;
          } else if (raw) {
            lastOutTimeSec = Number(raw[1]);
          }
        }
        if (lastOutTimeSec >= 0) {
          onProgress({ outTimeSec: lastOutTimeSec, stderr });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ code, stderr, stdout });
      } else {
        reject(new Error((stderr || "ffmpeg falhou").trim()));
      }
    });
  });
}

/**
 * Number of video loops needed to cover the audio, for display purposes.
 * Durations are rounded to 0.1s before calculating so a "15 second" video and
 * a "2 minute" audio report 8 loops instead of 9 due to encoder rounding.
 */
function computeLoopCount(videoDuration, audioDuration) {
  const v = Math.max(0.01, Math.round((Number(videoDuration) || 0) * 10) / 10);
  const a = Math.max(0, Math.round((Number(audioDuration) || 0) * 10) / 10);
  if (a <= 0) {
    return 0;
  }
  if (v >= a) {
    return 1;
  }
  return Math.max(1, Math.ceil(a / v));
}

/**
 * Validate that a media file has at least one video stream and one audio
 * stream, and that the durations can be read.
 */
function validateMedia(infoVideo, infoAudio) {
  const errors = [];

  if (!infoVideo || !infoVideo.hasVideo || !Number.isFinite(infoVideo.duration) || infoVideo.duration <= 0) {
    errors.push("video");
  }
  if (!infoAudio || !infoAudio.hasAudio || !Number.isFinite(infoAudio.duration) || infoAudio.duration <= 0) {
    errors.push("audio");
  }

  return errors;
}

/**
 * The core LoopSync operation:
 *   video + loop/trim + selected audio -> mp4 whose duration equals audio.
 */
async function generateSyncVideo({
  videoPath,
  audioPath,
  outputPath,
  copyVideo = true,
  onProgress,
}) {
  let infoVideo;
  let infoAudio;
  try {
    infoVideo = getMediaInfo(videoPath);
  } catch {
    const err = new Error("Não foi possível utilizar este arquivo. Escolha outro vídeo.");
    err.code = "INVALID_VIDEO";
    throw err;
  }
  try {
    infoAudio = getMediaInfo(audioPath);
  } catch {
    const err = new Error("Não foi possível utilizar este arquivo. Escolha outro áudio.");
    err.code = "INVALID_AUDIO";
    throw err;
  }

  const invalid = validateMedia(infoVideo, infoAudio);
  if (invalid.includes("video")) {
    const err = new Error("Não foi possível utilizar este arquivo. Escolha outro vídeo.");
    err.code = "INVALID_VIDEO";
    throw err;
  }
  if (invalid.includes("audio")) {
    const err = new Error("Não foi possível utilizar este arquivo. Escolha outro áudio.");
    err.code = "INVALID_AUDIO";
    throw err;
  }

  const duration = infoAudio.duration;
  if (duration > MAX_OUTPUT_SECONDS_WARN) {
    const err = new Error("O áudio é longo demais para gerar o vídeo.");
    err.code = "AUDIO_TOO_LONG";
    throw err;
  }

  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  const loopCount = computeLoopCount(infoVideo.duration, duration);

  if (typeof onProgress === "function") {
    onProgress({ phase: "probing", percent: 1, outTimeSec: 0 });
  }

  const handleProgress = (p) => {
    if (typeof onProgress !== "function") return;
    const percent = Math.min(99, Math.max(4, Math.round((p.outTimeSec / duration) * 100)));
    onProgress({ phase: "processing", percent, outTimeSec: p.outTimeSec });
  };

  const runWith = async (useCopy) => {
    const { args } = buildArgs({
      videoPath,
      audioPath,
      outputPath,
      audioDuration: duration,
      videoDuration: infoVideo.duration,
      copyVideo: useCopy,
    });
    await runFFmpeg(args, { onProgress: handleProgress });
  };

  let usedCopy = copyVideo;

  try {
    await runWith(copyVideo);
  } catch (err) {
    // Retry with a transcode if the fast copy path is incompatible with the
    // container/codec. This does not add any creative edit — it simply
    // preserves every decoded frame.
    if (copyVideo) {
      usedCopy = false;
      await runWith(false);
    } else {
      throw err;
    }
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    const err = new Error("Não foi possível gerar o vídeo. Tente novamente.");
    err.code = "GENERATION_FAILED";
    throw err;
  }

  let infoOutput = getMediaInfo(outputPath);
  let actualDuration = infoOutput.duration;
  let diffMs = Math.round(Math.abs((actualDuration - duration) * 1000));

  // With `-c:v copy`, ffmpeg can only cut on packet boundaries, so depending
  // on the keyframe interval the final duration may drift from the audio.
  // The spec requires DURAÇÃO DO VÍDEO FINAL = DURAÇÃO DO ÁUDIO, so when the
  // fast path misses the tolerance we redo it with a frame-accurate transcode
  // (still no creative edit — just repeat + exact trim).
  if (usedCopy && diffMs > VIDEO_DURATION_TOLERANCE_MS) {
    usedCopy = false;
    await runWith(false);
    infoOutput = getMediaInfo(outputPath);
    actualDuration = infoOutput.duration;
    diffMs = Math.round(Math.abs((actualDuration - duration) * 1000));
  }

  if (typeof onProgress === "function") {
    onProgress({ phase: "completed", percent: 100, outTimeSec: actualDuration });
  }

  return {
    outputPath,
    videoDuration: infoVideo.duration,
    audioDuration: duration,
    actualDuration,
    durationDiffMs: diffMs,
    loopCount,
    usedCopy,
    hasVideo: infoOutput.hasVideo,
    hasAudio: infoOutput.hasAudio,
    toleranceMs: VIDEO_DURATION_TOLERANCE_MS,
    withinTolerance: diffMs <= VIDEO_DURATION_TOLERANCE_MS,
    sizeBytes: fs.statSync(outputPath).size,
  };
}

/**
 * Rendering helpers used by tests/scripts.
 */
function formatSeconds(seconds) {
  const totalSeconds = Math.round(Number(seconds || 0));
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "00:00";
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  const base = `${pad(m)}:${pad(s)}`;
  return h > 0 ? `${pad(h)}:${base}` : base;
}

function tempDir(prefix = "loopsync-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = {
  ffmpegPath,
  ffprobePath,
  getMediaInfo,
  buildArgs,
  runFFmpeg,
  validateMedia,
  computeLoopCount,
  generateSyncVideo,
  formatSeconds,
  tempDir,
  VIDEO_DURATION_TOLERANCE_MS,
};
