"use strict";

/**
 * LoopSync — motor de upload resumível para o YouTube.
 *
 * Como funciona:
 *   1. o navegador envia o arquivo em blocos (chunks) para o servidor local;
 *   2. o servidor repassa cada bloco para a sessão resumível do Google
 *      (`uploadType=resumable`), usando o token de acesso que NUNCA chega ao
 *      navegador;
 *   3. o offset confirmado pelo Google é persistido no banco local, então se a
 *      conexão cair o envio continua de onde parou — sem reiniciar;
 *   4. quando o Google confirma 100%, o vídeo recebe miniatura personalizada,
 *      entra na playlist escolhida e o status passa a ser acompanhado
 *      (Processando -> Concluído).
 *
 * Erros tratados: queda de conexão, timeout, token expirado (refresh
 * automático), erro 5xx/cota (retry com backoff), sessão expirada (recria),
 * arquivo inválido e falha durante o envio.
 */

const fs = require("fs");

const {
  YouTubeError,
  createUploadSession,
  uploadChunk,
  querySessionOffset,
  setThumbnail,
  addToPlaylist,
  getVideo,
  refreshAccessToken,
  videoUrl,
  friendlyMessage,
} = require("./client");
const { normalizeTags } = require("./tags");

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const TAGS_TOTAL_MAX = 500;
const MAX_FILE_BYTES = 256 * 1024 * 1024 * 1024; // 256 GB (limite do YouTube)
const MAX_DURATION_SECONDS = 12 * 60 * 60; // 12 horas (limite do YouTube)
const SESSION_TTL_MS = 1000 * 60 * 60 * 20; // sessões resumíveis expiram (~1 semana; usamos margem segura)
const STATUS_POLL_MIN_MS = Number(process.env.LOOPSYNC_YT_STATUS_POLL_MS || 8000);
const MAX_CHUNK_RETRIES = 4;

/** Trava por job para não gravar blocos fora de ordem em requisições paralelas. */
const locks = new Map();

async function withLock(id, fn) {
  const previous = locks.get(id) || Promise.resolve();
  const safe = previous.catch(() => {});
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chained = safe.then(() => gate);
  locks.set(id, chained);
  try {
    await safe;
    return await fn();
  } finally {
    release();
    if (locks.get(id) === chained) locks.delete(id);
  }
}

function loadThumbnailFromDisk(job) {
  if (job.thumbnailBuffer && job.thumbnailBuffer.length) return job.thumbnailBuffer;
  if (!job.thumbnailPath) return null;
  try {
    job.thumbnailBuffer = fs.readFileSync(job.thumbnailPath);
    return job.thumbnailBuffer;
  } catch {
    job.thumbnailBuffer = null;
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── contexto de autenticação ───────────────────────────────────── */

/**
 * Cria o "contexto" usado pelo client.js: sabe ler o token atual da conexão,
 * renovar quando expirado e persistir o novo token no banco local.
 */
function createContext(store, connection) {
  let cachedToken = connection.accessToken;
  let cachedExpiry = connection.expiresAt ? new Date(connection.expiresAt).getTime() : 0;

  const refresh = async () => {
    if (!connection.refreshToken) {
      throw new YouTubeError(friendlyMessage("invalidGrant"), { code: "invalidGrant", status: 401 });
    }
    const tokens = await refreshAccessToken(connection.refreshToken);
    cachedToken = tokens.accessToken;
    cachedExpiry = new Date(tokens.expiresAt).getTime();
    store.update("connections", connection.id, connection.ownerId, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || connection.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope || connection.scope,
      lastRefreshAt: new Date().toISOString(),
    });
    return tokens;
  };

  return {
    connection,
    async getAccessToken() {
      if (!cachedToken) await refresh();
      else if (cachedExpiry && Date.now() > cachedExpiry - 60000) await refresh();
      return cachedToken;
    },
    refresh,
  };
}

/* ── validação ──────────────────────────────────────────────────── */

function validateMetadata(payload = {}) {
  const errors = [];
  const title = String(payload.title || "").trim();
  const description = String(payload.description || "").trim();
  const tags = normalizeTags(payload.tags || []);

  if (!title) errors.push({ field: "title", message: "Informe um título para o vídeo." });
  if (title.length > TITLE_MAX) {
    errors.push({ field: "title", message: `O título tem ${title.length} caracteres; o máximo do YouTube é ${TITLE_MAX}.` });
  }
  if (description.length > DESCRIPTION_MAX) {
    errors.push({ field: "description", message: `A descrição tem ${description.length} caracteres; o máximo é ${DESCRIPTION_MAX}.` });
  }
  const privacy = ["public", "unlisted", "private"].includes(payload.privacyStatus) ? payload.privacyStatus : null;
  if (!privacy) errors.push({ field: "privacyStatus", message: "Selecione a privacidade do vídeo." });

  const fileSize = Number(payload.fileSize || 0);
  if (!fileSize || fileSize <= 0) errors.push({ field: "file", message: "Arquivo de vídeo inválido ou vazio." });
  if (fileSize > MAX_FILE_BYTES) errors.push({ field: "file", message: "O arquivo excede o limite de 256 GB do YouTube." });

  const duration = Number(payload.duration || 0);
  if (duration && duration > MAX_DURATION_SECONDS) {
    errors.push({ field: "file", message: "O vídeo excede o limite de 12 horas do YouTube." });
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      title,
      description,
      tags,
      tagsTotalChars: tags.reduce((acc, tag, index) => acc + tag.length + (index ? 1 : 0), 0),
      categoryId: payload.categoryId ? String(payload.categoryId) : null,
      privacyStatus: privacy || "private",
      playlistId: payload.playlistId || null,
      madeForKids: Boolean(payload.madeForKids),
      language: payload.language || "pt-BR",
      notifySubscribers: Boolean(payload.notifySubscribers),
      recordedAt: payload.recordedAt || null,
      publishAt: payload.publishAt || null,
    },
  };
}

