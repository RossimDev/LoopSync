"use strict";

/**
 * Validação automatizada do módulo YouTube do LoopSync.
 *
 * Sobe o servidor REAL do LoopSync (server.js) apontando para um mock local
 * dos endpoints do Google (scripts/mock-google.js — apenas para testes) e
 * exercita todo o fluxo: OAuth 2.0 + PKCE, conexão/desconexão, isolamento por
 * usuário, bibliotecas de descrições e tags, templates, sugestões de tags,
 * upload resumível (com queda de conexão, sessão expirada, token expirado,
 * erro 5xx e cota), envio em lote, envio direto do resultado do LoopSync,
 * miniatura, playlist, histórico e segurança (nenhum token vaza para o cliente).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const { startMockGoogle } = require("./mock-google");
const { createVideo, createAudio } = require("./make-test-assets");

const ROOT = path.join(__dirname, "..");
const CLIENT_ID = "1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-secret-de-teste";

/* ── harness ────────────────────────────────────────────────────── */

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertiva falhou");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "valores diferentes"} — esperado: ${JSON.stringify(expected)}, recebido: ${JSON.stringify(actual)}`);
  }
}

async function test(name, fn) {
  const label = `${currentGroup ? `${currentGroup} · ` : ""}${name}`;
  const started = Date.now();
  try {
    await fn();
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);
    results.push({ label, ok: true, elapsed });
    process.stdout.write(`  ✓ ${label} (${elapsed}s)\n`);
  } catch (err) {
    results.push({ label, ok: false, error: err.message });
    process.stdout.write(`  ✗ ${label}\n      → ${err.message}\n`);
    if (process.env.GITHUB_ACTIONS === "true") {
      process.stdout.write(`::error::${label} — ${String(err.message).split("\n")[0]}\n`);
    }
  }
}

/* ── cliente HTTP com cookie jar ────────────────────────────────── */

function createClient(baseUrl, { name = "client" } = {}) {
  const jar = new Map();
  const responses = [];

  const cookieHeader = () => [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");

  async function call(method, urlPath, { body, raw, headers = {}, redirect = "manual" } = {}) {
    const finalHeaders = { ...headers };
    if (jar.size) finalHeaders.Cookie = cookieHeader();
    let payload;
    if (raw !== undefined) {
      payload = raw;
      finalHeaders["Content-Type"] = finalHeaders["Content-Type"] || "application/octet-stream";
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      finalHeaders["Content-Type"] = "application/json";
    }

    const response = await fetch(`${baseUrl}${urlPath}`, { method, headers: finalHeaders, body: payload, redirect });
    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === "" || /Max-Age=0/i.test(cookie)) jar.delete(key);
      else jar.set(key, value);
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const record = {
      name,
      method,
      urlPath,
      status: response.status,
      setCookies,
      location: response.headers.get("location"),
      text,
      json,
    };
    responses.push(record);
    return record;
  }

  return {
    name,
    jar,
    responses,
    get: (p, options) => call("GET", p, options),
    post: (p, body, options) => call("POST", p, { ...options, body }),
    put: (p, body, options) => call("PUT", p, { ...options, body }),
    putRaw: (p, raw, options) => call("PUT", p, { ...options, raw }),
    del: (p, options) => call("DELETE", p, options),
  };
}

/* ── sobe o servidor do LoopSync ────────────────────────────────── */

function startLoopSync({ env, dataDir }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: "0",
        LOOPSYNC_DATA_DIR: dataDir,
        LOOPSYNC_YT_STATUS_POLL_MS: "400",
        GOOGLE_CLIENT_ID: CLIENT_ID,
        GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Servidor não iniciou em 20s.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 20000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolve({
          child,
          port: Number(match[1]),
          baseUrl: `http://127.0.0.1:${match[1]}`,
          logs: () => stdout + stderr,
          stop: () =>
            new Promise((done) => {
              child.once("exit", () => done());
              child.kill("SIGTERM");
              setTimeout(() => {
                try { child.kill("SIGKILL"); } catch { /* ignore */ }
                done();
              }, 3000);
            }),
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (!stdout.includes("listening on")) {
        reject(new Error(`Servidor terminou com código ${code}.\nstderr: ${stderr}`));
      }
    });
  });
}

/* ── fluxo OAuth completo (como o navegador faria) ──────────────── */

