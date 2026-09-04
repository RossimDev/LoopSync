"use strict";

/**
 * LoopSync — cliente OAuth 2.0 + YouTube Data API v3.
 *
 * Regras de segurança seguidas aqui:
 *   - o `client secret` NUNCA sai do servidor (só é usado nesta troca de code);
 *   - o `access token` / `refresh token` NUNCA são devolvidos ao frontend;
 *   - PKCE (S256) + `state` protegem o fluxo contra CSRF e interceptação;
 *   - nenhum token aparece em URL de redirect (o Google devolve só o `code`).
 *
 * Os endpoints base podem ser sobrescritos por variáveis de ambiente, o que
 * permite que a suíte de testes valide o fluxo real contra um servidor mock.
 */

const crypto = require("crypto");

const GOOGLE_AUTH_BASE = process.env.GOOGLE_AUTH_BASE || "https://accounts.google.com";
/**
 * Base pública usada SOMENTE na URL de autorização aberta no navegador.
 * Útil quando o servidor alcança o Google por um endereço interno (proxy,
 * rede privada ou testes) mas o navegador precisa de uma URL pública.
 * Quando ausente, usa o mesmo GOOGLE_AUTH_BASE nos dois lados.
 */
const GOOGLE_PUBLIC_AUTH_BASE = (process.env.GOOGLE_PUBLIC_AUTH_BASE || "").trim();
const GOOGLE_API_BASE = process.env.GOOGLE_API_BASE || "https://www.googleapis.com";
const YOUTUBE_API_BASE = process.env.YOUTUBE_API_BASE || "https://www.googleapis.com/youtube/v3";
const YOUTUBE_UPLOAD_BASE = process.env.YOUTUBE_UPLOAD_BASE || "https://www.googleapis.com/upload/youtube/v3";

/**
 * `youtube.force-ssl` cobre upload, playlists e miniaturas personalizadas.
 * `youtube.readonly` garante leitura de canal/categorias mesmo se a força-ssl
 * mudar de comportamento. `openid email profile` dão o identificador estável.
 */
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
];

const DEFAULT_TIMEOUT_MS = Number(process.env.GOOGLE_TIMEOUT_MS || 30000);
const CHUNK_TIMEOUT_MS = Number(process.env.GOOGLE_CHUNK_TIMEOUT_MS || 120000);

/* ── erros ──────────────────────────────────────────────────────── */

class YouTubeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "YouTubeError";
    this.code = options.code || "youtube_error";
    this.status = options.status || 0;
    this.retryable = Boolean(options.retryable);
    this.reason = options.reason || null;
    this.details = options.details || null;
  }
}

const REASON_MESSAGES = {
  quotaExceeded: "A cota diária da YouTube Data API deste projeto foi esgotada. Tente novamente amanhã ou aumente a cota no Google Cloud.",
  dailyLimitExceeded: "Limite diário da API atingido. Tente novamente mais tarde.",
  rateLimitExceeded: "Muitas requisições seguidas. Aguarde alguns segundos e tente novamente.",
  userRateLimitExceeded: "Muitas requisições seguidas para esta conta. Aguarde e tente novamente.",
  invalidGrant: "A autorização do Google expirou ou foi revogada. Conecte o canal novamente.",
  expired_token: "O token de acesso expirou. Conecte o canal novamente.",
  invalid_token: "Token inválido. Conecte o canal novamente.",
  unauthorized: "Sua conta Google não autoriza esta operação.",
  forbidden: "Operação não permitida para esta conta ou canal.",
  youtubeSignupRequired: "Esta conta Google ainda não tem um canal do YouTube. Crie o canal em youtube.com e tente novamente.",
  invalidSubscription: "Não foi possível identificar o canal conectado.",
  insufficientPermissions: "O token não tem as permissões necessárias. Desconecte e conecte novamente marcando todas as permissões.",
  backendError: "O YouTube retornou um erro interno temporário. O envio será retomado automaticamente.",
  serviceUnavailable: "O YouTube está temporariamente indisponível. O envio será retomado automaticamente.",
  invalidCredentials: "Sua conta não permite esta operação (verifique a conta/canal conectado).",
  videoNotFound: "Vídeo não encontrado no YouTube.",
  playlistNotFound: "Playlist não encontrada no canal conectado.",
  invalidVideoFile: "O arquivo de vídeo não é aceito pelo YouTube.",
  uploadTooLarge: "Arquivo grande demais para o upload (limite do YouTube: 256 GB ou 12 horas).",
  notConfigured: "A integração com o YouTube ainda não foi configurada neste servidor.",
  videoTooLong: "O vídeo excede 12 horas de duração (limite do YouTube).",
};

