"use strict";

/**
 * Teste E2E do módulo YouTube no navegador (Chromium headless).
 *
 * Sobe o servidor real do LoopSync + o mock dos endpoints do Google (apenas
 * para testes) e percorre o fluxo completo pela interface:
 *
 *   LoopSync → YouTube → conectar canal → selecionar vídeo → aplicar template
 *   → usar descrição salva → editar descrição → usar tags salvas → sugestões
 *   → título/categoria/privacidade/playlist → revisão → enviar → progresso
 *   → upload concluído → histórico
 *
 * Também valida:
 *   - edição NÃO altera a descrição salva (cópia de trabalho);
 *   - responsividade (desktop 1280×900 e celular 390×844 sem overflow);
 *   - ausência de erros de console/rede.
 *
 * Uso: npm run build && npm run test:youtube:browser
 *      (SCREENSHOTS=/caminho/para/salvar para guardar as capturas)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { startMockGoogle } = require("./mock-google");
const { createVideo, createAudio } = require("./make-test-assets");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const SCREENSHOT_DIR = process.env.SCREENSHOTS || "";

const CLIENT_ID = "e2e-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-e2e-secret";

let failures = 0;
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.log(`  ✗ ${message}`);
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
        LOOPSYNC_YT_STATUS_POLL_MS: "400",
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
    }, 25000);
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

async function screenshot(page, name) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`    📸 ${file}`);
}

async function clickTestId(page, testId, { timeout = 8000 } = {}) {
  const selector = `[data-testid="${testId}"]`;
  await page.waitForSelector(selector, { visible: true, timeout });
  await page.click(selector);
}

/**
 * Limpa um campo controlado pelo React.
 * Atribuir `input.value` diretamente não dispara a mudança (o rastreador de
 * valor do React considera o campo inalterado), então usamos o setter nativo
 * do protótipo antes de disparar o evento.
 */
