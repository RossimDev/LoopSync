"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const {
  generateSyncVideo,
  getMediaInfo,
  computeLoopCount,
  formatSeconds,
  VIDEO_DURATION_TOLERANCE_MS,
} = require("../lib/media");
const naming = require("../lib/naming");
const imageSize = require("../lib/image-size");
const { createTestAssets } = require("./make-test-assets");

let logicChecks = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function check(condition, message) {
  logicChecks += 1;
  assert(condition, message);
}
function equal(actual, expected, message) {
  check(actual === expected, `${message}: recebido ${JSON.stringify(actual)}, esperado ${JSON.stringify(expected)}`);
}
function deepEqual(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: recebido ${JSON.stringify(actual)}, esperado ${JSON.stringify(expected)}`);
}

async function validateMediaPipeline(root) {
  const assets = path.join(root, "assets");
  const outputs = path.join(root, "outputs");
  fs.mkdirSync(outputs, { recursive: true });
  console.log("Criando mídias sintéticas…");
  await createTestAssets(assets);

  const cases = [
    { id: "video-15-audio-120", label: "Vídeo 15s + áudio 2min", video: "video-15.mp4", audio: "audio-120.m4a", width: 320, height: 180 },
    { id: "video-30-audio-135", label: "Vídeo 30s + áudio 2min15s", video: "video-30.mp4", audio: "audio-135.m4a", width: 320, height: 180 },
    { id: "video-60-audio-20", label: "Vídeo 1min + áudio 20s", video: "video-60.mp4", audio: "audio-20.m4a", width: 320, height: 180 },
    { id: "video-30-audio-30", label: "Vídeo 30s + áudio 30s", video: "video-30.mp4", audio: "audio-30.m4a", width: 320, height: 180 },
    { id: "video-05-audio-20", label: "Vídeo 5s + áudio 20s", video: "video-05.mp4", audio: "audio-20.m4a", width: 320, height: 240 },
    { id: "photo-png-audio-20", label: "Foto PNG 320×180 + áudio 20s", video: "photo-test.png", audio: "audio-20.m4a", width: 320, height: 180, image: true },
    { id: "photo-jpg-audio-30", label: "Foto JPG 320×180 + áudio 30s", video: "photo-test.jpg", audio: "audio-30.m4a", width: 320, height: 180, image: true },
    { id: "photo-vertical", label: "Foto PNG → 1080×1920", video: "photo-test.png", audio: "audio-05.m4a", width: 1080, height: 1920, image: true, imageSize: { preset: "1080x1920", width: 1080, height: 1920 } },
    { id: "photo-square", label: "Foto JPG → 1080×1080", video: "photo-test.jpg", audio: "audio-05.m4a", width: 1080, height: 1080, image: true, imageSize: { preset: "1080x1080", width: 1080, height: 1080 } },
    { id: "photo-free-even", label: "Foto PNG → tamanho livre 641×361", video: "photo-test.png", audio: "audio-05.m4a", width: 640, height: 360, image: true, imageSize: { preset: "custom", width: 641, height: 361 } },
  ];

  let passed = 0;
  for (const testCase of cases) {
    const videoPath = path.join(assets, testCase.video);
    const audioPath = path.join(assets, testCase.audio);
    const outputPath = path.join(outputs, `${testCase.id}.mp4`);
    const infoVideo = getMediaInfo(videoPath);
    const infoAudio = getMediaInfo(audioPath);
    const expectedLoops = infoVideo.isImage ? 1 : computeLoopCount(infoVideo.duration, infoAudio.duration);

    process.stdout.write(`${testCase.label} … `);
    const started = Date.now();
    const result = await generateSyncVideo({ videoPath, audioPath, outputPath, imageSize: testCase.imageSize || null });
    const output = getMediaInfo(outputPath);
    const diffMs = Math.round(Math.abs((output.duration - infoAudio.duration) * 1000));

    assert(infoVideo.isImage === Boolean(testCase.image), `${testCase.id}: classificação de foto incorreta`);
    assert(fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0, `${testCase.id}: saída ausente`);
    assert(output.hasVideo && output.hasAudio, `${testCase.id}: saída precisa de vídeo e áudio`);
    assert(diffMs <= VIDEO_DURATION_TOLERANCE_MS, `${testCase.id}: duração difere em ${diffMs}ms`);
    assert(result.withinTolerance, `${testCase.id}: resultado fora da tolerância`);
    assert(result.loopCount === expectedLoops, `${testCase.id}: loops ${result.loopCount} != ${expectedLoops}`);
    assert(output.width === testCase.width && output.height === testCase.height, `${testCase.id}: resolução ${output.width}×${output.height} != ${testCase.width}×${testCase.height}`);
    if (testCase.imageSize) {
      assert(result.requestedWidth === testCase.width && result.requestedHeight === testCase.height, `${testCase.id}: tamanho solicitado não foi normalizado`);
    }
    passed += 1;
    console.log(`OK (${formatSeconds(output.duration)} · ${output.width}×${output.height} · loops=${result.loopCount} · ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
  console.log(`\n${passed}/${cases.length} cenários ffmpeg passaram.`);
}

function validateNaming() {
  console.log("\nValidando nomes de download…");
  equal(naming.outputFileName("mix de janeiro.mp3"), "mix de janeiro.mp4", "nome simples");
  equal(naming.outputFileName("trilha"), "trilha.mp4", "nome sem extensão");
  equal(naming.outputFileName("show: ao*vivo?/final.wav"), "final.mp4", "caminho com caracteres inválidos");
  equal(naming.outputFileName("C:\\sons\\jogos.m4a"), "jogos.mp4", "caminho Windows");
  equal(naming.outputFileName("   .mp3"), "video.mp4", "fallback vazio");
  equal(naming.sanitizeBaseName('a<b>c|"d.mp3'), "a b c d", "sanitização");
  equal(naming.outputFileName("jogos.mp3", { used: ["jogos.mp4"] }), "jogos (2).mp4", "segunda colisão");
  equal(naming.outputFileName("jogos.mp3", { used: ["jogos.mp4", "jogos (2).mp4"] }), "jogos (3).mp4", "terceira colisão");
  equal(naming.outputFileName("JOGOS.mp3", { used: ["jogos.mp4"] }), "JOGOS (2).mp4", "colisão sem diferenciar caixa");
  equal(naming.baseName("notas.txt"), "notas.txt", "extensão não-mídia preservada");
  equal(naming.baseName("pasta/áudio.flac"), "áudio", "Unicode preservado");
  equal(naming.sanitizeBaseName(`${"a".repeat(120)}.wav`).length, 100, "limite do nome");
  equal(
    naming.contentDisposition("attachment", "músicas de vídeos.mp4"),
    "attachment; filename=\"m_sicas de v_deos.mp4\"; filename*=UTF-8''m%C3%BAsicas%20de%20v%C3%ADdeos.mp4",
    "Content-Disposition RFC 5987"
  );
}

function validateImageSize() {
  console.log("Validando resoluções de foto…");
  deepEqual(imageSize.normalizeImageSize(null), null, "tamanho null");
  deepEqual(imageSize.normalizeImageSize({ preset: "original", width: 1920, height: 1080 }), null, "preset original");
  deepEqual(imageSize.normalizeImageSize({ preset: "custom", width: 1920, height: 1080 }), { width: 1920, height: 1080 }, "preset horizontal");
  deepEqual(imageSize.normalizeImageSize({ preset: "custom", width: 1080, height: 1920 }), { width: 1080, height: 1920 }, "preset vertical");
  deepEqual(imageSize.normalizeImageSize({ preset: "custom", width: 1080, height: 1080 }), { width: 1080, height: 1080 }, "preset quadrado");
  deepEqual(imageSize.normalizeImageSize({ preset: "custom", width: "720", height: "1280" }), { width: 720, height: 1280 }, "strings numéricas");
  deepEqual(imageSize.normalizeImageSize({ preset: "custom", width: 641, height: 361 }), { width: 640, height: 360 }, "lados ímpares");
  deepEqual(imageSize.normalizeImageSize({ preset: "custom", width: "", height: "" }), null, "campos vazios");
  deepEqual(imageSize.normalizeImageSize({ preset: "custom", width: 4, height: 2 }), { width: 16, height: 16 }, "mínimo");
  deepEqual(imageSize.normalizeImageSize({ preset: "custom", width: 9000, height: 9000 }), { width: 7680, height: 7680 }, "máximo");
  deepEqual(imageSize.normalizeImageSize({ preset: "custom", width: 0, height: 1080 }), null, "largura zero");
  deepEqual(imageSize.normalizeImageSize({ preset: "custom", width: 1920, height: 0 }), null, "altura zero");
  equal(imageSize.even(NaN), 0, "inválido");
  equal(imageSize.even(17), 16, "par abaixo");
  equal(imageSize.imageScaleFilter(null), "scale=trunc(iw/2)*2:trunc(ih/2)*2", "filtro original");
  equal(imageSize.imageScaleFilter({ width: 1080, height: 1920 }), "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1", "filtro com barras");
}

async function validateClientLogic(root) {
  console.log("Validando lógica ESM do navegador…");
  const esbuild = require("esbuild");
  const outfile = path.join(root, "client-logic.mjs");
  await esbuild.build({
    stdin: {
      contents: `
        export { buildArgs } from ${JSON.stringify(path.join(__dirname, "../src/lib/wasm.js"))};
        export { kindOfFile } from ${JSON.stringify(path.join(__dirname, "../src/lib/files.js"))};
        export * as naming from ${JSON.stringify(path.join(__dirname, "../src/lib/naming.js"))};
        export * as imageSize from ${JSON.stringify(path.join(__dirname, "../src/lib/image-size.js"))};
      `,
      sourcefile: "client-logic-entry.js",
      resolveDir: path.join(__dirname, ".."),
    },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const client = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);

  const kinds = [
    [{ name: "foto.JPG", type: "" }, "image"],
    [{ name: "clipe.mov", type: "" }, "video"],
    [{ name: "som.MP3", type: "" }, "audio"],
    [{ name: "qualquer.bin", type: "image/png" }, "image"],
    [{ name: "video.mp3", type: "video/mp4" }, "video"],
    [{ name: "audio.mp4", type: "audio/mpeg" }, "audio"],
    [{ name: "capa.webp", type: "application/octet-stream" }, "image"],
    [{ name: "filme.webm", type: "application/octet-stream" }, "video"],
    [{ name: "", type: "" }, "unknown"],
  ];
  for (const [file, expected] of kinds) equal(client.kindOfFile(file), expected, `kindOfFile ${file.name || "vazio"}`);

  const photoArgs = client.buildArgs({ videoName: "in_video.png", audioName: "in_audio.m4a", duration: 20, videoDuration: 0, copyVideo: true, isImage: true });
  check(photoArgs.includes("-loop") && photoArgs[photoArgs.indexOf("-loop") + 1] === "1", "foto usa -loop 1");
  check(photoArgs.includes("-framerate") && photoArgs[photoArgs.indexOf("-framerate") + 1] === "30", "foto usa 30 fps de entrada");
  check(!photoArgs.includes("-stream_loop"), "foto não usa -stream_loop");
  check(!photoArgs.includes("copy"), "foto não copia o stream");
  check(photoArgs.includes("scale=trunc(iw/2)*2:trunc(ih/2)*2"), "foto normaliza lados pares");
  check(photoArgs.includes("-r") && photoArgs[photoArgs.indexOf("-r") + 1] === "30", "foto sai a 30 fps");
  check(photoArgs.includes("-t") && photoArgs[photoArgs.indexOf("-t") + 1] === "20", "foto dura até o fim do áudio");

  const selected = { preset: "custom", width: 1080, height: 1920 };
  const sizedArgs = client.buildArgs({ videoName: "in_video.jpg", audioName: "in_audio.m4a", duration: 5, videoDuration: 0, isImage: true, imageSize: selected });
  equal(sizedArgs[sizedArgs.indexOf("-vf") + 1], imageSize.imageScaleFilter(selected), "filtro wasm igual ao servidor");
  const shortArgs = client.buildArgs({ videoName: "in_video.mp4", audioName: "in_audio.m4a", duration: 20, videoDuration: 5, copyVideo: true });
  check(shortArgs.includes("-stream_loop") && shortArgs.includes("copy"), "vídeo curto repete com cópia");
  const longArgs = client.buildArgs({ videoName: "in_video.mp4", audioName: "in_audio.m4a", duration: 20, videoDuration: 60, copyVideo: true });
  check(!longArgs.includes("-stream_loop"), "vídeo longo não repete");

  const names = ["mix.mp3", "C:\\sons\\jogos.m4a", "   .wav", "áudio final.flac"];
  deepEqual(names.map((name) => client.naming.outputFileName(name)), names.map((name) => naming.outputFileName(name)), "nomes CJS e ESM concordam");
  const sizes = [null, { preset: "original" }, { preset: "custom", width: "641", height: "361" }, { width: 9000, height: 4 }];
  deepEqual(sizes.map((size) => client.imageSize.normalizeImageSize(size)), sizes.map((size) => imageSize.normalizeImageSize(size)), "tamanhos CJS e ESM concordam");
  await esbuild.stop();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loopsync-validate-"));
  try {
    await validateMediaPipeline(root);
    validateNaming();
    validateImageSize();
    await validateClientLogic(root);
    console.log(`\n${logicChecks}/${logicChecks} verificações de lógica passaram.`);
    console.log("Todas as validações do LoopSync passaram.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(async (error) => {
    try {
      const esbuild = require("esbuild");
      await esbuild.stop();
    } catch { /* ignore */ }
    console.error("\nVALIDAÇÃO FALHOU:", error.message);
    process.exit(1);
  });
}

module.exports = { main, validateNaming, validateImageSize, validateClientLogic };
