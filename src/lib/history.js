/**
 * LoopSync History - stores generated videos metadata + thumbnail
 * Local: IndexedDB + optional server sync
 */

import { idbGetAll, idbGet, idbPut, idbDelete, idbClear } from "./idb.js";

const STORE = "history";

function uid() {
  return `hist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function hasBackend() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch("/health", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body && body.ok && body.service === "loopsync");
  } catch {
    return false;
  }
}

export async function createThumbFromVideoFile(file, seekSeconds = 1) {
  // file can be File/Blob or URL string
  return new Promise((resolve) => {
    try {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      let url;
      if (typeof file === "string") {
        url = file;
      } else {
        url = URL.createObjectURL(file);
      }

      const cleanup = () => {
        if (typeof file !== "string") {
          try { URL.revokeObjectURL(url); } catch {}
        }
        video.removeAttribute("src");
        try { video.load(); } catch {}
      };

      video.onloadedmetadata = () => {
        // Seek to desired time
        const t = Math.min(seekSeconds, Math.max(0, (video.duration || 2) - 0.1));
        video.currentTime = t;
      };

      video.onseeked = () => {
        try {
          const canvas = document.createElement("canvas");
          const w = video.videoWidth || 320;
          const h = video.videoHeight || 180;
          const targetW = 320;
          const targetH = Math.round((h / w) * targetW) || 180;
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, targetW, targetH);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          cleanup();
          resolve(dataUrl);
        } catch {
          cleanup();
          resolve(null);
        }
      };

      video.onerror = () => {
        cleanup();
        resolve(null);
      };

      video.src = url;
    } catch {
      resolve(null);
    }
  });
}

export async function createThumbFromImageFile(file) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const targetW = 320;
          const targetH = Math.round((img.height / img.width) * targetW) || 180;
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, targetW, targetH);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          URL.revokeObjectURL(url);
          resolve(dataUrl);
        } catch {
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

export async function addHistoryEntry({
  fileName,
  sizeBytes,
  width,
  height,
  duration,
  videoDuration,
  audioDuration,
  outputDuration,
  loopCount,
  videoQuality,
  audioQuality,
  isImage,
  originalVisualName,
  originalAudioName,
  thumbDataUrl,
  blobUrl,
  downloadUrl,
  jobId,
}) {
  const id = uid();
  const createdAt = new Date().toISOString();

  const record = {
    id,
    fileName: String(fileName || "video.mp4").slice(0, 240),
    originalVisualName: originalVisualName || null,
    originalAudioName: originalAudioName || null,
    sizeBytes: Number(sizeBytes) || 0,
    width: width != null ? Number(width) : null,
    height: height != null ? Number(height) : null,
    duration: duration != null ? Number(duration) : null,
    videoDuration: videoDuration || null,
    audioDuration: audioDuration || null,
    outputDuration: outputDuration || null,
    loopCount: loopCount != null ? Number(loopCount) : null,
    videoQuality: videoQuality || null,
    audioQuality: audioQuality || null,
    isImage: Boolean(isImage),
    thumbDataUrl: thumbDataUrl || null,
    createdAt,
    jobId: jobId || null,
  };

  // Save locally
  await idbPut(STORE, record);

  // Try server if backend available (for wasm mode, also save metadata on server)
  if (await hasBackend()) {
    try {
      const payload = {
        fileName: record.fileName,
        sizeBytes: record.sizeBytes,
        width: record.width,
        height: record.height,
        duration: record.duration,
        videoDuration: record.videoDuration,
        audioDuration: record.audioDuration,
        outputDuration: record.outputDuration,
        loopCount: record.loopCount,
        videoQuality: record.videoQuality,
        audioQuality: record.audioQuality,
        isImage: record.isImage,
        originalVisualName: record.originalVisualName,
        originalAudioName: record.originalAudioName,
        thumbBase64: thumbDataUrl || null,
        downloadUrl: downloadUrl || null,
        jobId: record.jobId,
        createdAt: record.createdAt,
      };
      await fetch("/api/loopsync/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch { /* ignore */ }
  }

  return record;
}

export async function listHistory() {
  let serverItems = [];
  if (await hasBackend()) {
    try {
      const res = await fetch("/api/loopsync/history?limit=200");
      if (res.ok) {
        const body = await res.json();
        if (body.ok && Array.isArray(body.items)) {
          serverItems = body.items.map((it) => ({
            id: it.id,
            fileName: it.fileName,
            originalVisualName: it.originalVisualName,
            originalAudioName: it.originalAudioName,
            sizeBytes: it.sizeBytes,
            width: it.width,
            height: it.height,
            duration: it.duration,
            videoDuration: it.videoDuration,
            audioDuration: it.audioDuration,
            outputDuration: it.outputDuration,
            loopCount: it.loopCount,
            videoQuality: it.videoQuality,
            audioQuality: it.audioQuality,
            isImage: it.isImage,
            thumbUrl: it.hasThumb ? `/api/loopsync/history/${it.id}/thumb` : null,
            thumbDataUrl: null,
            createdAt: it.createdAt,
            jobId: it.jobId,
            downloadUrl: it.downloadUrl,
            server: true,
          }));
        }
      }
    } catch { /* ignore */ }
  }

  let localItems = [];
  try {
    localItems = await idbGetAll(STORE);
  } catch { localItems = []; }

  const merged = [...localItems, ...serverItems];
  // Deduplicate by id, local first
  const seen = new Set();
  const deduped = [];
  for (const item of merged) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      deduped.push(item);
    }
  }
  deduped.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return deduped;
}

export async function getHistory(id) {
  try {
    const local = await idbGet(STORE, id);
    if (local) return local;
  } catch {}
  return null;
}

export async function deleteHistory(id) {
  try {
    await idbDelete(STORE, id);
  } catch {}
  if (await hasBackend()) {
    try {
      await fetch(`/api/loopsync/history/${id}`, { method: "DELETE" });
    } catch {}
  }
}

export async function clearHistory() {
  try {
    await idbClear(STORE);
  } catch {}
  if (await hasBackend()) {
    try {
      await fetch("/api/loopsync/history", { method: "DELETE" });
    } catch {}
  }
}

export function formatBytes(bytes) {
  const v = Number(bytes) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDate(iso) {
  try {
    const d = new Date(iso);
    return {
      date: d.toLocaleDateString("pt-BR"),
      time: d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      full: d.toLocaleString("pt-BR"),
      iso,
    };
  } catch {
    return { date: "", time: "", full: iso, iso };
  }
}