async function clearField(page, selector) {
  await page.evaluate((sel) => {
    const input = document.querySelector(sel);
    if (!input) throw new Error(`campo não encontrado: ${sel}`);
    const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector);
}

async function textOf(page, selector) {
  return page.$eval(selector, (element) => element.textContent.trim()).catch(() => "");
}

async function main() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error("dist/ não encontrado. Rode 'npm run build' antes do teste de navegador.");
    process.exit(1);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopsync-yt-e2e-"));
  /* Chromium primeiro: se não houver navegador no ambiente, avisa e sai sem
     subir servidores (o teste em jsdom — npm run test:youtube:ui — cobre a
     mesma jornada de interface em qualquer máquina). */
  let browser = null;
  try {
    const puppeteer = require("puppeteer-core");
    const chromium = require("@sparticuz/chromium").default || require("@sparticuz/chromium");
    const executablePath =
      process.env.CHROME_PATH ||
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await chromium.executablePath());
    browser = await puppeteer.launch({
      args: [...(chromium.args || []), "--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
      executablePath,
      headless: true,
    });
  } catch (err) {
    console.log("\nChromium indisponível neste ambiente — teste de navegador IGNORADO.");
    console.log(`Motivo: ${String(err.message || err).split("\n")[0]}`);
    console.log("Instale as bibliotecas do Chromium (ex.: apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-liberation)");
    console.log("ou aponte CHROME_PATH para um Chrome/Chromium instalado.");
    console.log("Enquanto isso, rode: npm run test:youtube:ui  (mesma jornada, sem navegador).");
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(2);
  }

  const assets = path.join(workDir, "assets");
  fs.mkdirSync(assets, { recursive: true });
  console.log("Gerando mídia de teste (ffmpeg)…");
  await createVideo(path.join(assets, "video-e2e.mp4"), { duration: 4, width: 320, height: 180 });
  await createAudio(path.join(assets, "audio-e2e.m4a"), { duration: 8 });

  console.log("Subindo mock do Google (uso exclusivo de testes)…");
  const mock = await startMockGoogle({ port: 0 });
  console.log("Subindo o servidor do LoopSync…");
  const server = await startServer({ env: mock.env, dataDir: path.join(workDir, "data") });
  console.log(`LoopSync em ${server.base}\n`);

  const consoleErrors = [];
  const httpErrors = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on("response", (res) => {
      if (res.status() >= 400 && !res.url().includes("/health")) httpErrors.push(`${res.status()} ${res.url()}`);
    });

    /* ── 1. navegação até o YouTube ── */
    console.log("Fluxo principal:");
    await page.goto(`${server.base}/`, { waitUntil: "networkidle0" });
    await clickTestId(page, "nav-youtube");
    await page.waitForSelector(".yt-tabs", { timeout: 8000 });
    check(await page.$eval('[data-testid="nav-youtube"]', (el) => el.classList.contains("active")), "navegação LoopSync → YouTube");
    await screenshot(page, "01-youtube-desconectado");

    /* ── 2. conexão do canal (OAuth de ponta a ponta) ── */
    await clickTestId(page, "connect-cta");
    await page.waitForSelector(".yt-modal", { timeout: 5000 });
    await clickTestId(page, "connect-google-modal");
    await page.waitForFunction(
      () => document.body.innerText.includes("Canal conectado") || document.body.innerText.includes("canal conectado"),
      { timeout: 20000 }
    );
    await page.waitForSelector(".yt-channel-chip strong", { timeout: 8000 });
    const channelName = await page.$eval(".yt-channel-chip strong", (el) => el.textContent.trim());
    check(channelName.length > 0 && channelName !== "Canal não conectado", `canal conectado: "${channelName}"`);

    await clickTestId(page, "tab-connection");
    await page.waitForSelector(".yt-channel-avatar", { timeout: 8000 });
    const channelInfo = await page.$eval(".yt-channel-info", (el) => el.innerText);
    check(
      channelInfo.includes("Canal") && channelInfo.includes("Conta Google") && channelInfo.includes(channelName),
      "painel de conexão mostra nome do canal, conta e status",
    );
    check(Boolean(await page.$(".yt-channel-avatar img")), "avatar do canal exibido");
    check(channelInfo.includes("Token válido até"), "painel mostra validade do token (renovado automaticamente)");
    check(Boolean(await page.$('[data-testid="disconnect-channel"]')), "opção de desconectar disponível");
    await screenshot(page, "02-conexao");

    /* ── 3. biblioteca: criar descrição e conjunto de tags ── */
    await clickTestId(page, "tab-library");
    await page.waitForSelector('[data-testid="new-description"]', { timeout: 8000 });
    await clickTestId(page, "new-description");
    await page.waitForSelector("#libDescName", { timeout: 5000 });
    await page.type("#libDescName", "Descrição E2E");
    await page.click("#libDescContent");
    await page.type("#libDescContent", "Descrição original salva no E2E.\n\n#loopsync");
    await clickTestId(page, "save-description-library");
    await page.waitForFunction(() => document.body.innerText.includes("Descrição E2E"), { timeout: 8000 });
    check(true, "descrição salva criada na biblioteca");

    await clickTestId(page, "new-tagset");
    await page.waitForSelector("#libTagName", { timeout: 5000 });
    await page.type("#libTagName", "Tags E2E");
    const tagInput = await page.$(".yt-modal .yt-tag-compose .yt-input");
    for (const tag of ["musica", "remix", "dj"]) {
      await tagInput.type(tag);
      await tagInput.press("Enter");
    }
    const tagCount = await page.$$eval(".yt-modal .yt-tag", (els) => els.length);
    check(tagCount === 3, `3 tags adicionadas ao conjunto (obtidas: ${tagCount})`);
    await clickTestId(page, "save-tagset-library");
    await page.waitForFunction(() => document.body.innerText.includes("Tags E2E"), { timeout: 8000 });
    check(true, "conjunto de tags salvo na biblioteca");
    await screenshot(page, "03-biblioteca");

    /* ── 3b. biblioteca: duplicar, editar e excluir ── */
    const listDescriptions = () =>
      page.evaluate(async () => (await (await fetch("/api/youtube/descriptions")).json()).items);
    const descE2E = (await listDescriptions()).find((item) => item.name === "Descrição E2E");
    await clickTestId(page, `library-duplicate-description-${descE2E.id}`);
    await page.waitForFunction(
      () => document.body.innerText.includes("Descrição E2E (cópia)"),
      { timeout: 8000 },
    );
    check(true, "descrição duplicada na biblioteca");
    const copied = (await listDescriptions()).find((item) => item.name === "Descrição E2E (cópia)");
    check(copied.content === descE2E.content, "duplicação copia o conteúdo integral");

    await clickTestId(page, `library-edit-description-${copied.id}`);
    await page.waitForSelector("#libDescName", { timeout: 5000 });
    check((await page.$eval("#libDescName", (el) => el.value)) === copied.name, "editar carrega o nome existente");
    await clearField(page, "#libDescName");
    await page.type("#libDescName", "Descrição editada no E2E");
    await clickTestId(page, "save-description-library");
    await page.waitForFunction(() => document.body.innerText.includes("Descrição editada no E2E"), { timeout: 8000 });
    check(true, "descrição editada na biblioteca");

    await clickTestId(page, `library-delete-description-${copied.id}`);
    await page.waitForSelector('[data-testid="library-confirm-delete"]', { timeout: 5000 });
    check(true, "exclusão pede confirmação");
    await clickTestId(page, "library-confirm-delete");
    await page.waitForFunction(
      (id) => !document.body.innerText.includes("Descrição editada no E2E"),
      { timeout: 8000 },
      copied.id,
    );
    check(!(await listDescriptions()).some((item) => item.id === copied.id), "descrição excluída da biblioteca");
    await screenshot(page, "03b-biblioteca-crud");

    /* ── 4. selecionar vídeo ── */
    await clickTestId(page, "tab-send");
    await page.waitForSelector('[data-testid="video-input"]', { timeout: 8000 });
    const fileInput = await page.$('[data-testid="video-input"]');
    await fileInput.uploadFile(path.join(assets, "video-e2e.mp4"));
    await page.waitForSelector(".yt-queue-item", { timeout: 15000 });
    await page.waitForFunction(() => document.body.innerText.includes("video-e2e.mp4"), { timeout: 10000 });
    const fileInfo = await page.$eval(".yt-file-meta", (el) => el.innerText);
    check(/Tamanho/.test(fileInfo) && /Duração/.test(fileInfo) && /Formato/.test(fileInfo), "dados do arquivo exibidos (nome, tamanho, duração, formato)");
    await screenshot(page, "04-video-selecionado");

    /* ── 5. aplicar template ── */
    await clickTestId(page, "template-tpl_musica");
    await page.waitForFunction(() => {
      const badge = document.querySelector(".yt-badge.tone-accent");
      return badge && /Música \/ Remix/.test(badge.textContent);
    }, { timeout: 8000 });
    const afterTemplate = await page.$eval("#ytDescription", (el) => el.value);
    check(afterTemplate.includes("Produção/DJ"), "template aplicado preenche título/descrição/tags");
    const templateTags = await page.$$eval(".yt-tag", (els) => els.length);
    check(templateTags >= 5, `tags do template carregadas (${templateTags})`);

    /* ── 6. usar descrição salva e editar (sem alterar a salva) ── */
    await clickTestId(page, "pick-description");
    await page.waitForSelector(".yt-modal", { timeout: 5000 });
    const useButton = await page.$('[data-testid^="use-description-"]');
    await useButton.click();
    await page.waitForFunction(() => !document.querySelector(".yt-modal"), { timeout: 5000 });
    await page.waitForFunction(() => document.getElementById("ytDescription").value.includes("Descrição original salva no E2E"), { timeout: 5000 });
    check(true, "descrição salva carregada no campo de descrição");

    await page.click("#ytDescription");
    await page.keyboard.press("End");
    await page.type("#ytDescription", "\n\nEditado apenas neste envio.");
    const editedDescription = await page.$eval("#ytDescription", (el) => el.value);
    check(editedDescription.includes("Editado apenas neste envio"), "descrição editada livremente depois de carregada");
    check(await page.$eval(".yt-section-aside .yt-badge", (el) => el.textContent).then((t) => t.includes("editada")), "badge indica descrição salva editada");

    /* ── 7. usar tags salvas + sugestões ── */
    await clickTestId(page, "pick-tagset");
    await page.waitForSelector(".yt-modal", { timeout: 5000 });
    const useTags = await page.$('[data-testid^="use-tagset-"]');
    await useTags.click();
    await page.waitForFunction(() => !document.querySelector(".yt-modal"), { timeout: 5000 });
    const tagsAfterSet = await page.$$eval(".yt-tag-text", (els) => els.map((el) => el.textContent));
    check(tagsAfterSet.includes("musica") && tagsAfterSet.includes("remix"), "tags do conjunto salvas carregadas e somadas");

    await clickTestId(page, "generate-suggestions");
    await page.waitForSelector(".yt-suggestion:not([disabled])", { timeout: 15000 });
    const suggestionTexts = await page.$$eval(".yt-suggestion:not([disabled]) span", (els) => els.map((el) => el.textContent.trim()));
    check(suggestionTexts.length >= 3, `sugestões de tags geradas (${suggestionTexts.length})`);
    const beforeCount = await page.$$eval(".yt-tag", (els) => els.length);
    await page.click(".yt-suggestion:not([disabled])");
    await page.waitForFunction(
      (previous) => document.querySelectorAll(".yt-tag").length > previous,
      { timeout: 5000 },
      beforeCount
    );
    check(true, "sugestão adicionada somente após clique do usuário");

    const tagsBeforeAll = await page.$$eval(".yt-tag", (els) => els.length);
    await clickTestId(page, "add-all-suggestions");
    await page.waitForFunction((before) => document.querySelectorAll(".yt-tag").length > before, { timeout: 8000 }, tagsBeforeAll);
    const tagsAfterAll = await page.$$eval(".yt-tag", (els) => els.length);
    check(tagsAfterAll > tagsBeforeAll, `"Adicionar todas" inclui as sugestões (${tagsBeforeAll} → ${tagsAfterAll})`);
    const overLimit = await page.$$(".yt-tag-meter span[data-over='true']");
    check(overLimit.length === 0, `"Adicionar todas" respeita o limite de 500 caracteres (${await page.$eval(".yt-tag-meter", (el) => el.innerText)})`);

    await clickTestId(page, "clear-tags");
    await page.waitForFunction(() => document.querySelectorAll(".yt-tag").length === 0, { timeout: 5000 });
    check(true, '"Limpar tags" remove todas as tags');
    await clickTestId(page, "pick-tagset");
    await page.waitForSelector('[data-testid^="use-tagset-"]', { timeout: 5000 });
    await page.click('[data-testid^="use-tagset-"]');
    await page.waitForFunction(() => document.querySelectorAll(".yt-tag").length >= 3, { timeout: 5000 });
    check(true, "conjunto de tags recarregado depois de limpar");

    /* ── 8. editar / remover / reordenar tags ── */
    const firstTag = await page.$eval(".yt-tag-text", (el) => el.textContent);
    const editButtons = await page.$$(".yt-tag .yt-tag-tools button:nth-child(3)");
    await editButtons[0].click();
    await page.waitForSelector(".yt-tag-input", { timeout: 3000 });
    await clearField(page, ".yt-tag-input");
    await page.type(".yt-tag-input", "tag-editada-e2e");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (value) => [...document.querySelectorAll(".yt-tag-text")].some((el) => el.textContent === value),
      { timeout: 5000 },
      "tag-editada-e2e"
    );
    check(true, `tag editada (antes: "${firstTag}")`);

    const moveButton = await page.$(".yt-tag .yt-tag-tools button:nth-child(2)");
    await moveButton.click();
    const orderAfterMove = await page.$$eval(".yt-tag-text", (els) => els.map((el) => el.textContent));
    check(orderAfterMove[1] === "tag-editada-e2e", "tag reordenada com as setas");

    const removeButtons = await page.$$(".yt-tag .yt-tag-tools button:nth-child(4)");
    const countBeforeRemove = await page.$$eval(".yt-tag", (els) => els.length);
    await removeButtons[removeButtons.length - 1].click();
    await page.waitForFunction((before) => document.querySelectorAll(".yt-tag").length < before, { timeout: 5000 }, countBeforeRemove);
    check(true, "tag removida");

    /* ── 9. título + configurações ── */
    await clearField(page, "#ytTitle");
    await page.type("#ytTitle", "Vídeo E2E do LoopSync");
    const counter = await page.$eval(".yt-field-head .yt-counter", (el) => el.textContent);
    check(/^\d+\/100$/.test(counter), `contador de caracteres do título (${counter})`);

    await page.evaluate(() => {
      const segments = [...document.querySelectorAll(".yt-segment")];
      const publicOption = segments.find((el) => el.textContent.includes("Público"));
      publicOption.click();
    });
    check(await page.$eval(".yt-segment.active", (el) => el.textContent.includes("Público")), "privacidade alterada para Público");

    await page.waitForSelector("#ytCategory option[value='10']", { timeout: 15000 });
    await page.select("#ytCategory", "10");
    await page.waitForSelector("#ytPlaylist option[value='PL_MUSICA']", { timeout: 15000 });
    await page.select("#ytPlaylist", "PL_MUSICA");
    const categoryValue = await page.$eval("#ytCategory", (el) => el.value);
    const playlistValue = await page.$eval("#ytPlaylist", (el) => el.value);
    check(categoryValue === "10" && playlistValue === "PL_MUSICA", "categoria e playlist selecionadas via API");

    /* ── 10. thumbnail ── */
    const hasFrameThumb = await page.$(".yt-thumb-preview img");
    check(Boolean(hasFrameThumb), "thumbnail com preview (quadro capturado do vídeo)");

    const thumbPath = path.join(assets, "capa-e2e.png");
    fs.writeFileSync(
      thumbPath,
      Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478" +
          "9c6300010000050001" +
          "0d0a2db40000000049454e44ae426082",
        "hex",
      ),
    );
    const thumbInput = await page.$('[data-testid="thumbnail-input"]');
    await thumbInput.uploadFile(thumbPath);
    await page.waitForFunction(
      () => {
        const img = document.querySelector(".yt-thumb-preview img");
        return img && img.src.startsWith("data:image/png");
      },
      { timeout: 8000 },
    );
    check(true, "miniatura enviada pelo usuário aparece na prévia");
    check(
      (await page.$eval(".yt-thumb-source", (el) => el.textContent)).includes("capa-e2e.png"),
      "origem da miniatura exibida",
    );
    await clickTestId(page, "remove-thumbnail");
    await page.waitForFunction(
      () => !document.querySelector(".yt-thumb-preview img[src^='data:image/png']"),
      { timeout: 5000 },
    );
    check(true, "miniatura pode ser removida antes do envio");
    await clickTestId(page, "use-frame-thumbnail");
    await page.waitForFunction(() => Boolean(document.querySelector(".yt-thumb-preview img")), { timeout: 8000 });
    check(true, "quadro do vídeo pode ser usado como miniatura");
    await screenshot(page, "04b-thumbnail");

    /* ── 11. revisão ── */
    await clickTestId(page, "goto-review");
    await page.waitForSelector(".yt-review", { timeout: 8000 });
    const reviewText = await page.$eval(".yt-review", (el) => el.innerText);
    check(reviewText.includes("Vídeo E2E do LoopSync"), "revisão mostra o título");
    check(reviewText.includes("Descrição original salva no E2E"), "revisão mostra a descrição");
    check(reviewText.includes("Music"), "revisão mostra a categoria");
    check(reviewText.includes("Público"), "revisão mostra a privacidade");
    check(reviewText.includes("Músicas 2026"), "revisão mostra a playlist");
    check(reviewText.includes("tag-editada-e2e"), "revisão mostra as tags");
    check(Boolean(await page.$(".yt-review-thumb img")), "revisão mostra a thumbnail");
    await screenshot(page, "05-revisao");

    /* ── 12. envio + progresso + conclusão ── */
    await clickTestId(page, "send-to-youtube");
    await page.waitForSelector(".yt-progress-track", { timeout: 10000 });
    await screenshot(page, "06-progresso");
    await page.waitForSelector('[data-testid="upload-done"]', { timeout: 60000 });
    const doneText = await page.$eval('[data-testid="upload-done"]', (el) => el.innerText);
    check(doneText.includes("Upload concluído com sucesso!"), "mensagem de conclusão exibida");
    check(/vid_[a-f0-9]+/.test(doneText), "ID do vídeo exibido");
    check(doneText.includes("https://www.youtube.com/watch?v="), "link do vídeo exibido");
    const openHref = await page.$eval('[data-testid="open-on-youtube"]', (el) => el.getAttribute("href"));
    check(openHref && openHref.startsWith("https://www.youtube.com/watch?v="), `botão "Abrir no YouTube" (${openHref})`);
    await screenshot(page, "07-concluido");

    /* ── 13. histórico ── */
    await clickTestId(page, "tab-history");
    await page.waitForSelector(".yt-history-item", { timeout: 15000 });
    const historyText = await page.$eval(".yt-history-item", (el) => el.innerText);
    check(historyText.includes("Vídeo E2E do LoopSync"), "histórico mostra o título");
    check(/Concluído|Processando/.test(historyText), "histórico mostra o status");
    check(historyText.includes("Canal de"), "histórico mostra o canal");
    check(historyText.includes("Público"), "histórico mostra a privacidade");
    check(Boolean(await page.$('[data-testid^="history-open-"]')), "histórico tem link do vídeo");
    await screenshot(page, "08-historico");

    /* ── 14. descrição salva não foi alterada pela edição do envio ── */
    const descriptionsResponse = await page.evaluate(async () => {
      const res = await fetch("/api/youtube/descriptions");
      return res.json();
    });
    const saved = (descriptionsResponse.items || []).find((item) => item.name === "Descrição E2E");
    check(Boolean(saved), "descrição salva continua na biblioteca");
    check(saved && !saved.content.includes("Editado apenas neste envio"), "edição durante o upload NÃO alterou a descrição salva");

    const tagSetsResponse = await page.evaluate(async () => {
      const res = await fetch("/api/youtube/tagsets");
      return res.json();
    });
    const savedSet = (tagSetsResponse.items || []).find((item) => item.name === "Tags E2E");
    check(savedSet && savedSet.tags.length === 3 && !savedSet.tags.includes("tag-editada-e2e"), "edição das tags NÃO alterou o conjunto salvo");

    /* ── 15. lote: segundo vídeo + aplicar configuração a todos ── */
    await clickTestId(page, "tab-send");
    await page.waitForSelector('[data-testid="video-input"]', { timeout: 8000 });
    const secondInput = await page.$('[data-testid="video-input"]');
    await secondInput.uploadFile(path.join(assets, "audio-e2e.m4a"));
    const rejectedToast = await page.waitForFunction(
      () => {
        const toast = document.getElementById("toast");
        return toast ? toast.textContent : null;
      },
      { timeout: 8000 }
    ).catch(() => null);
    check(Boolean(rejectedToast), "arquivo que não é vídeo é recusado com aviso");
    check((await page.$$(".yt-queue-item")).length === 1, "arquivo inválido não entra na fila");

    await secondInput.uploadFile(path.join(assets, "video-e2e.mp4"));
    await page.waitForFunction(() => document.querySelectorAll(".yt-queue-item").length === 2, { timeout: 20000 });
    check(true, "vários vídeos formam uma fila de envio em lote");
    check(
      (await page.$eval(".yt-batch", (el) => el.innerText)).includes("Aplicar as configurações"),
      "controles de lote visíveis",
    );

    const sourceDescription = await page.$eval("#ytDescription", (el) => el.value);
    const sourceTags = await page.$$eval(".yt-tag-text", (els) => els.map((el) => el.textContent));
    await clickTestId(page, "apply-all-everything");
    const secondItem = await page.$$eval(".yt-queue-item", (els) =>
      els.map((el, index) => ({ index, text: el.innerText })),
    );
    const targetIndex = secondItem.find((item) => !/Concluído/.test(item.text)).index;
    await page.click(`.yt-queue-item:nth-of-type(${targetIndex + 1}) [data-testid^="queue-select-"]`);
    await page.waitForFunction(
      (expected) => document.getElementById("ytDescription").value === expected,
      { timeout: 8000 },
      sourceDescription,
    );
    check(true, "lote: descrição aplicada aos demais vídeos");
    const inheritedTags = await page.$$eval(".yt-tag-text", (els) => els.map((el) => el.textContent));
    check(inheritedTags.join("|") === sourceTags.join("|"), "lote: tags aplicadas aos demais vídeos");
    check(
      (await page.$eval("#ytCategory", (el) => el.value)) === "10" &&
        (await page.$eval(".yt-segment.active", (el) => el.textContent)).includes("Público"),
      "lote: categoria e privacidade aplicadas aos demais vídeos",
    );
    await screenshot(page, "12-lote");

    /* ── 15b. estado preservado ao navegar ── */
    await clearField(page, "#ytTitle");
    await page.type("#ytTitle", "Vídeo persistente E2E");
    await clickTestId(page, "tab-history");
    await page.waitForSelector(".yt-history-item", { timeout: 8000 });
    await clickTestId(page, "tab-send");
    await page.waitForFunction(() => document.querySelectorAll(".yt-queue-item").length === 2, { timeout: 8000 });
    check(
      (await page.$eval("#ytTitle", (el) => el.value)) === "Vídeo persistente E2E",
      "fila e metadados preservados ao trocar de aba",
    );

    await clickTestId(page, "nav-loopsync");
    await page.waitForFunction(() => document.querySelector('[data-testid="area-youtube"]').hidden === true, { timeout: 5000 });
    await clickTestId(page, "nav-youtube");
    await page.waitForFunction(() => document.querySelector('[data-testid="area-youtube"]').hidden === false, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll(".yt-queue-item").length === 2, { timeout: 8000 });
    check(
      (await page.$eval("#ytTitle", (el) => el.value)) === "Vídeo persistente E2E",
      "fila preservada ao alternar entre LoopSync e YouTube",
    );

    /* ── 16. responsividade ── */
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".yt-tabs", { timeout: 10000 });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    check(overflow.scrollWidth <= overflow.clientWidth + 1, `sem overflow horizontal no celular (${overflow.scrollWidth}≤${overflow.clientWidth})`);
    const tapTargets = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button, a.btn, .yt-tab, .nav-pill")];
      return buttons.filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.height < 30;
      }).length;
    });
    check(tapTargets === 0, `alvos de toque com altura ≥30px no celular (pequenos: ${tapTargets})`);
    await screenshot(page, "09-mobile");

    await page.setViewport({ width: 834, height: 1112, deviceScaleFactor: 1 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".yt-tabs", { timeout: 10000 });
    const tabletOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    check(tabletOverflow, "sem overflow horizontal no tablet");
    await screenshot(page, "10-tablet");

    /* ── 17. fluxo principal do LoopSync continua intacto ── */
    await page.setViewport({ width: 1280, height: 900 });
    await page.reload({ waitUntil: "networkidle0" });
    await clickTestId(page, "nav-loopsync");
    await page.waitForSelector("#videoInput", { timeout: 8000 });
    const mainVideo = await page.$("#videoInput");
    const mainAudio = await page.$("#audioInput");
    await mainVideo.uploadFile(path.join(assets, "video-e2e.mp4"));
    await mainAudio.uploadFile(path.join(assets, "audio-e2e.m4a"));
    await page.waitForFunction(() => {
      const btn = document.getElementById("generateBtn");
      return btn && !btn.disabled;
    }, { timeout: 20000 });
    await page.click("#generateBtn");
    await page.waitForSelector("#resultPanel", { timeout: 90000 });
    const resultDuration = await textOf(page, "#resultDuration");
    check(resultDuration === "00:08", `LoopSync continua gerando o vídeo (duração ${resultDuration})`);
    check(Boolean(await page.$("#sendToYouTubeBtn")), "botão 'Enviar para o YouTube' no resultado do LoopSync");

    /* ── 18. levar o resultado direto para o YouTube ── */
    await page.click("#sendToYouTubeBtn");
    await page.waitForSelector(".yt-queue-item", { timeout: 20000 });
    await page.waitForFunction(() => document.body.innerText.includes("Gerado no LoopSync"), { timeout: 15000 });
    check(true, "resultado do LoopSync enviado para a fila do YouTube sem re-download");
    await screenshot(page, "11-loopsync-para-youtube");

    await clickTestId(page, "goto-review");
    await page.waitForSelector(".yt-review", { timeout: 8000 });
    await clickTestId(page, "send-to-youtube");
    await page.waitForSelector('[data-testid="upload-done"]', { timeout: 90000 });
    check(true, "vídeo do LoopSync publicado no YouTube (fluxo integrado)");

    /* ── 19. higiene: erros de console/rede ── */
    const relevantConsoleErrors = consoleErrors.filter(
      (text) => !/favicon|Download the React DevTools|404 \(Not Found\)/i.test(text)
    );
    check(relevantConsoleErrors.length === 0, `sem erros de console (${relevantConsoleErrors.slice(0, 3).join(" | ")})`);
    const relevantHttpErrors = httpErrors.filter((entry) => !/\/health|favicon/.test(entry));
    check(relevantHttpErrors.length === 0, `sem erros HTTP (${relevantHttpErrors.slice(0, 3).join(" | ")})`);
  } finally {
    await browser.close();
    await server.stop();
    await mock.close();
  }

  console.log(`\n${checks - failures}/${checks} verificações de interface passaram.`);
  if (failures) {
    console.log("Logs do servidor (últimas linhas):");
    console.log(server.logs().split("\n").slice(-25).join("\n"));
    process.exit(1);
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log("Interface do módulo YouTube validada (desktop, tablet e celular).");
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nE2E DO YOUTUBE FALHOU:", err);
    process.exit(1);
  });
}

module.exports = { main };
