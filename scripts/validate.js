"use strict";

/**
 * End-to-end validation of the real LoopSync pipeline.
 *
 * It generates synthetic videos/audio, runs the same ffmpeg operation exposed
 * by lib/media.js, and checks that every produced MP4:
 *   - is a valid MP4 with video + audio,
 *   - has a duration equal to the selected audio (within encoder tolerance),
 *   - and repeats/trims according to the four scenarios from the spec.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const {
  generateSyncVideo,
  getMediaInfo,
  computeLoopCount,
  formatSeconds,
  VIDEO_DURATION_TOLERANCE_MS,
} = require("../lib/media");
const { createTestAssets } = require("./make-test-assets");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsync-validate-"));
  const assets = path.join(root, "assets");
  const outputs = path.join(root, "outputs");
  fs.mkdirSync(outputs, { recursive: true });

  console.log("Creating synthetic test media…");
  await createTestAssets(assets);

  const cases = [
    {
      id: "test1",
      label: "Teste 1 — vídeo 15s + áudio 2min",
      video: "video-15.mp4",
      audio: "audio-120.m4a",
    },
    {
      id: "test2",
      label: "Teste 2 — vídeo 30s + áudio 2min15s",
      video: "video-30.mp4",
      audio: "audio-135.m4a",
    },
    {
      id: "test3",
      label: "Teste 3 — vídeo 1min + áudio 20s (corta)",
      video: "video-60.mp4",
      audio: "audio-20.m4a",
    },
    {
      id: "test4",
      label: "Teste 4 — vídeo 30s + áudio 30s (sem repetição)",
      video: "video-30.mp4",
      audio: "audio-30.m4a",
    },
    {
      id: "extra-short-video",
      label: "Extra — vídeo 5s + áudio 20s",
      video: "video-05.mp4",
      audio: "audio-20.m4a",
    },
  ];

  let failed = 0;

  for (const testCase of cases) {
    const videoPath = path.join(assets, testCase.video);
    const audioPath = path.join(assets, testCase.audio);
    const outputPath = path.join(outputs, `${testCase.id}.mp4`);

    const infoVideo = getMediaInfo(videoPath);
    const infoAudio = getMediaInfo(audioPath);
    const expectedLoops = computeLoopCount(infoVideo.duration, infoAudio.duration);

    process.stdout.write(`${testCase.label} … `);
    const started = Date.now();
    const result = await generateSyncVideo({ videoPath, audioPath, outputPath });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    const infoOutput = getMediaInfo(outputPath);
    const diffMs = Math.round(Math.abs((infoOutput.duration - infoAudio.duration) * 1000));

    assert(fs.existsSync(outputPath), "arquivo de saída não existe");
    assert(infoOutput.hasVideo, "saída não possui faixa de vídeo");
    assert(infoOutput.hasAudio, "saída não possui faixa de áudio");
    assert(diffMs <= VIDEO_DURATION_TOLERANCE_MS, `duração final difere do áudio em ${diffMs}ms`);
    assert(result.withinTolerance, `resultado reporta duração fora da tolerância (${result.durationDiffMs}ms)`);
    assert(result.loopCount === expectedLoops, `loop count ${result.loopCount} != esperado ${expectedLoops}`);

    process.stdout.write(
      `OK  (áudio=${formatSeconds(infoAudio.duration)} · saída=${formatSeconds(infoOutput.duration)} · loops=${result.loopCount} · ${elapsed}s)\n`
    );
  }

  fs.rmSync(root, { recursive: true, force: true });

  if (failed) {
    throw new Error(`${failed} validação(ões) falhou(aram).`);
  }

  console.log("\nTodas as validações passaram.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nVALIDAÇÃO FALHOU:", err.message);
    process.exit(1);
  });
}
