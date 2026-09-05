/**
 * LoopSync — cliente HTTP do módulo YouTube + motor de upload em blocos.
 *
 * O navegador NUNCA vê tokens ou client secret: ele conversa apenas com o
 * servidor local do LoopSync, que repassa os blocos para a sessão resumível do
 * Google. Se a conexão cair, o offset confirmado é recuperado do servidor e o
 * envio continua de onde parou.
 */

const BASE = "/api/youtube";

/** 5 MB — múltiplo de 256 KB, como recomendado pelo YouTube. */
export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_RETRY_PER_CHUNK = 6;

export class ApiError extends Error {
  constructor(message, { code = "error", status = 0, retryable = false, errors = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.errors = errors;
  }
}

async function parseError(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const message =
    (body && (body.error || body.message)) ||
    `Falha na requisição (${response.status}).`;
  return new ApiError(message, {
    code: (body && body.code) || "http_error",
    status: response.status,
    retryable: Boolean(body && body.retryable) || response.status === 429 || response.status >= 500,
    errors: (body && body.errors) || null,
  });
}

async function request(path, { method = "GET", body, raw, headers = {}, signal, json = true } = {}) {
  const finalHeaders = { ...headers };
  let payload;
  if (raw !== undefined) {
    payload = raw;
    if (!finalHeaders["Content-Type"]) finalHeaders["Content-Type"] = "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    finalHeaders["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: finalHeaders,
      body: payload,
      signal,
      credentials: "same-origin",
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new ApiError("Não foi possível falar com o servidor do LoopSync. Verifique se ele está rodando.", {
      code: "network",
      retryable: true,
    });
  }

  if (!response.ok) throw await parseError(response);
  if (!json) return response;
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

/* ── status / conexão ───────────────────────────────────────────── */

export const youtubeApi = {
  status: () => request("/status"),
  authStart: (returnTo) => request(`/auth/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`),
  disconnect: () => request("/disconnect", { method: "POST" }),
  channel: () => request("/channel"),
  categories: (region) => request(`/categories${region ? `?region=${encodeURIComponent(region)}` : ""}`),
  playlists: () => request("/playlists"),

  descriptions: {
    list: () => request("/descriptions"),
    create: (payload) => request("/descriptions", { method: "POST", body: payload }),
    update: (id, payload) => request(`/descriptions/${encodeURIComponent(id)}`, { method: "PUT", body: payload }),
    duplicate: (id) => request(`/descriptions/${encodeURIComponent(id)}/duplicate`, { method: "POST" }),
    remove: (id) => request(`/descriptions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },

  tagSets: {
    list: () => request("/tagsets"),
    create: (payload) => request("/tagsets", { method: "POST", body: payload }),
    update: (id, payload) => request(`/tagsets/${encodeURIComponent(id)}`, { method: "PUT", body: payload }),
    duplicate: (id) => request(`/tagsets/${encodeURIComponent(id)}/duplicate`, { method: "POST" }),
    remove: (id) => request(`/tagsets/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },

  templates: {
    list: () => request("/templates"),
    create: (payload) => request("/templates", { method: "POST", body: payload }),
    remove: (id) => request(`/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
    resolve: (id, context) => request(`/templates/${encodeURIComponent(id)}/resolve`, { method: "POST", body: context }),
  },

  suggestions: (payload) => request("/tag-suggestions", { method: "POST", body: payload }),
  validateTags: (tags) => request("/validate-tags", { method: "POST", body: { tags } }),

  uploads: {
    create: (payload) => request("/uploads", { method: "POST", body: payload }),
    get: (id) => request(`/uploads/${encodeURIComponent(id)}`),
    list: (params = {}) => {
      const query = new URLSearchParams(params).toString();
      return request(`/uploads${query ? `?${query}` : ""}`);
    },
    resume: (id) => request(`/uploads/${encodeURIComponent(id)}/resume`, { method: "POST" }),
    pump: (id) => request(`/uploads/${encodeURIComponent(id)}/pump`, { method: "POST", body: {} }),
    cancel: (id) => request(`/uploads/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    remove: (id) => request(`/uploads/${encodeURIComponent(id)}`, { method: "DELETE" }),
    chunk: (id, buffer, offset, total, signal) =>
      request(`/uploads/${encodeURIComponent(id)}/chunk?offset=${offset}&total=${total}`, {
        method: "PUT",
        raw: buffer,
        signal,
      }),
    thumbnail: (id, payload) => request(`/uploads/${encodeURIComponent(id)}/thumbnail`, { method: "POST", body: payload }),
  },
};

/* ── utilidades de arquivo ──────────────────────────────────────── */

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!Number.isFinite(total)) return "--:--";
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function extensionOf(file) {
  const name = String((file && file.name) || "");
  const index = name.lastIndexOf(".");
  return index > -1 ? name.slice(index + 1).toUpperCase() : "";
}

/** Lê metadados do vídeo no navegador (duração + dimensões). */
export function readVideoMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const done = (value) => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    video.onloadedmetadata = () => {
      done({
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      });
    };
    video.onerror = () => done({ duration: null, width: null, height: null, error: true });
    setTimeout(() => done({ duration: null, width: null, height: null, timeout: true }), 12000);
    video.src = url;
  });
}

