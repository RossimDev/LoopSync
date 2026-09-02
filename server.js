"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const express = require("express");
const multer = require("multer");

const { generateSyncVideo, formatSeconds } = require("./lib/media");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "loopsync-"));
const MAX_UPLOAD_BYTES = Number(process.env.LOOPSYNC_MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024);
const RESULT_RETENTION_MS = Number(process.env.LOOPSYNC_RESULT_RETENTION_MS || 10 * 60 * 1000);

/** Simple in-memory job store. Files live on disk only while the job exists. */
const jobs = new Map();

function cleanupJob(job) {
  if (!job) return;
  clearTimeout(job.timeout);
  jobs.delete(job.id);
  try {
    fs.rmSync(job.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function extensionFor(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ext && ext.length <= 8) return ext;
  if ((file.mimetype || "").startsWith("video/")) return ".mp4";
  if ((file.mimetype || "").startsWith("audio/")) return ".m4a";
  return ".bin";
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      if (!req.loopsyncJobId) {
        req.loopsyncJobId = crypto.randomUUID();
        req.loopsyncJobDir = path.join(UPLOAD_ROOT, req.loopsyncJobId);
        fs.mkdirSync(req.loopsyncJobDir, { recursive: true });
      }
      cb(null, req.loopsyncJobDir);
    },
    filename(req, file, cb) {
      const field = file.fieldname === "audio" ? "audio" : "video";
      if (field === "video") req.loopsyncVideoName = file.originalname;
      if (field === "audio") req.loopsyncAudioName = file.originalname;
      cb(null, `${field}${extensionFor(file)}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 2,
  },
});

app.use(express.json({ limit: "1mb" }));

// In production, serve the Vite-built dist/ directory. In development, Vite's
// dev server handles the frontend and proxies /api and /health here.
const staticDir = process.env.NODE_ENV === "production"
  ? path.join(__dirname, "dist")
  : path.join(__dirname, "dist");

if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir, {
    extensions: ["html"],
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  }));
} else {
  // Fallback for environments where dist/ has not been built yet
  app.use(express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  }));
}

app.post("/api/process", upload.fields([{ name: "video", maxCount: 1 }, { name: "audio", maxCount: 1 }]), (req, res) => {
  const video = req.files && req.files.video && req.files.video[0];
  const audio = req.files && req.files.audio && req.files.audio[0];

  if (!video) {
    return res.status(400).json({ ok: false, error: "Selecione um vídeo." });
  }
  if (!audio) {
    return res.status(400).json({ ok: false, error: "Selecione um áudio." });
  }

  const id = req.loopsyncJobId;
  const job = {
    id,
    dir: req.loopsyncJobDir,
    videoPath: video.path,
    audioPath: audio.path,
    outputPath: path.join(req.loopsyncJobDir, "loopsync-result.mp4"),
    videoName: req.loopsyncVideoName || video.originalname,
    audioName: req.loopsyncAudioName || audio.originalname,
    status: "queued",
    percent: 0,
    phase: "queued",
    error: null,
    result: null,
  };
  jobs.set(id, job);
  job.timeout = setTimeout(() => cleanupJob(job), 60 * 60 * 1000);

  res.status(202).json({
    ok: true,
    id,
    videoName: video.originalname,
    audioName: audio.originalname,
  });

  runJob(job).catch((err) => {
    job.status = "error";
    job.error = err && err.message ? err.message : "Erro ao processar.";
    job.phase = "error";
  });
});

async function runJob(job) {
  job.status = "processing";
  job.phase = "probing";
  job.percent = 2;

  try {
    const result = await generateSyncVideo({
      videoPath: job.videoPath,
      audioPath: job.audioPath,
      outputPath: job.outputPath,
      onProgress: (p) => {
        job.phase = p.phase;
        job.percent = Math.max(job.percent, p.percent || 0);
      },
    });

    job.status = "done";
    job.phase = "completed";
    job.percent = 100;
    job.timeout = setTimeout(() => cleanupJob(job), RESULT_RETENTION_MS);
    job.result = {
      videoName: job.videoName,
      audioName: job.audioName,
      videoDuration: formatSeconds(result.videoDuration),
      audioDuration: formatSeconds(result.audioDuration),
      outputDuration: formatSeconds(result.actualDuration),
      loopCount: result.loopCount,
      sizeBytes: result.sizeBytes,
      withinTolerance: result.withinTolerance,
      differenceMs: result.durationDiffMs,
      downloadUrl: `/api/result/${job.id}`,
      fileName: `LoopSync_${timestampName(new Date())}.mp4`,
    };
  } finally {
    // Remove the uploaded source files as soon as processing finishes; only
    // the generated MP4 is retained until the user downloads it.
    try { fs.unlinkSync(job.videoPath); } catch { /* ignore */ }
    try { fs.unlinkSync(job.audioPath); } catch { /* ignore */ }
  }
}

function timestampName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

app.get("/api/process/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ ok: false, error: "Trabalho não encontrado." });
  }
  res.json({
    ok: job.status !== "error",
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    error: job.error || null,
    result: job.result || null,
  });
});

app.get("/api/result/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.result || job.status !== "done") {
    return res.status(404).json({ ok: false, error: "Resultado não encontrado." });
  }
  if (!fs.existsSync(job.outputPath)) {
    cleanupJob(job);
    return res.status(404).json({ ok: false, error: "O arquivo não está mais disponível." });
  }

  const fileName = job.result.fileName || "LoopSync.mp4";
  const stat = fs.statSync(job.outputPath);
  const fileSize = stat.size;

  // Retain the file for another window (clearTimeout before re-arming)
  clearTimeout(job.timeout);
  job.timeout = setTimeout(() => cleanupJob(job), RESULT_RETENTION_MS);

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");

  // ?inline=1 → Content-Disposition: inline (for preview player)
  const inline = req.query.inline === "1";
  if (inline) {
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  } else {
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  }

  // Range request support
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      return res.status(416).end();
    }

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      return res.status(416).end();
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", chunkSize);

    const stream = fs.createReadStream(job.outputPath, { start, end });
    stream.pipe(res);
  } else {
    res.setHeader("Content-Length", fileSize);
    const stream = fs.createReadStream(job.outputPath);
    stream.pipe(res);
  }
});

app.post("/api/clear/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) cleanupJob(job);
  res.json({ ok: true });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "loopsync" });
});

// Convert multer/upload errors into a small JSON response and clean partial
// temp files, so the UI can show a friendly message instead of an exception.
app.use((err, req, res, _next) => {
  if (req.loopsyncJobDir) {
    try { fs.rmSync(req.loopsyncJobDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const isSize = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
  const status = isSize ? 413 : 400;
  res.status(status).json({
    ok: false,
    error: isSize
      ? "Este arquivo é muito grande para ser processado."
      : (err && err.message) || "Não foi possível enviar os arquivos.",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LoopSync server listening on http://0.0.0.0:${PORT}`);
});
