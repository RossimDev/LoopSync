"use strict";

/**
 * Teste E2E do modo estático (Vercel): serve public/ SEM backend e valida no
 * Chromium headless que o fluxo completo funciona com ffmpeg.wasm:
 *   selecionar vídeo + áudio -> GERAR VÍDEO -> MP4 real com duração == áudio.
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const { createTestAssets } = require("./make-test-assets");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = 8123;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function staticServer() {
  return http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found"); // inclui /health -> modo navegador
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function main() {
  const chromium = require("@sparticuz/chromium").default || require("@sparticuz/chromium");
  const puppeteer = require("puppeteer-core");

  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "loopsync-e2e-"));
  console.log("Gerando mídia de teste…");
  await createTestAssets(assets);

  const server = staticServer();
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  console.log(`Servidor estático (sem backend) em http://127.0.0.1:${PORT}`);

  const browser = await puppeteer.launch({
    args: [...chromium.args, "--no-sandbox"],
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error" || t === "warn") console.log(`  [browser ${t}]`, msg.text());
    });
    page.on("pageerror", (err) => console.log("  [pageerror]", err.message));

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle0" });

    page.on("response", (res) => {
      if (res.status() >= 400 && !res.url().endsWith("/health")) {
        console.log(`  [http ${res.status()}]`, res.url());
      }
    });
    page.on("requestfailed", (req) => console.log("  [reqfail]", req.url(), req.failure() && req.failure().errorText));

    // Cenário: vídeo 5s + áudio 20s => 4 loops, saída 20s
    const videoInput = await page.$("#videoInput");
    const audioInput = await page.$("#audioInput");
    await videoInput.uploadFile(path.join(assets, "video-05.mp4"));
    await audioInput.uploadFile(path.join(assets, "audio-20.m4a"));

    await page.waitForFunction(
      () => !document.getElementById("generateBtn").disabled,
      { timeout: 15000 }
    );

    const info = await page.evaluate(() => ({
      video: document.getElementById("infoVideoDuration").textContent,
      audio: document.getElementById("infoAudioDuration").textContent,
      loops: document.getElementById("infoLoops").textContent,
    }));
    console.log("Painel de informações:", JSON.stringify(info));
    if (info.loops !== "4") throw new Error(`loops esperado 4, obtido ${info.loops}`);

    console.log("Clicando em GERAR VÍDEO (processamento no navegador)…");
    await page.click("#generateBtn");

    const monitor = setInterval(async () => {
      try {
        const s = await page.evaluate(() => ({
          progress: document.getElementById("progressText").textContent,
          toast: document.getElementById("toast").textContent,
          form: !document.getElementById("appForm").hidden,
          result: !document.getElementById("resultPanel").hidden,
        }));
        console.log("  [estado]", JSON.stringify(s));
      } catch { /* ignore */ }
    }, 8000);

    try {
      await page.waitForFunction(
        () => !document.getElementById("resultPanel").hidden,
        { timeout: 240000, polling: 500 }
      );
    } finally {
      clearInterval(monitor);
    }

    const result = await page.evaluate(() => ({
      duration: document.getElementById("resultDuration").textContent,
      meta: document.getElementById("resultMeta").textContent,
      href: document.getElementById("saveBtn").href,
      download: document.getElementById("saveBtn").getAttribute("download"),
    }));
    console.log("Resultado na tela:", JSON.stringify(result));

    if (!result.href.startsWith("blob:")) throw new Error("resultado não é um blob local");
    if (result.duration !== "00:20") throw new Error(`duração exibida ${result.duration} != 00:20`);

    // Baixa o blob de dentro da página e valida com ffprobe.
    const b64 = await page.evaluate(async (href) => {
      const buf = await (await fetch(href)).arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(bin);
    }, result.href);

    const outPath = path.join(assets, "e2e-output.mp4");
    fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
    console.log(`MP4 salvo (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB), validando com ffprobe…`);

    const probe = spawnSync(ffprobePath, [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", outPath,
    ], { encoding: "utf8" });
    if (probe.status !== 0) throw new Error("ffprobe falhou na saída");
    const parsed = JSON.parse(probe.stdout);
    const streams = parsed.streams.map((s) => `${s.codec_type}:${s.codec_name}`).join(", ");
    const duration = Number(parsed.format.duration);
    console.log(`Saída: ${streams} · duração=${duration.toFixed(3)}s`);

    if (!parsed.streams.some((s) => s.codec_type === "video")) throw new Error("sem faixa de vídeo");
    if (!parsed.streams.some((s) => s.codec_type === "audio")) throw new Error("sem faixa de áudio");
    const diffMs = Math.abs(duration - 20) * 1000;
    if (diffMs > 250) throw new Error(`duração difere do áudio em ${diffMs.toFixed(0)}ms`);

    console.log(`\nOK — modo navegador (Vercel) gera MP4 real com duração igual ao áudio (dif. ${diffMs.toFixed(0)}ms).`);
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(assets, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\nTESTE E2E FALHOU:", err.message);
  process.exit(1);
});