function friendlyMessage(reason, fallback) {
  return REASON_MESSAGES[reason] || fallback;
}

/** Converte a resposta de erro do Google em um YouTubeError amigável. */
function toYouTubeError(status, body, fallback = "Não foi possível falar com o YouTube.") {
  const err = (body && body.error) || {};
  const first = Array.isArray(err.errors) && err.errors[0] ? err.errors[0] : null;
  const reason = (first && first.reason) || err.status || null;
  const detail = (first && (first.message || first.reason)) || err.message || "";
  const code = normalizeReason(reason, status);
  const message = friendlyMessage(code, detail || fallback);

  const retryable =
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    ["backendError", "serviceUnavailable", "rateLimitExceeded", "userRateLimitExceeded"].includes(code);

  return new YouTubeError(message, {
    code,
    status,
    retryable,
    reason,
    details: detail || null,
  });
}

function normalizeReason(reason, status) {
  if (!reason) {
    if (status === 401) return "invalidGrant";
    if (status === 403) return "forbidden";
    if (status === 404) return "videoNotFound";
    return "youtubeError";
  }
  return String(reason);
}

/* ── utilidades ─────────────────────────────────────────────────── */

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createCodeVerifier() {
  return base64url(crypto.randomBytes(48));
}

function createCodeChallenge(verifier) {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

function decodeJwt(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function request(url, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { ...(options.headers || {}) };
  if (options.json !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json; charset=UTF-8";
  }

  let body;
  if (options.json !== undefined) body = JSON.stringify(options.json);
  else if (options.form !== undefined) body = new URLSearchParams(options.form).toString();
  else if (options.body !== undefined) body = options.body;

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body,
      signal: options.signal || controller.signal,
      redirect: options.redirect || "follow",
    });
    return response;
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new YouTubeError("Tempo esgotado ao falar com o YouTube. Verifique sua conexão.", {
        code: "timeout",
        retryable: true,
      });
    }
    throw new YouTubeError("Não foi possível conectar ao YouTube. Verifique sua conexão com a internet.", {
      code: "network",
      retryable: true,
      details: err && err.message,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/** Chamada autenticada na YouTube Data API v3 com refresh automático. */
async function apiCall(context, url, options = {}) {
  const accessToken = await context.getAccessToken();
  const response = await request(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  if (response.status === 401 && context.refresh) {
    // Token expirado no meio do caminho: renova e tenta uma única vez.
    await context.refresh();
    const retry = await request(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${await context.getAccessToken()}`,
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    if (!retry.ok) throw toYouTubeError(retry.status, await readJson(retry));
    return retry;
  }

  if (!response.ok) throw toYouTubeError(response.status, await readJson(response));
  return response;
}

/* ── configuração ───────────────────────────────────────────────── */

function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "";
  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    redirectUri: redirectUri.trim(),
    scopes: SCOPES,
    authBase: GOOGLE_AUTH_BASE,
    publicAuthBase: GOOGLE_PUBLIC_AUTH_BASE || GOOGLE_AUTH_BASE,
    apiBase: GOOGLE_API_BASE,
    youtubeBase: YOUTUBE_API_BASE,
    uploadBase: YOUTUBE_UPLOAD_BASE,
    configured: Boolean(clientId.trim()),
    canExchangeCode: Boolean(clientId.trim() && clientSecret.trim()),
  };
}

/**
 * Redirect URI efetivo: usa GOOGLE_REDIRECT_URI quando definido (obrigatório
 * em produção/HTTPS) ou deriva da origem da requisição em desenvolvimento.
 */
function resolveRedirectUri(req) {
  const cfg = config();
  if (cfg.redirectUri) return cfg.redirectUri;
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}/api/youtube/auth/callback`;
}

/* ── fluxo OAuth ────────────────────────────────────────────────── */

function buildAuthUrl({ redirectUri, state, codeVerifier, extraParams = {} }) {
  const cfg = config();
  if (!cfg.clientId) {
    throw new YouTubeError(friendlyMessage("notConfigured"), { code: "notConfigured", status: 503 });
  }
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state,
    code_challenge: createCodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    ...extraParams,
  });
  return `${cfg.publicAuthBase}/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode({ code, codeVerifier, redirectUri }) {
  const cfg = config();
  if (!cfg.canExchangeCode) {
    throw new YouTubeError(
      "Faltam GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET no servidor. Veja as instruções de configuração.",
      { code: "notConfigured", status: 503 }
    );
  }
  const response = await request(`${cfg.authBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    form: {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
  });
  const body = await readJson(response);
  if (!response.ok || !body.access_token) {
    throw toYouTubeError(response.status, { error: body.error || "invalid_grant" }, "Não foi possível concluir a autorização com o Google.");
  }
  return normalizeTokens(body);
}

async function refreshAccessToken(refreshToken) {
  const cfg = config();
  if (!cfg.canExchangeCode || !refreshToken) {
    throw new YouTubeError(friendlyMessage("invalidGrant"), { code: "invalidGrant", status: 401 });
  }
  const response = await request(`${cfg.authBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    form: {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
  });
  const body = await readJson(response);
  if (!response.ok || !body.access_token) {
    throw toYouTubeError(response.status, { error: body.error || "invalid_grant" }, "Não foi possível renovar o acesso ao Google.");
  }
  return normalizeTokens(body, { keepRefreshToken: refreshToken });
}

function normalizeTokens(body, options = {}) {
  const expiresIn = Number(body.expires_in || 3600);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || options.keepRefreshToken || null,
    idToken: body.id_token || null,
    scope: body.scope || "",
    tokenType: body.token_type || "Bearer",
    expiresAt: new Date(Date.now() + Math.max(60, expiresIn - 60) * 1000).toISOString(),
  };
}

async function revokeToken(token) {
  if (!token) return true;
  const cfg = config();
  try {
    await request(`${cfg.authBase}/o/oauth2/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      form: { token },
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/* ── dados do usuário / canal ───────────────────────────────────── */

async function getUserInfo(context) {
  const cfg = config();
  const response = await apiCall(context, `${cfg.apiBase}/oauth2/v3/userinfo`);
  return readJson(response);
}

async function getChannel(context) {
  const cfg = config();
  const url = `${cfg.youtubeBase}/channels?part=snippet%2CcontentDetails%2Cstatistics&mine=true&maxResults=1`;
  const response = await apiCall(context, url);
  const body = await readJson(response);
  const item = body.items && body.items[0];
  if (!item) {
    throw new YouTubeError(friendlyMessage("youtubeSignupRequired"), { code: "youtubeSignupRequired", status: 404 });
  }
  const snippet = item.snippet || {};
  const thumbs = snippet.thumbnails || {};
  const thumbnail =
    (thumbs.medium && thumbs.medium.url) ||
    (thumbs.default && thumbs.default.url) ||
    (thumbs.high && thumbs.high.url) ||
    null;
  return {
    id: item.id,
    title: snippet.title || "",
    description: snippet.description || "",
    thumbnail,
    country: snippet.country || "",
    uploadsPlaylistId: (item.contentDetails && item.contentDetails.relatedPlaylists && item.contentDetails.relatedPlaylists.uploads) || null,
    subscriberCount: Number((item.statistics && item.statistics.subscriberCount) || 0),
    videoCount: Number((item.statistics && item.statistics.videoCount) || 0),
    viewCount: Number((item.statistics && item.statistics.viewCount) || 0),
    hiddenSubscriberCount: Boolean(item.statistics && item.statistics.hiddenSubscriberCount),
  };
}

async function listCategories(context, regionCode = "BR") {
  const cfg = config();
  const url = `${cfg.youtubeBase}/videoCategories?part=snippet&regionCode=${encodeURIComponent(regionCode || "BR")}&maxResults=50`;
  const response = await apiCall(context, url);
  const body = await readJson(response);
  const items = (body.items || []).map((item) => ({
    id: String(item.id),
    title: (item.snippet && item.snippet.title) || "",
    assignable: Boolean(item.snippet && item.snippet.assignable),
  }));
  return items.filter((item) => item.title);
}

async function listPlaylists(context, { maxResults = 50 } = {}) {
  const cfg = config();
  const playlists = [];
  let pageToken = "";
  do {
    const url =
      `${cfg.youtubeBase}/playlists?part=snippet%2CcontentDetails&mine=true&maxResults=${Math.min(50, maxResults)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const response = await apiCall(context, url);
    const body = await readJson(response);
    for (const item of body.items || []) {
      const snippet = item.snippet || {};
      playlists.push({
        id: item.id,
        title: snippet.title || "",
        thumbnail: (snippet.thumbnails && snippet.thumbnails.default && snippet.thumbnails.default.url) || null,
        itemCount: Number((item.contentDetails && item.contentDetails.itemCount) || 0),
        privacy: snippet.privacyStatus || null,
      });
    }
    pageToken = body.nextPageToken || "";
  } while (pageToken && playlists.length < 200);
  return playlists;
}

async function getVideo(context, videoId) {
  const cfg = config();
  const url = `${cfg.youtubeBase}/videos?part=snippet%2Cstatus%2CprocessingDetails&id=${encodeURIComponent(videoId)}`;
  const response = await apiCall(context, url);
  const body = await readJson(response);
  const item = body.items && body.items[0];
  if (!item) return null;
  const processing = item.processingDetails || {};
  return {
    id: item.id,
    title: (item.snippet && item.snippet.title) || "",
    thumbnail:
      (item.snippet && item.snippet.thumbnails && item.snippet.thumbnails.medium && item.snippet.thumbnails.medium.url) ||
      (item.snippet && item.snippet.thumbnails && item.snippet.thumbnails.default && item.snippet.thumbnails.default.url) ||
      null,
    privacyStatus: (item.status && item.status.uploadStatus) || null,
    uploadStatus: (item.status && item.status.uploadStatus) || null,
    processingStatus: processing.processingStatus || null,
    uploadPriority: (item.status && item.status.uploadPriority) || null,
    rejectionReason: (item.status && item.status.rejectionReason) || null,
    failureReason: (item.status && item.status.failureReason) || null,
    selfDeclaredMadeForKids: (item.status && item.status.selfDeclaredMadeForKids) || null,
  };
}

/* ── upload resumível ───────────────────────────────────────────── */

/**
 * Cria a sessão de upload resumível (`uploadType=resumable`) e devolve a
 * `sessionUri` retornada no header `Location`.
 */
async function createUploadSession(context, metadata, { notifySubscribers = false } = {}) {
  const cfg = config();
  const url =
    `${cfg.uploadBase}/videos?uploadType=resumable&part=snippet%2Cstatus` +
    `&notifySubscribers=${notifySubscribers ? "true" : "false"}`;

  const response = await apiCall(context, url, {
    method: "POST",
    json: metadata,
    timeout: CHUNK_TIMEOUT_MS,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": metadata.__contentType || "video/mp4",
      "X-Upload-Content-Length": String(metadata.__contentLength || 0),
    },
  });

  const sessionUri = response.headers.get("location");
  if (!sessionUri) {
    throw new YouTubeError("O YouTube não retornou uma sessão de upload. Tente novamente.", {
      code: "sessionFailed",
      retryable: true,
    });
  }
  return { sessionUri };
}

/**
 * Envia um trecho do arquivo para a sessão resumível.
 *
 * Respostas possíveis do Google:
 *   200/201 — upload concluído (corpo = recurso do vídeo)
 *   308     — incompleto; header `Range: bytes=0-N` diz quanto já foi recebido
 *   4xx/5xx — erro
 */
async function uploadChunk(sessionUri, buffer, { start, total, contentType = "video/mp4" }) {
  const end = start + buffer.length - 1;
  const contentRange = `bytes ${start}-${end}/${total}`;
  const response = await request(sessionUri, {
    method: "PUT",
    body: buffer,
    timeout: CHUNK_TIMEOUT_MS,
    headers: {
      "Content-Length": String(buffer.length),
      "Content-Range": contentRange,
      "Content-Type": contentType,
    },
  });

  if (response.status === 200 || response.status === 201) {
    return { done: true, status: response.status, video: await readJson(response), offset: total };
  }

  if (response.status === 308) {
    const range = response.headers.get("range") || "";
    const match = /^bytes=(\d+)-(\d+)$/.exec(range.trim());
    const offset = match ? Number(match[2]) + 1 : start;
    return { done: false, status: 308, offset, video: null };
  }

  const body = await readJson(response);
  if (response.status === 404) {
    // Sessão expirada/invalidada: o chamador deve recriá-la.
    throw new YouTubeError("A sessão de upload expirou. O envio será reiniciado.", {
      code: "sessionExpired",
      status: 404,
      retryable: true,
    });
  }
  throw toYouTubeError(response.status, body, "Falha durante o envio do vídeo.");
}

/**
 * Pergunta ao Google quantos bytes da sessão já foram recebidos
 * (`Content-Range: bytes * /total`). Usado para retomar após queda de conexão.
 */
async function querySessionOffset(sessionUri, total) {
  const response = await request(sessionUri, {
    method: "PUT",
    body: Buffer.alloc(0),
    timeout: DEFAULT_TIMEOUT_MS,
    headers: {
      "Content-Length": "0",
      "Content-Range": `bytes */${total}`,
    },
  });

  if (response.status === 200 || response.status === 201) {
    return { done: true, offset: total, video: await readJson(response) };
  }
  if (response.status === 308) {
    const range = response.headers.get("range") || "";
    const match = /^bytes=(\d+)-(\d+)$/.exec(range.trim());
    return { done: false, offset: match ? Number(match[2]) + 1 : 0, video: null };
  }
  if (response.status === 404) {
    throw new YouTubeError("A sessão de upload expirou. O envio será reiniciado.", {
      code: "sessionExpired",
      status: 404,
      retryable: true,
    });
  }
  const body = await readJson(response);
  throw toYouTubeError(response.status, body, "Não foi possível retomar o upload.");
}

/* ── pós-upload ─────────────────────────────────────────────────── */

/** Define a miniatura personalizada (requer conta verificada). */
async function setThumbnail(context, videoId, buffer, contentType = "image/jpeg") {
  const cfg = config();
  const boundary = `loopsync_${crypto.randomBytes(8).toString("hex")}`;
  const parts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"id":${JSON.stringify(videoId)}}\r\n`,
    `--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Transfer-Encoding: binary\r\n\r\n`,
  ];
  const body = Buffer.concat([
    Buffer.from(parts[0], "utf8"),
    Buffer.from(parts[1], "utf8"),
    Buffer.from(buffer),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);

  const response = await apiCall(context, `${cfg.uploadBase}/thumbnails/set?uploadType=multipart&videoId=${encodeURIComponent(videoId)}`, {
    method: "POST",
    body,
    timeout: CHUNK_TIMEOUT_MS,
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
  });
  return readJson(response);
}

/** Adiciona o vídeo a uma playlist do canal. */
async function addToPlaylist(context, playlistId, videoId) {
  const cfg = config();
  const response = await apiCall(context, `${cfg.youtubeBase}/playlistItems?part=snippet`, {
    method: "POST",
    json: {
      snippet: {
        playlistId,
        resourceId: { kind: "youtube#video", videoId },
      },
    },
  });
  return readJson(response);
}

function videoUrl(videoId) {
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null;
}

module.exports = {
  YouTubeError,
  SCOPES,
  config,
  resolveRedirectUri,
  createCodeVerifier,
  createCodeChallenge,
  decodeJwt,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  getUserInfo,
  getChannel,
  listCategories,
  listPlaylists,
  getVideo,
  createUploadSession,
  uploadChunk,
  querySessionOffset,
  setThumbnail,
  addToPlaylist,
  videoUrl,
  toYouTubeError,
  friendlyMessage,
  REASON_MESSAGES,
};
