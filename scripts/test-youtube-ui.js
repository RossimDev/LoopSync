"use strict";

/**
 * Teste de interface do módulo YouTube rodando em jsdom (sem navegador).
 *
 * Renderiza o App REAL do LoopSync (React + motion) contra o servidor REAL e o
 * mock dos endpoints do Google, e percorre o fluxo pela UI:
 *
 *   YouTube → conectar → biblioteca (descrição + tags) → selecionar vídeo
 *   → template → usar descrição salva → editar → tags salvas → sugestões
 *   → editar/remover/reordenar tags → título → privacidade/categoria/playlist
 *   → revisão → enviar → progresso → concluído → histórico
 *
 * Complementa scripts/test-youtube-browser.js (Chromium), que cobre layout e
 * responsividade quando há navegador disponível no ambiente.
 *
 * Uso: npm run test:youtube:ui
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (err) {
  console.error("\nNão foi possível carregar o jsdom neste Node.", err.message);
  console.error("O teste de interface exige Node 22 ou superior (jsdom 30 + undici).");
  console.error(`Node em uso: ${process.version}`);
  process.exit(2);
}

const { startMockGoogle } = require("./mock-google");

const ROOT = path.join(__dirname, "..");
const CLIENT_ID = "ui-test-client.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-ui-test-secret";

let checks = 0;
let failures = 0;
/** Rótulos das verificações que falharam — impressos no resumo final. */
const failedMessages = [];

const CI = process.env.GITHUB_ACTIONS === "true";

function check(condition, message) {
  checks += 1;
  if (!condition) {
    failures += 1;
    failedMessages.push(message);
    console.log(`  ✗ ${message}`);
    if (CI) console.log(`::error::${message}`);
    return false;
  }
  console.log(`  ✓ ${message}`);
  return true;
}

function startServer({ env, dataDir }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: "0",
        LOOPSYNC_DATA_DIR: dataDir,
        LOOPSYNC_YT_STATUS_POLL_MS: "300",
        GOOGLE_CLIENT_ID: CLIENT_ID,
        GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`servidor não iniciou\n${out}\n${err}`));
    }, 60000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({
          child,
          base: `http://127.0.0.1:${match[1]}`,
          logs: () => `${out}\n${err}`,
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
      err += chunk;
    });
  });
}

async function bundleProbe(workDir) {
  const esbuild = require("esbuild");
  const outfile = path.join(workDir, "ui-probe.mjs");
  await esbuild.build({
    entryPoints: [path.join(__dirname, "ui-probe.jsx")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    target: "node20",
    loader: { ".css": "empty", ".svg": "text" },
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "silent",
  });
  return outfile;
}

/* ── ambiente jsdom ─────────────────────────────────────────────── */

function createDom(baseUrl) {
  const virtualConsole = new VirtualConsole();
  const notImplemented = [];
  const consoleErrors = [];
  virtualConsole.on("jsdomError", (error) => {
    if (/Not implemented/i.test(error.message)) notImplemented.push(error.message);
    else consoleErrors.push(String(error.message || error));
  });
  virtualConsole.on("error", (...args) => consoleErrors.push(args.map(String).join(" ")));
  virtualConsole.on("warn", (...args) => console.log("  [console.warn]", ...args));

  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: `${baseUrl}/`,
    pretendToBeVisual: true,
    runScripts: "outside-only",
    virtualConsole,
  });

  const { window } = dom;

  // fetch com cookie jar (o app usa sessões httpOnly)
  const jar = new Map();
  const nativeFetch = globalThis.fetch;
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" && input.startsWith("/") ? `${baseUrl}${input}` : input;
    const headers = new Headers(init.headers || {});
    if (jar.size && !headers.has("cookie")) {
      headers.set("cookie", [...jar].map(([key, value]) => `${key}=${value}`).join("; "));
    }
    const response = await nativeFetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value || /Max-Age=0/i.test(cookie)) jar.delete(key);
      else jar.set(key, value);
    }
    return response;
  };

  window.URL.createObjectURL = () => `blob:${baseUrl}/fake-${Math.random().toString(36).slice(2)}`;
  window.URL.revokeObjectURL = () => {};
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};

  // Elementos de mídia: metadados imediatos (jsdom não decodifica vídeo)
  const realCreateElement = window.document.createElement.bind(window.document);
  window.document.createElement = (tag, options) => {
    const element = realCreateElement(tag, options);
    if (String(tag).toLowerCase() === "video") {
      Object.defineProperty(element, "duration", { value: 8, configurable: true });
      Object.defineProperty(element, "videoWidth", { value: 320, configurable: true });
      Object.defineProperty(element, "videoHeight", { value: 180, configurable: true });
      Object.defineProperty(element, "currentTime", {
        configurable: true,
        get: () => 0,
        set: () => {
          setTimeout(() => {
            if (typeof element.onseeked === "function") element.onseeked();
          }, 0);
        },
      });
      element.play = () => Promise.resolve();
      element.pause = () => {};
      element.load = () => {
        setTimeout(() => {
          if (typeof element.onloadedmetadata === "function") element.onloadedmetadata();
          if (typeof element.onloadeddata === "function") element.onloadeddata();
        }, 0);
      };
      setTimeout(() => {
        if (typeof element.onloadedmetadata === "function") element.onloadedmetadata();
        if (typeof element.onloadeddata === "function") element.onloadeddata();
      }, 0);
    }
    if (String(tag).toLowerCase() === "canvas") {
      element.getContext = () => null; // sem canvas nativo: a captura de quadro é ignorada
      element.toBlob = (cb) => cb(null);
    }
    return element;
  };

  return { dom, window, jar, notImplemented, consoleErrors };
}

function setGlobal(name, value) {
  try {
    Object.defineProperty(global, name, { value, writable: true, configurable: true });
  } catch (err) {
    console.log(`  (aviso: não foi possível definir global.${name}: ${err.message})`);
  }
}

function installGlobals(window) {
  const names = [
    "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLAnchorElement",
    "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "File", "FileList", "Blob",
    "FileReader", "FormData", "Headers", "Request", "Response", "DataTransfer", "getComputedStyle",
    "requestAnimationFrame", "cancelAnimationFrame", "matchMedia", "ResizeObserver", "IntersectionObserver",
    "DOMParser", "MutationObserver",
  ];
  for (const name of names) {
    if (window[name] !== undefined) setGlobal(name, window[name]);
  }
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("navigator", window.navigator);
  setGlobal("location", window.location);
  setGlobal("history", window.history);
  setGlobal("localStorage", window.localStorage);
  setGlobal("fetch", window.fetch);
  setGlobal("URL", window.URL);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", false);
}

