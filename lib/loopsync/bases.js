"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeExt(name, fallback) {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (ext && ext.length <= 8 && /^\\.[a-z0-9]+$/i.test(ext)) return ext;
  return fallback;
}

function getBasesDir(dataDir) {
  return path.join(dataDir, "bases");
}

function getBaseFilePath(dataDir, id, originalName, kind) {
  const dir = getBasesDir(dataDir);
  ensureDir(dir);
  const fallback = kind === "audio" ? ".m4a" : kind === "image" ? ".png" : ".mp4";
  const ext = safeExt(originalName, fallback);
  return path.join(dir, `${id}${ext}`);
}

function saveBaseFile(dataDir, id, file, kind) {
  // file is multer file object with path
  const dest = getBaseFilePath(dataDir, id, file.originalname, kind);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(file.path, dest);
  try { fs.unlinkSync(file.path); } catch { /* ignore */ }
  return dest;
}

function deleteBaseFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
}

function formatBytes(bytes) {
  const v = Number(bytes) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

module.exports = {
  getBasesDir,
  getBaseFilePath,
  saveBaseFile,
  deleteBaseFile,
  formatBytes,
};
