"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ffmpegPath } = require("@ffmpeg-installer/ffmpeg");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function getHistoryDir(dataDir) {
  return path.join(dataDir, "history");
}

function getThumbDir(dataDir) {
  return path.join(dataDir, "history-thumbs");
}

function generateThumbnail(videoPath, thumbPath) {
  try {
    ensureDir(path.dirname(thumbPath));
    // Try to generate thumbnail at 1 second
    const result = spawnSync(
      ffmpegPath,
      [
        "-y",
        "-ss", "1",
        "-i", videoPath,
        "-vframes", "1",
        "-vf", "scale=320:-2",
        "-q:v", "4",
        thumbPath,
      ],
      { encoding: "utf8", timeout: 15000 }
    );
    if (result.status === 0 && fs.existsSync(thumbPath)) {
      return true;
    }
    // Fallback: try at 0.1s
    const result2 = spawnSync(
      ffmpegPath,
      [
        "-y",
        "-ss", "0.1",
        "-i", videoPath,
        "-vframes", "1",
        "-vf", "scale=320:-2",
        "-q:v", "4",
        thumbPath,
      ],
      { encoding: "utf8", timeout: 15000 }
    );
    return result2.status === 0 && fs.existsSync(thumbPath);
  } catch {
    return false;
  }
}

function deleteThumb(thumbPath) {
  try {
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  } catch { /* ignore */ }
}

function formatBytes(bytes) {
  const v = Number(bytes) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return {
      date: d.toLocaleDateString("pt-BR"),
      time: d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      iso,
      timestamp: d.getTime(),
    };
  } catch {
    return { date: "", time: "", iso, timestamp: 0 };
  }
}

module.exports = {
  getHistoryDir,
  getThumbDir,
  generateThumbnail,
  deleteThumb,
  formatBytes,
  formatDate,
};