/** Captura um quadro do vídeo para usar como sugestão de miniatura. */
export function captureVideoFrame(file, atSeconds = null) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    const grab = () => {
      try {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return finish(null);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) return finish(null);
            finish({ blob, width, height });
          },
          "image/jpeg",
          0.85
        );
      } catch {
        finish(null);
      }
    };
    video.onloadeddata = () => {
      const target = atSeconds != null ? atSeconds : Math.min(2, (video.duration || 4) * 0.15);
      try {
        video.currentTime = Number.isFinite(target) ? target : 1;
      } catch {
        grab();
      }
    };
    video.onseeked = grab;
    video.onerror = () => finish(null);
    setTimeout(() => finish(null), 12000);
    video.src = url;
  });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
    reader.readAsDataURL(blob);
  });
}

/* ── motor de upload ────────────────────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunkSizeFor(fileSize) {
  if (fileSize > 500 * 1024 * 1024) return 8 * 1024 * 1024;
  if (fileSize > 64 * 1024 * 1024) return DEFAULT_CHUNK_SIZE;
  return Math.max(256 * 1024, Math.min(DEFAULT_CHUNK_SIZE, 2 * 1024 * 1024));
}

/**
 * Envia um vídeo para o YouTube usando a sessão resumível do servidor.
 *
 * @param {object} options
 * @param {File} options.file arquivo de vídeo
 * @param {object} options.metadata título/descrição/tags/etc.
 * @param {(state: object) => void} options.onProgress callback de progresso
 * @param {AbortSignal} [options.signal] sinal de cancelamento
 * @param {string} [options.uploadId] reutiliza um upload existente (retomada)
 * @returns {Promise<object>} registro final do upload
 */
export async function uploadToYouTube({ file, metadata, onProgress, signal, uploadId = null }) {
  const report = (patch) => {
    if (typeof onProgress === "function") onProgress(patch);
  };
  const total = file.size;
  const chunkSize = chunkSizeFor(total);

  report({ phase: "preparando", percent: 0, received: 0, total });

  let resolvedUploadId = uploadId;
  if (!resolvedUploadId) {
    const created = await youtubeApi.uploads.create({
      ...metadata,
      fileName: file.name,
      fileSize: total,
      contentType: file.type || "video/mp4",
    });
    resolvedUploadId = created.upload.id;
  }
  report({ phase: "preparando", uploadId: resolvedUploadId, percent: 1 });

  // Miniatura: enviada antes para ser aplicada assim que o vídeo existir.
  if (metadata.thumbnailDataUrl && !uploadId) {
    try {
      await youtubeApi.uploads.thumbnail(resolvedUploadId, {
        mime: metadata.thumbnailMime || "image/jpeg",
        dataBase64: metadata.thumbnailDataUrl,
      });
    } catch (err) {
      report({ thumbnailWarning: err.message });
    }
  }

  let offset = 0;

  // Descobre o offset já confirmado (retomada de envio interrompido).
  try {
    const resumed = await youtubeApi.uploads.resume(resolvedUploadId);
    offset = Number(resumed.received || 0);
    if (resumed.restarted) report({ restarted: true });
  } catch {
    offset = 0;
  }

  let retries = 0;

  while (offset < total) {
    if (signal && signal.aborted) {
      const cancelled = { id: resolvedUploadId, status: "cancelled" };
      report({ phase: "cancelado", percent: Math.round((offset / total) * 100), upload: cancelled });
      return cancelled;
    }

    const end = Math.min(offset + chunkSize, total);
    let buffer;
    try {
      buffer = await file.slice(offset, end).arrayBuffer();
    } catch {
      throw new ApiError(
        "Não foi possível ler o arquivo de vídeo (referência expirada). Selecione o arquivo novamente.",
        { code: "file_unreadable" }
      );
    }

    try {
      const result = await youtubeApi.uploads.chunk(resolvedUploadId, buffer, offset, total, signal);
      retries = 0;

      if (result.resync) {
        offset = Number(result.received || offset);
        report({ phase: "retomando", received: offset, percent: Math.round((offset / total) * 100) });
        continue;
      }

      offset = Number(result.received != null ? result.received : end);
      const percent = Math.min(99, Math.round((offset / total) * 100));
      report({ phase: "enviando", received: offset, percent, speedBytes: end });

      if (result.done) {
        report({ phase: "processando", percent: 100, received: total });
        return waitForCompletion(resolvedUploadId, report, signal);
      }
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (err instanceof ApiError && !err.retryable && err.code !== "network") {
        throw err;
      }
      retries += 1;
      if (retries > MAX_RETRY_PER_CHUNK) throw err;

      const wait = Math.min(15000, 800 * 2 ** (retries - 1));
      report({
        phase: "reconectando",
        retryIn: Math.round(wait / 1000),
        attempt: retries,
        percent: Math.round((offset / total) * 100),
        warning: err.message,
      });
      await sleep(wait);

      // Pergunta ao servidor (que pergunta ao Google) onde parou de verdade.
      try {
        const resumed = await youtubeApi.uploads.resume(resolvedUploadId);
        offset = Number(resumed.received || offset);
        if (resumed.done) {
          report({ phase: "processando", percent: 100 });
          return waitForCompletion(resolvedUploadId, report, signal);
        }
        if (resumed.restarted) report({ restarted: true, phase: "retomando" });
      } catch {
        /* tenta novamente o bloco atual */
      }
    }
  }

  report({ phase: "processando", percent: 100 });
  return waitForCompletion(resolvedUploadId, report, signal);
}

