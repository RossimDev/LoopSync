"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { getBasesDir, getBaseFilePath, saveBaseFile, deleteBaseFile } = require("./bases");
const { getThumbDir, generateThumbnail, deleteThumb } = require("./history");

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

function createLoopSyncRouter({ store, dataDir }) {
  const router = express.Router();

  // Session middleware (same as YouTube)
  router.use((req, res, next) => {
    try {
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

      req.loopsync = {
        session,
        ownerId: session.ownerId,
        cookies,
      };
      next();
    } catch (err) {
      next(err);
    }
  });

  // Multer for base uploads
  const tmpRoot = path.join(dataDir, "tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });

  const baseUpload = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        const dir = path.join(tmpRoot, `base-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
        fs.mkdirSync(dir, { recursive: true });
        req._tmpBaseDir = dir;
        cb(null, dir);
      },
      filename(req, file, cb) {
        cb(null, `${file.fieldname}${extensionFor(file)}`);
      },
    }),
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024,
      files: 2,
    },
  });

  // ── BASES ────────────────────────────────────────────────────────

  // List bases
  router.get("/bases", (req, res) => {
    const ownerId = req.loopsync.ownerId;
    const items = store.list("loopsyncBases", ownerId).map((item) => ({
      ...item,
      hasFile: Boolean(item.filePath && fs.existsSync(item.filePath)),
    }));
    res.json({ ok: true, items });
  });

  // Create base (visual or audio)
  router.post("/bases", baseUpload.fields([{ name: "visual", maxCount: 1 }, { name: "audio", maxCount: 1 }]), (req, res) => {
    const ownerId = req.loopsync.ownerId;
    const body = req.body || {};
    const visualFile = req.files && req.files.visual && req.files.visual[0];
    const audioFile = req.files && req.files.audio && req.files.audio[0];

    if (!visualFile && !audioFile) {
      if (req._tmpBaseDir) {
        try { fs.rmSync(req._tmpBaseDir, { recursive: true, force: true }); } catch { }
      }
      return res.status(400).json({ ok: false, error: "Envie um vídeo, imagem ou áudio para salvar como base." });
    }

    const results = [];

    const saveOne = (file, kind) => {
      const id = `base_${crypto.randomBytes(10).toString("hex")}`;
      const originalName = decodeUploadedName(file.originalname || `${kind}`);
      const filePath = saveBaseFile(dataDir, id, file, kind);
      const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : { size: 0 };

      const record = store.insert("loopsyncBases", {
        ownerId,
        kind, // video, image, audio
        name: body.name ? String(body.name).slice(0, 120) : originalName,
        originalName,
        filePath,
        sizeBytes: stat.size,
        mimeType: file.mimetype || "",
        duration: body.duration ? Number(body.duration) : null,
        width: body.width ? Number(body.width) : null,
        height: body.height ? Number(body.height) : null,
        // For visual bases, store extra info
        meta: {
          width: body.width ? Number(body.width) : null,
          height: body.height ? Number(body.height) : null,
          duration: body.duration ? Number(body.duration) : null,
        },
      });
      results.push(record);
    };

    try {
      if (visualFile) {
        const kind = (visualFile.mimetype || "").startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(visualFile.originalname || "")
          ? "image"
          : "video";
        saveOne(visualFile, kind);
      }
      if (audioFile) {
        saveOne(audioFile, "audio");
      }
    } finally {
      if (req._tmpBaseDir) {
        try { fs.rmSync(req._tmpBaseDir, { recursive: true, force: true }); } catch { }
      }
    }

    res.status(201).json({ ok: true, items: results });
  });

  // Get base file
  router.get("/bases/:id/file", (req, res) => {
    const ownerId = req.loopsync.ownerId;
    const item = store.get("loopsyncBases", req.params.id, ownerId);
    if (!item) return res.status(404).json({ ok: false, error: "Base não encontrada." });
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      return res.status(404).json({ ok: false, error: "Arquivo da base não encontrado." });
    }
    const fileName = item.name || item.originalName || "base";
    res.setHeader("Content-Type", item.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename=\"${fileName.replace(/\"/g, "")}\"`);
    const stream = fs.createReadStream(item.filePath);
    stream.pipe(res);
  });

  // Delete base
  router.delete("/bases/:id", (req, res) => {
    const ownerId = req.loopsync.ownerId;
    const item = store.get("loopsyncBases", req.params.id, ownerId);
    if (!item) return res.status(404).json({ ok: false, error: "Base não encontrada." });
    deleteBaseFile(item.filePath);
    store.remove("loopsyncBases", req.params.id, ownerId);
    res.json({ ok: true });
  });

  // ── HISTORY ──────────────────────────────────────────────────────

  router.get("/history", (req, res) => {
    const ownerId = req.loopsync.ownerId;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const all = store.list("loopsyncHistory", ownerId);
    const items = all.slice(offset, offset + limit);
    // Add thumb existence flag
    const withThumb = items.map((item) => ({
      ...item,
      hasThumb: Boolean(item.thumbPath && fs.existsSync(item.thumbPath)),
    }));
    res.json({ ok: true, items: withThumb, total: all.length, limit, offset });
  });

  router.get("/history/:id/thumb", (req, res) => {
    const ownerId = req.loopsync.ownerId;
    const item = store.get("loopsyncHistory", req.params.id, ownerId);
    if (!item) return res.status(404).json({ ok: false, error: "Histórico não encontrado." });
    if (!item.thumbPath || !fs.existsSync(item.thumbPath)) {
      return res.status(404).json({ ok: false, error: "Thumbnail não encontrada." });
    }
    res.setHeader("Content-Type", "image/jpeg");
    const stream = fs.createReadStream(item.thumbPath);
    stream.pipe(res);
  });

  router.delete("/history/:id", (req, res) => {
    const ownerId = req.loopsync.ownerId;
    const item = store.get("loopsyncHistory", req.params.id, ownerId);
    if (!item) return res.status(404).json({ ok: false, error: "Histórico não encontrado." });
    deleteThumb(item.thumbPath);
    store.remove("loopsyncHistory", req.params.id, ownerId);
    res.json({ ok: true });
  });

  router.delete("/history", (req, res) => {
    const ownerId = req.loopsync.ownerId;
    const all = store.listAll("loopsyncHistory", ownerId);
    for (const item of all) {
      deleteThumb(item.thumbPath);
      store.remove("loopsyncHistory", item.id, ownerId);
    }
    res.json({ ok: true, deleted: all.length });
  });

  // Create history entry (used by server after job, and optionally by client for wasm mode)
  router.post("/history", express.json({ limit: "10mb" }), (req, res) => {
    const ownerId = req.loopsync.ownerId;
    const body = req.body || {};
    if (!body.fileName) {
      return res.status(400).json({ ok: false, error: "fileName é obrigatório." });
    }

    // If body contains thumbBase64, save it
    let thumbPath = null;
    if (body.thumbBase64) {
      try {
        const dir = getThumbDir(dataDir);
        fs.mkdirSync(dir, { recursive: true });
        const id = `thumb_${crypto.randomBytes(8).toString("hex")}`;
        thumbPath = path.join(dir, `${id}.jpg`);
        const base64 = String(body.thumbBase64).replace(/^data:image\/[^;]+;base64,/, "");
        const buffer = Buffer.from(base64, "base64");
        if (buffer.length > 0 && buffer.length < 5 * 1024 * 1024) {
          fs.writeFileSync(thumbPath, buffer);
        } else {
          thumbPath = null;
        }
      } catch {
        thumbPath = null;
      }
    }

    const record = store.insert("loopsyncHistory", {
      ownerId,
      fileName: String(body.fileName).slice(0, 240),
      originalVisualName: body.originalVisualName ? String(body.originalVisualName).slice(0, 240) : null,
      originalAudioName: body.originalAudioName ? String(body.originalAudioName).slice(0, 240) : null,
      sizeBytes: Number(body.sizeBytes) || 0,
      width: body.width ? Number(body.width) : null,
      height: body.height ? Number(body.height) : null,
      duration: body.duration ? Number(body.duration) : null,
      videoDuration: body.videoDuration || null,
      audioDuration: body.audioDuration || null,
      outputDuration: body.outputDuration || null,
      loopCount: body.loopCount != null ? Number(body.loopCount) : null,
      videoQuality: body.videoQuality || null,
      audioQuality: body.audioQuality || null,
      isImage: Boolean(body.isImage),
      thumbPath,
      downloadUrl: body.downloadUrl || null,
      jobId: body.jobId || null,
      createdAt: body.createdAt || new Date().toISOString(),
    });

    res.status(201).json({ ok: true, item: record });
  });

  // Helper to create history from server job (internal use)
  router._createFromJob = async (job, result) => {
    try {
      const ownerId = job.ownerId || null;
      // Find owner from job if available, otherwise try to get from store? For now use first owner or null?
      // We'll store with ownerId if job has it, else we need to store without scoping.
      // For simplicity, if job has no ownerId, we store with ownerId from a default? We'll try to get owner from recent session.
      // Actually, jobs created via /api/process don't have ownerId yet - we need to capture it.
      // So we will pass ownerId when creating job.

      const dataDirForThumb = dataDir;
      const thumbDir = getThumbDir(dataDirForThumb);
      fs.mkdirSync(thumbDir, { recursive: true });
      const thumbId = `thumb_${crypto.randomBytes(8).toString("hex")}`;
      const thumbPath = path.join(thumbDir, `${thumbId}.jpg`);
      let hasThumb = false;
      if (result && job.outputPath && fs.existsSync(job.outputPath)) {
        // Try to generate thumb
        try {
          const { generateThumbnail } = require("./history");
          hasThumb = generateThumbnail(job.outputPath, thumbPath);
        } catch { hasThumb = false; }
      }

      const record = store.insert("loopsyncHistory", {
        ownerId: ownerId || job.ownerId || "anonymous",
        fileName: result.fileName || "video.mp4",
        originalVisualName: job.videoName || null,
        originalAudioName: job.audioName || null,
        sizeBytes: result.sizeBytes || 0,
        width: result.width || null,
        height: result.height || null,
        duration: result.actualDuration || result.outputDuration ? Number(result.outputDuration) : null,
        videoDuration: result.videoDuration || null,
        audioDuration: result.audioDuration || null,
        outputDuration: result.outputDuration || null,
        loopCount: result.loopCount || null,
        videoQuality: result.videoQuality || null,
        audioQuality: result.audioQuality || null,
        isImage: Boolean(result.isImage),
        thumbPath: hasThumb ? thumbPath : null,
        downloadUrl: result.downloadUrl || null,
        jobId: job.id || null,
        createdAt: new Date().toISOString(),
      });
      return record;
    } catch (err) {
      console.error("LoopSync history create error:", err.message);
      return null;
    }
  };

  return router;
}

module.exports = {
  createLoopSyncRouter,
  parseCookies,
  SESSION_COOKIE,
  PROFILE_COOKIE,
};
