"use strict";

/**
 * Jornada da interface principal em jsdom contra o servidor e ffmpeg reais.
 * Cobre foto, resolução, Unicode, arrastar/soltar, fila em massa, downloads e
 * entrega de vários resultados ao uploader do YouTube.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { JSDOM, VirtualConsole } = require("jsdom");
const { startMockGoogle } = require("./mock-google");
const { createImage, createVideo, createAudio } = require("./make-test-assets");
const { getMediaInfo } = require("../lib/media");

const ROOT = path.join(__dirname, "..");
const CLIENT_ID = "loopsync-ui-client.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-loopsync-ui-secret";
let checks = 0;
let failures = 0;
const failedMessages = [];

function check(condition, message) {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${message}`);
    return true;
  }
  failures += 1;
  failedMessages.push(message);
  console.log(`  ✗ ${message}`);
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, { timeout = 60000, interval = 40, label = "condição" } = {}) {
  const started = Date.now();
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started > timeout) {
      throw new Error(`tempo esgotado aguardando ${label}${lastError ? `: ${lastError.message}` : ""}`);
    }
    await sleep(interval);
  }
}

function startServer({ dataDir, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: "0",
        LOOPSYNC_DATA_DIR: dataDir,
        GOOGLE_CLIENT_ID: CLIENT_ID,
        GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`servidor não iniciou\n${stdout}\n${stderr}`)), 60000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        child,
        base: `http://127.0.0.1:${match[1]}`,
        logs: () => `${stdout}\n${stderr}`,
        stop: () => new Promise((done) => {
          if (child.exitCode != null) return done();
          child.once("exit", done);
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* noop */ } done(); }, 3000).unref();
        }),
      });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
  });
}

async function bundleProbe(workDir) {
  const esbuild = require("esbuild");
  const outfile = path.join(workDir, "loopsync-ui-probe.mjs");
  await esbuild.build({
    entryPoints: [path.join(__dirname, "ui-probe.jsx")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    target: "node22",
    loader: { ".css": "empty", ".svg": "text" },
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "silent",
  });
  return outfile;
}

function createDom(baseUrl) {
  const virtualConsole = new VirtualConsole();
  const consoleErrors = [];
  virtualConsole.on("jsdomError", (error) => {
    if (!/Not implemented|navigation/i.test(error.message)) consoleErrors.push(error.message);
  });
  virtualConsole.on("error", (...args) => consoleErrors.push(args.map(String).join(" ")));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `${baseUrl}/`, pretendToBeVisual: true, runScripts: "outside-only", virtualConsole,
  });
  const { window } = dom;
  const nativeFetch = globalThis.fetch;
  const jar = new Map();
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" && input.startsWith("/") ? `${baseUrl}${input}` : input;
    const headers = new Headers(init.headers || {});
    if (jar.size && !headers.has("cookie")) headers.set("cookie", [...jar].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await nativeFetch(url, { ...init, headers, redirect: init.redirect || "manual" });
    for (const cookie of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value || /Max-Age=0/i.test(cookie)) jar.delete(key); else jar.set(key, value);
    }
    return response;
  };

  let blobSequence = 0;
  window.URL.createObjectURL = () => `blob:loopsync-test-${++blobSequence}`;
  window.URL.revokeObjectURL = () => {};
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const realCreateElement = window.document.createElement.bind(window.document);
  window.document.createElement = (tag, options) => {
    const element = realCreateElement(tag, options);
    const type = String(tag).toLowerCase();
    if (type === "video") {
      Object.defineProperty(element, "duration", { value: 8, configurable: true });
      Object.defineProperty(element, "videoWidth", { value: 320, configurable: true });
      Object.defineProperty(element, "videoHeight", { value: 180, configurable: true });
      Object.defineProperty(element, "currentTime", {
        configurable: true,
        get: () => 0,
        set: () => setTimeout(() => element.onseeked?.(), 0),
      });
      element.play = () => Promise.resolve();
      element.pause = () => {};
      element.load = () => {};
      const remove = element.removeAttribute.bind(element);
      element.removeAttribute = (name) => { if (name !== "src") remove(name); };
      setTimeout(() => { element.onloadedmetadata?.(); element.onloadeddata?.(); }, 0);
    } else if (type === "audio") {
      Object.defineProperty(element, "duration", { value: 20, configurable: true });
      element.load = () => {};
      const remove = element.removeAttribute.bind(element);
      element.removeAttribute = (name) => { if (name !== "src") remove(name); };
      setTimeout(() => element.onloadedmetadata?.(), 0);
    } else if (type === "img") {
      Object.defineProperty(element, "naturalWidth", { value: 320, configurable: true });
      Object.defineProperty(element, "naturalHeight", { value: 180, configurable: true });
      setTimeout(() => element.onload?.(), 0);
    } else if (type === "canvas") {
      element.getContext = () => null;
      element.toBlob = (callback) => callback(null);
    }
    return element;
  };

  const downloads = [];
  window.HTMLAnchorElement.prototype.click = function clickAnchor() {
    downloads.push({ download: this.download, href: this.href });
  };
  return { dom, window, jar, downloads, consoleErrors };
}