function buildInsertMetadata(job) {
  const metadata = {
    snippet: {
      title: job.title,
      description: job.description || "",
      tags: job.tags || [],
      defaultLanguage: job.language || "pt-BR",
      defaultAudioLanguage: job.language || "pt-BR",
    },
    status: {
      privacyStatus: job.privacyStatus || "private",
      madeForKids: Boolean(job.madeForKids),
      selfDeclaredMadeForKids: Boolean(job.madeForKids),
      embeddable: true,
      publicStatsViewable: true,
      license: "youtube",
    },
    __contentType: job.contentType || "video/mp4",
    __contentLength: job.fileSize,
  };
  if (job.categoryId) metadata.snippet.categoryId = String(job.categoryId);
  if (job.publishAt && job.privacyStatus === "public") {
    metadata.status.publishAt = new Date(job.publishAt).toISOString();
    metadata.status.privacyStatus = "private";
  }
  return metadata;
}

/* ── criação da sessão ──────────────────────────────────────────── */

async function ensureSession(store, job, context, { force = false } = {}) {
  const stillValid =
    !force &&
    job.sessionUri &&
    job.sessionExpiresAt &&
    new Date(job.sessionExpiresAt).getTime() > Date.now() + 5000;
  if (stillValid) return job.sessionUri;

  const metadata = buildInsertMetadata(job);
  const { sessionUri } = await createUploadSession(context, metadata, {
    notifySubscribers: job.notifySubscribers,
  });

  const patch = {
    sessionUri,
    sessionExpiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    sessionCreatedAt: new Date().toISOString(),
    status: job.status === "error" || job.status === "cancelled" ? "queued" : job.status,
    error: null,
    errorCode: null,
  };
  // Se a sessão foi recriada do zero, o Google reinicia o contador de bytes.
  if (job.sessionUri && job.sessionUri !== sessionUri) patch.received = 0;

  Object.assign(job, store.update("uploads", job.id, job.ownerId, patch) || patch);
  return sessionUri;
}

/* ── envio de um bloco ──────────────────────────────────────────── */