async function waitForCompletion(uploadId, report, signal, { timeoutMs = 15 * 60 * 1000 } = {}) {
  const started = Date.now();
  let lastStatus = null;
  let lastProgress = -1;
  let interval = 1200;

  for (;;) {
    if (signal && signal.aborted) {
      return { id: uploadId, status: "cancelled" };
    }
    let payload;
    try {
      payload = await youtubeApi.uploads.get(uploadId);
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
      await sleep(3000);
      continue;
    }
    const upload = payload.upload;
    const percent = Math.max(0, Math.min(100, Number(upload.progress) || 0));
    if (upload.status !== lastStatus || percent !== lastProgress) {
      lastStatus = upload.status;
      lastProgress = percent;
      report({
        phase: upload.status === "processing" ? "processando" : upload.status,
        upload,
        percent: upload.status === "processing" || upload.status === "done" ? 100 : percent,
        received: upload.received,
      });
    }
    if (upload.status === "done") {
      report({ phase: "concluido", upload, percent: 100 });
      return upload;
    }
    if (upload.status === "error") {
      const error = new ApiError(upload.error || "O YouTube recusou o vídeo.", {
        code: upload.errorCode || "upload_error",
        retryable: Boolean(upload.retryable),
      });
      error.upload = upload;
      throw error;
    }
    if (upload.status === "cancelled") return upload;
    if (Date.now() - started > timeoutMs) {
      // O vídeo já foi enviado; o YouTube continua processando no servidor.
      report({ phase: "processando", upload, percent: 100, slowProcessing: true });
      return upload;
    }
    await sleep(interval);
    interval = Math.min(interval + 400, 6000);
  }
}

/**
 * Envida para o YouTube um arquivo que já está no servidor do LoopSync
 * (resultado do fluxo principal). Nenhum byte volta para o navegador: o
 * servidor bombeia o arquivo direto para a sessão resumível do Google.
 */
export async function uploadLocalResult({ jobId, metadata, onProgress, signal, uploadId = null }) {
  const report = (patch) => {
    if (typeof onProgress === "function") onProgress(patch);
  };

  report({ phase: "preparando", percent: 0 });

  let resolvedUploadId = uploadId;
  if (!resolvedUploadId) {
    const created = await youtubeApi.uploads.create({ ...metadata, source: { jobId } });
    resolvedUploadId = created.upload.id;
    report({ phase: "preparando", uploadId: resolvedUploadId, percent: 2, total: created.upload.fileSize });
  }

  if (metadata.thumbnailDataUrl && !uploadId) {
    try {
      await youtubeApi.uploads.thumbnail(resolvedUploadId, {
        mime: metadata.thumbnailMime || "image/jpeg",
        dataBase64: metadata.thumbnailDataUrl,
      });
    } catch (err) {
      report({ thumbnailWarning: err.message });
    }
  }

  if (signal && signal.aborted) {
    return { id: resolvedUploadId, status: "cancelled" };
  }

  await youtubeApi.uploads.pump(resolvedUploadId);
  report({ phase: "enviando", percent: 3 });

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        youtubeApi.uploads.cancel(resolvedUploadId).catch(() => {});
      },
      { once: true }
    );
  }

  return waitForCompletion(resolvedUploadId, report, signal);
}

/** Captura um quadro de um vídeo servido pelo próprio LoopSync (mesma origem). */
export function captureFrameFromUrl(url, atSeconds = 1) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    const grab = () => {
      try {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return finish(null);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(video, 0, 0, width, height);
        canvas.toBlob((blob) => finish(blob ? { blob, width, height } : null), "image/jpeg", 0.85);
      } catch {
        finish(null);
      }
    };
    video.onloadeddata = () => {
      const target = Math.min(atSeconds, Math.max(0.5, (video.duration || 4) * 0.15));
      try {
        video.currentTime = target;
      } catch {
        grab();
      }
    };
    video.onseeked = grab;
    video.onerror = () => finish(null);
    setTimeout(() => finish(null), 25000);
    video.src = url;
  });
}

/** Converte um File/Blob em data URL para envio de miniatura. */
export async function fileToThumbnailPayload(file) {
  const dataUrl = await blobToDataUrl(file);
  return { mime: file.type || "image/jpeg", dataBase64: dataUrl, name: file.name, size: file.size };
}

export { BASE };