function setGlobal(name, value) {
  Object.defineProperty(global, name, { value, writable: true, configurable: true });
}
function installGlobals(window) {
  const names = [
    "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLAnchorElement",
    "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "File", "FileList", "Blob",
    "FileReader", "FormData", "Headers", "Request", "Response", "DataTransfer", "XMLHttpRequest", "AbortController",
    "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia", "ResizeObserver",
    "IntersectionObserver", "DOMParser", "MutationObserver",
  ];
  for (const name of names) if (window[name] !== undefined) setGlobal(name, window[name]);
  setGlobal("window", window); setGlobal("document", window.document); setGlobal("navigator", window.navigator);
  setGlobal("location", window.location); setGlobal("history", window.history); setGlobal("localStorage", window.localStorage);
  setGlobal("fetch", window.fetch); setGlobal("URL", window.URL); setGlobal("IS_REACT_ACT_ENVIRONMENT", false);
}

function helpers(window) {
  const { document } = window;
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => [...document.querySelectorAll(selector)];
  const byTestId = (id) => q(`[data-testid="${id}"]`);
  const bodyText = () => document.body.textContent || "";
  const click = async (element) => {
    if (typeof element === "string") element = q(element);
    if (!element) throw new Error("elemento para clique não encontrado");
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(35);
  };
  const clickTestId = async (id) => {
    const element = await waitFor(() => {
      const candidate = byTestId(id);
      return candidate && !candidate.disabled ? candidate : null;
    }, { label: `${id} habilitado` });
    await click(element);
    return element;
  };
  const setValue = async (element, value) => {
    const proto = element instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    if (element instanceof window.HTMLSelectElement) {
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    } else {
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    await sleep(35);
  };
  const setFiles = async (input, files) => {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(35);
  };
  const dropFiles = async (element, files) => {
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"], dropEffect: "copy" } });
      element.dispatchEvent(event);
      await sleep(15);
    }
  };
  return { q, qa, byTestId, bodyText, click, clickTestId, setValue, setFiles, dropFiles };
}

