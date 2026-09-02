"use strict";

/**
 * LoopSync — processamento 100% no navegador com ffmpeg.wasm.
 *
 * Usado quando o app está hospedado como site estático (ex.: Vercel) e não
 * existe backend de processamento. A operação é exatamente a mesma do
 * servidor: repetir o vídeo com -stream_loop, cortar com -t na duração do
 * áudio, usar somente o áudio escolhido como trilha. Nenhuma edição criativa.
 *
 * Os arquivos nunca saem do dispositivo do usuário.
 */

(function () {
  // Arquivos auto-hospedados em /vendor (copiados dos pacotes npm no build),
  // para funcionar sem CDN externo e sem problemas de CORS.
  const FFMPEG_BASE = "/vendor";
  const UTIL_SCRIPT = "/vendor/ffmpeg-util.js";
  const CORE_BASE = "/vendor";

  const DURATION_TOLERANCE_S = 0.25;

  let scriptsPromise = null;
  let enginePromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
      document.head.appendChild(s);
    });
  }

  function loadScripts() {
    if (!scriptsPromise) {
      scriptsPromise = Promise.all([
        loadScript(`${FFMPEG_BASE}/ffmpeg.js`),
        loadScript(UTIL_SCRIPT),
      ]).catch((err) => {
        scriptsPromise = null;
        throw err;
      });
    }
    return scriptsPromise;
  }

  async function getEngine(onStatus) {
    await loadScripts();
    if (!enginePromise) {
      enginePromise = (async () => {
        const { FFmpeg } = window.FFmpegWASM;
        const { toBlobURL } = window.FFmpegUtil;
        const ffmpeg = new FFmpeg();
        if (typeof onStatus === "function") {
          onStatus("Carregando o motor de vídeo… (primeira vez pode demorar)");
        }
        const abs = (p) => new URL(p, window.location.href).href;
        const load = ffmpeg.load({
          coreURL: await toBlobURL(abs(`${CORE_BASE}/ffmpeg-core.js`), "text/javascript"),
          wasmURL: await toBlobURL(abs(`${CORE_BASE}/ffmpeg-core.wasm`), "application/wasm"),
          classWorkerURL: await toBlobURL(abs(`${FFMPEG_BASE}/814.ffmpeg.js`), "text/javascript"),
        });
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Tempo esgotado ao carregar o motor de vídeo. Verifique sua conexão e tente novamente.")), 180000)
        );
        await Promise.race([load, timeout]);
        return ffmpeg;
      })().catch((err) => {
        enginePromise = null;
        throw err;
      });
    }
    return enginePromise;
  }

  function extFor(file, fallback) {
    const name = (file && file.name) || "";
    const m = name.toLowerCase().match(/\.([a-z0-9]{1,7})$/);
    return m ? m[1] : fallback;
  }

  function buildArgs({ videoName, audioName, duration, videoDuration, copyVideo }) {
    const args = [];
    if (videoDuration < duration) {
      args.push("-stream_loop", "-1");
    }
    args.push("-i", videoName);
    args.push("-i", audioName);
    args.push("-map", "0:v:0");
    args.push("-map", "1:a:0");
    if (copyVideo) {
      args.push("-c:v", "copy");
    } else {
      args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p");
    }
    args.push("-c:a", "aac", "-b:a", "192k");
    args.push("-t", String(duration));
    args.push("-movflags", "+faststart");
    args.push("output.mp4");
    return args;
  }

  function blobDuration(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      const done = (value) => {
        URL.revokeObjectURL(url);
        v.removeAttribute("src");
        v.load();
        resolve(value);
      };
      v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : NaN);
      v.onerror = () => done(NaN);
      v.src = url;
    });
  }

  /**
   * Processa localmente. onProgress({ percent, text }).
   * Retorna { blob, actualDuration, usedCopy }.
   */
  async function processInBrowser({ videoFile, audioFile, videoDuration, audioDuration, onProgress }) {
    const report = (percent, text) => {
      if (typeof onProgress === "function") onProgress({ percent, text });
    };

    report(3, "Carregando o motor de vídeo…");
    const ffmpeg = await getEngine((text) => report(4, text));
    const { fetchFile } = window.FFmpegUtil;

    const videoName = `in_video.${extFor(videoFile, "mp4")}`;
    const audioName = `in_audio.${extFor(audioFile, "m4a")}`;
    const duration = audioDuration;

    report(8, "Preparando arquivos…");
    await ffmpeg.writeFile(videoName, await fetchFile(videoFile));
    await ffmpeg.writeFile(audioName, await fetchFile(audioFile));

    const onFfmpegProgress = ({ time }) => {
      const outSec = Number(time) / 1e6;
      if (Number.isFinite(outSec) && duration > 0) {
        const percent = Math.min(98, Math.max(10, Math.round((outSec / duration) * 100)));
        report(percent, "Repetindo vídeo até o final do áudio…");
      }
    };
    ffmpeg.on("progress", onFfmpegProgress);

    const cleanup = async () => {
      ffmpeg.off("progress", onFfmpegProgress);
      for (const f of [videoName, audioName, "output.mp4"]) {
        try { await ffmpeg.deleteFile(f); } catch { /* ignore */ }
      }
    };

    try {
      const run = async (copyVideo) => {
        const args = buildArgs({ videoName, audioName, duration, videoDuration, copyVideo });
        const code = await ffmpeg.exec(args);
        if (code !== 0) throw new Error(`ffmpeg saiu com código ${code}`);
        const data = await ffmpeg.readFile("output.mp4");
        if (!data || !data.byteLength) throw new Error("saída vazia");
        return new Blob([data.buffer ? data.buffer : data], { type: "video/mp4" });
      };

      let usedCopy = true;
      let blob;
      try {
        blob = await run(true);
      } catch {
        // Cópia incompatível com o contêiner/codec: recodifica preservando
        // todos os frames (nenhuma edição criativa).
        usedCopy = false;
        report(10, "Recodificando para garantir compatibilidade…");
        blob = await run(false);
      }

      // Precisão da duração: se o corte por keyframe (modo cópia) ficou fora
      // da tolerância, refaz com corte exato por frame.
      let actualDuration = await blobDuration(blob);
      if (
        usedCopy &&
        Number.isFinite(actualDuration) &&
        Math.abs(actualDuration - duration) > DURATION_TOLERANCE_S
      ) {
        usedCopy = false;
        report(12, "Ajustando o corte final com precisão…");
        blob = await run(false);
        actualDuration = await blobDuration(blob);
      }

      report(99, "Finalizando…");
      return {
        blob,
        actualDuration: Number.isFinite(actualDuration) ? actualDuration : duration,
        usedCopy,
      };
    } finally {
      await cleanup();
    }
  }

  window.LoopSyncWasm = { processInBrowser };
})();
