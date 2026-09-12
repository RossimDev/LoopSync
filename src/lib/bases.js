/**
 * LoopSync Bases - save video/image/audio for reuse
 * Uses IndexedDB locally + server API when available
 */

import { idbGetAll, idbGet, idbPut, idbDelete } from "./idb.js";
import { kindOfFile, loadImageSize, loadVideoMeta, loadAudioDuration } from "./files.js";

const STORE = "bases";

function uid(prefix = "base") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

async function probeFile(file) {
  const kind = kindOfFile(file);
  let meta = { width: null, height: null, duration: null };
  try {
    if (kind === "image") {
      const size = await loadImageSize(file);
      meta.width = size.width;
      meta.height = size.height;
      meta.duration = 0;
    } else if (kind === "video") {
      const v = await loadVideoMeta(file);
      meta.width = v.width;
      meta.height = v.height;
      meta.duration = v.duration;
    } else if (kind === "audio") {
      const d = await loadAudioDuration(file);
      meta.duration = d;
    }
  } catch { /* ignore */ }
  return { kind, ...meta };
}

export async function saveBase(file, { name } = {}) {
  const { kind, width, height, duration } = await probeFile(file);
  if (kind === "unknown") throw new Error("Tipo de arquivo não reconhecido.");

  const id = uid(kind);
  const record = {
    id,
    kind,
    name: (name || file.name || `${kind}-${id}`).slice(0, 120),
    originalName: file.name,
    sizeBytes: file.size,
    mimeType: file.type || "",
    width: width || null,
    height: height || null,
    duration: duration || null,
    createdAt: new Date().toISOString(),
    file, // blob stored in IDB
  };

  await idbPut(STORE, record);

  // Try to also save on server if backend available
  if (await hasBackend()) {
    try {
      const form = new FormData();
      if (kind === "audio") {
        form.append("audio", file, file.name);
      } else {
        form.append("visual", file, file.name);
        if (width) form.append("width", String(width));
        if (height) form.append("height", String(height));
        if (duration) form.append("duration", String(duration));
      }
      if (name) form.append("name", name);
      await fetch("/api/loopsync/bases", { method: "POST", body: form });
    } catch { /* ignore server error */ }
  }

  return record;
}

export async function listBases() {
  // Try server first if backend available, merge with local
  let serverItems = [];
  if (await hasBackend()) {
    try {
      const res = await fetch("/api/loopsync/bases");
      if (res.ok) {
        const body = await res.json();
        if (body.ok && Array.isArray(body.items)) {
          serverItems = body.items.map((it) => ({
            id: it.id,
            kind: it.kind,
            name: it.name,
            originalName: it.originalName,
            sizeBytes: it.sizeBytes,
            mimeType: it.mimeType,
            width: it.width || (it.meta && it.meta.width) || null,
            height: it.height || (it.meta && it.meta.height) || null,
            duration: it.duration || (it.meta && it.meta.duration) || null,
            createdAt: it.createdAt,
            server: true,
            filePath: it.filePath,
            hasFile: it.hasFile,
          }));
        }
      }
    } catch { /* ignore */ }
  }

  let localItems = [];
  try {
    localItems = await idbGetAll(STORE);
  } catch { localItems = []; }

  // Merge: local items have file blobs, server items are remote
  // Show both, with local taking precedence if same id (shouldn't happen)
  const merged = [...localItems];
  const localIds = new Set(localItems.map((i) => i.id));
  for (const srv of serverItems) {
    if (!localIds.has(srv.id)) merged.push(srv);
  }

  // Sort by createdAt desc
  merged.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return merged;
}

export async function getBase(id) {
  // Try local first
  try {
    const local = await idbGet(STORE, id);
    if (local) return local;
  } catch { /* ignore */ }

  // Try server
  if (await hasBackend()) {
    try {
      // For server bases, we need to fetch file blob
      const res = await fetch(`/api/loopsync/bases/${id}/file`);
      if (res.ok) {
        const blob = await res.blob();
        // Need metadata from list
        const list = await listBases();
        const meta = list.find((i) => i.id === id);
        if (meta) {
          return {
            ...meta,
            file: blob,
          };
        }
        return { id, file: blob, kind: blob.type.startsWith("image/") ? "image" : blob.type.startsWith("video/") ? "video" : "audio", name: `base-${id}` };
      }
    } catch { /* ignore */ }
  }
  return null;
}

export async function deleteBase(id) {
  try {
    await idbDelete(STORE, id);
  } catch { /* ignore */ }

  if (await hasBackend()) {
    try {
      await fetch(`/api/loopsync/bases/${id}`, { method: "DELETE" });
    } catch { /* ignore */ }
  }
}

export async function getBaseFile(id) {
  const base = await getBase(id);
  if (!base) return null;
  if (base.file instanceof Blob || base.file instanceof File) {
    // Ensure File object with name
    if (base.file instanceof File) return base.file;
    return new File([base.file], base.name || base.originalName || `${base.kind}-${id}`, { type: base.mimeType || base.file.type || "" });
  }
  // If base has no file blob (server-only without file), try to fetch
  if (await hasBackend()) {
    try {
      const res = await fetch(`/api/loopsync/bases/${id}/file`);
      if (res.ok) {
        const blob = await res.blob();
        return new File([blob], base.name || `base-${id}`, { type: blob.type });
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function formatBytes(bytes) {
  const v = Number(bytes) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
