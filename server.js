"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const multer = require("multer");

const { generateSyncVideo, formatSeconds } = require("./lib/media");
const { normalizeImageSize } = require("./lib/image-size");
const { normalizeAudioQuality, normalizeVideoQuality } = require("./lib/quality");
const { outputFileName, sanitizeBaseName, contentDisposition } = require("./lib/naming");
const { getStore } = require("./lib/store");
const { createYouTubeRouter } = require("./lib/youtube/routes");
const { createLoopSyncRouter } = require("./lib/loopsync/routes");
const { generateThumbnail, getThumbDir } = require("./lib/loopsync/history");

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const youtubeConfiguredAtBoot = Boolean(
  (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim() &&
  (process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim()
);

const store = getStore({ dir: process.env.LOOPSYNC_DATA_DIR || path.join(__dirname, "data") });

const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "loopsync-"));
const MAX_UPLOAD_BYTES = Number(process.env.LOOPSYNC_MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024);
const RESULT_RETENTION_MS = Number(process.env.LOOPSYNC_RESULT_RETENTION_MS || 10 * 60 * 1000);

const jobs = new Map();

function cleanupJob(job) {
  if (!job) return;
  clearTimeout(job.timeout);
  jobs.delete(job.id);
  try {
    fs.rmSync(job.dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function decodeUploadedName(raw) {
  if (!raw || !/[^\\x00-\\x7f]/.test(raw)) return raw;
  const fixed = Buffer.from(raw, "latin1").toString("utf8");
  return fixed.includes("\\uFFFD") ? raw : fixed;
}

function extensionFor(file) {
  const originalName = decodeUploadedName(file.originalname || "");
  const ext = path.extname(originalName).toLowerCase();
  if (ext && ext.length <= 8 && /^\\.[a-z0-9]+$/i.test(ext)) return ext;
  const mime = String(file.mimetype || "").toLowerCase();
  if (mime.startsWith("image/")) {
    const subtype = mime.slice(6).split(/[;+]/)[0].replace("jpeg", "jpg");
    return subtype && /^[a-z0-9]+$/.test(subtype) ? `.${subtype}` : ".png";
  }
  if (mime.startsWith("video/")) return ".mp4";
  if (mime.startsWith("audio/")) return ".m4a";
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
      const decodedName = decodeUploadedName(file.originalname);
      if (field === "video") req.loopsyncVideoName = decodedName;
      if (field === "audio") req.loopsyncAudioName = decodedName;
      cb(null, `${field}${extensionFor(file)}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 2,
  },
  defParamCharset: "utf8",
});

app.use(express.json({ limit: "10mb" }));

// ── Session middleware (shared) ──
const SESSION_COOKIE = "loopsync_session";
const PROFILE_COOKIE = "loopsync_profile";
const SESSION_SECRET = (process.env.LOOPSYNC_SESSION_SECRET || "").trim();

function signSession(id) {
  if (!SESSION_SECRET) return id;
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(id).digest("base64url");
  return `${id}.${signature}`;
}

function readSessionId(cookieValue) {
  if (!cookieValue) return null;
  if (!SESSION_SECRET) return cookieValue;
  const dot = cookieValue.lastIndexOf(".");
  if (dot === -1) return null;
  const id = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(id).digest("base64url");
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) return null;
  return id;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function setCookie(res, name, value, { maxAgeDays = 30, httpOnly = true } = {}) {
  const secure = process.env.LOOPSYNC_COOKIE_SECURE === "1";
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.round(maxAgeDays * 24 * 60 * 60)}`,
  ];
  if (!httpOnly) parts.splice(2, 1);
  if (secure) parts.push("Secure");
  const header = res.getHeader("Set-Cookie");
  const list = Array.isArray(header) ? header : header ? [header] : [];
  list.push(parts.join("; "));
  res.setHeader("Set-Cookie", list);
}

app.use("/api", (req, res, next) => {
  try {
    if (req.loopsync && req.loopsync.ownerId) return next();
    const cookies = parseCookies(req);
    const sessionId = readSessionId(cookies[SESSION_COOKIE]);
    let session = sessionId ? store.getSession(sessionId) : null;
    if (!session) {
      const localId = cookies[PROFILE_COOKIE] || null;
      const profileId = store.ensureProfile(localId);
      session = store.createSession(profileId, { kind: "local" });
      setCookie(res, SESSION_COOKIE, signSession(session.id), { maxAgeDays: 30 });
      setCookie(res, PROFILE_COOKIE, profileId, { maxAgeDays: 365, httpOnly: false });
    } else if (!cookies[PROFILE_COOKIE]) {
      setCookie(res, PROFILE_COOKIE, session.ownerId, { maxAgeDays: 365, httpOnly: false });
    }
    req.loopsyncSession = session;
    req.loopsyncOwnerId = session.ownerId;
    next();
  } catch (err) {
    next(err);
  }
});

function resolveLocalFile(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== "done" || !job.result) return null;
  if (!fs.existsSync(job.outputPath)) return null;
  const stat = fs.statSync(job.outputPath);
  clearTimeout(job.timeout);
  job.timeout = setTimeout(() => cleanupJob(job), Math.max(RESULT_RETENTION_MS, 3 * 60 * 60 * 1000));
  return {
    path: job.outputPath,
    name: job.result.fileName || outputFileName(job.audioName),
    size: stat.size,
    mime: "video/mp4",
  };
}

app.use("/api/youtube", createYouTubeRouter({ store, dataDir: store.dir, resolveLocalFile }));
app.use("/api/loopsync", createLoopSyncRouter({ store, dataDir: store.dir }));

app.post("/api/process", upload.fields([{ name: "video", maxCount: 1 }, { name: "audio", maxCount: 1 }]), (req, res) => {
  const video = req.files && req.files.video && req.files.video[0];
  const audio = req.files && req.files.audio && req.files.audio[0];

  if (!video) {
    return res.status(400).json({ ok: false, error: "Selecione um vídeo ou uma imagem." });
  }
  if (!audio) {
    return res.status(400).json({ ok: false, error: "Selecione um áudio." });
  }

  const id = req.loopsyncJobId;
  const ownerId = (req.loopsyncSession && req.loopsyncSession.ownerId) || req.loopsyncOwnerId || "anonymous";
  const job = {
    id,
    ownerId,
    dir: req.loopsyncJobDir,
    videoPath: video.path,
    audioPath: audio.path,
    outputPath: path.join(req.loopsyncJobDir, "loopsync-result.mp4"),
    videoName: decodeUploadedName(req.loopsyncVideoName || video.originalname),
    audioName: decodeUploadedName(req.loopsyncAudioName || audio.originalname),
    imageSize: normalizeImageSize({
      preset: "custom",
      width: req.body && req.body.imageWidth,
      height: req.body && req.body.imageHeight,
    }),
    videoQuality: normalizeVideoQuality(req.body && req.body.videoQuality),
    audioQuality: normalizeAudioQuality(req.body && req.body.audioQuality),
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
    videoName: decodeUploadedName(video.originalname),
    audioName: decodeUploadedName(audio.originalname),
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
      imageSize: job.imageSize,
      videoQuality: job.videoQuality,
      audioQuality: job.audioQuality,
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
      width: result.width,
      height: result.height,
      requestedWidth: result.requestedWidth,
      requestedHeight: result.requestedHeight,
      isImage: result.isImage,
      videoQuality: result.videoQuality,
      audioQuality: result.audioQuality,
      audioBitrate: result.audioBitrate,
      downloadUrl: `/api/result/${job.id}`,
      fileName: outputFileName(job.audioName),
    };

    // ── Save to history with thumbnail ──
    try {
      const thumbDir = getThumbDir(store.dir);
      fs.mkdirSync(thumbDir, { recursive: true });
      const thumbId = `thumb_${crypto.randomBytes(8).toString("hex")}`;
      const thumbPath = path.join(thumbDir, `${thumbId}.jpg`);
      let hasThumb = false;
      if (fs.existsSync(job.outputPath)) {
        hasThumb = generateThumbnail(job.outputPath, thumbPath);
      }
      store.insert("loopsyncHistory", {
        ownerId: job.ownerId || "anonymous",
        fileName: job.result.fileName,
        originalVisualName: job.videoName,
        originalAudioName: job.audioName,
        sizeBytes: result.sizeBytes,
        width: result.width,
        height: result.height,
        duration: result.actualDuration,
        videoDuration: result.videoDuration,
        audioDuration: result.audioDuration,
        outputDuration: job.result.outputDuration,
        loopCount: result.loopCount,
        videoQuality: result.videoQuality,
        audioQuality: result.audioQuality,
        isImage: Boolean(result.isImage),
        thumbPath: hasThumb ? thumbPath : null,
        downloadUrl: job.result.downloadUrl,
        jobId: job.id,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("LoopSync history save error:", err.message);
    }
  } finally {
    try { fs.unlinkSync(job.videoPath); } catch { /* ignore */ }
    try { fs.unlinkSync(job.audioPath); } catch { /* ignore */ }
  }
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

  const requestedName = String(req.query.name || "").trim();
  const fileName = requestedName
    ? `${sanitizeBaseName(requestedName, { fallback: sanitizeBaseName(job.audioName) })}.mp4`
    : job.result.fileName || outputFileName(job.audioName);
  const stat = fs.statSync(job.outputPath);
  const fileSize = stat.size;

  clearTimeout(job.timeout);
  job.timeout = setTimeout(() => cleanupJob(job), RESULT_RETENTION_MS);

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  const inline = req.query.inline === "1";
  res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", fileName));

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

app.get("/health", (req, res) => {
  const youtubeConfigured = Boolean(
    (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim()
  );
  res.json({
    ok: true,
    service: "loopsync",
    youtube: {
      serverMode: true,
      configured: youtubeConfigured,
    },
  });
});

// Static files (after API)
const staticDir = path.join(__dirname, "dist");
if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir, {
    extensions: ["html"],
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  }));
} else {
  app.use(express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  }));
}

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

const server = app.listen(PORT, HOST, () => {
  const address = server.address() || {};
  console.log(`LoopSync server listening on http://${HOST}:${address.port || PORT}`);
  if (!youtubeConfiguredAtBoot) {
    console.log("YouTube: credenciais Google ausentes — defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (docs/YOUTUBE_SETUP.md).");
  }
});

function shutdown(signal) {
  console.log(`\\nLoopSync: received ${signal}, shutting down.`);
  Promise.resolve(store.flush())
    .catch(() => {})
    .finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = { app, store, decodeUploadedName, extensionFor };