async function connectChannel(mock, client, options = {}) {
  const start = await client.get(`/api/youtube/auth/start?returnTo=${encodeURIComponent(options.returnTo || "/#/youtube")}`);
  assertEqual(start.status, 200, "auth/start deve responder 200");
  assert(start.json && start.json.url, "auth/start deve devolver a URL de autorização");

  const url = new URL(start.json.url);
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  const code = mock.issueCode({
    codeChallenge: challenge,
    sub: options.sub,
    email: options.email,
    name: options.name,
  });

  const callback = await client.get(
    `/api/youtube/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
  );
  return { start, url, state, challenge, code, callback };
}

async function pollUpload(client, uploadId, { timeoutMs = 30000 } = {}) {
  const started = Date.now();
  let last = null;
  for (;;) {
    const res = await client.get(`/api/youtube/uploads/${uploadId}`);
    assertEqual(res.status, 200, "GET upload deve responder 200");
    last = res.json.upload;
    if (["done", "error", "cancelled"].includes(last.status)) return last;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Tempo esgotado aguardando conclusão do upload (status=${last.status}, progress=${last.progress})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
}

function fakeVideoBuffer(size) {
  const buffer = Buffer.alloc(size);
  // conteúdo determinístico e não-trivial (o mock apenas acumula os bytes)
  for (let i = 0; i < size; i += 1) buffer[i] = (i * 37 + 11) % 251;
  return buffer;
}

async function sendInChunks(client, uploadId, buffer, chunkSize, { onChunk, stopAfter, startOffset = 0 } = {}) {
  let offset = startOffset;
  let index = 0;
  let resyncs = 0;
  const sent = [];
  while (offset < buffer.length) {
    if (stopAfter != null && index >= stopAfter) break;
    if (resyncs > 20) throw new Error("muitos resync seguidos — possível loop");
    const end = Math.min(offset + chunkSize, buffer.length);
    const slice = buffer.subarray(offset, end);
    const res = await client.putRaw(`/api/youtube/uploads/${uploadId}/chunk?offset=${offset}&total=${buffer.length}`, slice);
    sent.push({ offset, status: res.status, json: res.json });
    if (onChunk) onChunk(res, index);
    if (res.status === 200 && res.json && res.json.resync) {
      offset = Number(res.json.received || 0);
      index += 1;
      resyncs += 1;
      continue;
    }
    if (res.status !== 200) {
      throw new Error(`Falha no bloco ${index} (offset ${offset}): HTTP ${res.status} ${res.json && res.json.error}`);
    }
    offset = Number(res.json.received != null ? res.json.received : end);
    index += 1;
    if (res.json.done) return { done: true, offset, sent, chunks: index };
  }
  return { done: false, offset, sent, chunks: index };
}

/* ── main ───────────────────────────────────────────────────────── */

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsync-yt-"));
  const dataDirA = path.join(workDir, "data-a");
  const dataDirNoCreds = path.join(workDir, "data-nocreds");
  fs.mkdirSync(dataDirA, { recursive: true });
  fs.mkdirSync(dataDirNoCreds, { recursive: true });

  console.log("Subindo mock dos endpoints do Google (uso exclusivo de testes)…");
  const mock = await startMockGoogle({ port: 0 });

  console.log(`Subindo o servidor do LoopSync (dados em ${dataDirA})…`);
  const server = await startLoopSync({ env: mock.env, dataDir: dataDirA });
  const base = server.baseUrl;
  console.log(`LoopSync em ${base}\n`);

  const alice = createClient(base, { name: "alice" });
  const bob = createClient(base, { name: "bob" });
  const anonymous = createClient(base, { name: "anon" });

  const videoBuffer = fakeVideoBuffer(6 * 1024 * 1024); // 6 MB
  const thumbBuffer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), fakeVideoBuffer(48 * 1024)]);

  try {
    /* ═══════════ 1. CONFIGURAÇÃO E SEGURANÇA ═══════════ */
    group("Configuração");

    await test("health reporta modo servidor", async () => {
      const res = await alice.get("/health");
      assertEqual(res.status, 200);
      assertEqual(res.json.service, "loopsync");
      assertEqual(res.json.youtube.serverMode, true);
      assertEqual(res.json.youtube.configured, true);
    });

    await test("status público expõe configuração sem segredos", async () => {
      const res = await alice.get("/api/youtube/status");
      assertEqual(res.status, 200);
      assertEqual(res.json.configured, true);
      assertEqual(res.json.canUpload, true);
      assertEqual(res.json.connected, false);
      assertEqual(res.json.limits.title, 100);
      assertEqual(res.json.limits.description, 5000);
      assertEqual(res.json.limits.tagsTotalChars, 500);
      assert(res.json.redirectUri.endsWith("/api/youtube/auth/callback"), "redirect URI incorreto");
      assert(!res.text.includes(CLIENT_SECRET), "client secret vazou no status");
      assert(!res.text.includes("accessToken"), "campo de token vazou no status");
    });

    await test("biblioteca funciona antes de conectar (perfil local)", async () => {
      const created = await alice.post("/api/youtube/descriptions", { name: "Descrição pré-conexão", content: "Feita antes de conectar o canal." });
      assertEqual(created.status, 201, "deve criar descrição sem canal conectado");
      const list = await alice.get("/api/youtube/descriptions");
      assertEqual(list.json.items.length, 1);
    });

    await test("rotas de canal exigem conexão", async () => {
      const res = await anonymous.get("/api/youtube/channel");
      assertEqual(res.status, 401);
      assertEqual(res.json.code, "not_connected");
      const playlists = await anonymous.get("/api/youtube/playlists");
      assertEqual(playlists.status, 401);
    });

    /* ═══════════ 2. OAUTH 2.0 ═══════════ */
    group("OAuth 2.0");

    await test("URL de autorização usa code + PKCE(S256) + state + escopos oficiais", async () => {
      const res = await alice.get("/api/youtube/auth/start");
      const url = new URL(res.json.url);
      assertEqual(url.origin, mock.base, "deve apontar para o endpoint de auth configurado");
      assertEqual(url.pathname, "/o/oauth2/v2/auth");
      assertEqual(url.searchParams.get("client_id"), CLIENT_ID);
      assertEqual(url.searchParams.get("response_type"), "code");
      assertEqual(url.searchParams.get("code_challenge_method"), "S256");
      assertEqual(url.searchParams.get("access_type"), "offline");
      assert(url.searchParams.get("code_challenge").length >= 40, "code_challenge ausente");
      assert(url.searchParams.get("state").length >= 20, "state ausente");
      const scope = url.searchParams.get("scope");
      assert(scope.includes("https://www.googleapis.com/auth/youtube.force-ssl"), "escopo force-ssl ausente");
      assert(scope.includes("https://www.googleapis.com/auth/youtube.upload"), "escopo upload ausente");
      assert(scope.includes("https://www.googleapis.com/auth/youtube.readonly"), "escopo readonly ausente");
      assert(scope.includes("openid"), "escopo openid ausente");
      assert(!res.text.includes(CLIENT_SECRET), "client secret não pode sair do servidor");
    });

    await test("callback com state inválido é recusado", async () => {
      const res = await alice.get("/api/youtube/auth/callback?code=abc&state=estado-falso");
      assertEqual(res.status, 302);
      assert(res.location.includes("yt=error"), `redirect inesperado: ${res.location}`);
      assert(res.location.includes("reason=invalid_state"), `motivo ausente: ${res.location}`);
    });

    await test("callback com PKCE inválido não gera conexão", async () => {
      const start = await alice.get("/api/youtube/auth/start");
      const url = new URL(start.json.url);
      const code = mock.issueCode({ codeChallenge: crypto.createHash("sha256").update("verifier-errado").digest("base64url") });
      const res = await alice.get(`/api/youtube/auth/callback?code=${encodeURIComponent(code)}&state=${url.searchParams.get("state")}`);
      assertEqual(res.status, 302);
      assert(res.location.includes("yt=error"), "deve reportar erro");
      const status = await alice.get("/api/youtube/status");
      assertEqual(status.json.connected, false, "não deve conectar com PKCE inválido");
    });

    await test("usuário cancelando no Google não quebra o app", async () => {
      const res = await alice.get("/api/youtube/auth/callback?error=access_denied&state=x");
      assertEqual(res.status, 302);
      assert(res.location.includes("reason=access_denied"));
    });

    await test("conexão completa: canal conectado e cookie HttpOnly", async () => {
      const flow = await connectChannel(mock, alice, { sub: "google-alice", email: "alice@example.com", name: "Teste LoopSync" });
      assertEqual(flow.callback.status, 302, "callback deve redirecionar");
      assert(flow.callback.location.includes("yt=connected"), `redirect inesperado: ${flow.callback.location}`);
      assert(!flow.callback.location.includes("ya29."), "token não pode aparecer na URL");
      assert(!flow.callback.location.includes("access_token"), "access_token não pode aparecer na URL");

      const sessionCookie = flow.callback.setCookies.find((cookie) => cookie.startsWith("loopsync_session="));
      assert(sessionCookie, "cookie de sessão não foi definido");
      assert(/HttpOnly/i.test(sessionCookie), "cookie de sessão deve ser HttpOnly");
      assert(/SameSite=Lax/i.test(sessionCookie), "cookie deve ter SameSite");

      const status = await alice.get("/api/youtube/status");
      assertEqual(status.json.connected, true);
      assertEqual(status.json.channel.title, "Canal de Teste LoopSync");
      assertEqual(status.json.channel.email, "alice@example.com");
      assert(status.json.channel.thumbnail, "foto do canal ausente");
      assert(!status.text.includes("ya29."), "access token vazou para o frontend");
      assert(!status.text.includes("1//test-"), "refresh token vazou para o frontend");
      assert(!status.text.includes(CLIENT_SECRET), "client secret vazou para o frontend");
    });

    await test("dados criados antes da conexão foram migrados para a conta Google", async () => {
      const list = await alice.get("/api/youtube/descriptions");
      assertEqual(list.json.items.length, 1, "descrição do perfil local deveria migrar");
      assertEqual(list.json.items[0].name, "Descrição pré-conexão");
    });

    /* ═══════════ 3. CANAL, CATEGORIAS, PLAYLISTS ═══════════ */
    group("Dados do canal");

    await test("canal: nome, foto, inscritos e vídeos", async () => {
      const res = await alice.get("/api/youtube/channel");
      assertEqual(res.status, 200);
      assertEqual(res.json.channel.id, "UC_TESTE_GOOGLE-ALICE");
      assertEqual(res.json.channel.title, "Canal de Teste LoopSync");
      assertEqual(res.json.channel.subscriberCount, 678);
      assertEqual(res.json.channel.videoCount, 42);
      assert(!res.text.includes("ya29."), "token vazou na resposta do canal");
    });

    await test("categorias vêm da API (somente as atribuíveis)", async () => {
      const res = await alice.get("/api/youtube/categories");
      assertEqual(res.status, 200);
      const titles = res.json.items.map((item) => item.title);
      assert(titles.includes("Music"), "categoria Music ausente");
      assert(titles.includes("Gaming"), "categoria Gaming ausente");
      assert(!titles.includes("Science & Technology"), "categoria não-atribuível deveria ser filtrada");
      assertEqual(res.json.fallback, false);
    });

    await test("playlists do canal conectado", async () => {
      const res = await alice.get("/api/youtube/playlists");
      assertEqual(res.status, 200);
      assertEqual(res.json.items.length, 2);
      assertEqual(res.json.items[0].id, "PL_MUSICA");
      assertEqual(res.json.items[0].itemCount, 12);
    });

    /* ═══════════ 4. BIBLIOTECAS ═══════════ */
    group("Bibliotecas");

    await test("descrições: criar, listar, editar, duplicar e excluir", async () => {
      const created = await alice.post("/api/youtube/descriptions", {
        name: "Descrição Música",
        content: "🎧 Mix gravado ao vivo.\n\n#musica #dj",
      });
      assertEqual(created.status, 201);
      const id = created.json.item.id;
      assert(created.json.item.createdAt, "createdAt ausente");
      assert(created.json.item.updatedAt, "updatedAt ausente");

      const updated = await alice.put(`/api/youtube/descriptions/${id}`, { name: "Descrição Música v2", content: "Conteúdo novo." });
      assertEqual(updated.json.item.name, "Descrição Música v2");
      assert(updated.json.item.updatedAt >= created.json.item.updatedAt, "updatedAt deveria avançar");

      const duplicated = await alice.post(`/api/youtube/descriptions/${id}/duplicate`, {});
      assertEqual(duplicated.status, 201);
      assertEqual(duplicated.json.item.name, "Descrição Música v2 (cópia)");

      const list = await alice.get("/api/youtube/descriptions");
      assert(list.json.items.length >= 3, "lista deveria ter ao menos 3 descrições");

      const removed = await alice.del(`/api/youtube/descriptions/${duplicated.json.item.id}`);
      assertEqual(removed.status, 200);
      const afterRemove = await alice.get("/api/youtube/descriptions");
      assert(!afterRemove.json.items.some((item) => item.id === duplicated.json.item.id), "descrição duplicada deveria ter sido excluída");
    });

    await test("descrições: validações (nome, tamanho)", async () => {
      const noName = await alice.post("/api/youtube/descriptions", { name: "  ", content: "x" });
      assertEqual(noName.status, 400);
      const tooLong = await alice.post("/api/youtube/descriptions", { name: "ok", content: "a".repeat(5001) });
      assertEqual(tooLong.status, 400);
    });

    await test("tags salvas: criar conjunto, normalizar e editar", async () => {
      const created = await alice.post("/api/youtube/tagsets", {
        name: "Tags Música",
        tags: ["música", "remix", "DJ", "electronic", "dance", "mix", "música", "rock, pop"],
      });
      assertEqual(created.status, 201);
      const tags = created.json.item.tags;
      assertEqual(tags.length, 8, `vírgulas devem separar tags e duplicadas somem: ${JSON.stringify(tags)}`);
      assert(tags.includes("música") && tags.includes("pop") && tags.includes("rock"), "tags esperadas ausentes");

      const updated = await alice.put(`/api/youtube/tagsets/${created.json.item.id}`, { name: "Tags Música", tags: ["música", "remix", "lofi"] });
      assertEqual(updated.json.item.tags.length, 3);

      const duplicated = await alice.post(`/api/youtube/tagsets/${created.json.item.id}/duplicate`, {});
      assertEqual(duplicated.json.item.name, "Tags Música (cópia)");
      await alice.del(`/api/youtube/tagsets/${duplicated.json.item.id}`);
    });

    await test("tags: limite oficial de 500 caracteres é respeitado", async () => {
      const many = Array.from({ length: 80 }, (_, i) => `tag-numero-${String(i).padStart(3, "0")}`);
      const res = await alice.post("/api/youtube/validate-tags", { tags: many });
      assertEqual(res.status, 200);
      const total = res.json.tags.reduce((acc, tag, index) => acc + tag.length + (index ? 1 : 0), 0);
      assert(total <= 500, `total ${total} excede 500`);
      assert(res.json.tags.length < many.length, "deveria cortar tags para caber no limite");
    });

    await test("templates padrão disponíveis e resolvem placeholders", async () => {
      const res = await alice.get("/api/youtube/templates");
      assertEqual(res.status, 200);
      assert(res.json.items.length >= 6, `templates padrão ausentes (${res.json.items.length})`);
      const names = res.json.items.map((item) => item.name);
      assert(names.includes("Música / Remix"), "template Música / Remix ausente");
      assert(names.includes("Padrão LoopSync"), "template Padrão LoopSync ausente");

      const music = res.json.items.find((item) => item.name === "Música / Remix");
      const resolved = await alice.post(`/api/youtube/templates/${music.id}/resolve`, {
        fileName: "mix_ao_vivo_2026.mp4",
        duration: 185,
        fileSize: 24 * 1024 * 1024,
        channelTitle: "Canal de Teste LoopSync",
      });
      assertEqual(resolved.status, 200);
      assertEqual(resolved.json.template.title, "Mix ao vivo 2026", `título resolvido: ${resolved.json.template.title}`);
      assert(resolved.json.template.description.includes("Canal de Teste LoopSync"), "placeholder {canal} não resolvido");
      assert(!/\{\w+\}/.test(resolved.json.template.description), "placeholder não resolvido na descrição");
      assert(resolved.json.template.tags.includes("remix"), "tags do template ausentes");
      assertEqual(resolved.json.template.categoryId, "10");
    });

    await test("templates pessoais podem ser criados e excluídos; padrão é protegido", async () => {
      const created = await alice.post("/api/youtube/templates", {
        name: "Meu template",
        titlePattern: "{titulo} (oficial)",
        descriptionTemplate: "Descrição do meu template para {arquivo}",
        tags: ["meu canal", "oficial"],
        categoryId: "22",
        privacyStatus: "unlisted",
      });
      assertEqual(created.status, 201);
      const list = await alice.get("/api/youtube/templates");
      assert(list.json.items.some((item) => item.id === created.json.item.id), "template pessoal não listado");

      const builtinDelete = await alice.del("/api/youtube/templates/tpl_musica");
      assertEqual(builtinDelete.status, 404, "template padrão não pode ser excluído");

      const removed = await alice.del(`/api/youtube/templates/${created.json.item.id}`);
      assertEqual(removed.status, 200);
    });

    /* ═══════════ 5. SUGESTÕES DE TAGS ═══════════ */
    group("Sugestões de tags");

    await test("sugestões a partir do título (música eletrônica)", async () => {
      const res = await alice.post("/api/youtube/tag-suggestions", {
        title: "Mix de música eletrônica ao vivo",
        baseTags: [],
      });
      assertEqual(res.status, 200);
      const tags = res.json.suggestions.map((item) => item.tag);
      assert(tags.length >= 8, `poucas sugestões (${tags.length})`);
      assert(tags.includes("mix"), "tag direta do título ausente");
      assert(tags.some((tag) => ["remix", "edm", "dj set", "electronic"].includes(tag)), "expansão por domínio ausente");
      assert(res.json.totalChars <= 500, "limite de caracteres violado");
    });

    await test("sugestões não repetem tags já usadas e respeitam o limite", async () => {
      const res = await alice.post("/api/youtube/tag-suggestions", {
        title: "Gameplay de corrida",
        subject: "campeonato online",
        baseTags: ["gameplay", "corrida", "games"],
      });
      const tags = res.json.suggestions.map((item) => item.tag);
      assert(!tags.includes("gameplay"), "não deveria sugerir tag já usada");
      assert(!tags.includes("corrida"), "não deveria sugerir tag já usada");
      assert(tags.length > 0, "deveria sugerir algo novo");
    });

    await test("sem título/assunto não há sugestões", async () => {
      const res = await alice.post("/api/youtube/tag-suggestions", { title: "", subject: "", baseTags: [] });
      assertEqual(res.json.suggestions.length, 0);
    });

    /* ═══════════ 6. UPLOAD RESUMÍVEL ═══════════ */
    group("Upload resumível");

    await test("validação de metadados antes de criar o upload", async () => {
      const noTitle = await alice.post("/api/youtube/uploads", { fileName: "v.mp4", fileSize: 1024, privacyStatus: "private" });
      assertEqual(noTitle.status, 400);
      assert(noTitle.json.errors.some((error) => error.field === "title"), "erro de título ausente");

      const longTitle = await alice.post("/api/youtube/uploads", {
        fileName: "v.mp4",
        fileSize: 1024,
        title: "t".repeat(101),
        privacyStatus: "private",
      });
      assertEqual(longTitle.status, 400);

      const badPrivacy = await alice.post("/api/youtube/uploads", {
        fileName: "v.mp4",
        fileSize: 1024,
        title: "ok",
        privacyStatus: "secreto",
      });
      assertEqual(badPrivacy.status, 400);

      const noFile = await alice.post("/api/youtube/uploads", { title: "ok", fileSize: 0, privacyStatus: "public" });
      assertEqual(noFile.status, 400);
    });

    await test("upload completo em blocos: sessão resumível, miniatura, playlist e conclusão", async () => {
      mock.control.reset();
      mock.control.processingSucceedsAfter(0);

      const created = await alice.post("/api/youtube/uploads", {
        fileName: "mix-eletronico.mp4",
        fileSize: videoBuffer.length,
        contentType: "video/mp4",
        duration: 185,
        title: "Mix eletrônico ao vivo — LoopSync",
        description: "Set gravado ao vivo.\n\n#musica",
        tags: ["mix", "electronic", "dj set", "ao vivo"],
        categoryId: "10",
        categoryTitle: "Music",
        privacyStatus: "unlisted",
        playlistId: "PL_MUSICA",
        playlistTitle: "Músicas 2026",
        madeForKids: false,
        language: "pt-BR",
        templateId: "tpl_musica",
        templateName: "Música / Remix",
      });
      assertEqual(created.status, 201, `criar upload falhou: ${created.text}`);
      const uploadId = created.json.upload.id;
      assertEqual(created.json.upload.status, "queued");

      const thumb = await alice.post(`/api/youtube/uploads/${uploadId}/thumbnail`, {
        mime: "image/jpeg",
        dataBase64: thumbBuffer.toString("base64"),
      });
      assertEqual(thumb.status, 200);
      assertEqual(thumb.json.stored, true, "miniatura deveria ficar guardada até o vídeo existir");

      const sent = await sendInChunks(alice, uploadId, videoBuffer, 1024 * 1024);
      assert(sent.done, `upload não terminou (offset final ${sent.offset})`);
      assertEqual(sent.chunks, 6, `deveria ter enviado 6 blocos, enviou ${sent.chunks}`);

      const final = await pollUpload(alice, uploadId);
      assertEqual(final.status, "done", `status final: ${final.status} (${final.error || ""})`);
      assertEqual(final.progress, 100);
      assert(final.videoId && final.videoId.startsWith("vid_"), `videoId inválido: ${final.videoId}`);
      assertEqual(final.videoUrl, `https://www.youtube.com/watch?v=${final.videoId}`);
      assertEqual(final.thumbnailApplied, true, `miniatura não aplicada: ${final.thumbnailError}`);
      assertEqual(final.playlistApplied, true, `playlist não aplicada: ${final.playlistError}`);
      assertEqual(final.privacyStatus, "unlisted");
      assertEqual(final.channelTitle, "Canal de Teste LoopSync");
      assert(final.completedAt, "completedAt ausente");

      const mockState = await (await fetch(`${mock.base}/__state`)).json();
      assertEqual(mockState.thumbnails.length, 1, "mock não recebeu a miniatura");
      assertEqual(mockState.playlistItems.length, 1, "mock não recebeu o playlistItems.insert");
      assertEqual(mockState.playlistItems[0].snippet.playlistId, "PL_MUSICA");
      assertEqual(mockState.playlistItems[0].snippet.resourceId.videoId, final.videoId);
      assertEqual(mockState.videos.length, 1, "mock deveria ter 1 vídeo");
      assertEqual(mockState.videos[0].snippet.tags.length, 4, "tags não foram enviadas ao YouTube");

      const history = await alice.get("/api/youtube/uploads?limit=10");
      assert(history.json.items.some((item) => item.id === uploadId), "upload ausente do histórico");
    });

    await test("histórico expõe thumbnail, título, data, status, canal, privacidade e link", async () => {
      const res = await alice.get("/api/youtube/uploads?limit=10");
      const item = res.json.items.find((upload) => upload.status === "done");
      assert(item, "nenhum upload concluído no histórico");
      assert(item.title, "título ausente");
      assert(item.createdAt, "data ausente");
      assertEqual(item.channelTitle, "Canal de Teste LoopSync");
      assert(item.privacyStatus, "privacidade ausente");
      assert(item.videoUrl && item.videoUrl.startsWith("https://www.youtube.com/watch?v="), "link ausente");
      assert(!res.text.includes("ya29."), "token vazou no histórico");
      assert(!res.text.includes("sessionUri") || !item.sessionUri, "URI de sessão não deve vazar");
    });

    await test("retomada após queda de conexão continua do offset confirmado", async () => {
      mock.control.reset();
      const created = await alice.post("/api/youtube/uploads", {
        fileName: "retomada.mp4",
        fileSize: videoBuffer.length,
        title: "Vídeo com queda de conexão",
        privacyStatus: "private",
        tags: ["teste"],
      });
      const uploadId = created.json.upload.id;

      const partial = await sendInChunks(alice, uploadId, videoBuffer, 1024 * 1024, { stopAfter: 2 });
      assertEqual(partial.done, false, "não deveria ter terminado");
      assertEqual(partial.offset, 2 * 1024 * 1024, `offset parcial: ${partial.offset}`);

      // "Conexão caiu": o cliente volta e pergunta onde parou.
      const resume = await alice.post(`/api/youtube/uploads/${uploadId}/resume`, {});
      assertEqual(resume.status, 200);
      assertEqual(resume.json.received, 2 * 1024 * 1024, "offset confirmado divergente");
      assertEqual(resume.json.restarted, false, "não deveria reiniciar a sessão");

      const rest = await sendInChunks(alice, uploadId, videoBuffer, 1024 * 1024, {
        startOffset: 2 * 1024 * 1024,
      });
      assert(rest.done, "retomada não concluiu o envio");
      assertEqual(rest.chunks, 4, `deveria enviar só os 4 blocos restantes, enviou ${rest.chunks}`);

      const final = await pollUpload(alice, uploadId);
      assertEqual(final.status, "done", `retomada não concluiu: ${final.error || final.status}`);

      const state = await (await fetch(`${mock.base}/__state`)).json();
      assertEqual(state.sessionCreations, 1, "a retomada deveria REUTILIZAR a mesma sessão resumível");
    });

    await test("erro 5xx no meio do envio é tratado com retry automático", async () => {
      mock.control.reset();
      mock.control.failNextChunks(2, 500);
      const created = await alice.post("/api/youtube/uploads", {
        fileName: "erro-5xx.mp4",
        fileSize: videoBuffer.length,
        title: "Vídeo com erro 500 no meio",
        privacyStatus: "private",
        tags: ["teste"],
      });
      const uploadId = created.json.upload.id;
      const sent = await sendInChunks(alice, uploadId, videoBuffer, 1024 * 1024);
      assert(sent.done, "upload deveria concluir mesmo com erro 5xx (retry automático)");
      const final = await pollUpload(alice, uploadId);
      assertEqual(final.status, "done");
    });

    await test("token expirado no meio do envio é renovado automaticamente", async () => {
      mock.control.reset();
      mock.control.invalidateTokenAfter(2);
      const created = await alice.post("/api/youtube/uploads", {
        fileName: "token-expirado.mp4",
        fileSize: videoBuffer.length,
        title: "Vídeo com token expirado",
        privacyStatus: "private",
        tags: ["teste"],
      });
      const uploadId = created.json.upload.id;
      const sent = await sendInChunks(alice, uploadId, videoBuffer, 1024 * 1024);
      assert(sent.done, "upload deveria concluir após refresh do token");
      const final = await pollUpload(alice, uploadId);
      assertEqual(final.status, "done");

      const status = await alice.get("/api/youtube/status");
      assertEqual(status.json.connected, true, "conexão deve continuar válida após refresh");
      assert(!status.text.includes("ya29."), "novo token vazou");
    });

    await test("sessão expirada no Google recria a sessão e reenvia do início", async () => {
      mock.control.reset();
      mock.control.expireSessionOnChunk(2);
      assertEqual((await (await fetch(`${mock.base}/__state`)).json()).sessionCreations, 0);
      const created = await alice.post("/api/youtube/uploads", {
        fileName: "sessao-expirada.mp4",
        fileSize: videoBuffer.length,
        title: "Vídeo com sessão expirada",
        privacyStatus: "private",
        tags: ["teste"],
      });
      const uploadId = created.json.upload.id;
      const sent = await sendInChunks(alice, uploadId, videoBuffer, 1024 * 1024);
      assert(sent.done, "upload deveria concluir recriando a sessão");
      const resynced = sent.sent.filter((item) => item.json && item.json.resync);
      assert(resynced.length >= 1, "servidor deveria ter pedido resync após expirar a sessão");
      assert(resynced.some((item) => item.json.restarted), "deveria sinalizar reinício da sessão");
      const final = await pollUpload(alice, uploadId);
      assertEqual(final.status, "done");
      const state = await (await fetch(`${mock.base}/__state`)).json();
      assertEqual(state.sessionCreations, 2, "sessão expirada deveria gerar uma nova sessão");
    });

    await test("cota da API esgotada gera erro amigável em português", async () => {
      mock.control.reset();
      mock.control.forceQuotaError(true);
      const created = await alice.post("/api/youtube/uploads", {
        fileName: "quota.mp4",
        fileSize: 1024 * 1024,
        title: "Vídeo que estoura a cota",
        privacyStatus: "private",
        tags: ["teste"],
      });
      // A criação não fala com o Google; o erro aparece ao abrir a sessão.
      const uploadId = created.json.upload.id;
      const chunk = await alice.putRaw(`/api/youtube/uploads/${uploadId}/chunk?offset=0&total=${1024 * 1024}`, videoBuffer.subarray(0, 1024 * 1024));
      assert(chunk.status >= 400, `deveria falhar, recebeu ${chunk.status}`);
      assert(/cota/i.test(chunk.json.error || ""), `mensagem deveria falar de cota: ${chunk.json.error}`);

      const state = await alice.get(`/api/youtube/uploads/${uploadId}`);
      assertEqual(state.json.upload.status, "error", "upload deveria ficar com status de erro");

      mock.control.forceQuotaError(false);
      const playlists = await alice.get("/api/youtube/playlists");
      assertEqual(playlists.status, 200, "deveria voltar a funcionar após a cota");
    });

    await test("offset divergente devolve resync em vez de corromper o arquivo", async () => {
      mock.control.reset();
      const created = await alice.post("/api/youtube/uploads", {
        fileName: "offset.mp4",
        fileSize: videoBuffer.length,
        title: "Vídeo com offset divergente",
        privacyStatus: "private",
        tags: ["teste"],
      });
      const uploadId = created.json.upload.id;
      await sendInChunks(alice, uploadId, videoBuffer, 1024 * 1024, { stopAfter: 1 });
      // cliente "acha" que está no offset 4MB, mas o Google só tem 1MB
      const wrong = await alice.putRaw(`/api/youtube/uploads/${uploadId}/chunk?offset=${4 * 1024 * 1024}&total=${videoBuffer.length}`, videoBuffer.subarray(0, 1024 * 1024));
      assertEqual(wrong.status, 200);
      assertEqual(wrong.json.resync, true, "deveria pedir resync");
      assert(wrong.json.received < 4 * 1024 * 1024, "received deveria ser o offset real");
      await alice.post(`/api/youtube/uploads/${uploadId}/cancel`, {});
    });

    await test("cancelamento interrompe o envio e bloqueia novos blocos", async () => {
      mock.control.reset();
      const created = await alice.post("/api/youtube/uploads", {
        fileName: "cancelado.mp4",
        fileSize: videoBuffer.length,
        title: "Vídeo cancelado",
        privacyStatus: "private",
        tags: ["teste"],
      });
      const uploadId = created.json.upload.id;
      await sendInChunks(alice, uploadId, videoBuffer, 1024 * 1024, { stopAfter: 1 });
      const cancel = await alice.post(`/api/youtube/uploads/${uploadId}/cancel`, {});
      assertEqual(cancel.json.upload.status, "cancelled");

      const chunk = await alice.putRaw(`/api/youtube/uploads/${uploadId}/chunk?offset=${1024 * 1024}&total=${videoBuffer.length}`, videoBuffer.subarray(1024 * 1024, 2 * 1024 * 1024));
      assertEqual(chunk.status, 409, "blocos após cancelamento devem ser recusados");

      const history = await alice.get("/api/youtube/uploads?status=cancelled");
      assert(history.json.items.some((item) => item.id === uploadId), "cancelado deveria aparecer no filtro do histórico");
    });

    await test("upload em lote: vários vídeos configurados e enviados individualmente", async () => {
      mock.control.reset();
      const small = fakeVideoBuffer(768 * 1024);
      const ids = [];
      for (const [index, title] of ["Vídeo 1 — lote", "Vídeo 2 — lote", "Vídeo 3 — lote"].entries()) {
        const created = await alice.post("/api/youtube/uploads", {
          fileName: `lote-${index + 1}.mp4`,
          fileSize: small.length,
          title,
          description: "Mesma descrição para o lote",
          tags: ["lote", "teste"],
          categoryId: "10",
          privacyStatus: "private",
          playlistId: "PL_MUSICA",
          batchId: "batch-teste-1",
        });
        assertEqual(created.status, 201, `lote ${index + 1} falhou`);
        ids.push(created.json.upload.id);
      }

      // fila: 1 enviando, 2 e 3 aguardando
      const before = await Promise.all(ids.map(async (id) => (await alice.get(`/api/youtube/uploads/${id}`)).json.upload.status));
      assertEqual(before[0], "queued");
      assertEqual(before[1], "queued");

      for (const id of ids) {
        const sent = await sendInChunks(alice, id, small, 256 * 1024);
        assert(sent.done, `envio do lote ${id} não concluiu`);
      }

      const finals = await Promise.all(ids.map((id) => pollUpload(alice, id)));
      for (const item of finals) assertEqual(item.status, "done", `item do lote com status ${item.status}`);
      assertEqual(new Set(finals.map((item) => item.videoId)).size, 3, "cada vídeo deveria ter seu próprio ID");
      assert(finals.every((item) => item.playlistApplied), "playlist deveria ser aplicada em todos");
    });

    await test("arquivo inválido / origem inexistente é recusado", async () => {
      const res = await alice.post("/api/youtube/uploads", {
        source: { jobId: "job-que-nao-existe" },
        title: "Vídeo de origem local",
        privacyStatus: "private",
        fileSize: 10,
      });
      assertEqual(res.status, 404);
      assertEqual(res.json.code, "source_missing");
    });

    /* ═══════════ 7. LOOPSYNC → YOUTUBE (arquivo local) ═══════════ */
    group("LoopSync → YouTube");

    await test("resultado processado pelo LoopSync é enviado direto do servidor", async () => {
      mock.control.reset();
      const assets = path.join(workDir, "assets");
      fs.mkdirSync(assets, { recursive: true });
      console.log("      (gerando mídia sintética com ffmpeg…)");
      await createVideo(path.join(assets, "v.mp4"), { duration: 3, width: 160, height: 120 });
      await createAudio(path.join(assets, "a.m4a"), { duration: 6 });

      const form = new FormData();
      form.append("video", new Blob([fs.readFileSync(path.join(assets, "v.mp4"))], { type: "video/mp4" }), "v.mp4");
      form.append("audio", new Blob([fs.readFileSync(path.join(assets, "a.m4a"))], { type: "audio/m4a" }), "a.m4a");

      const processRes = await fetch(`${base}/api/process`, { method: "POST", body: form });
      assertEqual(processRes.status, 202, "processamento do LoopSync falhou");
      const { id: jobId } = await processRes.json();

      // aguarda o ffmpeg terminar
      let job = null;
      for (let i = 0; i < 120; i += 1) {
        const status = await (await fetch(`${base}/api/process/${jobId}`)).json();
        if (status.status === "done") { job = status; break; }
        if (status.status === "error") throw new Error(`LoopSync falhou: ${status.error}`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      assert(job, "processamento não terminou a tempo");

      const created = await alice.post("/api/youtube/uploads", {
        source: { jobId },
        title: "Vídeo gerado no LoopSync",
        description: "Enviado direto do servidor, sem re-download.",
        tags: ["loopsync", "test"],
        privacyStatus: "private",
        categoryId: "10",
      });
      assertEqual(created.status, 201, `criar upload local falhou: ${created.text}`);
      const uploadId = created.json.upload.id;
      assert(created.json.upload.fileSize > 1000, "tamanho do arquivo local não foi resolvido");

      const pump = await alice.post(`/api/youtube/uploads/${uploadId}/pump`, {});
      assertEqual(pump.status, 202, `pump falhou: ${pump.text}`);

      const final = await pollUpload(alice, uploadId, { timeoutMs: 45000 });
      assertEqual(final.status, "done", `upload local não concluiu: ${final.error || final.status}`);
      assert(final.videoId, "videoId ausente no upload local");
      assertEqual(final.title, "Vídeo gerado no LoopSync");
    });

    /* ═══════════ 8. ISOLAMENTO ENTRE USUÁRIOS ═══════════ */
    group("Segurança e isolamento");

    await test("segundo usuário conecta outro canal e não vê dados do primeiro", async () => {
      await connectChannel(mock, bob, { sub: "google-bob", email: "bob@example.com", name: "Bob Canal" });
      const status = await bob.get("/api/youtube/status");
      assertEqual(status.json.connected, true);
      assertEqual(status.json.owner.id, "google_google-bob");

      const descriptions = await bob.get("/api/youtube/descriptions");
      assertEqual(descriptions.json.items.length, 0, "Bob não deveria ver descrições da Alice");

      const history = await bob.get("/api/youtube/uploads");
      assertEqual(history.json.items.length, 0, "Bob não deveria ver uploads da Alice");

      const aliceHistory = await alice.get("/api/youtube/uploads");
      assert(aliceHistory.json.items.length > 0, "Alice deveria continuar vendo os próprios uploads");
    });

    await test("IDs de outros usuários não são acessíveis diretamente", async () => {
      const aliceUploads = await alice.get("/api/youtube/uploads?limit=1");
      const uploadId = aliceUploads.json.items[0].id;
      const stolen = await bob.get(`/api/youtube/uploads/${uploadId}`);
      assertEqual(stolen.status, 404, "Bob não deveria ler upload da Alice");

      const aliceDescriptions = await alice.get("/api/youtube/descriptions");
      const descriptionId = aliceDescriptions.json.items[0].id;
      const stolenDescription = await bob.del(`/api/youtube/descriptions/${descriptionId}`);
      assertEqual(stolenDescription.status, 404, "Bob não deveria excluir descrição da Alice");

      const stillThere = await alice.get("/api/youtube/descriptions");
      assert(stillThere.json.items.some((item) => item.id === descriptionId), "descrição da Alice deveria continuar existindo");
    });

    await test("nenhum token ou segredo aparece em qualquer resposta da API", async () => {
      const secrets = [CLIENT_SECRET, "ya29.", "1//test-"];
      const all = [...alice.responses, ...bob.responses, ...anonymous.responses];
      assert(all.length > 30, "poucas respostas coletadas para auditoria");
      for (const response of all) {
        for (const secret of secrets) {
          assert(!response.text.includes(secret), `segredo "${secret}" vazou em ${response.method} ${response.urlPath}`);
        }
      }
      const locations = all.map((response) => response.location).filter(Boolean);
      for (const location of locations) {
        assert(!/access_token=/.test(location), `access_token em redirect: ${location}`);
      }
    });

    await test("banco local não guarda senha e mantém tokens só no servidor", async () => {
      const storeFile = path.join(dataDirA, "loopsync-store.json");
      assert(fs.existsSync(storeFile), "banco local não foi criado");
      const raw = fs.readFileSync(storeFile, "utf8");
      assert(!/password|senha/i.test(raw), "banco não deve conter senhas");
      assert(!raw.includes(CLIENT_SECRET), "client secret não pode ser gravado no banco");
      assert(raw.includes("refreshToken"), "refresh token deveria existir apenas no banco do servidor");
    });

    await test("desconexão revoga o token no Google e apaga as credenciais", async () => {
      const before = await bob.get("/api/youtube/status");
      assertEqual(before.json.connected, true);

      const res = await bob.post("/api/youtube/disconnect", {});
      assertEqual(res.status, 200);
      assertEqual(res.json.disconnected, true);

      const state = await (await fetch(`${mock.base}/__state`)).json();
      assert(state.revoked.some((token) => String(token).startsWith("1//test-")), "refresh token deveria ter sido revogado no Google");

      const after = await bob.get("/api/youtube/status");
      assertEqual(after.json.connected, false, "deveria constar como desconectado");
      assertEqual(after.json.channel, null);

      const channel = await bob.get("/api/youtube/channel");
      assertEqual(channel.status, 401, "rotas do canal devem exigir conexão");

      const raw = fs.readFileSync(path.join(dataDirA, "loopsync-store.json"), "utf8");
      const parsed = JSON.parse(raw);
      const bobConnection = parsed.connections.find((item) => item.googleUserId === "google-bob");
      assert(bobConnection, "registro da conexão deveria continuar para auditoria");
      assertEqual(bobConnection.accessToken, null, "access token deveria ter sido apagado");
      assertEqual(bobConnection.refreshToken, null, "refresh token deveria ter sido apagado");
      assert(bobConnection.disconnectedAt, "deveria registrar a data da desconexão");
    });

    /* ═══════════ 9. SERVIDOR SEM CREDENCIAIS ═══════════ */
    group("Sem credenciais Google");

    await test("sem GOOGLE_CLIENT_ID/SECRET o app explica a configuração", async () => {
      const noCreds = await startLoopSync({
        env: {
          ...mock.env,
          GOOGLE_CLIENT_ID: "",
          GOOGLE_CLIENT_SECRET: "",
        },
        dataDir: dataDirNoCreds,
      });
      try {
        const client = createClient(noCreds.baseUrl, { name: "nocreds" });
        const status = await client.get("/api/youtube/status");
        assertEqual(status.json.configured, false);
        assertEqual(status.json.canUpload, false);

        const start = await client.get("/api/youtube/auth/start");
        assertEqual(start.status, 503);
        assertEqual(start.json.code, "not_configured");
        assert(/GOOGLE_CLIENT_ID/.test(start.json.error), "mensagem deveria orientar a configuração");

        // o resto do app continua funcionando
        const health = await client.get("/health");
        assertEqual(health.json.ok, true);
        const descriptions = await client.post("/api/youtube/descriptions", { name: "Sem canal", content: "Biblioteca continua disponível." });
        assertEqual(descriptions.status, 201);
        const templates = await client.get("/api/youtube/templates");
        assert(templates.json.items.length >= 6, "templates padrão deveriam estar disponíveis");
      } finally {
        await noCreds.stop();
      }
    });

    /* ═══════════ resultado ═══════════ */
    group("");
  } finally {
    await server.stop();
    await mock.close();
  }

  const failed = results.filter((item) => !item.ok);
  const passed = results.length - failed.length;
  console.log(`\n${passed}/${results.length} verificações passaram.`);
  if (failed.length) {
    console.log("\nFalhas:");
    for (const item of failed) console.log(`  ✗ ${item.label}\n      ${item.error}`);
  }

  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (failed.length) process.exit(1);
  console.log("Módulo YouTube validado.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nVALIDAÇÃO DO YOUTUBE FALHOU:", err);
    process.exit(1);
  });
}

module.exports = { main };