async function pushChunk(store, job, context, buffer, offset, { chunkTotal } = {}) {
  return withLock(job.id, async () => {
    if (job.status === "cancelled") {
      throw new YouTubeError("Este upload foi cancelado.", { code: "cancelled" });
    }
    if (job.videoId && job.status === "done") {
      return { done: true, received: job.fileSize, videoId: job.videoId };
    }

    const total = Number(chunkTotal || job.fileSize);
    let start = Number(offset);

    if (!Number.isFinite(start) || start < 0 || start > total) {
      throw new YouTubeError("Offset de upload inválido.", { code: "invalidOffset" });
    }

    // O servidor é a fonte da verdade sobre o offset confirmado pelo Google.
    if (start !== Number(job.received || 0)) {
      if (start < Number(job.received || 0)) {
        return { resync: true, received: Number(job.received || 0), done: false };
      }
      // Buraco entre blocos: pergunta ao Google quanto já foi recebido.
      const synced = await syncOffset(store, job, context, total);
      if (synced.received !== start) {
        return { resync: true, received: synced.received, done: Boolean(synced.done) };
      }
    }

    if (start >= total) {
      const synced = await syncOffset(store, job, context, total);
      if (synced.done && synced.video) {
        await finalizeUpload(store, job, context, synced.video);
        return { done: true, received: total, videoId: job.videoId };
      }
      return { resync: true, received: synced.received, done: false };
    }

    try {
      const sessionUri = await ensureSession(store, job, context, { force: Boolean(job.forceNewSession) });
      job.forceNewSession = false;

      store.update("uploads", job.id, job.ownerId, { status: "uploading", startedAt: job.startedAt || new Date().toISOString() });
      job.status = "uploading";

      for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt += 1) {
        try {
          const result = await uploadChunk(sessionUri, buffer, {
            start,
            total,
            contentType: job.contentType || "video/mp4",
          });

          if (result.done) {
            await finalizeUpload(store, job, context, result.video);
            return { done: true, received: total, videoId: job.videoId };
          }

          const received = Math.max(0, Number(result.offset || 0));
          const progress = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
          const patch = { received, progress, status: "uploading", attempts: (job.attempts || 0) + 1 };
          store.update("uploads", job.id, job.ownerId, patch);
          Object.assign(job, patch);
          return { done: false, received, progress };
        } catch (err) {
          const code = err && err.code;

          if (code === "invalidGrant" || (err && err.status === 401)) {
            // Token expirado no meio do envio: renova e repete o mesmo bloco.
            await context.refresh();
            if (attempt < MAX_CHUNK_RETRIES) continue;
            throw err;
          }

          if (code === "sessionExpired") {
            // A sessão morreu no Google: descarta e recria. Os bytes precisam
            // ser relidos a partir do novo offset confirmado (nunca reusamos um
            // buffer de outro offset — isso corromperia o arquivo).
            store.update("uploads", job.id, job.ownerId, {
              sessionUri: null,
              sessionExpiresAt: null,
              received: 0,
              progress: 0,
            });
            job.sessionUri = null;
            job.sessionExpiresAt = null;
            job.received = 0;
            await ensureSession(store, job, context, { force: true });
            return { resync: true, received: 0, done: false, restarted: true };
          }

          if (err && err.retryable && attempt < MAX_CHUNK_RETRIES) {
            await sleep(400 * 2 ** attempt);
            continue;
          }
          throw err;
        }
      }
      throw new YouTubeError("Falha durante o envio do vídeo.", { code: "uploadFailed" });
    } catch (err) {
      // Qualquer falha (inclusive ao abrir a sessão) precisa ficar visível no
      // histórico com status de erro e mensagem amigável.
      await markError(store, job, err);
      throw err instanceof YouTubeError ? err : new YouTubeError("Falha durante o envio do vídeo.", { code: "uploadFailed" });
    }
  });
}

/** Pergunta ao Google quantos bytes já foram recebidos nesta sessão. */
async function syncOffset(store, job, context, total) {
  const size = Number(total || job.fileSize);
  if (!job.sessionUri) {
    return { received: Number(job.received || 0), done: false };
  }
  try {
    const result = await querySessionOffset(job.sessionUri, size);
    if (result.done && result.video) {
      await finalizeUpload(store, job, context, result.video);
      return { received: size, done: true };
    }
    const received = Math.max(0, Number(result.offset || 0));
    store.update("uploads", job.id, job.ownerId, {
      received,
      progress: size ? Math.min(99, Math.round((received / size) * 100)) : 0,
    });
    job.received = received;
    return { received, done: false };
  } catch (err) {
    if (err && err.code === "sessionExpired") {
      // Sessão morreu: recria e recomeça do zero (o arquivo ainda está no navegador).
      store.update("uploads", job.id, job.ownerId, { sessionUri: null, sessionExpiresAt: null, received: 0, progress: 0 });
      job.sessionUri = null;
      job.received = 0;
      return { received: 0, done: false, restarted: true };
    }
    throw err;
  }
}

/* ── finalização ────────────────────────────────────────────────── */

