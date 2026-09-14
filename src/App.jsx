import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { processInBrowser } from "./lib/wasm.js";
import { kindOfFile, loadImageSize, loadVideoMeta, loadAudioDuration } from "./lib/files.js";
import { formatDuration } from "./lib/format.js";
import { outputFileName } from "./lib/naming.js";
import { DEFAULT_IMAGE_SIZE, normalizeImageSize, even } from "./lib/image-size.js";
import { DEFAULT_AUDIO_QUALITY, DEFAULT_VIDEO_QUALITY, videoQualityShort, audioQualityShort } from "./lib/quality.js";
import ImageSizePicker from "./ImageSizePicker.jsx";
import QualityPicker from "./QualityPicker.jsx";
import Batch from "./Batch.jsx";
import YouTube from "./youtube/YouTube.jsx";
import Bases from "./Bases.jsx";
import History from "./History.jsx";
import { addHistoryEntry, createThumbFromVideoFile } from "./lib/history.js";
import { saveBase as saveBaseFile } from "./lib/bases.js";
import "./youtube.css";

const REREAD_BYTES = 65536;
export const MAX_WASM_TOTAL_BYTES = 800 * 1024 * 1024;
export const MAX_WASM_REENCODE_BYTES = 400 * 1024 * 1024;

function computeLoopCount(videoSeconds, audioSeconds) {
  const video = Math.max(0.01, Math.round((Number(videoSeconds) || 0) * 10) / 10);
  const audio = Math.max(0, Math.round((Number(audioSeconds) || 0) * 10) / 10);
  if (audio <= 0) return 0;
  return video >= audio ? 1 : Math.max(1, Math.ceil(audio / video));
}

async function preReadFile(file) {
  const part = file.slice(0, REREAD_BYTES);
  if (typeof part.arrayBuffer === "function") {
    await part.arrayBuffer();
    return;
  }
  await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve();
    reader.onerror = () => reject(reader.error || new Error("file"));
    reader.readAsArrayBuffer(part);
  });
}

async function hasBackend() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch("/health", { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body && body.ok && body.service === "loopsync");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function uploadWithProgress(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/process");
    xhr.responseType = "json";
    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && typeof onProgress === "function") onProgress(event.loaded / event.total);
      };
    }
    xhr.onload = () => {
      let body = xhr.response;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = null; }
      }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.ok && body.id) resolve(body);
      else reject(new Error((body && body.error) || "Não foi possível enviar os arquivos."));
    };
    xhr.onerror = () => reject(new Error("Não foi possível conectar ao serviço de processamento."));
    xhr.send(formData);
  });
}

export async function pollJob(jobId, onProgress) {
  for (;;) {
    const response = await fetch(`/api/process/${jobId}`);
    if (!response.ok) throw new Error("Não foi possível acompanhar o processamento.");
    const body = await response.json();
    if (typeof onProgress === "function") onProgress(body);
    if (body.status === "done") return body;
    if (body.status === "error") throw new Error(body.error || "Não foi possível gerar o vídeo.");
    await new Promise((resolve) => setTimeout(resolve, 650));
  }
}

const springTransition = { type: "spring", stiffness: 260, damping: 26 };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.08 } } };
const fadeUp = { hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0, transition: springTransition } };
const childFadeUp = { hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0, transition: springTransition } };

function areaFromHash() {
  const h = String(window.location.hash || "");
  if (h.startsWith("#/youtube")) return "youtube";
  if (h.startsWith("#/bases")) return "bases";
  if (h.startsWith("#/history")) return "history";
  return "loopsync";
}

function visualOutputDimensions(visual, imageSize) {
  if (!visual) return { width: 0, height: 0 };
  if (visual.kind !== "image") return { width: visual.width, height: visual.height };
  const requested = normalizeImageSize(imageSize);
  return requested || { width: even(visual.width), height: even(visual.height) };
}