/* ── helpers de interação ───────────────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 45000, label = "condição", interval = 40 } = {}) {
  const started = Date.now();
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() - started > timeout) {
      throw new Error(`tempo esgotado aguardando: ${label}${lastError ? ` (${lastError.message})` : ""}`);
    }
    await sleep(interval);
  }
}

function makeHelpers(window) {
  const document = window.document;
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => [...document.querySelectorAll(selector)];
  const byTestId = (id) => q(`[data-testid="${id}"]`);
  const text = (selector) => (q(selector) ? q(selector).textContent : "");
  const bodyText = () => document.body.textContent || "";

  const click = async (elementOrSelector) => {
    const element = typeof elementOrSelector === "string" ? q(elementOrSelector) : elementOrSelector;
    if (!element) throw new Error(`elemento não encontrado para clique: ${elementOrSelector}`);
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    await sleep(30);
    return element;
  };

  const clickTestId = async (id) => {
    const element = await waitFor(() => byTestId(id), { label: `data-testid=${id}`, timeout: 30000 });
    // Um clique em botão desabilitado é silencioso: espere habilitar para que a
    // falha apareça como "elemento desabilitado" e não como timeout confuso.
    const enabled = await waitFor(() => (byTestId(id) && !byTestId(id).disabled ? byTestId(id) : null), {
      label: `data-testid=${id} habilitado`,
      timeout: 30000,
    });
    return click(enabled);
  };

  const setValue = async (element, value) => {
    const proto =
      element instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : element instanceof window.HTMLSelectElement
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(element, value);
    element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    await sleep(30);
  };

  const typeInto = async (element, text2) => setValue(element, `${element.value}${text2}`);

  return { document, q, qa, byTestId, text, bodyText, click, clickTestId, setValue, typeInto };
}

/* ── fluxo OAuth feito "pelo navegador" ─────────────────────────── */

async function performOAuth(window, mock, baseUrl) {
  const startResponse = await window.fetch("/api/youtube/auth/start");
  const start = await startResponse.json();
  const authUrl = new URL(start.url);
  const consent = await globalThis.fetch(authUrl.toString(), { redirect: "manual" });
  const html = await consent.text();
  const match = /location\.replace\('([^']+)'\)/.exec(html);
  if (!match) throw new Error("página de consentimento do mock não devolveu redirect");
  const callbackUrl = match[1];
  // o callback passa pelo fetch do jsdom para gravar o cookie de sessão no jar
  const callback = await window.fetch(callbackUrl.replace(baseUrl, ""), { redirect: "manual" });
  return { location: callback.headers.get("location"), status: callback.status };
}