async function performOAuth(window, baseUrl) {
  const start = await (await window.fetch("/api/youtube/auth/start")).json();
  const consent = await globalThis.fetch(start.url, { redirect: "manual" });
  const html = await consent.text();
  const match = /location\.replace\('([^']+)'\)/.exec(html);
  if (!match) throw new Error("mock OAuth não retornou callback");
  return window.fetch(match[1].replace(baseUrl, ""), { redirect: "manual" });
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsync-main-ui-"));
  const mediaDir = path.join(workDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  console.log("Criando mídias curtas para a jornada da interface…");
  await createImage(path.join(mediaDir, "photo.png"), { width: 320, height: 180, color: "orange" });
  await createVideo(path.join(mediaDir, "video.mp4"), { duration: 2, width: 320, height: 180 });
  await createAudio(path.join(mediaDir, "audio-20.m4a"), { duration: 20 });
  await createAudio(path.join(mediaDir, "audio-05.m4a"), { duration: 5 });

  const bundle = await bundleProbe(workDir);
  const mock = await startMockGoogle({ port: 0 });
  const server = await startServer({ dataDir: path.join(workDir, "data"), env: mock.env });
  const { dom, window, jar, downloads, consoleErrors } = createDom(server.base);
  installGlobals(window);
  const ui = helpers(window);
  let root;

  const photoBytes = fs.readFileSync(path.join(mediaDir, "photo.png"));
  const videoBytes = fs.readFileSync(path.join(mediaDir, "video.mp4"));
  const audio20Bytes = fs.readFileSync(path.join(mediaDir, "audio-20.m4a"));
  const audio05Bytes = fs.readFileSync(path.join(mediaDir, "audio-05.m4a"));
  const file = (bytes, name, type) => new window.File([bytes], name, { type });

  try {
    console.log("Conectando o mock do YouTube antes de montar o app…");
    const oauth = await performOAuth(window, server.base);
    check(oauth.status === 302, "OAuth do mock concluído antes do mount");
    check(jar.has("loopsync_session"), "sessão conectada disponível para o handoff do lote");

    const { mount } = await import(`${bundle}?v=${Date.now()}`);
    root = mount(window.document.getElementById("root"));
    await waitFor(() => ui.byTestId("loopsync-video-input"), { label: "formulário principal" });
    console.log("\nInterface LoopSync:");

    check(ui.byTestId("mode-single").textContent === "Vídeo único", "alternância exibe Vídeo único");
    check(ui.byTestId("mode-batch").textContent === "Em massa", "alternância exibe Em massa");
    check(ui.byTestId("mode-single").getAttribute("aria-pressed") === "true", "modo único começa ativo");
    check(ui.bodyText().includes("Vídeo ou imagem"), "card visual aceita vídeo ou imagem");
    check(ui.byTestId("select-visual").textContent === "Selecione vídeo ou imagem", "texto exato do botão visual");
    check(ui.byTestId("select-audio").textContent === "Selecione áudio", "texto exato do botão de áudio");
    check(ui.byTestId("loopsync-video-input").accept === "video/*,image/*", "accept visual contém vídeo e imagem");
    check(ui.byTestId("loopsync-audio-input").accept === "audio/*", "accept de áudio correto");
    check(ui.byTestId("loopsync-video-input").id === "videoInput", "input visual mantém id videoInput");
    check(ui.byTestId("loopsync-audio-input").id === "audioInput", "input de áudio mantém id audioInput");
    check(ui.byTestId("video-input") === null, "testid video-input continua reservado ao YouTube");
    check(ui.qa(".card-drop-hint").length === 2, "dica de arrastar aparece nos dois cards");

    const originalPhoto = file(photoBytes, "foto de verão.png", "image/png");
    const originalAudio = file(audio20Bytes, "áudio para edição.m4a", "audio/mp4");
    await ui.setFiles(ui.byTestId("loopsync-video-input"), [originalPhoto]);
    await waitFor(() => ui.byTestId("image-info"), { label: "metadados da foto" });
    check(ui.byTestId("image-info").textContent === "Foto 320×180 · vira um vídeo com a duração do áudio", "foto mostra dimensões e explica a duração");
    check(ui.bodyText().includes("Imagem selecionada"), "estado Imagem selecionada visível");
    check(ui.q('[data-card="video"] .card-icon').textContent === "🖼️", "ícone muda para imagem");
    check(Boolean(ui.byTestId("image-size-picker")), "picker aparece somente após escolher foto");
    check(ui.byTestId("image-size-select").value === "original", "resolução original é o padrão");
    check(ui.byTestId("image-size-summary").textContent.trim() === "Saída na resolução da foto (320×180).", "resumo usa a resolução da foto");

    await ui.setFiles(ui.byTestId("loopsync-audio-input"), [originalAudio]);
    await waitFor(() => ui.q("#infoPanel"), { label: "painel de informações" });
    check(ui.bodyText().includes("Loops (foto é fixa)"), "painel explica que foto é fixa");
    check(ui.q("#infoLoops").textContent === "1", "foto sempre informa um loop");
    check(ui.q("#infoAudioDuration").textContent === "00:20", "duração do áudio aparece no painel");
    check(!ui.q("#generateBtn").disabled, "geração habilita com foto e áudio");

    await ui.click("#generateBtn");
    await waitFor(() => ui.q("#saveBtn"), { timeout: 120000, label: "resultado da foto" });
    check(ui.q("#saveBtn").download === "áudio para edição.mp4", "download recebe o nome Unicode do áudio");
    check(!ui.q("#saveBtn").download.includes("LoopSync_"), "download não usa timestamp LoopSync_");
    check(ui.q("#saveBtn").href.includes("name="), "URL inclui nome solicitado para preservar Content-Disposition");
    const originalResponse = await window.fetch(ui.q("#saveBtn").getAttribute("href"));
    const disposition = originalResponse.headers.get("content-disposition") || "";
    check(disposition.includes("filename*=UTF-8''%C3%A1udio%20para%20edi%C3%A7%C3%A3o.mp4"), "Content-Disposition usa RFC 5987");
    const originalOut = path.join(workDir, "original-result.mp4");
    fs.writeFileSync(originalOut, Buffer.from(await originalResponse.arrayBuffer()));
    const originalInfo = getMediaInfo(originalOut);
    check(originalInfo.hasVideo && originalInfo.hasAudio, "MP4 de foto contém vídeo e áudio");
    check(Math.abs(originalInfo.duration - 20) <= 0.25, "MP4 de foto dura os 20s do áudio");
    check(originalInfo.width === 320 && originalInfo.height === 180, "resolução original 320×180 foi mantida");

    await ui.click("#resetBtn");
    await waitFor(() => ui.byTestId("loopsync-video-input"), { label: "formulário reiniciado" });
    const sizedPhoto = file(photoBytes, "capa.jpg", "image/jpeg");
    const gameAudio = file(audio05Bytes, "jogos.m4a", "audio/mp4");
    await ui.setFiles(ui.byTestId("loopsync-video-input"), [sizedPhoto]);
    await waitFor(() => ui.byTestId("image-size-select"), { label: "picker de tamanho" });
    await ui.setValue(ui.byTestId("image-size-select"), "custom");
    check(Boolean(ui.byTestId("image-size-width")) && Boolean(ui.byTestId("image-size-height")), "preset personalizado mostra largura e altura");
    await ui.setValue(ui.byTestId("image-size-width"), "641");
    await ui.setValue(ui.byTestId("image-size-height"), "361");
    check(ui.byTestId("image-size-summary").textContent.includes("Saída 640×360"), "custom 641×361 é normalizado para 640×360");
    check(ui.byTestId("image-size-summary").textContent.includes("barras pretas"), "resumo avisa sobre barras pretas");
    check(ui.byTestId("image-size-summary").textContent.includes("nada é esticado"), "resumo garante que nada é esticado");
    await ui.setValue(ui.byTestId("image-size-select"), "1080x1920");
    check(ui.byTestId("image-size-summary").textContent.includes("Saída 1080×1920"), "preset vertical aparece no resumo");
    await ui.setFiles(ui.byTestId("loopsync-audio-input"), [gameAudio]);
    await waitFor(() => !ui.q("#generateBtn").disabled, { label: "geração vertical habilitada" });
    await ui.click("#generateBtn");
    await waitFor(() => ui.q("#saveBtn"), { timeout: 120000, label: "resultado vertical" });
    check(ui.q("#saveBtn").download === "jogos.mp4", "preset mantém nome jogos.mp4");
    const verticalResponse = await window.fetch(ui.q("#saveBtn").getAttribute("href"));
    const verticalOut = path.join(workDir, "vertical-result.mp4");
    fs.writeFileSync(verticalOut, Buffer.from(await verticalResponse.arrayBuffer()));
    const verticalInfo = getMediaInfo(verticalOut);
    check(verticalInfo.width === 1080 && verticalInfo.height === 1920, "MP4 vertical real mede 1080×1920");
    check(Math.abs(verticalInfo.duration - 5) <= 0.25, "MP4 vertical dura o áudio de 5s");

    await ui.click("#resetBtn");
    const dropAudio = file(audio05Bytes, "trilha solta.m4a", "audio/mp4");
    const visualCard = await waitFor(() => ui.q('[data-card="video"]'), { label: "card visual após reiniciar" });
    const dragEnter = new window.Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(dragEnter, "dataTransfer", { value: { files: [dropAudio], dropEffect: "copy" } });
    visualCard.dispatchEvent(dragEnter);
    await sleep(30);
    check(visualCard.classList.contains("drop-active"), "dragenter destaca apenas a caixa visual");
    await ui.dropFiles(visualCard, [dropAudio]);
    await waitFor(() => ui.bodyText().includes("Áudio selecionado"), { label: "áudio reroteado" });
    check(ui.q('[data-card="audio"] .card-file').textContent === "trilha solta.m4a", "áudio solto na caixa visual foi reroteado");
    check(ui.q("#toast").textContent.includes("já coloquei na caixa de áudio"), "toast explica o reroteamento do áudio");
    const droppedPhoto = file(photoBytes, "foto solta.png", "image/png");
    await ui.dropFiles(ui.q('[data-card="audio"]'), [droppedPhoto]);
    await waitFor(() => ui.byTestId("image-info"), { label: "imagem reroteada" });
    check(ui.q('[data-card="video"] .card-file').textContent === "foto solta.png", "imagem solta no áudio foi reroteada");
    check(ui.q("#toast").textContent.includes("já coloquei na caixa de vídeo"), "toast explica o reroteamento da imagem");
    const unknown = file(Buffer.from("not media"), "notas.txt", "text/plain");
    await ui.dropFiles(ui.q('[data-card="video"]'), [unknown]);
    await waitFor(() => ui.q("#toast")?.textContent.includes("Não reconheci"), { label: "toast de desconhecido" });
    check(ui.q("#toast").textContent.includes("notas.txt"), "arquivo desconhecido é citado pelo nome");

    const batchPhoto = file(photoBytes, "foto lote.png", "image/png");
    const batchVideo = file(videoBytes, "vídeo lote.mp4", "video/mp4");
    const batchAudio1 = file(audio05Bytes, "jogos.m4a", "audio/mp4");
    const batchAudio2 = file(audio05Bytes, "jogos.m4a", "audio/mp4");
    await ui.setFiles(ui.byTestId("loopsync-video-input"), [batchPhoto, batchVideo, batchAudio1, batchAudio2]);
    await waitFor(() => ui.byTestId("batch-mode"), { label: "modo em massa automático" });
    check(ui.byTestId("mode-batch").getAttribute("aria-pressed") === "true", "vários arquivos abrem automaticamente Em massa");
    await waitFor(() => ui.byTestId("batch-visual-count").textContent === "2" && ui.byTestId("batch-audio-count").textContent === "2", { label: "seed do lote" });
    check(ui.byTestId("batch-visual-count").textContent === "2", "seed contém dois visuais");
    check(ui.byTestId("batch-audio-count").textContent === "2", "seed contém dois áudios");
    check(ui.byTestId("batch-visual-input").multiple, "input visual do lote aceita múltiplos arquivos");
    check(ui.byTestId("batch-audio-input").multiple, "input de áudio do lote aceita múltiplos arquivos");
    check(ui.byTestId("batch-visual-input").accept === "video/*,image/*", "accept visual do lote correto");
    check(Boolean(ui.byTestId("image-size-picker")), "lote com foto exibe picker compartilhado");

    await ui.clickTestId("batch-pair-order");
    await waitFor(() => ui.qa('[data-testid^="batch-row-row_"]').length === 2, { label: "combinação um a um" });
    check(ui.byTestId("batch-row-count").textContent.includes("2 item(ns)"), "combinar um a um cria duas rows");
    await ui.clickTestId("batch-clear");
    await waitFor(() => ui.byTestId("batch-row-count").textContent.startsWith("0 item"), { label: "fila limpa" });
    check(ui.bodyText().includes("Nada na fila ainda"), "fila vazia mostra orientação completa");

    const visualAll = ui.q('[data-testid^="visual-for-all-"]');
    await ui.click(visualAll);
    await waitFor(() => ui.qa('[data-testid^="batch-row-row_"]').length === 2, { label: "visual em todos" });
    const rowNames = ui.qa('[data-testid^="row-name-"]').map((element) => element.textContent);
    check(rowNames.includes("jogos.mp4"), "primeira row usa o nome do áudio");
    check(rowNames.includes("jogos (2).mp4"), "colisão recebe sufixo (2)");
    await ui.click(visualAll);
    await sleep(80);
    check(ui.qa('[data-testid^="batch-row-row_"]').length === 2, "addPairs não duplica o mesmo par");
    check(ui.byTestId("batch-row-count").textContent.includes("2 pendente(s)"), "contador informa dois pendentes");

    await ui.clickTestId("batch-generate-all");
    await waitFor(() => ui.qa('[data-testid^="batch-row-row_"][data-status="done"]').length === 2, { timeout: 180000, label: "duas gerações do lote" });
    check(ui.qa('[data-testid^="row-status-"]').every((element) => element.textContent === "Concluído"), "status individual termina como Concluído");
    check(ui.qa('[data-testid^="row-result-"]').every((element) => element.textContent.includes("320×180")), "cada resultado mostra a resolução");
    check(ui.byTestId("batch-row-count").textContent.includes("2 pronto(s)"), "contador informa dois prontos");
    check(ui.qa('[data-testid^="row-download-"]').map((element) => element.download).sort().join("|") === "jogos (2).mp4|jogos.mp4", "links de lote preservam nomes individuais");
    check(ui.qa('[data-testid^="row-youtube-"]').length === 2, "cada resultado oferece envio ao YouTube");

    const beforeDownloads = downloads.length;
    await ui.clickTestId("batch-download-all");
    await waitFor(() => downloads.length >= beforeDownloads + 2, { label: "dois downloads do lote" });
    const downloadedNames = downloads.slice(beforeDownloads).map((item) => item.download);
    check(downloadedNames.includes("jogos.mp4") && downloadedNames.includes("jogos (2).mp4"), "Baixar todos usa um nome por áudio");
    await waitFor(() => ui.q("#toast")?.textContent.includes("2 arquivo(s) baixado(s)"), { label: "toast de downloads" });
    check(true, "toast confirma os dois downloads");

    await ui.clickTestId("batch-send-all");
    await waitFor(() => ui.byTestId("area-youtube") && !ui.byTestId("area-youtube").hidden, { label: "navegação ao YouTube" });
    check(ui.byTestId("area-loopsync").hidden, "handoff esconde a área LoopSync");
    await waitFor(() => ui.qa(".yt-queue-item").length === 2, { timeout: 90000, label: "dois itens recebidos no YouTube" });
    const queueText = ui.qa(".yt-queue-item").map((element) => element.textContent).join(" ");
    check(queueText.includes("jogos.mp4") && queueText.includes("jogos (2).mp4"), "YouTube recebe os dois nomes do lote");
    check(ui.q("#toast")?.textContent.includes("2 vídeos gerados no LoopSync"), "toast do YouTube usa plural para o lote");
    check(ui.byTestId("video-input") !== null, "testid video-input pertence ao uploader do YouTube");

    const relevantErrors = consoleErrors.filter((message) => !/not wrapped in act|React does not recognize/i.test(message));
    check(relevantErrors.length === 0, relevantErrors.length ? `sem erros no console: ${relevantErrors.join(" | ")}` : "sem erros no console da página");
  } finally {
    try { root?.unmount(); } catch { /* noop */ }
    await server.stop();
    await mock.close();
    dom.window.close();
  }

  console.log(`\n${checks - failures}/${checks} verificações da interface LoopSync passaram.`);
  if (failures) {
    console.log("\nFalhas:");
    failedMessages.forEach((message, index) => console.log(`  ${index + 1}. ${message}`));
    console.log("\nLogs do servidor:");
    console.log(server.logs().split("\n").slice(-50).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Interface principal validada com servidor e ffmpeg reais.");
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  try { await require("esbuild").stop(); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error("\nTESTE DA INTERFACE LOOPSYNC FALHOU:", error);
    try { await require("esbuild").stop(); } catch { /* noop */ }
    process.exit(1);
  });
}

module.exports = { main };