async function finalizeUpload(store, job, context, videoResource) {
  const videoId = videoResource && videoResource.id;
  if (!videoId) {
    throw new YouTubeError("O YouTube confirmou o envio mas não devolveu o ID do vídeo.", {
      code: "noVideoId",
      retryable: true,
    });
  }

  const patch = {
    videoId,
    videoUrl: videoUrl(videoId),
    status: "processing",
    received: Number(job.fileSize),
    progress: 100,
    sessionUri: null,
    sessionExpiresAt: null,
    error: null,
    errorCode: null,
    thumbnailUrl:
      (videoResource.snippet && videoResource.snippet.thumbnails && videoResource.snippet.thumbnails.medium && videoResource.snippet.thumbnails.medium.url) ||
      job.thumbnailUrl ||
      null,
    processingCheckedAt: new Date().toISOString(),
  };
  store.update("uploads", job.id, job.ownerId, patch);
  Object.assign(job, patch);

  // Miniatura personalizada (requer conta verificada; falha não invalida o upload)
  const thumbnailBuffer = loadThumbnailFromDisk(job);
  if (thumbnailBuffer && thumbnailBuffer.length) {
    try {
      const result = await setThumbnail(context, videoId, thumbnailBuffer, job.thumbnailMime || "image/jpeg");
      const thumbs = (result && result.items && result.items[0] && result.items[0].snippet && result.items[0].snippet.thumbnails) || {};
      const custom = thumbs.maxRes || thumbs.standard || thumbs.high || thumbs.medium || null;
      store.update("uploads", job.id, job.ownerId, {
        thumbnailApplied: true,
        thumbnailUrl: (custom && custom.url) || job.thumbnailUrl || null,
      });
      job.thumbnailApplied = true;
    } catch (err) {
      store.update("uploads", job.id, job.ownerId, {
        thumbnailApplied: false,
        thumbnailError: err && err.message ? err.message : "Não foi possível aplicar a miniatura.",
      });
    }
  }

  // Playlist
  if (job.playlistId) {
    try {
      await addToPlaylist(context, job.playlistId, videoId);
      store.update("uploads", job.id, job.ownerId, { playlistApplied: true });
      job.playlistApplied = true;
    } catch (err) {
      store.update("uploads", job.id, job.ownerId, {
        playlistApplied: false,
        playlistError: err && err.message ? err.message : "Não foi possível adicionar à playlist.",
      });
    }
  }

  // Já tenta ler o status real do vídeo (alguns canais processam rápido)
  await refreshVideoStatus(store, job, context, { force: true });
  return job;
}

/**
 * Consulta o YouTube para saber se o vídeo terminou de processar.
 * Chamado sob demanda (polling do frontend) com intervalo mínimo.
 */
async function refreshVideoStatus(store, job, context, { force = false } = {}) {
  if (job.status !== "processing" || !job.videoId) return job;
  const last = job.processingCheckedAt ? new Date(job.processingCheckedAt).getTime() : 0;
  if (!force && Date.now() - last < STATUS_POLL_MIN_MS) return job;

  try {
    const video = await getVideo(context, job.videoId);
    const patch = { processingCheckedAt: new Date().toISOString() };

    if (video) {
      const processing = video.processingStatus;
      if (processing === "succeeded" && (!video.uploadStatus || video.uploadStatus === "processed")) {
        patch.status = "done";
        patch.completedAt = new Date().toISOString();
        patch.thumbnailUrl = video.thumbnail || job.thumbnailUrl || null;
      } else if (processing === "failed" || processing === "rejected" || video.uploadStatus === "rejected" || video.uploadStatus === "failed") {
        patch.status = "error";
        patch.errorCode = video.rejectionReason || video.failureReason || "processingFailed";
        patch.error =
          friendlyMessage(patch.errorCode) ||
          `O YouTube recusou o processamento do vídeo (${patch.errorCode}).`;
        patch.completedAt = new Date().toISOString();
      } else {
        patch.status = "processing";
        patch.thumbnailUrl = video.thumbnail || job.thumbnailUrl || null;
        patch.privacyStatus = (video.privacyStatus && job.privacyStatus) || job.privacyStatus;
      }
    }
    store.update("uploads", job.id, job.ownerId, patch);
    Object.assign(job, patch);
  } catch (err) {
    // Falha de leitura não invalida um upload já confirmado.
    store.update("uploads", job.id, job.ownerId, { processingCheckedAt: new Date().toISOString(), statusWarning: err.message });
  }
  return job;
}

async function markError(store, job, err) {
  const patch = {
    status: "error",
    error: (err && err.message) || "Não foi possível enviar o vídeo.",
    errorCode: (err && err.code) || "uploadFailed",
    retryable: Boolean(err && err.retryable),
    failedAt: new Date().toISOString(),
    sessionUri: err && err.code === "sessionExpired" ? null : job.sessionUri,
  };
  store.update("uploads", job.id, job.ownerId, patch);
  Object.assign(job, patch);
}

/* ── envio de arquivo que já está no servidor (resultado do LoopSync) ── */

const pumping = new Set();