/* ── main ───────────────────────────────────────────────────────── */

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsync-ui-"));
  console.log("Empacotando o app com esbuild…");
  const bundlePath = await bundleProbe(workDir);

  console.log("Subindo mock do Google (somente testes)…");
  const mock = await startMockGoogle({ port: 0 });
  console.log("Subindo o servidor do LoopSync…");
  const server = await startServer({ env: mock.env, dataDir: path.join(workDir, "data") });
  console.log(`LoopSync em ${server.base}\n`);

  const { dom, window, jar, consoleErrors } = createDom(server.base);
  installGlobals(window);
  const ui = makeHelpers(window);

  const getJson = async (path) => (await window.fetch(path)).json();
  const getDescriptions = () => getJson("/api/youtube/descriptions");
  const getTagSets = () => getJson("/api/youtube/tagsets");
  const getMockState = async () => (await globalThis.fetch(`${mock.base}/__state`)).json();
  const addFile = async (file) => {
    const input = ui.byTestId("video-input");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(30);
  };

  let root = null;
  try {
    const { mount } = await import(bundlePath);

    /* ── 1. app renderiza e navega para o YouTube ── */
    console.log("Interface:");
    const container = window.document.getElementById("root");
    root = mount(container);
    await waitFor(() => ui.byTestId("nav-youtube"), { label: "navegação do app" });
    check(true, "App do LoopSync renderiza sem erros");

    await ui.clickTestId("nav-youtube");
    await waitFor(() => ui.q(".yt-tabs"), { label: "abas do YouTube" });
    check(true, "navegação LoopSync → YouTube");
    await waitFor(() => ui.byTestId("connect-cta"), { label: "CTA de conexão" });
    check(true, "sem canal conectado: CTA de conexão visível");
    check(ui.bodyText().includes("Conecte seu canal para começar"), "área de upload bloqueada sem conexão");
    check(ui.byTestId("video-input") === null, "seletor de vídeo não aparece antes de conectar");

    // mesmo caminho do E2E no navegador: o CTA precisa abrir o modal de conexão
    await ui.clickTestId("connect-cta");
    await waitFor(() => ui.q(".yt-modal"), { label: "modal de conexão" });
    check(ui.q(".yt-modal").textContent.includes("Conectar canal do YouTube"), "modal de conexão abre ao clicar no CTA");
    check(Boolean(ui.byTestId("connect-google-modal")), "modal tem o botão Conectar com o Google");
    await ui.click(ui.q(".yt-modal-head .yt-icon-btn"));
    await waitFor(() => !ui.q(".yt-modal-backdrop"), { label: "modal fechado" });
    check(true, "modal de conexão pode ser fechado sem conectar");

    /* ── 2. OAuth completo (redirect + callback + cookie) ── */
    const oauth = await performOAuth(window, mock, server.base);
    check(String(oauth.location || "").includes("yt=connected"), `callback OAuth redireciona conectado (${oauth.location})`);
    check(jar.has("loopsync_session"), "cookie de sessão gravado no navegador");

    // equivalente ao retorno do Google: recarrega o app com a sessão ativa
    root.unmount();
    window.document.getElementById("root").innerHTML = "";
    root = mount(window.document.getElementById("root"));
    await waitFor(() => ui.q(".yt-channel-chip"), { label: "chip do canal" });
    await waitFor(() => ui.q(".yt-channel-chip strong") && !ui.q(".yt-channel-chip.off"), { label: "canal conectado" });
    check(!ui.q(".yt-channel-chip").className.includes("off"), `canal conectado na interface (${ui.text(".yt-channel-chip strong")})`);

    /* ── 3. biblioteca: descrição + conjunto de tags ── */
    await ui.clickTestId("tab-library");
    await waitFor(() => ui.byTestId("new-description"), { label: "botão nova descrição" });
    await ui.clickTestId("new-description");
    await waitFor(() => ui.q("#libDescName"), { label: "modal de descrição" });
    await ui.setValue(ui.q("#libDescName"), "Descrição UI");
    await ui.setValue(ui.q("#libDescContent"), "Conteúdo original salvo pela UI.\n\n#loopsync");
    await ui.clickTestId("save-description-library");
    await waitFor(() => ui.bodyText().includes("Descrição UI"), { label: "descrição listada" });
    check(true, "descrição salva criada pela biblioteca");
    check(ui.bodyText().includes("Criada em") && ui.bodyText().includes("Alterada em"), "descrição mostra data de criação e última alteração");

    await ui.clickTestId("new-tagset");
    await waitFor(() => ui.q("#libTagName"), { label: "modal de tags" });
    await ui.setValue(ui.q("#libTagName"), "Tags Música UI");
    const tagField = ui.q(".yt-modal .yt-tag-compose .yt-input");
    for (const tag of ["música", "remix", "DJ", "electronic", "dance", "mix"]) {
      await ui.setValue(tagField, tag);
      tagField.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await sleep(20);
    }
    const savedTags = ui.qa(".yt-modal .yt-tag-text").map((el) => el.textContent);
    check(savedTags.length === 6, `6 tags no conjunto (${savedTags.length}: ${savedTags.join(", ")})`);
    await ui.clickTestId("save-tagset-library");
    await waitFor(() => ui.bodyText().includes("Tags Música UI"), { label: "conjunto listado" });
    check(true, "conjunto de tags salvo pela biblioteca");

    /* ── 3b. biblioteca: editar, duplicar e excluir ── */
    await ui.clickTestId("new-description");
    await waitFor(() => ui.q("#libDescName"), { label: "modal de descrição" });
    await ui.setValue(ui.q("#libDescName"), "Descrição p/ atualizar");
    await ui.setValue(ui.q("#libDescContent"), "Versão antiga da descrição.");
    await ui.clickTestId("save-description-library");
    await waitFor(() => ui.bodyText().includes("Descrição p/ atualizar"), { label: "segunda descrição" });

    await ui.clickTestId("new-tagset");
    await waitFor(() => ui.q("#libTagName"), { label: "modal de tags" });
    await ui.setValue(ui.q("#libTagName"), "Tags p/ atualizar");
    const tagField2 = ui.q(".yt-modal .yt-tag-compose .yt-input");
    for (const tag of ["base", "antiga"]) {
      await ui.setValue(tagField2, tag);
      tagField2.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await sleep(20);
    }
    await ui.clickTestId("save-tagset-library");
    await waitFor(() => ui.bodyText().includes("Tags p/ atualizar"), { label: "segundo conjunto" });
    check(
      ui.bodyText().includes("Criado em") && ui.bodyText().includes("Alterado em"),
      "conjunto de tags mostra data de criação e última alteração",
    );

    const desc2 = (await getDescriptions()).items.find((item) => item.name === "Descrição p/ atualizar");
    check(Boolean(desc2), "segunda descrição persistida no banco");

    await ui.clickTestId(`library-duplicate-description-${desc2.id}`);
    await waitFor(
      async () => (await getDescriptions()).items.some((item) => item.name === "Descrição p/ atualizar (cópia)"),
      { label: "descrição duplicada" },
    );
    const copied = (await getDescriptions()).items.find((item) => item.name === "Descrição p/ atualizar (cópia)");
    check(true, 'descrição duplicada pela biblioteca (nome recebe "(cópia)")');
    check(copied.content === desc2.content, "duplicação copia o conteúdo integral");

    await ui.clickTestId(`library-edit-description-${copied.id}`);
    await waitFor(() => ui.q("#libDescName"), { label: "modal de edição" });
    check(ui.q("#libDescName").value === copied.name, "editar carrega o nome existente no formulário");
    check(ui.q("#libDescContent").value === copied.content, "editar carrega o conteúdo existente no formulário");
    await ui.setValue(ui.q("#libDescName"), "Descrição editada na biblioteca");
    await ui.setValue(ui.q("#libDescContent"), "Conteúdo reescrito pela edição.");
    await ui.clickTestId("save-description-library");
    await waitFor(
      async () => {
        const item = (await getDescriptions()).items.find((entry) => entry.id === copied.id);
        return item && item.name === "Descrição editada na biblioteca" && item.content === "Conteúdo reescrito pela edição.";
      },
      { label: "edição persistida" },
    );
    check(true, "descrição existente editada pela biblioteca");
    const edited = (await getDescriptions()).items.find((entry) => entry.id === copied.id);
    check(new Date(edited.updatedAt).getTime() >= new Date(edited.createdAt).getTime(), "última alteração registrada após editar");

    await ui.clickTestId(`library-delete-description-${edited.id}`);
    await waitFor(() => ui.byTestId("library-confirm-delete"), { label: "confirmação de exclusão" });
    check(ui.bodyText().includes("Descrição editada na biblioteca"), "exclusão pede confirmação citando o item");
    await ui.clickTestId("library-confirm-delete");
    await waitFor(async () => !(await getDescriptions()).items.some((entry) => entry.id === edited.id), { label: "descrição excluída" });
    check(true, "descrição excluída pela biblioteca");
    await waitFor(() => !ui.q(".yt-modal-backdrop"), { label: "confirmação fechada" });
    await waitFor(
      () => !ui.qa(".yt-lib-head strong").some((el) => el.textContent === "Descrição editada na biblioteca"),
      { label: "item fora da lista" },
    );
    check(true, "item some da lista após excluir");

    const set2 = (await getTagSets()).items.find((item) => item.name === "Tags p/ atualizar");
    check(Boolean(set2) && set2.tags.length === 2, `conjunto de tags persistido (${set2 && set2.tags.join(", ")})`);
    await ui.clickTestId(`library-duplicate-tagset-${set2.id}`);
    await waitFor(
      async () => (await getTagSets()).items.some((item) => item.name === "Tags p/ atualizar (cópia)"),
      { label: "conjunto duplicado" },
    );
    check(true, "conjunto de tags duplicado pela biblioteca");
    const setCopy = (await getTagSets()).items.find((item) => item.name === "Tags p/ atualizar (cópia)");
    await ui.clickTestId(`library-delete-tagset-${setCopy.id}`);
    await waitFor(() => ui.byTestId("library-confirm-delete"), { label: "confirmação de exclusão do conjunto" });
    await ui.clickTestId("library-confirm-delete");
    await waitFor(async () => !(await getTagSets()).items.some((item) => item.id === setCopy.id), { label: "conjunto excluído" });
    check(true, "conjunto de tags excluído pela biblioteca");

    /* ── 4. selecionar vídeo ── */
    await ui.clickTestId("tab-send");
    const fileInput = await waitFor(() => ui.byTestId("video-input"), { label: "input de vídeo" });
    const videoBytes = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < videoBytes.length; i += 1) videoBytes[i] = (i * 31 + 7) % 251;
    const file = new window.File([videoBytes], "show_ao_vivo.mp4", { type: "video/mp4" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));

    await waitFor(() => ui.q(".yt-queue-item"), { label: "item na fila" });
    check(ui.bodyText().includes("show_ao_vivo.mp4"), "arquivo exibido na fila");
    const fileMeta = ui.text(".yt-file-meta");
    check(/3(\.0+)? MB/.test(fileMeta), `tamanho do arquivo exibido (${fileMeta.replace(/\n/g, " | ")})`);
    check(fileMeta.includes("00:08"), "duração do vídeo exibida");
    check(fileMeta.includes("MP4"), "formato exibido");

    /* ── 5. template ── */
    await ui.clickTestId("template-tpl_musica");
    await waitFor(() => ui.q("#ytDescription") && ui.q("#ytDescription").value.includes("Produção/DJ"), { label: "template aplicado" });
    check(true, "template aplicado preenche descrição");
    check(ui.qa(".yt-tag").length >= 5, `tags do template carregadas (${ui.qa(".yt-tag").length})`);
    check(ui.q("#ytTitle").value.length > 0, `título vindo do template ("${ui.q("#ytTitle").value}")`);

    /* ── 6. descrição salva: usar, editar, atualizar a salva, não sobrescrever ── */
    const desc1 = (await getDescriptions()).items.find((item) => item.name === "Descrição UI");
    const pickDescription = async (id) => {
      await ui.clickTestId("pick-description");
      await waitFor(() => ui.byTestId(`use-description-${id}`), { label: "lista de descrições" });
      await ui.click(ui.byTestId(`use-description-${id}`));
    };

    await pickDescription(desc1.id);
    await waitFor(() => ui.q("#ytDescription").value.includes("Conteúdo original salvo pela UI"), { label: "descrição carregada" });
    check(true, "descrição salva carregada no campo");

    await ui.typeInto(ui.q("#ytDescription"), "\n\nEditado só neste envio.");
    check(ui.q("#ytDescription").value.includes("Editado só neste envio"), "descrição editada livremente após carregar");
    await waitFor(() => ui.bodyText().includes("editada"), { label: "badge de descrição editada" });
    check(true, "interface sinaliza que a descrição salva foi editada (cópia de trabalho)");
    check(!ui.byTestId("update-saved-description").disabled, '"Atualizar descrição salva" fica disponível quando há edição');

    // atualizar a salva é sempre uma ação explícita do usuário
    await pickDescription(desc2.id);
    await waitFor(() => ui.q("#ytDescription").value.includes("Versão antiga da descrição"), { label: "segunda descrição carregada" });
    await ui.typeInto(ui.q("#ytDescription"), " [atualizada pela UI]");
    await ui.clickTestId("update-saved-description");
    await waitFor(
      async () => {
        const item = (await getDescriptions()).items.find((entry) => entry.id === desc2.id);
        return item && item.content.includes("[atualizada pela UI]");
      },
      { label: "descrição salva atualizada" },
    );
    check(true, '"Atualizar descrição salva" grava a edição na biblioteca quando o usuário pede');
    await waitFor(() => ui.byTestId("update-saved-description").disabled, { label: "botão volta a desabilitar" });
    check(true, "sem edição pendente o botão de atualizar fica desabilitado");

    // volta para a descrição 1 (que NÃO deve ser alterada na biblioteca)
    await pickDescription(desc1.id);
    await waitFor(() => ui.q("#ytDescription").value.includes("Conteúdo original salvo pela UI"), { label: "descrição 1 recarregada" });
    await ui.typeInto(ui.q("#ytDescription"), "\n\nEditado só neste envio.");
    check(ui.q("#ytDescription").value.includes("Editado só neste envio"), "descrição recarregada e editada de novo (cópia de trabalho)");

    /* ── 7. tags salvas, sugestões, adicionar todas, limpar e atualizar conjunto ── */
    const setId1 = (await getTagSets()).items.find((item) => item.name === "Tags Música UI").id;
    const setId2 = (await getTagSets()).items.find((item) => item.name === "Tags p/ atualizar").id;
    const pickTagSet = async (id) => {
      await ui.clickTestId("pick-tagset");
      await waitFor(() => ui.byTestId(`use-tagset-${id}`), { label: "lista de conjuntos" });
      await ui.click(ui.byTestId(`use-tagset-${id}`));
    };
    const addTag = async (value) => {
      const compose = ui.q(".yt-tag-compose .yt-input");
      await ui.setValue(compose, value);
      compose.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await waitFor(() => ui.qa(".yt-tag-text").some((el) => el.textContent === value), { label: `tag "${value}"` });
    };
    /** Clica em "Salvar alterações"; se houver mais de uma origem, escolhe o conjunto informado. */
    const updateSavedTagSet = async (preferredId) => {
      await ui.clickTestId("update-saved-tagset");
      await sleep(300);
      if (ui.q('[data-testid^="choose-tagset-"]')) {
        await ui.click(ui.byTestId(`choose-tagset-${preferredId}`));
        return "chooser";
      }
      return "direct";
    };

    await pickTagSet(setId1);
    await waitFor(() => ui.qa(".yt-tag-text").some((el) => el.textContent === "electronic"), { label: "tags do conjunto" });
    check(true, "conjunto de tags aplicado ao vídeo (misturado às existentes)");

    /* ── 7b. semântica do seletor de conjuntos ── */
    const tagsBeforePicker = ui.qa(".yt-tag-text").map((el) => el.textContent);
    check(Boolean(ui.q(".yt-modal")), '"Somar" mantém o seletor aberto para combinar conjuntos');
    await ui.clickTestId("close-tagset-picker");
    await waitFor(() => !ui.q(".yt-modal-backdrop"), { label: "seletor fechado" });
    check(true, '"Fechar" encerra o seletor de tags salvas');

    await ui.clickTestId("pick-tagset");
    await waitFor(() => ui.byTestId(`replace-tagset-${setId2}`), { label: "seletor reaberto" });
    await ui.click(ui.byTestId(`replace-tagset-${setId2}`));
    await waitFor(() => !ui.q(".yt-modal-backdrop"), { label: "seletor fechado após substituir" });
    const set2Tags = (await getTagSets()).items.find((entry) => entry.id === setId2).tags;
    await waitFor(() => JSON.stringify(ui.qa(".yt-tag-text").map((el) => el.textContent)) === JSON.stringify(set2Tags), {
      label: "tags substituídas",
    });
    check(true, `"Substituir" troca as tags do vídeo pelas do conjunto (${set2Tags.length}) e fecha o seletor`);

    // devolve o estado anterior para o restante do fluxo não mudar
    // ("Limpar tags" só existe quando há sugestões geradas)
    let tagsLeft = ui.qa(".yt-tag").length;
    for (let guard = 0; guard < 60 && tagsLeft > 0; guard += 1) {
      const removeButtons = ui.qa('button[aria-label^="Remover "]');
      if (!removeButtons.length) break;
      await ui.click(removeButtons[removeButtons.length - 1]);
      await waitFor(() => ui.qa(".yt-tag").length < tagsLeft, { label: "tag removida" });
      tagsLeft = ui.qa(".yt-tag").length;
    }
    await waitFor(() => ui.qa(".yt-tag").length === 0, { label: "tags zeradas antes de restaurar" });
    for (const tag of tagsBeforePicker) await addTag(tag);
    await waitFor(() => ui.qa(".yt-tag-text").length === tagsBeforePicker.length, { label: "estado restaurado" });
    check(true, "estado de tags restaurado depois de testar o seletor");

    const tagsBeforeSuggestion = ui.qa(".yt-tag").length;
    await ui.clickTestId("generate-suggestions");
    await waitFor(() => ui.q(".yt-suggestion:not([disabled])"), { label: "sugestões de tags" });
    const suggestionTexts = ui.qa(".yt-suggestion:not([disabled]) span").map((el) => el.textContent.trim());
    check(suggestionTexts.length >= 3, `sugestões geradas a partir do título/assunto (${suggestionTexts.length})`);
    check(ui.qa(".yt-tag").length === tagsBeforeSuggestion, "sugestões NÃO são adicionadas automaticamente");
    await ui.click(ui.q(".yt-suggestion:not([disabled])"));
    await waitFor(() => ui.qa(".yt-tag").length > tagsBeforeSuggestion, { label: "sugestão aceita" });
    check(true, "sugestão adicionada individualmente após clique do usuário");

    const beforeAll = ui.qa(".yt-tag").length;
    const remaining = ui.qa(".yt-suggestion:not([disabled])").length;
    await ui.clickTestId("add-all-suggestions");
    await waitFor(() => ui.qa(".yt-tag").length >= beforeAll + remaining, { label: "todas as sugestões" });
    check(ui.qa(".yt-tag").length === beforeAll + remaining, `"Adicionar todas" inclui as sugestões restantes (${beforeAll} + ${remaining})`);
    check(ui.qa(".yt-suggestion:not([disabled])").length === 0, "sugestões já usadas ficam desabilitadas");

    await ui.clickTestId("clear-tags");
    await waitFor(() => ui.qa(".yt-tag").length === 0, { label: "tags limpas" });
    check(true, '"Limpar tags" remove todas as tags do vídeo');

    await pickTagSet(setId2);
    await waitFor(() => ui.qa(".yt-tag-text").some((el) => el.textContent === "base"), { label: "segundo conjunto aplicado" });
    await addTag("nova-do-video");
    check(!ui.byTestId("update-saved-tagset").disabled, '"Salvar alterações" fica disponível quando as tags foram editadas');
    await updateSavedTagSet(setId2);
    await waitFor(
      async () => {
        const item = (await getTagSets()).items.find((entry) => entry.id === setId2);
        return item && item.tags.includes("nova-do-video");
      },
      { label: "conjunto atualizado" },
    );
    check(true, '"Salvar alterações" atualiza o conjunto de tags quando o usuário pede');

    // duas origens diferentes: o app pergunta qual conjunto atualizar
    await pickTagSet(setId1);
    await waitFor(() => ui.qa(".yt-tag-text").some((el) => el.textContent === "electronic"), { label: "conjunto somado" });
    check(ui.qa(".yt-tag-text").some((el) => el.textContent === "nova-do-video"), "tags de conjuntos diferentes são misturadas no vídeo");
    const usedChooser = await updateSavedTagSet(setId2);
    check(usedChooser === "chooser", "com mais de uma origem o app pergunta qual conjunto atualizar");
    await waitFor(
      async () => {
        const item = (await getTagSets()).items.find((entry) => entry.id === setId2);
        return item && item.tags.includes("electronic");
      },
      { label: "conjunto escolhido atualizado" },
    );
    check(true, "o conjunto escolhido é atualizado");
    const untouched = (await getTagSets()).items.find((entry) => entry.id === setId1);
    check(untouched.tags.length === 6, `o conjunto não escolhido permanece intacto (${untouched.tags.length} tags)`);

    /* ── 8. editar / reordenar / remover tag ── */
    const editButton = ui.qa(".yt-tag .yt-tag-tools button")[2];
    await ui.click(editButton);
    await waitFor(() => ui.q(".yt-tag-input"), { label: "tag em edição" });
    await ui.setValue(ui.q(".yt-tag-input"), "tag-editada-ui");
    ui.q(".yt-tag-input").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => ui.qa(".yt-tag-text").some((el) => el.textContent === "tag-editada-ui"), { label: "tag editada" });
    check(true, "tag editada individualmente");

    const orderBefore = ui.qa(".yt-tag-text").map((el) => el.textContent);
    await ui.click(ui.qa(".yt-tag .yt-tag-tools button")[1]); // ›
    await waitFor(() => ui.qa(".yt-tag-text").map((el) => el.textContent).join("|") !== orderBefore.join("|"), { label: "reordenação" });
    check(true, "tag reordenada");

    const countBeforeRemove = ui.qa(".yt-tag").length;
    const removeButtons = ui.qa(".yt-tag .yt-tag-tools button");
    await ui.click(removeButtons[removeButtons.length - 1]);
    await waitFor(() => ui.qa(".yt-tag").length < countBeforeRemove, { label: "tag removida" });
    check(true, "tag removida");

    /* ── 9. título, contador e configurações ── */
    await ui.setValue(ui.q("#ytTitle"), "Show ao vivo — Mix eletrônico");
    const counter = ui.text(".yt-field-head .yt-counter");
    check(/^\d+\/100$/.test(counter), `contador de caracteres do título (${counter})`);

    const publicSegment = ui.qa(".yt-segment").find((el) => el.textContent.includes("Público"));
    await ui.click(publicSegment);
    check(ui.q(".yt-segment.active").textContent.includes("Público"), "privacidade Público selecionada");

    await waitFor(() => ui.q("#ytCategory option[value='10']"), { label: "categorias da API" });
    await ui.setValue(ui.q("#ytCategory"), "10");
    check(ui.q("#ytCategory").value === "10", "categoria selecionada (vinda da API)");

    await waitFor(() => ui.q("#ytPlaylist option[value='PL_MUSICA']"), { label: "playlists da API" });
    await ui.setValue(ui.q("#ytPlaylist"), "PL_MUSICA");
    check(ui.q("#ytPlaylist").value === "PL_MUSICA", "playlist do canal selecionada");

    /* ── 10. revisão ── */
    await ui.clickTestId("goto-review");
    await waitFor(() => ui.q(".yt-review"), { label: "tela de revisão" });
    const review = ui.text(".yt-review");
    check(review.includes("Show ao vivo — Mix eletrônico"), "revisão: título");
    check(review.includes("Conteúdo original salvo pela UI"), "revisão: descrição");
    check(review.includes("Music"), "revisão: categoria");
    check(review.includes("Público"), "revisão: privacidade");
    check(review.includes("Músicas 2026"), "revisão: playlist");
    check(review.includes("tag-editada-ui"), "revisão: tags");
    check(ui.bodyText().includes("Voltar e editar"), "revisão permite voltar e editar");

    /* ── 11. envio real com progresso e conclusão ── */
    await ui.clickTestId("send-to-youtube");
    await waitFor(() => ui.q(".yt-progress-track"), { label: "barra de progresso" });
    check(true, "progresso do upload exibido");

    // acompanha a porcentagem enquanto o envio acontece
    const seen = [];
    const poller = setInterval(() => {
      for (const track of ui.qa('.yt-progress-track[aria-valuenow]')) {
        const value = Number(track.getAttribute("aria-valuenow"));
        if (Number.isFinite(value) && seen[seen.length - 1] !== value) seen.push(value);
      }
    }, 20);

    await waitFor(() => ui.byTestId("upload-done"), { label: "conclusão do upload", timeout: 180000 });
    clearInterval(poller);
    const done = ui.text('[data-testid="upload-done"]');
    check(done.includes("Upload concluído com sucesso!"), "mensagem de conclusão");
    check(/vid_[a-f0-9]+/.test(done), "ID do vídeo exibido");
    check(done.includes("https://www.youtube.com/watch?v="), "link do vídeo exibido");
    check(ui.byTestId("open-on-youtube").getAttribute("href").startsWith("https://www.youtube.com/watch?v="), "botão Abrir no YouTube");
    const percentages = seen;
    const monotonic = percentages.every((value, index) => index === 0 || value >= percentages[index - 1]);
    check(
      percentages.length > 0 && monotonic && Math.max(...percentages) > 0,
      `porcentagem do envio avançou até a conclusão (${percentages.join(" → ")}%)`,
    );

    const mockState = await (await globalThis.fetch(`${mock.base}/__state`)).json();
    check(mockState.videos.length === 1, "YouTube (mock) recebeu exatamente 1 vídeo");
    check(mockState.videos[0].snippet.title === "Show ao vivo — Mix eletrônico", "título enviado corretamente pela API");
    check(mockState.videos[0].snippet.tags.length > 0, `tags enviadas pela API (${mockState.videos[0].snippet.tags.length})`);
    check(mockState.videos[0].snippet.categoryId === "10", "categoria enviada pela API");
    check(mockState.videos[0].status.privacyStatus === "public", "privacidade enviada pela API");
    check(mockState.playlistItems.length === 1, "vídeo adicionado à playlist pela API");

    /* ── 12. histórico ── */
    await ui.clickTestId("tab-history");
    await waitFor(() => ui.q(".yt-history-item"), { label: "item do histórico" });
    const history = ui.text(".yt-history-item");
    check(history.includes("Show ao vivo — Mix eletrônico"), "histórico: título");
    check(/Concluído|Processando/.test(history), "histórico: status");
    check(history.includes("Canal de"), "histórico: canal");
    check(history.includes("Público"), "histórico: privacidade");
    check(history.includes("https://www.youtube.com/watch?v=") || Boolean(ui.q('[data-testid^="history-open-"]')), "histórico: link do vídeo");

    /* ── 13. bibliotecas preservadas (edição não sobrescreve) ── */
    const descriptions = await (await window.fetch("/api/youtube/descriptions")).json();
    const saved = descriptions.items.find((item) => item.name === "Descrição UI");
    check(Boolean(saved) && !saved.content.includes("Editado só neste envio"), "descrição salva NÃO foi alterada pela edição do envio");
    const tagSets = await (await window.fetch("/api/youtube/tagsets")).json();
    const savedSet = tagSets.items.find((item) => item.name === "Tags Música UI");
    check(savedSet && savedSet.tags.length === 6 && !savedSet.tags.includes("tag-editada-ui"), "conjunto de tags NÃO foi alterado pela edição do envio");

    /* ── 13b. lote: fila, aplicar a todos, thumbnail, arquivo inválido e envio em sequência ── */
    await ui.clickTestId("tab-send");
    await waitFor(() => ui.byTestId("video-input"), { label: "aba enviar" });

    // arquivo que não é vídeo é recusado
    const audioFile = new window.File([Buffer.alloc(4096, 3)], "trilha.m4a", { type: "audio/mp4" });
    await addFile(audioFile);
    await waitFor(() => ui.bodyText().includes("não é um arquivo de vídeo suportado"), { label: "aviso de arquivo inválido" });
    check(true, "arquivo que não é vídeo é recusado com aviso claro");
    check(
      ui.qa(".yt-queue-item").length === 1,
      `arquivo inválido não entra na fila (itens: ${ui.qa(".yt-queue-item").length} · nomes: ${ui.qa(".yt-queue-item").map((el) => el.textContent.slice(0, 40)).join(" / ")})`,
    );

    // segundo vídeo → fila com 2
    await addFile(new window.File([videoBytes], "segundo_video.mp4", { type: "video/mp4" }));
    await waitFor(() => ui.qa(".yt-queue-item").length === 2, { label: "segundo vídeo na fila" });
    check(true, "vários vídeos formam uma fila de envio em lote");
    const queueTexts = ui.qa(".yt-queue-item").map((el) => el.textContent);
    check(queueTexts.some((text) => text.includes("show_ao_vivo.mp4") && /Concluído/.test(text)), "vídeo já enviado aparece como Concluído na fila");
    check(queueTexts.some((text) => text.includes("segundo_video.mp4") && /Aguardando/.test(text)), "vídeo novo aparece como Aguardando na fila");
    check(ui.bodyText().includes("Aplicar as configurações do vídeo selecionado aos demais"), "controles de lote disponíveis");

    // aplicar a configuração do vídeo selecionado aos demais
    const sourceDescription = ui.q("#ytDescription").value;
    const sourceTags = ui.qa(".yt-tag-text").map((el) => el.textContent);
    const sourceTagsAfterEdit = sourceTags.slice(); // enviadas pela API (sem remoções posteriores)
    await ui.clickTestId("apply-all-everything");
    const secondItem = ui.qa(".yt-queue-item").find((el) => el.textContent.includes("segundo_video.mp4"));
    await ui.click(secondItem.querySelector('[data-testid^="queue-select-"]'));
    await waitFor(
      () => ui.q("#ytDescription") && ui.q("#ytDescription").value === sourceDescription,
      { label: "descrição copiada para o segundo vídeo" },
    );
    check(true, "lote: descrição do vídeo selecionado aplicada aos demais");
    check(
      ui.qa(".yt-tag-text").map((el) => el.textContent).join("|") === sourceTags.join("|"),
      "lote: tags aplicadas aos demais vídeos",
    );
    check(
      ui.q("#ytCategory").value === "10" &&
        ui.q("#ytPlaylist").value === "PL_MUSICA" &&
        ui.q(".yt-segment.active").textContent.includes("Público"),
      "lote: categoria, playlist e privacidade aplicadas aos demais vídeos",
    );

    // thumbnail: prévia, remoção e recolocação
    const pngHex =
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000a49444154789c6300010000050001" +
      "0d0a2db40000000049454e44ae426082";
    const imageFile = new window.File([Buffer.from(pngHex, "hex")], "capa.png", { type: "image/png" });
    const setThumbnail = async () => {
      const input = ui.byTestId("thumbnail-input");
      Object.defineProperty(input, "files", { value: [imageFile], configurable: true });
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await waitFor(() => ui.q(".yt-thumb-preview img"), { label: "prévia da miniatura" });
    };
    await setThumbnail();
    check(true, "miniatura selecionada mostra prévia");
    check(ui.text(".yt-thumb-source") === "capa.png", `origem da miniatura exibida (${ui.text(".yt-thumb-source")})`);
    await ui.clickTestId("remove-thumbnail");
    await waitFor(() => !ui.q(".yt-thumb-preview img"), { label: "miniatura removida" });
    check(true, "miniatura pode ser removida antes do envio");
    await setThumbnail();

    // imagem que não é imagem é recusada
    const badThumb = new window.File([Buffer.alloc(2048, 9)], "nota.txt", { type: "text/plain" });
    const thumbInput = ui.byTestId("thumbnail-input");
    Object.defineProperty(thumbInput, "files", { value: [badThumb], configurable: true });
    thumbInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => ui.bodyText().includes("Selecione uma imagem"), { label: "miniatura inválida recusada" });
    check(true, "arquivo que não é imagem é recusado na miniatura");

    // terceiro vídeo apenas para testar a remoção da fila
    await addFile(new window.File([videoBytes], "descartar.mp4", { type: "video/mp4" }));
    await waitFor(() => ui.qa(".yt-queue-item").length === 3, { label: "terceiro vídeo na fila" });
    const thirdItem = ui.qa(".yt-queue-item").find((el) => el.textContent.includes("descartar.mp4"));
    await ui.click(thirdItem.querySelector('[data-testid^="queue-remove-"]'));
    await waitFor(() => ui.qa(".yt-queue-item").length === 2, { label: "item removido da fila" });
    check(true, "vídeo pode ser removido da fila antes do envio");

    // modal da fila
    await ui.clickTestId("open-queue");
    await waitFor(() => ui.q(".yt-modal .yt-picker-item"), { label: "modal da fila" });
    check(ui.qa(".yt-modal .yt-picker-item").length === 2, "modal da fila lista os vídeos com status individual");
    await ui.click(ui.q(".yt-modal-head .yt-icon-btn"));
    await waitFor(() => !ui.q(".yt-modal-backdrop"), { label: "modal fechado" });

    // envio em lote (sequencial)
    const seenStatus = new Set();
    const statusPoller = setInterval(() => {
      for (const badge of ui.qa(".yt-queue-item .yt-badge")) seenStatus.add(badge.textContent.trim());
    }, 25);
    await ui.clickTestId("send-all");
    await waitFor(async () => (await getMockState()).videos.length >= 2, { label: "fila enviada", timeout: 240000 });
    await waitFor(() => ui.qa(".yt-queue-item").every((el) => /Concluído|Processando/.test(el.textContent)), {
      label: "fila concluída",
      timeout: 90000,
    });
    clearInterval(statusPoller);
    check([...seenStatus].some((label) => /Enviando|Aguardando|Processando|Concluído/.test(label)), `status da fila acompanhados (${[...seenStatus].join(", ")})`);

    const finalState = await getMockState();
    check(finalState.videos.length === 2, `envio em lote publicou o vídeo pendente (${finalState.videos.length} vídeos no total)`);
    check(finalState.thumbnails.length >= 1, "miniatura personalizada enviada pela API (thumbnails.set)");
    check(finalState.playlistItems.length === 2, "os dois vídeos foram para a playlist escolhida");
    const secondVideo = finalState.videos.find((video) => /segundo/i.test(video.snippet.title));
    check(Boolean(secondVideo), `segundo vídeo publicado com o próprio título (${secondVideo && secondVideo.snippet.title})`);
    check(
      secondVideo && secondVideo.snippet.description === sourceDescription,
      "segundo vídeo herdou a descrição compartilhada do lote",
    );
    check(
      secondVideo && secondVideo.snippet.tags.join("|") === sourceTagsAfterEdit.join("|"),
      "segundo vídeo herdou as tags compartilhadas do lote",
    );
    check(
      Boolean(secondVideo && secondVideo.snippet.categoryId === "10") &&
        finalState.playlistItems.filter((item) => item.snippet.playlistId === "PL_MUSICA").length === 2,
      "segundo vídeo herdou categoria, privacidade e playlist do lote",
    );

    await ui.clickTestId("tab-history");
    await waitFor(() => ui.qa(".yt-history-item").length >= 2, { label: "histórico com os envios do lote" });
    check(true, `histórico acumula todos os envios (${ui.qa(".yt-history-item").length} itens)`);

    /* ── 13c. fila, metadados e uploads sobrevivem à navegação ── */
    await ui.clickTestId("tab-send");
    await addFile(new window.File([Buffer.alloc(6 * 1024 * 1024).fill(11)], "persistente.mp4", { type: "video/mp4" }));
    await waitFor(() => ui.qa(".yt-queue-item").length === 3, { label: "terceiro vídeo na fila" });
    const persistentItem = ui.qa(".yt-queue-item").find((el) => el.textContent.includes("persistente.mp4"));
    await ui.click(persistentItem.querySelector('[data-testid^="queue-select-"]'));
    await waitFor(() => ui.q("#ytTitle") && ui.q("#ytTitle").value !== "Show ao vivo — Mix eletrônico", { label: "novo vídeo ativo" });
    await ui.setValue(ui.q("#ytTitle"), "Vídeo persistente");
    await ui.setValue(ui.q("#ytDescription"), "Descrição que não pode se perder ao trocar de aba.");

    await ui.clickTestId("tab-history");
    await waitFor(() => ui.q(".yt-history-item"), { label: "aba histórico" });
    await ui.clickTestId("tab-send");
    await waitFor(() => ui.qa(".yt-queue-item").length === 3, { label: "fila preservada" });
    check(true, "a fila de vídeos continua intacta ao trocar de aba");
    check(ui.q("#ytTitle").value === "Vídeo persistente", "título preservado ao trocar de aba");
    check(ui.q("#ytDescription").value.includes("não pode se perder"), "descrição preservada ao trocar de aba");

    // o envio não pode ser interrompido por navegação
    await ui.clickTestId("goto-review");
    await waitFor(() => ui.q(".yt-review"), { label: "revisão do terceiro vídeo" });
    await ui.clickTestId("send-to-youtube");
    await waitFor(() => ui.q(".yt-progress-track"), { label: "envio iniciado" });
    await ui.clickTestId("tab-library");
    await sleep(300);
    await ui.clickTestId("nav-loopsync");
    await sleep(300);
    check(ui.byTestId("area-youtube").hidden === true, "área YouTube fica oculta — porém montada — no fluxo LoopSync");
    check(ui.byTestId("area-loopsync").hidden === false, "área LoopSync visível");
    await ui.clickTestId("nav-youtube");
    await ui.clickTestId("tab-send");
    await waitFor(() => ui.byTestId("upload-done"), { label: "upload concluído após navegar", timeout: 240000 });
    check(true, "upload em andamento continua ao trocar de aba e de área (não é abortado)");
    const afterNav = await getMockState();
    check(afterNav.videos.length === 3, `três vídeos publicados no total (${afterNav.videos.length})`);

    /* ── 14. desconexão ── */
    await ui.clickTestId("tab-connection");
    await waitFor(() => ui.byTestId("disconnect-channel"), { label: "botão desconectar" });
    check(ui.bodyText().includes("Canal conectado"), "status da conexão visível");
    check(ui.bodyText().includes("client secret") || ui.bodyText().includes("access token"), "painel explica o tratamento seguro dos tokens");
    await ui.clickTestId("disconnect-channel");
    await waitFor(() => ui.q(".yt-modal-foot .btn.danger"), { label: "confirmação de desconexão" });
    await ui.click(ui.q(".yt-modal-foot .btn.danger"));
    await waitFor(() => ui.q(".yt-channel-chip.off"), { label: "canal desconectado" });
    check(true, "desconexão do canal pela interface");

    /* ── 15. fluxo principal do LoopSync continua funcionando ── */
    await ui.clickTestId("nav-loopsync");
    await waitFor(() => ui.q("#videoInput") && ui.q("#audioInput"), { label: "formulário do LoopSync" });
    check(ui.bodyText().includes("Vídeo + música"), "fluxo principal do LoopSync intacto");

    const problems = consoleErrors.filter((line) => !/React does not recognize|not wrapped in act|Not implemented/i.test(line));
    check(
      problems.length === 0,
      problems.length === 0 ? "sem erros no console da página" : `sem erros no console (${problems.slice(0, 3).join(" | ")})`,
    );
  } finally {
    try { root.unmount(); } catch { /* ignore */ }
    await server.stop();
    await mock.close();
    dom.window.close();
  }

  console.log(`\n${checks - failures}/${checks} verificações de interface passaram.`);
  if (failures) {
    console.log(`\nResumo das ${failures} falha(s):`);
    failedMessages.forEach((message, index) => console.log(`  ${index + 1}. ${message}`));
    console.log("\nLogs do servidor (últimas linhas):");
    console.log(server.logs().split("\n").slice(-30).join("\n"));
    process.exit(1);
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log("Interface do módulo YouTube validada em jsdom.");
  await stopEsbuild();
  process.exit(0);
}

async function stopEsbuild() {
  try {
    const esbuild = require("esbuild");
    if (typeof esbuild.stop === "function") await esbuild.stop();
  } catch {
    /* ignore */
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nTESTE DE UI FALHOU:", err);
    process.exit(1);
  });
}

module.exports = { main };