export default function App() {
  const [area, setArea] = useState(areaFromHash);
  const [youtubeMounted, setYoutubeMounted] = useState(areaFromHash() === "youtube");
  const [basesMounted, setBasesMounted] = useState(areaFromHash() === "bases");
  const [historyMounted, setHistoryMounted] = useState(areaFromHash() === "history");
  const [incomingVideo, setIncomingVideo] = useState(null);

  const [mode, setMode] = useState("single");
  const [batchSeed, setBatchSeed] = useState(null);
  const [outputSize, setOutputSize] = useState(DEFAULT_IMAGE_SIZE);
  const [videoQuality, setVideoQuality] = useState(DEFAULT_VIDEO_QUALITY);
  const [audioQuality, setAudioQuality] = useState(DEFAULT_AUDIO_QUALITY);
  const [screen, setScreen] = useState("form");
  const [visual, setVisual] = useState(null);
  const [audio, setAudio] = useState(null);
  const [dragTarget, setDragTarget] = useState(null);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("Preparando arquivos…");
  const [result, setResult] = useState(null);
  const [toast, setToast] = useState(null);
  const [toastType, setToastType] = useState("info");

  const videoInputRef = useRef(null);
  const audioInputRef = useRef(null);
  const resultVideoRef = useRef(null);
  const busyRef = useRef(false);
  const jobIdRef = useRef(null);
  const resultBlobUrlRef = useRef(null);
  const toastTimerRef = useRef(null);

  const showToast = useCallback((message, type = "info") => {
    setToast(message);
    setToastType(type);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3600);
  }, []);

  useEffect(() => () => {
    clearTimeout(toastTimerRef.current);
    if (resultBlobUrlRef.current) URL.revokeObjectURL(resultBlobUrlRef.current);
  }, []);

  useEffect(() => {
    if (area === "youtube") setYoutubeMounted(true);
    if (area === "bases") setBasesMounted(true);
    if (area === "history") setHistoryMounted(true);
  }, [area]);

  const navigate = useCallback((next) => {
    setArea(next);
    const map = {
      youtube: "#/youtube",
      bases: "#/bases",
      history: "#/history",
      loopsync: "#/",
    };
    const target = map[next] || "#/";
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${target}`);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const onHashChange = () => setArea(areaFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const chooseMode = useCallback((next) => {
    if (busyRef.current) return;
    setMode(next);
    setScreen("form");
  }, []);

  const applyVisual = useCallback(async (file) => {
    const kind = kindOfFile(file);
    try {
      if (kind === "image") {
        const size = await loadImageSize(file);
        setVisual({ file, name: file.name, size: file.size, kind, duration: 0, ...size });
      } else if (kind === "video") {
        const meta = await loadVideoMeta(file);
        setVisual({ file, name: file.name, size: file.size, kind, ...meta });
      }
    } catch {
      showToast(
        kind === "image"
          ? "Não foi possível utilizar esta imagem. Escolha outra foto."
          : "Não foi possível utilizar este arquivo. Escolha outro vídeo.",
        "error"
      );
      if (videoInputRef.current) videoInputRef.current.value = "";
    }
  }, [showToast]);

  const applyAudio = useCallback(async (file) => {
    try {
      const duration = await loadAudioDuration(file);
      setAudio({ file, name: file.name, size: file.size, kind: "audio", duration });
    } catch {
      showToast("Não foi possível utilizar este arquivo. Escolha outro áudio.", "error");
      if (audioInputRef.current) audioInputRef.current.value = "";
    }
  }, [showToast]);

  const receiveFiles = useCallback(async (fileList, target) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const classified = files.map((file) => ({ file, kind: kindOfFile(file) }));
    const visuals = classified.filter((item) => item.kind === "video" || item.kind === "image");
    const audios = classified.filter((item) => item.kind === "audio");
    const unknown = classified.filter((item) => item.kind === "unknown");

    if (mode === "single" && (visuals.length > 1 || audios.length > 1)) {
      setBatchSeed({ id: Date.now(), files: classified.filter((item) => item.kind !== "unknown").map((item) => item.file) });
      setMode("batch");
      setScreen("form");
      showToast("Vários arquivos de uma vez: abri o modo Em massa com todos eles.");
      if (unknown.length) {
        setTimeout(() => showToast(`Não reconheci: ${unknown.map((item) => item.file.name).join(", ")}. Envie vídeo, imagem ou áudio.`, "error"), 0);
      }
      return;
    }

    if (visuals[0]) await applyVisual(visuals[0].file);
    if (audios[0]) await applyAudio(audios[0].file);

    if (target === "video" && audios.length && !visuals.length) {
      showToast("Este arquivo é um áudio — já coloquei na caixa de áudio.");
    } else if (target === "audio" && visuals.length && !audios.length) {
      showToast("Este arquivo é um vídeo/imagem — já coloquei na caixa de vídeo.");
    } else if (!visuals.length && !audios.length) {
      showToast(
        target === "video"
          ? "Envie um vídeo (MP4, MOV, WebM…) ou uma imagem (JPG, PNG, WebP…)."
          : "Envie um áudio (MP3, WAV, M4A, FLAC…).",
        "error"
      );
    }

    if (unknown.length) {
      showToast(`Não reconheci: ${unknown.map((item) => item.file.name || "arquivo sem nome").join(", ")}. Envie vídeo, imagem ou áudio.`, "error");
    }
  }, [applyAudio, applyVisual, mode, showToast]);

  const dropHandlers = useCallback((target) => ({
    onDragEnter(event) {
      event.preventDefault();
      setDragTarget(target);
    },
    onDragOver(event) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragTarget(target);
    },
    onDragLeave(event) {
      if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
      setDragTarget((current) => current === target ? null : current);
    },
    onDrop(event) {
      event.preventDefault();
      setDragTarget(null);
      receiveFiles(event.dataTransfer && event.dataTransfer.files, target);
    },
  }), [receiveFiles]);

  const clearOldJob = useCallback(() => {
    if (jobIdRef.current) fetch(`/api/clear/${jobIdRef.current}`, { method: "POST" }).catch(() => {});
    jobIdRef.current = null;
    if (resultBlobUrlRef.current) {
      URL.revokeObjectURL(resultBlobUrlRef.current);
      resultBlobUrlRef.current = null;
    }
  }, []);

  const processPair = useCallback(async ({ visual: visualItem, audio: audioItem, fileName, onProgress }) => {
    try {
      await preReadFile(visualItem.file);
    } catch {
      throw new Error(
        visualItem.kind === "image"
          ? "Não foi possível ler a imagem selecionada. Selecione o arquivo novamente."
          : "Não foi possível ler o vídeo selecionado. Selecione o arquivo novamente."
      );
    }
    try {
      await preReadFile(audioItem.file);
    } catch {
      throw new Error("Não foi possível ler o áudio selecionado. Selecione o arquivo novamente.");
    }
    const selectedSize = visualItem.kind === "image" ? normalizeImageSize(outputSize) : null;
    const report = (percent, text) => {
      if (typeof onProgress === "function") onProgress(percent, text);
    };

    if (await hasBackend()) {
      const form = new FormData();
      form.append("video", visualItem.file, visualItem.file.name);
      form.append("audio", audioItem.file, audioItem.file.name);
      form.append("videoQuality", videoQuality);
      form.append("audioQuality", audioQuality);
      if (selectedSize) {
        form.append("imageWidth", String(selectedSize.width));
        form.append("imageHeight", String(selectedSize.height));
      }
      const accepted = await uploadWithProgress(form, (fraction) => {
        report(Math.round(fraction * 20), `Enviando arquivos… ${Math.round(fraction * 100)}%`);
      });
      const done = await pollJob(accepted.id, (job) => {
        const percent = Math.min(98, 20 + Math.round((Number(job.percent) || 0) * 0.78));
        const text = job.phase === "probing"
          ? "Reconhecendo arquivos…"
          : visualItem.kind === "image"
            ? "Gerando vídeo a partir da imagem…"
            : "Repetindo vídeo até o final do áudio…";
        report(percent, text);
      });
      const serverResult = done.result;
      report(100, "Finalizando…");
      return {
        jobId: accepted.id,
        downloadUrl: `${serverResult.downloadUrl}?name=${encodeURIComponent(fileName)}`,
        previewUrl: `${serverResult.downloadUrl}?inline=1`,
        sizeBytes: serverResult.sizeBytes,
        outputDuration: serverResult.outputDuration,
        actualDuration: audioItem.duration,
        width: serverResult.width,
        height: serverResult.height,
        loopCount: serverResult.loopCount,
        videoDuration: serverResult.videoDuration,
        audioDuration: serverResult.audioDuration,
        videoQuality: serverResult.videoQuality || videoQuality,
        audioQuality: serverResult.audioQuality || audioQuality,
        fileName,
        originalVisualName: visualItem.name,
        originalAudioName: audioItem.name,
        isImage: visualItem.kind === "image",
      };
    }

    const isImageFile = visualItem.kind === "image";
    const needsReencode = isImageFile || videoQuality !== "auto";
    const wasmLimit = needsReencode ? MAX_WASM_REENCODE_BYTES : MAX_WASM_TOTAL_BYTES;
    const totalBytes = (Number(visualItem.file.size) || 0) + (Number(audioItem.file.size) || 0);
    if (totalBytes > wasmLimit) {
      if (needsReencode) {
        throw new Error(
          "Os arquivos são grandes demais para processar no navegador com foto ou qualidade de vídeo personalizada (limite de 400 MB). Rode o servidor local com npm start ou use arquivos menores."
        );
      }
      throw new Error(
        "Os arquivos são grandes demais para processar no navegador (limite de 800 MB). Rode o servidor local com npm start ou use arquivos menores."
      );
    }
    const browserResult = await processInBrowser({
      videoFile: visualItem.file,
      audioFile: audioItem.file,
      videoDuration: visualItem.kind === "image" ? 0 : visualItem.duration,
      audioDuration: audioItem.duration,
      isImage: visualItem.kind === "image",
      imageSize: outputSize,
      videoQuality,
      audioQuality,
      onProgress: ({ percent, text }) => report(percent, text),
    });
    const blobUrl = URL.createObjectURL(browserResult.blob);
    const file = new File([browserResult.blob], fileName, { type: "video/mp4" });
    const dimensions = visualOutputDimensions(visualItem, outputSize);
    report(100, "Finalizando…");
    return {
      blobUrl,
      downloadUrl: blobUrl,
      previewUrl: blobUrl,
      sizeBytes: browserResult.blob.size,
      outputDuration: formatDuration(browserResult.actualDuration),
      actualDuration: browserResult.actualDuration,
      width: dimensions.width,
      height: dimensions.height,
      loopCount: visualItem.kind === "image" ? 1 : computeLoopCount(visualItem.duration, audioItem.duration),
      videoDuration: formatDuration(visualItem.duration),
      audioDuration: formatDuration(audioItem.duration),
      videoQuality: browserResult.videoQuality || videoQuality,
      audioQuality: browserResult.audioQuality || audioQuality,
      file,
      fileName,
      originalVisualName: visualItem.name,
      originalAudioName: audioItem.name,
      isImage: visualItem.kind === "image",
      blob: browserResult.blob,
    };
  }, [outputSize, videoQuality, audioQuality]);

  const visualReady = visual && (visual.kind === "image" ? Boolean(visual.file) : Number.isFinite(visual.duration));
  const audioReady = audio && Number.isFinite(audio.duration);
  const bothReady = Boolean(visualReady && audioReady);
  const loops = bothReady ? (visual.kind === "image" ? 1 : computeLoopCount(visual.duration, audio.duration)) : 0;

  const resetToEdit = useCallback(() => {
    busyRef.current = false;
    setScreen("form");
    setProgress(0);
    setProgressText("Preparando arquivos…");
  }, []);

  const resetAll = useCallback(() => {
    if (resultVideoRef.current) {
      try { resultVideoRef.current.pause(); } catch { /* noop */ }
      resultVideoRef.current.removeAttribute("src");
      try { resultVideoRef.current.load(); } catch { /* noop */ }
    }
    clearOldJob();
    setVisual(null);
    setAudio(null);
    setResult(null);
    setOutputSize(DEFAULT_IMAGE_SIZE);
    setVideoQuality(DEFAULT_VIDEO_QUALITY);
    setAudioQuality(DEFAULT_AUDIO_QUALITY);
    if (videoInputRef.current) videoInputRef.current.value = "";
    if (audioInputRef.current) audioInputRef.current.value = "";
    resetToEdit();
  }, [clearOldJob, resetToEdit]);

  const generate = useCallback(async () => {
    if (mode !== "single" || busyRef.current) return;
    if (!visual || !audio) {
      showToast("Selecione um vídeo ou imagem e um áudio para continuar.", "error");
      return;
    }
    clearOldJob();
    busyRef.current = true;
    setScreen("processing");
    setProgress(2);
    setProgressText("Preparando…");
    const fileName = outputFileName(audio.file.name);
    try {
      const generated = await processPair({
        visual,
        audio,
        fileName,
        onProgress(percent, text) {
          setProgress(percent);
          setProgressText(text);
        },
      });
      jobIdRef.current = generated.jobId || null;
      if (generated.blobUrl) resultBlobUrlRef.current = generated.blobUrl;
      setResult(generated);
      setProgress(100);
      setScreen("result");

      // ── Save to history ──
      try {
        let thumbDataUrl = null;
        if (generated.blob) {
          thumbDataUrl = await createThumbFromVideoFile(generated.blob);
        } else if (generated.previewUrl) {
          // For server mode, try to create thumb from preview URL after a short delay
          // We can't easily fetch server video blob for thumb in wasm helper if CORS,
          // but we can attempt using previewUrl as string (video element will load)
          // Skip for now - server will generate thumb itself
        }
        await addHistoryEntry({
          fileName: generated.fileName,
          sizeBytes: generated.sizeBytes,
          width: generated.width,
          height: generated.height,
          duration: generated.actualDuration,
          videoDuration: generated.videoDuration,
          audioDuration: generated.audioDuration,
          outputDuration: generated.outputDuration,
          loopCount: generated.loopCount,
          videoQuality: generated.videoQuality,
          audioQuality: generated.audioQuality,
          isImage: generated.isImage || visual.kind === "image",
          originalVisualName: generated.originalVisualName || visual.name,
          originalAudioName: generated.originalAudioName || audio.name,
          thumbDataUrl,
          blobUrl: generated.blobUrl,
          downloadUrl: generated.downloadUrl,
          jobId: generated.jobId,
        });
      } catch (e) {
        console.warn("History save failed", e);
      }
    } catch (error) {
      console.error("LoopSync:", error);
      showToast(error && error.message ? error.message : "Não foi possível gerar o vídeo.", "error");
      resetToEdit();
    } finally {
      busyRef.current = false;
    }
  }, [audio, clearOldJob, mode, processPair, resetToEdit, showToast, visual]);

  const shareResult = useCallback(async () => {
    if (!result) return;
    const fileName = result.fileName || "video.mp4";
    try {
      const response = await fetch(result.blobUrl || result.downloadUrl);
      if (!response.ok) throw new Error("download");
      const blob = await response.blob();
      const file = new File([blob], fileName, { type: blob.type || "video/mp4" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "LoopSync" });
        return;
      }
    } catch {
      // Download fallback below.
    }
    const anchor = document.createElement("a");
    anchor.href = result.downloadUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [result]);

  const sendToYouTube = useCallback(() => {
    if (!result) return;
    const item = result.jobId
      ? { sourceJobId: result.jobId, name: result.fileName || "video.mp4", size: Number(result.sizeBytes || 0), previewUrl: result.previewUrl, title: "" }
      : { file: result.file, name: result.fileName || "video.mp4", size: Number(result.sizeBytes || 0), previewUrl: result.previewUrl, title: "" };
    setIncomingVideo(item);
    navigate("youtube");
  }, [navigate, result]);

  const sendBatchToYouTube = useCallback((items) => {
    if (!items || !items.length) return;
    setIncomingVideo(items.length === 1 ? items[0] : { items });
    navigate("youtube");
  }, [navigate]);

  // Bases handlers
  const handleUseVisualBase = useCallback(async (file) => {
    await applyVisual(file);
    navigate("loopsync");
    showToast("Base visual carregada. Agora selecione o áudio.");
  }, [applyVisual, navigate, showToast]);

  const handleUseAudioBase = useCallback(async (file) => {
    await applyAudio(file);
    navigate("loopsync");
    showToast("Base de áudio carregada. Agora selecione o vídeo.");
  }, [applyAudio, navigate, showToast]);

  const handleSaveVisualBase = useCallback(async () => {
    if (!visual || !visual.file) {
      showToast("Nenhum visual para salvar.", "error");
      return;
    }
    try {
      await saveBaseFile(visual.file, { name: visual.name });
      showToast(`Vídeo/foto "${visual.name}" salvo nas bases!`, "info");
    } catch (e) {
      showToast(e.message || "Erro ao salvar base.", "error");
    }
  }, [visual, showToast]);

  const handleSaveAudioBase = useCallback(async () => {
    if (!audio || !audio.file) {
      showToast("Nenhum áudio para salvar.", "error");
      return;
    }
    try {
      await saveBaseFile(audio.file, { name: audio.name });
      showToast(`Áudio "${audio.name}" salvo nas bases!`, "info");
    } catch (e) {
      showToast(e.message || "Erro ao salvar base.", "error");
    }
  }, [audio, showToast]);

  return (
    <main className="page">
      <header className="hero">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 40 40" width="34" height="34" fill="none">
              <circle cx="20" cy="20" r="18" fill="#1d1a15" stroke="#ff8a3d" strokeWidth="2.5" />
              <path d="M16 13 L28 20 L16 27Z" fill="#ff8a3d" />
              <path d="M12 10 A14 14 0 0 1 30 14" stroke="#ff8a3d" strokeWidth="2" strokeLinecap="round" />
              <path d="M28 30 A14 14 0 0 1 10 26" stroke="#ff8a3d" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <div><h1>LoopSync</h1><p>Vídeo + música. Automaticamente.</p></div>
        </div>
        <span className="privacy-badge" title="Os arquivos temporários são apagados após o processamento.">🔒 Local &amp; privado</span>
      </header>

      <nav className="app-nav" aria-label="Áreas do LoopSync">
        <button type="button" className={`nav-pill${area === "loopsync" ? " active" : ""}`} data-testid="nav-loopsync" onClick={() => navigate("loopsync")} aria-current={area === "loopsync" ? "page" : undefined}><span aria-hidden="true">🎬</span> LoopSync</button>
        <button type="button" className={`nav-pill${area === "bases" ? " active" : ""}`} data-testid="nav-bases" onClick={() => navigate("bases")} aria-current={area === "bases" ? "page" : undefined}><span aria-hidden="true">📚</span> Bases</button>
        <button type="button" className={`nav-pill${area === "history" ? " active" : ""}`} data-testid="nav-history" onClick={() => navigate("history")} aria-current={area === "history" ? "page" : undefined}><span aria-hidden="true">🕘</span> Histórico</button>
        <button type="button" className={`nav-pill${area === "youtube" ? " active" : ""}`} data-testid="nav-youtube" onClick={() => navigate("youtube")} aria-current={area === "youtube" ? "page" : undefined}><span aria-hidden="true">▶</span> YouTube</button>
      </nav>

      {youtubeMounted ? (
        <div className="area-panel" data-testid="area-youtube" hidden={area !== "youtube"}>
          <YouTube showToast={showToast} incomingVideo={incomingVideo} onIncomingConsumed={() => setIncomingVideo(null)} />
        </div>
      ) : null}

      {basesMounted ? (
        <div className="area-panel" data-testid="area-bases" hidden={area !== "bases"}>
          <Bases showToast={showToast} onUseVisual={handleUseVisualBase} onUseAudio={handleUseAudioBase} currentVisual={visual} currentAudio={audio} />
        </div>
      ) : null}

      {historyMounted ? (
        <div className="area-panel" data-testid="area-history" hidden={area !== "history"}>
          <History showToast={showToast} />
        </div>
      ) : null}

      <div className="area-panel" data-testid="area-loopsync" hidden={area !== "loopsync" && area !== "bases" && area !== "history" && area !== "youtube" ? false : area !== "loopsync"}>
        <div className="mode-switch" role="group" aria-label="Modo de geração">
          <button type="button" className={mode === "single" ? "active" : ""} data-testid="mode-single" aria-pressed={mode === "single"} onClick={() => chooseMode("single")}>Vídeo único</button>
          <button type="button" className={mode === "batch" ? "active" : ""} data-testid="mode-batch" aria-pressed={mode === "batch"} onClick={() => chooseMode("batch")}>Em massa</button>
        </div>

        {mode === "batch" ? (
          <Batch
            processPair={processPair}
            onSendToYouTube={sendBatchToYouTube}
            showToast={showToast}
            seed={batchSeed}
            imageSize={outputSize}
            onImageSizeChange={setOutputSize}
            videoQuality={videoQuality}
            onVideoQualityChange={setVideoQuality}
            audioQuality={audioQuality}
            onAudioQualityChange={setAudioQuality}
          />
        ) : (
          <AnimatePresence mode="wait">
            {screen === "form" ? (
              <motion.form id="appForm" key="form" noValidate onSubmit={(event) => { event.preventDefault(); generate(); }} variants={stagger} initial="hidden" animate="show" exit={{ opacity: 0, y: -20, transition: springTransition }}>
                <motion.div className="grid" variants={fadeUp}>
                  <motion.article className={`card${visual ? " selected" : ""}${dragTarget === "video" ? " drop-active" : ""}`} data-card="video" variants={childFadeUp} whileHover={{ y: -4, transition: { duration: 0.2 } }} {...dropHandlers("video")}>
                    <div className="card-head"><span className="card-icon" aria-hidden="true">{visual?.kind === "image" ? "🖼️" : "🎬"}</span><h2>Vídeo ou imagem</h2></div>
                    <p className="card-state">{visual ? (visual.kind === "image" ? "Imagem selecionada" : "Vídeo selecionado") : "Nenhum vídeo ou imagem selecionado"}</p>
                    {visual ? <p className="card-file">{visual.name}</p> : null}
                    {visual?.kind === "image" ? <p className="card-file-sub" data-testid="image-info">Foto {visual.width}×{visual.height} · vira um vídeo com a duração do áudio</p> : null}
                    {visual?.kind === "image" ? <ImageSizePicker value={outputSize} onChange={setOutputSize} source={visual} idPrefix="singleImageSize" /> : null}
                    <button type="button" className="btn subtle" data-testid="select-visual" onClick={() => videoInputRef.current?.click()}>Selecione vídeo ou imagem</button>
                    <p className="card-drop-hint">ou arraste o arquivo para cá</p>
                    <input ref={videoInputRef} type="file" id="videoInput" data-testid="loopsync-video-input" accept="video/*,image/*" hidden onChange={(event) => { receiveFiles(event.target.files, "video"); event.target.value = ""; }} />
                    {visual && (
                      <button type="button" className="btn ghost compact bases-inline-save" onClick={handleSaveVisualBase} data-testid="inline-save-visual">
                        📚 Salvar como base
                      </button>
                    )}
                  </motion.article>

                  <motion.article className={`card${audio ? " selected" : ""}${dragTarget === "audio" ? " drop-active" : ""}`} data-card="audio" variants={childFadeUp} whileHover={{ y: -4, transition: { duration: 0.2 } }} {...dropHandlers("audio")}>
                    <div className="card-head"><span className="card-icon" aria-hidden="true">🎵</span><h2>Áudio</h2></div>
                    <p className="card-state">{audio ? "Áudio selecionado" : "Nenhum áudio selecionado"}</p>
                    {audio ? <p className="card-file">{audio.name}</p> : null}
                    <button type="button" className="btn subtle" data-testid="select-audio" onClick={() => audioInputRef.current?.click()}>Selecione áudio</button>
                    <p className="card-drop-hint">ou arraste o arquivo para cá</p>
                    <input ref={audioInputRef} type="file" id="audioInput" data-testid="loopsync-audio-input" accept="audio/*" hidden onChange={(event) => { receiveFiles(event.target.files, "audio"); event.target.value = ""; }} />
                    {audio && (
                      <button type="button" className="btn ghost compact bases-inline-save" onClick={handleSaveAudioBase} data-testid="inline-save-audio">
                        📚 Salvar como base
                      </button>
                    )}
                  </motion.article>
                </motion.div>

                <motion.div className="quality-wrap" variants={childFadeUp}>
                  <QualityPicker
                    videoQuality={videoQuality}
                    onVideoQualityChange={setVideoQuality}
                    audioQuality={audioQuality}
                    onAudioQualityChange={setAudioQuality}
                  />
                </motion.div>

                <AnimatePresence>
                  {bothReady ? (
                    <motion.section className="info" id="infoPanel" aria-live="polite" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={springTransition} style={{ overflow: "hidden" }}>
                      <div className="info-row"><span>{visual.kind === "image" ? "Foto" : "Duração do vídeo"}</span><strong id="infoVideoDuration">{visual.kind === "image" ? `${visual.width}×${visual.height}` : formatDuration(visual.duration)}</strong></div>
                      <div className="info-row"><span>Duração do áudio</span><strong id="infoAudioDuration">{formatDuration(audio.duration)}</strong></div>
                      <div className="info-row"><span>{visual.kind === "image" ? "Loops (foto é fixa)" : "Loops necessários"}</span><strong id="infoLoops">{loops}</strong></div>
                      <p className="info-note">Você pode gerar o resultado agora.</p>
                    </motion.section>
                  ) : null}
                </AnimatePresence>

                <motion.button type="submit" className="btn primary generate" id="generateBtn" disabled={!bothReady} variants={childFadeUp} whileTap={{ scale: 0.97 }}><span className="btn-label">Gerar vídeo</span><span className="btn-spinner" aria-hidden="true" /></motion.button>
              </motion.form>
            ) : null}

            {screen === "processing" ? (
              <motion.section className="panel processing" id="processingPanel" key="processing" aria-live="polite" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={springTransition}>
                <div className="panel-title"><h2>Gerando seu vídeo...</h2><p>{visual?.kind === "image" ? "Gerando vídeo a partir da imagem" : "Repetindo vídeo até o final do áudio"}</p></div>
                <div className="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progress)}><motion.div className="progress-fill" initial={{ width: "0%" }} animate={{ width: `${Math.max(0, Math.min(100, Math.round(progress)))}%` }} /></div>
                <p className="progress-text" id="progressText">{progressText}</p>
                <div className="processing-spinner" aria-hidden="true"><motion.div className="spinner-ring" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }} /></div>
                <p className="hint">O processamento acontece de forma assíncrona e não trava a interface.</p>
              </motion.section>
            ) : null}

            {screen === "result" && result ? (
              <motion.section className="panel result" id="resultPanel" key="result" aria-live="polite" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={springTransition}>
                <div className="result-icon" aria-hidden="true">✅</div><h2>Vídeo criado com sucesso!</h2>
                <p className="result-duration">Duração: <strong id="resultDuration">{result.outputDuration || result.audioDuration || "00:00"}</strong></p>
                <div className="result-preview"><video id="resultVideo" ref={resultVideoRef} controls playsInline preload="metadata" src={result.previewUrl} /></div>
                <div className="actions">
                  <a className="btn primary" id="saveBtn" href={result.downloadUrl} download={result.fileName || "video.mp4"}>Salvar vídeo</a>
                  <button type="button" className="btn subtle" id="shareBtn" onClick={shareResult}>Compartilhar</button>
                  <button type="button" className="btn youtube" id="sendToYouTubeBtn" onClick={sendToYouTube}><span className="yt-mark" aria-hidden="true">▶</span> Enviar para o YouTube</button>
                  <button type="button" className="btn ghost" id="resetBtn" onClick={resetAll}>Criar outro</button>
                </div>
                <p className="hint" id="resultMeta">{`Vídeo: ${result.videoDuration} · Áudio: ${result.audioDuration} · Loops: ${result.loopCount} · ${result.width || 0}×${result.height || 0} · ${(Number(result.sizeBytes || 0) / 1024 / 1024).toFixed(1)} MB · Qualidade: vídeo ${videoQualityShort(result.videoQuality)} / áudio ${audioQualityShort(result.audioQuality)}`}</p>
                <div className="result-extra-actions">
                  <button type="button" className="btn ghost compact" onClick={() => navigate("history")}>🕘 Ver no histórico</button>
                  <button type="button" className="btn ghost compact" onClick={() => navigate("bases")}>📚 Ver bases</button>
                </div>
              </motion.section>
            ) : null}
          </AnimatePresence>
        )}
      </div>

      <AnimatePresence>{toast ? <motion.div id="toast" className={`toast${toastType === "error" ? " error" : ""}`} role="status" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 18 }} transition={springTransition}>{toast}</motion.div> : null}</AnimatePresence>
    </main>
  );
}