/**
 * Bombeia um arquivo local (ex.: o MP4 gerado pelo fluxo principal do
 * LoopSync) para a sessão resumível do YouTube, sem passar pelo navegador.
 * Mantém as mesmas regras de retomada, refresh de token e retry.
 */
async function pumpLocalFile(store, job, context, { chunkSize = 5 * 1024 * 1024 } = {}) {
  if (pumping.has(job.id)) return { alreadyRunning: true };
  if (!job.sourcePath || !fs.existsSync(job.sourcePath)) {
    throw new YouTubeError("O arquivo de origem não está mais disponível no servidor.", { code: "sourceMissing" });
  }

  pumping.add(job.id);
  const stat = fs.statSync(job.sourcePath);
  const total = Number(job.fileSize || stat.size);
  if (!job.fileSize || Number(job.fileSize) !== stat.size) {
    store.update("uploads", job.id, job.ownerId, { fileSize: stat.size });
    job.fileSize = stat.size;
  }

  const handle = fs.openSync(job.sourcePath, "r");
  try {
    let offset = Number(job.received || 0);
    if (offset > total) offset = 0;

    while (offset < total) {
      const fresh = store.get("uploads", job.id, job.ownerId) || job;
      if (fresh.status === "cancelled") {
        Object.assign(job, fresh);
        return { cancelled: true, received: offset };
      }

      const size = Math.min(chunkSize, total - offset);
      const buffer = Buffer.allocUnsafe(size);
      const bytesRead = fs.readSync(handle, buffer, 0, size, offset);
      if (bytesRead <= 0) break;
      const slice = bytesRead === size ? buffer : buffer.subarray(0, bytesRead);

      const result = await pushChunk(store, job, context, slice, offset, { chunkTotal: total });
      if (result.resync) {
        offset = Number(result.received || offset);
        if (result.done) break;
        continue;
      }
      offset = Number(result.received != null ? result.received : offset + bytesRead);
      if (result.done) {
        return { done: true, received: total };
      }
    }

    // Garante a confirmação final caso o último bloco tenha terminado o envio.
    const final = store.get("uploads", job.id, job.ownerId) || job;
    if (!final.videoId) {
      const synced = await syncOffset(store, final, context, total);
      return { done: Boolean(synced.done), received: synced.received };
    }
    return { done: true, received: total, videoId: final.videoId };
  } finally {
    try { fs.closeSync(handle); } catch { /* ignore */ }
    pumping.delete(job.id);
  }
}

/* ── API pública do motor ───────────────────────────────────────── */

function publicJob(job, { includeInternal = false } = {}) {
  const base = {
    id: job.id,
    ownerId: job.ownerId,
    channelId: job.channelId,
    channelTitle: job.channelTitle,
    fileName: job.fileName,
    fileSize: job.fileSize,
    contentType: job.contentType,
    duration: job.duration,
    title: job.title,
    description: job.description,
    tags: job.tags,
    categoryId: job.categoryId,
    privacyStatus: job.privacyStatus,
    playlistId: job.playlistId,
    playlistTitle: job.playlistTitle || null,
    categoryTitle: job.categoryTitle || null,
    madeForKids: job.madeForKids,
    language: job.language,
    templateId: job.templateId || null,
    templateName: job.templateName || null,
    videoId: job.videoId || null,
    videoUrl: job.videoUrl || null,
    thumbnailUrl: job.thumbnailUrl || null,
    thumbnailApplied: Boolean(job.thumbnailApplied),
    thumbnailError: job.thumbnailError || null,
    playlistApplied: Boolean(job.playlistApplied),
    playlistError: job.playlistError || null,
    status: job.status,
    progress: Math.max(0, Math.min(100, Number(job.progress || 0))),
    received: Number(job.received || 0),
    error: job.error || null,
    errorCode: job.errorCode || null,
    retryable: Boolean(job.retryable),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
  };
  if (includeInternal) {
    base.sessionActive = Boolean(job.sessionUri);
    base.sessionExpiresAt = job.sessionExpiresAt || null;
  }
  return base;
}

module.exports = {
  createContext,
  pumpLocalFile,
  validateMetadata,
  buildInsertMetadata,
  ensureSession,
  pushChunk,
  syncOffset,
  finalizeUpload,
  refreshVideoStatus,
  markError,
  publicJob,
  withLock,
  TITLE_MAX,
  DESCRIPTION_MAX,
  TAGS_TOTAL_MAX,
  MAX_FILE_BYTES,
  MAX_DURATION_SECONDS,
  SESSION_TTL_MS,
};
