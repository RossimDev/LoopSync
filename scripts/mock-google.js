"use strict";

/**
 * ⚠️ SOMENTE PARA TESTES — não faz parte do produto.
 *
 * Servidor que imita os endpoints do Google (OAuth 2.0 + YouTube Data API v3 +
 * upload resumível) para que a suíte de validação exercite o código REAL do
 * LoopSync (troca de código com PKCE, refresh de token, sessão resumível,
 * retomada após queda, miniatura, playlist, histórico) sem depender de rede ou
 * de credenciais verdadeiras.
 *
 * Em produção o app aponta para https://accounts.google.com e
 * https://www.googleapis.com — os endpoints só mudam via variáveis de ambiente
 * dentro dos testes.
 */

const http = require("http");
const crypto = require("crypto");

function makeIdToken(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: "test", typ: "JWT" });
  const body = encode(payload);
  return `${header}.${body}.signature-de-teste`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=UTF-8",
    "Content-Length": String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, headers);
  res.end();
}

/**
 * @param {object} [options]
 * @param {number} [options.port] 0 = porta aleatória
 */
async function startMockGoogle(options = {}) {
  const state = {
    codes: new Map(), // code -> { codeChallenge, sub, email, name }
    tokens: new Map(), // access token -> { sub, email, name, refreshed }
    refreshTokens: new Set(),
    revoked: [],
    sessions: new Map(), // id -> { received, total, metadata, bytes, expired }
    videos: new Map(), // videoId -> recurso
    playlistsItems: [],
    thumbnails: [],
    calls: [],
    // controles de falha (usados pelos testes)
    failNextChunks: 0,
    failStatus: 500,
    expireSessionOnChunk: -1,
    invalidateTokenAfter: -1,
    chunkCount: 0,
    sessionCreations: 0,
    forceQuotaError: false,
    processingSucceedsAfter: 1,
    processingChecks: 0,
    channelCalls: 0,
  };

  const control = {
    failNextChunks(n, status = 500) {
      state.failNextChunks = n;
      state.failStatus = status;
    },
    expireSessionOnChunk(index) {
      state.expireSessionOnChunk = index;
    },
    invalidateTokenAfter(index) {
      state.invalidateTokenAfter = index;
    },
    forceQuotaError(value = true) {
      state.forceQuotaError = value;
    },
    processingSucceedsAfter(n) {
      state.processingSucceedsAfter = n;
      state.processingChecks = 0;
    },
    reset() {
      state.failNextChunks = 0;
      state.failStatus = 500;
      state.expireSessionOnChunk = -1;
      state.invalidateTokenAfter = -1;
      state.forceQuotaError = false;
      state.processingSucceedsAfter = 1;
      state.processingChecks = 0;
      state.chunkCount = 0;
      state.sessionCreations = 0;
    },
    state,
  };

  function finishSession(res, id, session) {
    const videoId = `vid_${crypto.randomBytes(6).toString("hex")}`;
    const resource = {
      kind: "youtube#video",
      id: videoId,
      snippet: {
        title: session.metadata.snippet.title,
        description: session.metadata.snippet.description || "",
        tags: session.metadata.snippet.tags || [],
        categoryId: session.metadata.snippet.categoryId || null,
        thumbnails: {
          default: { url: `https://example.com/${videoId}-default.jpg` },
          medium: { url: `https://example.com/${videoId}-medium.jpg` },
        },
      },
      status: {
        uploadStatus: "uploaded",
        privacyStatus: (session.metadata.status && session.metadata.status.privacyStatus) || "private",
        madeForKids: Boolean(session.metadata.status && session.metadata.status.madeForKids),
      },
      processingDetails: { processingStatus: "processing" },
      contentDetails: { duration: "PT1M30S" },
    };
    state.videos.set(videoId, resource);
    state.sessions.delete(id);
    return sendJson(res, 200, resource);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    state.calls.push(`${req.method} ${path}`);

    try {
      /* ── controles de teste ── */
      if (path === "/__control") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        if (typeof body.failNextChunks === "number") control.failNextChunks(body.failNextChunks, body.failStatus || 500);
        if (typeof body.expireSessionOnChunk === "number") control.expireSessionOnChunk(body.expireSessionOnChunk);
        if (typeof body.invalidateTokenAfter === "number") control.invalidateTokenAfter(body.invalidateTokenAfter);
        if (typeof body.forceQuotaError === "boolean") control.forceQuotaError(body.forceQuotaError);
        if (typeof body.processingSucceedsAfter === "number") control.processingSucceedsAfter(body.processingSucceedsAfter);
        if (body.reset) control.reset();
        return sendJson(res, 200, { ok: true });
      }

      if (path === "/__state") {
        return sendJson(res, 200, {
          sessions: [...state.sessions.entries()].map(([id, value]) => ({
            id,
            received: value.received,
            total: value.total,
            expired: Boolean(value.expired),
            metadata: value.metadata,
            bytes: value.bytes.length,
          })),
          videos: [...state.videos.values()],
          revoked: state.revoked,
          playlistItems: state.playlistsItems,
          thumbnails: state.thumbnails,
          calls: state.calls.slice(-60),
          chunkCount: state.chunkCount,
          sessionCreations: state.sessionCreations,
        });
      }

      /* ── OAuth 2.0: página de consentimento (auto-aprovação nos testes) ── */
      if (path === "/o/oauth2/v2/auth" && req.method === "GET") {
        const clientId = url.searchParams.get("client_id") || "";
        const redirectUri = url.searchParams.get("redirect_uri") || "";
        const state = url.searchParams.get("state") || "";
        const scope = url.searchParams.get("scope") || "";
        const challenge = url.searchParams.get("code_challenge") || "";

        if (!clientId || !redirectUri || !state) {
          return sendJson(res, 400, { error: "invalid_request", error_description: "client_id/redirect_uri/state obrigatórios" });
        }
        const code = module.exports.__issue
          ? module.exports.__issue({ codeChallenge: challenge, scope })
          : null;
        if (!code) {
          return sendJson(res, 500, { error: "mock sem emissor de código" });
        }
        const target = `${redirectUri}${redirectUri.includes("?") ? "&" : "?"}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
        const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Google (mock de teste) — Autorizar LoopSync</title>
<style>body{font-family:system-ui,sans-serif;background:#14120f;color:#f3ede2;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#1d1a15;border:1px solid #353026;border-radius:16px;padding:26px;max-width:420px;text-align:center}
button{margin-top:14px;background:#ff8a3d;border:0;color:#221204;font-weight:700;padding:12px 20px;border-radius:12px;cursor:pointer;font-size:15px}</style>
</head><body><div class="card">
<h1 style="font-size:19px">Autorizar o LoopSync</h1>
<p style="color:#a89c88;font-size:13px;line-height:1.5">Mock de teste do consentimento do Google.<br>Escopos: <code style="font-size:11px">${scope}</code></p>
<button id="approve" onclick="location.replace('${target}')">Autorizar</button>
<script>setTimeout(function(){ location.replace('${target}'); }, 250);</script>
</div></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(Buffer.byteLength(html)) });
        return res.end(html);
      }

      /* ── OAuth 2.0: token endpoint ── */
      if (path === "/token" && req.method === "POST") {
        const params = new URLSearchParams((await readBody(req)).toString("utf8"));
        const grant = params.get("grant_type");

        if (grant === "authorization_code") {
          const code = params.get("code");
          const verifier = params.get("code_verifier");
          const record = state.codes.get(code);
          if (!record) {
            return sendJson(res, 400, { error: "invalid_grant", error_description: "código inválido" });
          }
          // PKCE validado como o Google faz: sha256(verifier) == code_challenge
          const actualChallenge = crypto.createHash("sha256").update(String(verifier || "")).digest("base64url");
          const expectedChallenge = record.codeChallenge
            ? String(record.codeChallenge)
            : crypto.createHash("sha256").update(String(record.codeVerifier || "")).digest("base64url");
          if (!verifier || actualChallenge !== expectedChallenge) {
            return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE inválido" });
          }
          if (!params.get("client_secret")) {
            return sendJson(res, 400, { error: "invalid_client" });
          }
          if (params.get("redirect_uri") !== record.redirectUri && record.redirectUri) {
            return sendJson(res, 400, { error: "redirect_uri_mismatch" });
          }

          state.codes.delete(code);
          const accessToken = `ya29.test-${crypto.randomBytes(8).toString("hex")}`;
          const refreshToken = `1//test-${crypto.randomBytes(8).toString("hex")}`;
          state.tokens.set(accessToken, {
            sub: record.sub || "google-user-1",
            email: record.email || "criador@example.com",
            name: record.name || "Criador de Teste",
            refreshed: false,
          });
          state.refreshTokens.add(refreshToken);

          return sendJson(res, 200, {
            access_token: accessToken,
            expires_in: 3599,
            refresh_token: refreshToken,
            scope: record.scope || "openid https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload",
            token_type: "Bearer",
            id_token: makeIdToken({
              sub: record.sub || "google-user-1",
              email: record.email || "criador@example.com",
              name: record.name || "Criador de Teste",
              email_verified: true,
            }),
          });
        }

        if (grant === "refresh_token") {
          const refreshToken = params.get("refresh_token");
          if (!state.refreshTokens.has(refreshToken)) {
            return sendJson(res, 400, { error: "invalid_grant" });
          }
          if (!params.get("client_secret")) {
            return sendJson(res, 400, { error: "invalid_client" });
          }
          const previous = [...state.tokens.values()].pop() || {};
          const accessToken = `ya29.refreshed-${crypto.randomBytes(8).toString("hex")}`;
          state.tokens.set(accessToken, {
            sub: previous.sub || "google-user-1",
            email: previous.email || "criador@example.com",
            name: previous.name || "Criador de Teste",
            refreshed: true,
          });
          return sendJson(res, 200, {
            access_token: accessToken,
            expires_in: 3599,
            scope: previous.scope || "openid https://www.googleapis.com/auth/youtube.force-ssl",
            token_type: "Bearer",
          });
        }

        return sendJson(res, 400, { error: "unsupported_grant_type" });
      }

      if (path === "/o/oauth2/revoke" && req.method === "POST") {
        const params = new URLSearchParams((await readBody(req)).toString("utf8"));
        state.revoked.push(params.get("token"));
        return sendJson(res, 200, {});
      }

      /* ── autenticação das chamadas de API ── */
      const authHeader = req.headers.authorization || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const tokenRecord = state.tokens.get(token);

      const needsAuth =
        path.startsWith("/oauth2/") ||
        path.startsWith("/youtube/v3/") ||
        path.startsWith("/upload/youtube/v3/");

      if (needsAuth && !tokenRecord) {
        return sendJson(res, 401, {
          error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError", message: "Invalid Credentials" }] },
        });
      }

      if (path === "/oauth2/v3/userinfo") {
        return sendJson(res, 200, {
          sub: tokenRecord.sub,
          email: tokenRecord.email || "criador@example.com",
          name: tokenRecord.name || "Criador de Teste",
          picture: "https://example.com/avatar.png",
        });
      }

      if (state.forceQuotaError && needsAuth) {
        return sendJson(res, 403, {
          error: {
            code: 403,
            message: "The request cannot be completed because you have exceeded your quota.",
            errors: [{ reason: "quotaExceeded", message: "quota excedida" }],
          },
        });
      }

      /* ── YouTube Data API v3 ── */
      if (path === "/youtube/v3/channels") {
        state.channelCalls += 1;
        return sendJson(res, 200, {
          kind: "youtube#channelListResponse",
          items: [
            {
              kind: "youtube#channel",
              id: `UC_TESTE_${tokenRecord.sub.toUpperCase()}`,
              snippet: {
                title: `Canal de ${tokenRecord.name || "Teste"}`,
                description: "Canal usado nos testes",
                country: "BR",
                thumbnails: {
                  default: { url: "https://example.com/thumb-default.jpg" },
                  medium: { url: "https://example.com/thumb-medium.jpg" },
                },
              },
              contentDetails: { relatedPlaylists: { uploads: "UU_TESTE_UPLOADS" } },
              statistics: { viewCount: "12345", subscriberCount: "678", hiddenSubscriberCount: false, videoCount: "42" },
            },
          ],
        });
      }

      if (path === "/youtube/v3/videoCategories") {
        return sendJson(res, 200, {
          items: [
            { id: "10", snippet: { title: "Music", assignable: true, channelId: "UCBR8" } },
            { id: "20", snippet: { title: "Gaming", assignable: true, channelId: "UCBR8" } },
            { id: "22", snippet: { title: "People & Blogs", assignable: true, channelId: "UCBR8" } },
            { id: "24", snippet: { title: "Entertainment", assignable: true, channelId: "UCBR8" } },
            { id: "28", snippet: { title: "Science & Technology", assignable: false, channelId: "UCBR8" } },
          ],
        });
      }

      if (path === "/youtube/v3/playlists") {
        return sendJson(res, 200, {
          items: [
            {
              id: "PL_MUSICA",
              snippet: { title: "Músicas 2026", privacyStatus: "public", thumbnails: { default: { url: "https://example.com/pl1.jpg" } } },
              contentDetails: { itemCount: 12 },
            },
            {
              id: "PL_VLOGS",
              snippet: { title: "Vlogs", privacyStatus: "private", thumbnails: { default: { url: "https://example.com/pl2.jpg" } } },
              contentDetails: { itemCount: 3 },
            },
          ],
        });
      }

      if (path === "/youtube/v3/playlistItems" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        state.playlistsItems.push(body);
        return sendJson(res, 200, {
          kind: "youtube#playlistItem",
          id: `PLI_${crypto.randomBytes(4).toString("hex")}`,
          snippet: body.snippet,
        });
      }

      if (path === "/youtube/v3/videos" && req.method === "GET") {
        const id = url.searchParams.get("id");
        const video = state.videos.get(id);
        if (!video) return sendJson(res, 200, { items: [] });
        state.processingChecks += 1;
        const succeeded = state.processingChecks > state.processingSucceedsAfter;
        return sendJson(res, 200, {
          items: [
            {
              ...video,
              processingDetails: { processingStatus: succeeded ? "succeeded" : "processing" },
              status: { ...video.status, uploadStatus: succeeded ? "processed" : "uploaded" },
            },
          ],
        });
      }

      /* ── upload resumível ── */
      if (path === "/upload/youtube/v3/videos" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        if (!body.snippet || !body.snippet.title) {
          return sendJson(res, 400, { error: { code: 400, message: "missingTitle", errors: [{ reason: "missingTitle" }] } });
        }
        if (url.searchParams.get("uploadType") !== "resumable") {
          return sendJson(res, 400, { error: { code: 400, message: "uploadType inválido" } });
        }
        const id = `session_${crypto.randomBytes(8).toString("hex")}`;
        state.sessionCreations += 1;
        state.sessions.set(id, {
          received: 0,
          total: Number(req.headers["x-upload-content-length"] || 0),
          contentType: req.headers["x-upload-content-type"] || "video/mp4",
          metadata: body,
          bytes: Buffer.alloc(0),
          expired: false,
          notifySubscribers: url.searchParams.get("notifySubscribers"),
        });
        return sendEmpty(res, 200, { Location: `http://${req.headers.host}/upload-session/${id}` });
      }

      if (path === "/upload/youtube/v3/thumbnails/set" && req.method === "POST") {
        const buffer = await readBody(req);
        state.thumbnails.push({ videoId: url.searchParams.get("videoId"), bytes: buffer.length });
        return sendJson(res, 200, {
          items: [
            {
              snippet: {
                thumbnails: {
                  medium: { url: "https://example.com/custom-thumb.jpg" },
                  maxRes: { url: "https://example.com/custom-thumb-max.jpg" },
                },
              },
            },
          ],
        });
      }

      if (path.startsWith("/upload-session/")) {
        const id = path.split("/").pop();
        const session = state.sessions.get(id);
        if (!session || session.expired) {
          return sendJson(res, 404, {
            error: { code: 404, message: "Sessão expirada", errors: [{ reason: "sessionGone" }] },
          });
        }

        const buffer = await readBody(req);
        const contentRange = String(req.headers["content-range"] || "");

        // Consulta de offset: "bytes */total"
        const queryMatch = /^bytes \*\/(\d+)$/.exec(contentRange);
        if (queryMatch) {
          session.total = Number(queryMatch[1]) || session.total;
          if (session.total > 0 && session.received >= session.total) {
            return finishSession(res, id, session);
          }
          return sendEmpty(res, 308, session.received > 0 ? { Range: `bytes=0-${session.received - 1}` } : {});
        }

        const chunkMatch = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
        if (!chunkMatch) {
          return sendJson(res, 400, { error: { code: 400, message: "Content-Range inválido" } });
        }

        state.chunkCount += 1;
        const start = Number(chunkMatch[1]);
        const end = Number(chunkMatch[2]);
        const total = chunkMatch[3] === "*" ? session.total : Number(chunkMatch[3]);
        session.total = total;

        if (state.failNextChunks > 0) {
          state.failNextChunks -= 1;
          if (state.failStatus === 0) {
            req.socket.destroy(); // simula queda de conexão sem resposta
            return undefined;
          }
          return sendJson(res, state.failStatus, {
            error: {
              code: state.failStatus,
              message: "Falha simulada",
              errors: [{ reason: state.failStatus >= 500 ? "backendError" : "badRequest" }],
            },
          });
        }

        if (state.expireSessionOnChunk === state.chunkCount) {
          session.expired = true;
          return sendJson(res, 404, {
            error: { code: 404, message: "Sessão expirada", errors: [{ reason: "sessionGone" }] },
          });
        }

        if (state.invalidateTokenAfter === state.chunkCount) {
          return sendJson(res, 401, {
            error: { code: 401, message: "Token expirado", errors: [{ reason: "authError" }] },
          });
        }

        if (start !== session.received) {
          // Google responde 308 com o offset real quando há divergência
          return sendEmpty(res, 308, session.received > 0 ? { Range: `bytes=0-${session.received - 1}` } : {});
        }

        session.bytes = Buffer.concat([session.bytes, buffer]);
        session.received = end + 1;

        if (session.received >= session.total) {
          return finishSession(res, id, session);
        }
        return sendEmpty(res, 308, { Range: `bytes=0-${session.received - 1}` });
      }

      return sendJson(res, 404, {
        error: { code: 404, message: `Rota não implementada no mock: ${req.method} ${path}` },
      });
    } catch (err) {
      return sendJson(res, 500, { error: { code: 500, message: err.message } });
    }
  });

  // A página de consentimento precisa emitir códigos sem conhecer o objeto retornado.
  const issuer = {
    issue({ codeChallenge = null, sub = "google-browser", email = "browser@example.com", name = "Usuário Browser", scope = null } = {}) {
      const code = `4/test-${crypto.randomBytes(8).toString("hex")}`;
      state.codes.set(code, { codeChallenge, sub, email, name, scope });
      return code;
    },
  };
  module.exports.__issue = issuer.issue;

  const host = options.host || "127.0.0.1";
  await new Promise((resolve) => server.listen(options.port || 0, host, resolve));
  const { port } = server.address();
  const base = options.publicBase || `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

  return {
    base,
    port,
    state,
    control,
    env: {
      GOOGLE_AUTH_BASE: base,
      GOOGLE_API_BASE: base,
      YOUTUBE_API_BASE: `${base}/youtube/v3`,
      YOUTUBE_UPLOAD_BASE: `${base}/upload/youtube/v3`,
    },
    /** Emite códigos usando o perfil padrão do navegador (usado no E2E). */
    issueBrowserCode: issuer.issue,
    /** Registra um código de autorização válido (simula o consentimento do Google). */
    issueCode({ codeChallenge = null, codeVerifier = null, redirectUri = null, sub = "google-user-1", email = "criador@example.com", name = "Criador de Teste", scope = null } = {}) {
      const code = `4/test-${crypto.randomBytes(8).toString("hex")}`;
      state.codes.set(code, { codeChallenge, codeVerifier, redirectUri, sub, email, name, scope });
      return code;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startMockGoogle, makeIdToken };

if (require.main === module) {
  const port = Number(process.env.MOCK_PORT || 4000);
  const host = process.env.MOCK_HOST || "127.0.0.1";
  const publicBase = (process.env.MOCK_PUBLIC_BASE || "").trim();
  startMockGoogle({ port, host, publicBase }).then((mock) => {
    console.log(`Mock Google (somente testes) ouvindo em ${host}:${mock.port} · base ${mock.base}`);
    console.log("Controles: POST /__control · Inspeção: GET /__state");
    console.log("Google (mock):");
    for (const [key, value] of Object.entries(mock.env)) console.log(`  ${key}=${value}`);
  });
}
