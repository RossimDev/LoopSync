"use strict";

/**
 * LoopSync — rotas HTTP do módulo YouTube.
 *
 * Tudo que exige credencial Google acontece aqui (servidor). O navegador
 * recebe apenas dados públicos: nome/foto do canal, categorias, playlists,
 * biblioteca de descrições/tags, templates e o estado dos uploads.
 * Tokens, client secret e sessões OAuth nunca são expostos.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const client = require("./client");
const resumable = require("./resumable");
const { suggestTags, normalizeTags, tagsTotalLength } = require("./tags");
const { BUILTIN_TEMPLATES, CATEGORY_FALLBACK, PRIVACY_OPTIONS, resolveTemplate, titleFromFileName, formatBytes } = require("./templates");

const SESSION_COOKIE = "loopsync_session";
const PROFILE_COOKIE = "loopsync_profile";
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const THUMBNAIL_MIME = ["image/jpeg", "image/png", "image/gif", "image/bmp", "image/webp"];
const MAX_CHUNK_BYTES = Number(process.env.LOOPSYNC_YT_MAX_CHUNK_BYTES || 16 * 1024 * 1024);

/* ── helpers de cookie (sem dependência externa) ────────────────── */

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
    "HttpOnly" ,
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

function clearCookie(res, name) {
  const header = res.getHeader("Set-Cookie");
  const list = Array.isArray(header) ? header : header ? [header] : [];
  list.push(`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.setHeader("Set-Cookie", list);
}

function publicChannel(connection) {
  if (!connection) return null;
  return {
    id: connection.channelId || null,
    title: connection.channelTitle || "",
    thumbnail: connection.channelThumbnail || null,
    email: connection.email || null,
    googleUserId: connection.googleUserId || null,
    subscriberCount: connection.subscriberCount || 0,
    videoCount: connection.videoCount || 0,
    uploadsPlaylistId: connection.uploadsPlaylistId || null,
    scope: connection.scope || "",
    connectedAt: connection.createdAt || null,
    tokenExpiresAt: connection.expiresAt || null,
    status: connection.disconnectedAt ? "disconnected" : "connected",
  };
}

/* ── fábrica do router ──────────────────────────────────────────── */

/**
 * @param {object} options
 * @param {import("../store").Store} options.store
 * @param {string} options.dataDir
 * @param {(jobId: string) => ({path:string,name:string,size:number,mime:string}|null)} [options.resolveLocalFile]
 *        permite enviar direto um arquivo já gerado pelo LoopSync (sem re-upload pelo navegador)
 */
function createYouTubeRouter({ store, dataDir, resolveLocalFile = null }) {
  const router = express.Router();
  const thumbDir = path.join(dataDir, "thumbnails");
  fs.mkdirSync(thumbDir, { recursive: true });

  const chunkParser = express.raw({
    type: () => true,
    limit: MAX_CHUNK_BYTES,
  });

  /* ── dono dos dados (sessão local / perfil) ─────────────────── */

  router.use((req, res, next) => {
    try {
      const cookies = parseCookies(req);
      let session = store.getSession(cookies[SESSION_COOKIE]);

      if (!session) {
        const localId = cookies[PROFILE_COOKIE] || null;
        const profileId = store.ensureProfile(localId);
        session = store.createSession(profileId, { kind: "local" });
        setCookie(res, SESSION_COOKIE, session.id, { maxAgeDays: 30 });
        setCookie(res, PROFILE_COOKIE, profileId, { maxAgeDays: 365 });
      } else if (!cookies[PROFILE_COOKIE]) {
        setCookie(res, PROFILE_COOKIE, session.ownerId, { maxAgeDays: 365 });
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

  function connectionFor(req) {
    return store.findConnectionByOwner(req.loopsync.ownerId);
  }

  function requireConnection(req, res, next) {
    const connection = connectionFor(req);
    if (!connection) {
      return res.status(401).json({
        ok: false,
        code: "not_connected",
        error: "Conecte seu canal do YouTube para continuar.",
      });
    }
    // OBS.: nunca usar `req.ytConnection` — no Node é um alias do socket e
    // quebraria o parser de corpo (chunks de upload).
    req.ytConnection = connection;
    req.ytContext = resumable.createContext(store, connection);
    next();
  }

  function requireConfigured(req, res, next) {
    const cfg = client.config();
    if (!cfg.canExchangeCode) {
      return res.status(503).json({
        ok: false,
        code: "not_configured",
        error:
          "A integração com o YouTube ainda não foi configurada neste servidor. Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (veja a documentação em docs/YOUTUBE_SETUP.md).",
      });
    }
    next();
  }

  /* ── status / configuração pública ──────────────────────────── */

  router.get("/status", (req, res) => {
    const cfg = client.config();
    const connection = connectionFor(req);
    res.json({
      ok: true,
      serverMode: true,
      configured: cfg.configured,
      canUpload: cfg.canExchangeCode,
      redirectUri: client.resolveRedirectUri(req),
      scopes: cfg.scopes,
      connected: Boolean(connection),
      channel: publicChannel(connection),
      owner: { id: req.loopsync.ownerId, kind: req.loopsync.session.kind || "local" },
      limits: {
        title: resumable.TITLE_MAX,
        description: resumable.DESCRIPTION_MAX,
        tagsTotalChars: resumable.TAGS_TOTAL_MAX,
        maxChunkBytes: MAX_CHUNK_BYTES,
        maxFileBytes: resumable.MAX_FILE_BYTES,
        maxDurationSeconds: resumable.MAX_DURATION_SECONDS,
      },
      privacyOptions: PRIVACY_OPTIONS,
    });
  });

  /* ── OAuth 2.0 (authorization code + PKCE) ─────────────────── */

  router.get("/auth/start", requireConfigured, (req, res) => {
    const cfg = client.config();
    const redirectUri = client.resolveRedirectUri(req);
    const codeVerifier = client.createCodeVerifier();
    const state = store.createAuthState({
      codeVerifier,
      redirectUri,
      ownerId: req.loopsync.ownerId,
      sessionId: req.loopsync.session.id,
      returnTo: String(req.query.returnTo || "/#/youtube"),
    });
    const url = client.buildAuthUrl({ redirectUri, state, codeVerifier });

    if (req.query.redirect === "1") return res.redirect(url);
    res.json({ ok: true, url, clientId: cfg.clientId, redirectUri });
  });

  router.get("/auth/callback", requireConfigured, async (req, res) => {
    let returnTo = "/#/youtube";
    const finish = (status, reason, detail) => {
      const base = returnTo.split("?")[0] || "/#/youtube";
      const target = `${base}?yt=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}${
        detail ? `&detail=${encodeURIComponent(detail.slice(0, 180))}` : ""
      }`;
      res.redirect(target);
    };

    try {
      const code = String(req.query.code || "");
      const state = String(req.query.state || "");
      if (req.query.error) {
        return finish("error", String(req.query.error), String(req.query.error_description || ""));
      }
      if (!code || !state) return finish("error", "missing_code", "Resposta do Google sem código de autorização.");

      const authState = store.takeAuthState(state);
      if (!authState) return finish("error", "invalid_state", "Sessão de autorização expirada. Tente conectar novamente.");
      if (authState.returnTo) returnTo = String(authState.returnTo);

      const tokens = await client.exchangeCode({
        code,
        codeVerifier: authState.codeVerifier,
        redirectUri: authState.redirectUri,
      });

      const tempContext = {
        getAccessToken: async () => tokens.accessToken,
        refresh: async () => tokens,
      };

      let userInfo = {};
      try {
        userInfo = await client.getUserInfo(tempContext);
      } catch {
        userInfo = client.decodeJwt(tokens.idToken) || {};
      }

      const channel = await client.getChannel(tempContext);
      const googleUserId = userInfo.sub || `channel:${channel.id}`;
      const ownerId = `google_${googleUserId}`;

      // Migra a biblioteca local (criada antes da conexão) para a conta Google.
      store.migrateOwner(authState.ownerId, ownerId);
      store.ensureProfile(ownerId);

      const connection = store.upsertConnection({
        ownerId,
        googleUserId,
        email: userInfo.email || null,
        name: userInfo.name || channel.title,
        channelId: channel.id,
        channelTitle: channel.title,
        channelThumbnail: channel.thumbnail,
        channelCountry: channel.country || "",
        subscriberCount: channel.subscriberCount,
        videoCount: channel.videoCount,
        uploadsPlaylistId: channel.uploadsPlaylistId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        scope: tokens.scope,
        tokenType: tokens.tokenType,
        expiresAt: tokens.expiresAt,
      });

      const session = store.createSession(ownerId, { kind: "google", connectionId: connection.id });
      setCookie(res, SESSION_COOKIE, session.id, { maxAgeDays: 30 });
      setCookie(res, PROFILE_COOKIE, ownerId, { maxAgeDays: 365 });

      finish("connected", null, null);
    } catch (err) {
      const reason = (err && err.code) || "auth_failed";
      finish("error", reason, (err && err.message) || "Falha na autorização.");
    }
  });

  router.post("/disconnect", async (req, res) => {
    const connection = connectionFor(req);
    if (!connection) {
      return res.json({ ok: true, disconnected: false });
    }
    // Revoga no Google o que for possível (refresh token) e apaga os tokens locais.
    await client.revokeToken(connection.refreshToken || connection.accessToken);
    store.disconnect(connection.id, req.loopsync.ownerId);
    store.deleteSession(req.loopsync.session.id);
    clearCookie(res, SESSION_COOKIE);
    res.json({ ok: true, disconnected: true });
  });

  /* ── canal, categorias, playlists ───────────────────────────── */

  router.get("/channel", requireConnection, async (req, res, next) => {
    try {
      const channel = await client.getChannel(req.ytContext);
      store.update("connections", req.ytConnection.id, req.loopsync.ownerId, {
        channelTitle: channel.title,
        channelThumbnail: channel.thumbnail,
        subscriberCount: channel.subscriberCount,
        videoCount: channel.videoCount,
        uploadsPlaylistId: channel.uploadsPlaylistId,
        channelCountry: channel.country || req.ytConnection.channelCountry,
      });
      res.json({ ok: true, channel: { ...publicChannel({ ...req.ytConnection, ...channel }), ...channel } });
    } catch (err) {
      next(err);
    }
  });

  router.get("/categories", requireConnection, async (req, res, next) => {
    try {
      const region = String(req.query.region || req.ytConnection.channelCountry || "BR");
      let items;
      try {
        items = await client.listCategories(req.ytContext, region);
      } catch (err) {
        // Sem permissão/cota para categorias: usa a tabela oficial estática.
        items = CATEGORY_FALLBACK.map((item) => ({ ...item, assignable: true }));
        res.json({ ok: true, items, region, fallback: true, warning: err.message });
        return;
      }
      const assignable = items.filter((item) => item.assignable !== false);
      res.json({ ok: true, items: assignable.length ? assignable : items, region, fallback: false });
    } catch (err) {
      next(err);
    }
  });

  router.get("/playlists", requireConnection, async (req, res, next) => {
    try {
      const items = await client.listPlaylists(req.ytContext);
      res.json({ ok: true, items });
    } catch (err) {
      next(err);
    }
  });

  /* ── biblioteca de descrições ───────────────────────────────── */

  function readDescriptionPayload(body = {}) {
    const name = String(body.name || "").trim().slice(0, 80);
    const content = String(body.content || "").slice(0, resumable.DESCRIPTION_MAX + 500);
    const errors = [];
    if (!name) errors.push("Informe um nome para a descrição.");
    if (name.length > 80) errors.push("O nome da descrição pode ter no máximo 80 caracteres.");
    if (content.length > resumable.DESCRIPTION_MAX) {
      errors.push(`A descrição pode ter no máximo ${resumable.DESCRIPTION_MAX} caracteres.`);
    }
    return { ok: errors.length === 0, errors, value: { name, content } };
  }

  router.get("/descriptions", (req, res) => {
    const items = store.list("descriptions", req.loopsync.ownerId);
    res.json({ ok: true, items });
  });

  router.post("/descriptions", (req, res) => {
    const payload = readDescriptionPayload(req.body);
    if (!payload.ok) return res.status(400).json({ ok: false, error: payload.errors[0], errors: payload.errors });
    const item = store.insert("descriptions", { ownerId: req.loopsync.ownerId, ...payload.value });
    res.status(201).json({ ok: true, item });
  });

  router.put("/descriptions/:id", (req, res) => {
    const payload = readDescriptionPayload(req.body);
    if (!payload.ok) return res.status(400).json({ ok: false, error: payload.errors[0], errors: payload.errors });
    const item = store.update("descriptions", req.params.id, req.loopsync.ownerId, payload.value);
    if (!item) return res.status(404).json({ ok: false, error: "Descrição não encontrada." });
    res.json({ ok: true, item });
  });

  router.post("/descriptions/:id/duplicate", (req, res) => {
    const source = store.get("descriptions", req.params.id, req.loopsync.ownerId);
    if (!source) return res.status(404).json({ ok: false, error: "Descrição não encontrada." });
    const copy = store.insert("descriptions", {
      ownerId: req.loopsync.ownerId,
      name: `${source.name} (cópia)`.slice(0, 80),
      content: source.content,
    });
    res.status(201).json({ ok: true, item: copy });
  });

  router.delete("/descriptions/:id", (req, res) => {
    const removed = store.remove("descriptions", req.params.id, req.loopsync.ownerId);
    if (!removed) return res.status(404).json({ ok: false, error: "Descrição não encontrada." });
    res.json({ ok: true });
  });

  /* ── conjuntos de tags ──────────────────────────────────────── */

  function readTagSetPayload(body = {}) {
    const name = String(body.name || "").trim().slice(0, 80);
    const rawTags = Array.isArray(body.tags) ? body.tags : String(body.tags || "").split(",");
    const tags = normalizeTags(rawTags);
    const errors = [];
    if (!name) errors.push("Informe um nome para o conjunto de tags.");
    if (!tags.length) errors.push("Adicione pelo menos uma tag.");
    if (tagsTotalLength(tags) > resumable.TAGS_TOTAL_MAX) {
      errors.push(`As tags ultrapassam ${resumable.TAGS_TOTAL_MAX} caracteres no total.`);
    }
    return { ok: errors.length === 0, errors, value: { name, tags } };
  }

  router.get("/tagsets", (req, res) => {
    res.json({ ok: true, items: store.list("tagSets", req.loopsync.ownerId) });
  });

  router.post("/tagsets", (req, res) => {
    const payload = readTagSetPayload(req.body);
    if (!payload.ok) return res.status(400).json({ ok: false, error: payload.errors[0], errors: payload.errors });
    const item = store.insert("tagSets", { ownerId: req.loopsync.ownerId, ...payload.value });
    res.status(201).json({ ok: true, item });
  });

  router.put("/tagsets/:id", (req, res) => {
    const payload = readTagSetPayload(req.body);
    if (!payload.ok) return res.status(400).json({ ok: false, error: payload.errors[0], errors: payload.errors });
    const item = store.update("tagSets", req.params.id, req.loopsync.ownerId, payload.value);
    if (!item) return res.status(404).json({ ok: false, error: "Conjunto de tags não encontrado." });
    res.json({ ok: true, item });
  });

  router.post("/tagsets/:id/duplicate", (req, res) => {
    const source = store.get("tagSets", req.params.id, req.loopsync.ownerId);
    if (!source) return res.status(404).json({ ok: false, error: "Conjunto de tags não encontrado." });
    const copy = store.insert("tagSets", {
      ownerId: req.loopsync.ownerId,
      name: `${source.name} (cópia)`.slice(0, 80),
      tags: [...source.tags],
    });
    res.status(201).json({ ok: true, item: copy });
  });

  router.delete("/tagsets/:id", (req, res) => {
    const removed = store.remove("tagSets", req.params.id, req.loopsync.ownerId);
    if (!removed) return res.status(404).json({ ok: false, error: "Conjunto de tags não encontrado." });
    res.json({ ok: true });
  });

  /* ── sugestões de tags ──────────────────────────────────────── */

  router.post("/tag-suggestions", (req, res) => {
    const body = req.body || {};
    const result = suggestTags({
      title: body.title || "",
      subject: body.subject || "",
      description: body.description || "",
      baseTags: Array.isArray(body.baseTags) ? body.baseTags : [],
      limit: Number(body.limit || 24),
    });
    res.json({ ok: true, ...result });
  });

  /* ── templates ──────────────────────────────────────────────── */

  router.get("/templates", (req, res) => {
    const stored = store.list("templates", req.loopsync.ownerId);
    const personal = stored.filter((item) => item.ownerId === req.loopsync.ownerId);
    if (!stored.some((item) => item.builtin)) {
      // Semeia os templates padrão na primeira execução.
      for (const template of BUILTIN_TEMPLATES) {
        if (!stored.some((item) => item.id === template.id)) {
          store.insert("templates", { ...template, builtin: true, ownerId: null, createdAt: template.createdAt });
        }
      }
    }
    const items = [...store.list("templates", req.loopsync.ownerId)].sort((a, b) => {
      if (Boolean(a.builtin) !== Boolean(b.builtin)) return a.builtin ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });
    res.json({ ok: true, items, personal });
  });

  router.post("/templates", (req, res) => {
    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ ok: false, error: "Informe um nome para o template." });
    const item = store.insert("templates", {
      ownerId: req.loopsync.ownerId,
      builtin: false,
      name,
      description: String(body.description || "Template pessoal").slice(0, 200),
      titlePattern: String(body.titlePattern || body.title || "").slice(0, 150),
      descriptionTemplate: String(body.descriptionTemplate || body.description || "").slice(0, resumable.DESCRIPTION_MAX),
      tags: normalizeTags(body.tags || []),
      categoryId: body.categoryId ? String(body.categoryId) : null,
      privacyStatus: ["public", "unlisted", "private"].includes(body.privacyStatus) ? body.privacyStatus : "private",
      playlistId: body.playlistId || null,
      madeForKids: Boolean(body.madeForKids),
      language: body.language || "pt-BR",
      notifySubscribers: Boolean(body.notifySubscribers),
    });
    res.status(201).json({ ok: true, item });
  });

  router.delete("/templates/:id", (req, res) => {
    const removed = store.remove("templates", req.params.id, req.loopsync.ownerId);
    if (!removed) return res.status(404).json({ ok: false, error: "Template não encontrado (templates padrão não podem ser apagados)." });
    res.json({ ok: true });
  });

  router.post("/templates/:id/resolve", (req, res) => {
    const template = store.get("templates", req.params.id, req.loopsync.ownerId);
    if (!template) return res.status(404).json({ ok: false, error: "Template não encontrado." });
    const body = req.body || {};
    const resolved = resolveTemplate(template, {
      fileName: body.fileName || "",
      title: body.title || "",
      duration: body.duration,
      fileSize: body.fileSize,
      channelTitle: body.channelTitle || (connectionFor(req) || {}).channelTitle || "",
    });
    res.json({ ok: true, template: resolved });
  });

  /* ── uploads ────────────────────────────────────────────────── */

  function loadThumbnailBuffer(job) {
    if (job.thumbnailBuffer && job.thumbnailBuffer.length) return;
    if (!job.thumbnailPath) return;
    try {
      job.thumbnailBuffer = fs.readFileSync(job.thumbnailPath);
    } catch {
      job.thumbnailBuffer = null;
    }
  }

  router.post("/uploads", requireConnection, async (req, res, next) => {
    try {
      const body = { ...(req.body || {}) };

      // Origem local: resultado já processado pelo LoopSync no servidor.
      let source = null;
      if (body.source && body.source.jobId) {
        if (typeof resolveLocalFile !== "function") {
          return res.status(400).json({ ok: false, error: "Este servidor não permite enviar arquivos gerados localmente." });
        }
        source = resolveLocalFile(String(body.source.jobId));
        if (!source) {
          return res.status(404).json({
            ok: false,
            code: "source_missing",
            error: "O vídeo gerado pelo LoopSync não está mais disponível. Gere novamente ou selecione um arquivo.",
          });
        }
        body.fileName = source.name;
        body.fileSize = source.size;
        body.contentType = source.mime || "video/mp4";
        body.duration = body.duration || source.duration || 0;
      }

      const validation = resumable.validateMetadata(body);
      if (!validation.ok) {
        return res.status(400).json({ ok: false, error: validation.errors[0].message, errors: validation.errors });
      }
      const meta = validation.value;
      const connection = req.ytConnection;
      const playlist = body.playlistTitle || null;
      const category = body.categoryTitle || null;

      const job = store.insert("uploads", {
        ownerId: req.loopsync.ownerId,
        connectionId: connection.id,
        sourcePath: source ? source.path : null,
        sourceJobId: source ? String(body.source.jobId) : null,
        channelId: connection.channelId,
        channelTitle: connection.channelTitle,
        fileName: String(body.fileName || "video.mp4").slice(0, 240),
        fileSize: Number(body.fileSize || 0),
        contentType: String(body.contentType || "video/mp4").slice(0, 80),
        duration: Number(body.duration || 0) || null,
        ...meta,
        playlistTitle: playlist,
        categoryTitle: category,
        templateId: body.templateId || null,
        templateName: body.templateName || null,
        descriptionSourceId: body.descriptionSourceId || null,
        tagSetSourceIds: Array.isArray(body.tagSetSourceIds) ? body.tagSetSourceIds : [],
        status: "queued",
        progress: 0,
        received: 0,
        attempts: 0,
        batchId: body.batchId || null,
      });

      res.status(201).json({ ok: true, upload: resumable.publicJob(job, { includeInternal: true }) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/uploads/:id", requireConnection, async (req, res, next) => {
    try {
      const job = store.get("uploads", req.params.id, req.loopsync.ownerId);
      if (!job) return res.status(404).json({ ok: false, error: "Upload não encontrado." });
      if (job.status === "processing") {
        await resumable.refreshVideoStatus(store, job, req.ytContext);
      }
      res.json({ ok: true, upload: resumable.publicJob(job, { includeInternal: true }) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/uploads", (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 30)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const status = req.query.status ? String(req.query.status) : null;
    const all = store.list("uploads", req.loopsync.ownerId).filter((item) => !status || item.status === status);
    const items = all.slice(offset, offset + limit).map((item) => resumable.publicJob(item));
    res.json({ ok: true, items, total: all.length, limit, offset });
  });

  router.put("/uploads/:id/chunk", requireConnection, chunkParser, async (req, res, next) => {
    try {
      const job = store.get("uploads", req.params.id, req.loopsync.ownerId);
      if (!job) return res.status(404).json({ ok: false, error: "Upload não encontrado." });
      if (job.status === "cancelled") {
        return res.status(409).json({ ok: false, code: "cancelled", error: "Este upload foi cancelado." });
      }

      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
      if (!buffer.length) return res.status(400).json({ ok: false, error: "Bloco vazio." });

      const offset = Number(req.query.offset != null ? req.query.offset : req.headers["x-upload-offset"] || 0);
      const total = Number(req.query.total || job.fileSize);
      loadThumbnailBuffer(job);

      const result = await resumable.pushChunk(store, job, req.ytContext, buffer, offset, { chunkTotal: total });
      const fresh = store.get("uploads", job.id, req.loopsync.ownerId) || job;
      res.json({
        ok: true,
        ...result,
        upload: resumable.publicJob(fresh),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Inicia o envio de um arquivo que já está no servidor (resultado do
   * LoopSync). O progresso é acompanhado por GET /uploads/:id.
   */
  router.post("/uploads/:id/pump", requireConnection, async (req, res, next) => {
    try {
      const job = store.get("uploads", req.params.id, req.loopsync.ownerId);
      if (!job) return res.status(404).json({ ok: false, error: "Upload não encontrado." });
      if (!job.sourcePath) {
        return res.status(400).json({ ok: false, error: "Este upload não tem um arquivo de origem no servidor." });
      }
      if (job.status === "done") {
        return res.json({ ok: true, alreadyDone: true, upload: resumable.publicJob(job) });
      }
      loadThumbnailBuffer(job);
      store.update("uploads", job.id, req.loopsync.ownerId, { status: "uploading", startedAt: job.startedAt || new Date().toISOString() });
      job.status = "uploading";

      // Dispara em segundo plano: o frontend acompanha por polling.
      resumable
        .pumpLocalFile(store, job, req.ytContext, {
          chunkSize: Number(req.body && req.body.chunkSize) || 5 * 1024 * 1024,
        })
        .catch((err) => {
          resumable.markError(store, job, err);
          console.error("LoopSync YouTube pump:", err.message);
        });

      res.status(202).json({ ok: true, upload: resumable.publicJob(store.get("uploads", job.id, req.loopsync.ownerId) || job) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/uploads/:id/resume", requireConnection, async (req, res, next) => {
    try {
      const job = store.get("uploads", req.params.id, req.loopsync.ownerId);
      if (!job) return res.status(404).json({ ok: false, error: "Upload não encontrado." });
      if (job.status === "done") {
        return res.json({ ok: true, received: job.fileSize, done: true, upload: resumable.publicJob(job) });
      }
      const total = Number(job.fileSize);
      let synced;
      try {
        synced = await resumable.syncOffset(store, job, req.ytContext, total);
      } catch (err) {
        if (err && err.code === "sessionExpired") synced = { received: 0, done: false, restarted: true };
        else throw err;
      }
      store.update("uploads", job.id, req.loopsync.ownerId, { status: job.status === "error" ? "queued" : job.status, error: null });
      res.json({
        ok: true,
        received: synced.received,
        done: Boolean(synced.done),
        restarted: Boolean(synced.restarted),
        upload: resumable.publicJob(store.get("uploads", job.id, req.loopsync.ownerId) || job, { includeInternal: true }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/uploads/:id/cancel", requireConnection, async (req, res, next) => {
    try {
      const job = store.get("uploads", req.params.id, req.loopsync.ownerId);
      if (!job) return res.status(404).json({ ok: false, error: "Upload não encontrado." });
      store.update("uploads", job.id, req.loopsync.ownerId, {
        status: "cancelled",
        sessionUri: null,
        sessionExpiresAt: null,
        error: null,
        cancelledAt: new Date().toISOString(),
      });
      res.json({ ok: true, upload: resumable.publicJob(store.get("uploads", job.id, req.loopsync.ownerId)) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/uploads/:id/thumbnail", requireConnection, express.json({ limit: "6mb" }), async (req, res, next) => {
    try {
      const job = store.get("uploads", req.params.id, req.loopsync.ownerId);
      if (!job) return res.status(404).json({ ok: false, error: "Upload não encontrado." });

      const mime = String((req.body && req.body.mime) || "image/jpeg");
      const data = String((req.body && req.body.dataBase64) || "");
      if (!THUMBNAIL_MIME.includes(mime)) {
        return res.status(400).json({ ok: false, error: "Formato de miniatura não suportado. Use JPG, PNG, GIF, BMP ou WEBP." });
      }
      let buffer;
      try {
        buffer = Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64");
      } catch {
        return res.status(400).json({ ok: false, error: "Não foi possível ler a imagem da miniatura." });
      }
      if (!buffer.length) return res.status(400).json({ ok: false, error: "Arquivo de miniatura vazio." });
      if (buffer.length > MAX_THUMBNAIL_BYTES) {
        return res.status(413).json({ ok: false, error: "A miniatura deve ter no máximo 2 MB." });
      }

      const file = path.join(thumbDir, `${job.id}-${crypto.randomBytes(4).toString("hex")}.img`);
      fs.writeFileSync(file, buffer);
      store.update("uploads", job.id, req.loopsync.ownerId, {
        thumbnailPath: file,
        thumbnailMime: mime,
        thumbnailSize: buffer.length,
        thumbnailApplied: false,
        thumbnailError: null,
      });
      job.thumbnailPath = file;
      job.thumbnailBuffer = buffer;
      job.thumbnailMime = mime;

      if (job.videoId) {
        // Vídeo já existe: aplica imediatamente.
        try {
          await client.setThumbnail(req.ytContext, job.videoId, buffer, mime);
          store.update("uploads", job.id, req.loopsync.ownerId, { thumbnailApplied: true, thumbnailError: null });
        } catch (err) {
          store.update("uploads", job.id, req.loopsync.ownerId, { thumbnailApplied: false, thumbnailError: err.message });
          return res.json({ ok: true, applied: false, warning: err.message });
        }
      }
      res.json({ ok: true, applied: Boolean(job.videoId), stored: !job.videoId, bytes: buffer.length });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/uploads/:id", (req, res) => {
    const job = store.get("uploads", req.params.id, req.loopsync.ownerId);
    if (!job) return res.status(404).json({ ok: false, error: "Upload não encontrado." });
    if (job.thumbnailPath) {
      try { fs.unlinkSync(job.thumbnailPath); } catch { /* ignore */ }
    }
    store.remove("uploads", req.params.id, req.loopsync.ownerId);
    res.json({ ok: true });
  });

  /* ── utilidades ─────────────────────────────────────────────── */

  router.post("/validate-tags", (req, res) => {
    const tags = normalizeTags((req.body && req.body.tags) || []);
    res.json({ ok: true, tags, totalChars: tagsTotalLength(tags), maxTotalChars: resumable.TAGS_TOTAL_MAX });
  });

  router.get("/title-from-file", (req, res) => {
    res.json({ ok: true, title: titleFromFileName(String(req.query.name || "")) });
  });

  router.post("/format-bytes", (req, res) => {
    res.json({ ok: true, value: formatBytes(Number((req.body && req.body.bytes) || 0)) });
  });

  /* ── erros ─────────────────────────────────────────────────── */

  router.use((err, req, res, _next) => {
    if (res.headersSent) return;
    const status = err && err.status ? err.status : err instanceof client.YouTubeError ? err.status || 502 : 500;
    const payload = {
      ok: false,
      code: (err && err.code) || "error",
      error: (err && err.message) || "Erro inesperado no módulo YouTube.",
      retryable: Boolean(err && err.retryable),
    };
    if (err && err.details) payload.details = err.details;
    if (status >= 500 && !(err instanceof client.YouTubeError)) {
      console.error("LoopSync YouTube:", err);
    }
    res.status(status || 500).json(payload);
  });

  return router;
}

module.exports = {
  createYouTubeRouter,
  parseCookies,
  SESSION_COOKIE,
  PROFILE_COOKIE,
  THUMBNAIL_MIME,
  MAX_THUMBNAIL_BYTES,
};
