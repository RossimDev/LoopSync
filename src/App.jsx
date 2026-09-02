import React, { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { processInBrowser } from "./lib/wasm.js";

/* ─── helpers ────────────────────────────────────────────────────── */

const REREAD_BYTES = 65536;
const MAX_WASM_TOTAL_BYTES = 1.2 * 1024 * 1024 * 1024; // 1.2 GB

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(Number(seconds || 0)));
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function computeLoopCount(videoSeconds, audioSeconds) {
  const v = Math.max(0.01, Math.round((Number(videoSeconds) || 0) * 10) / 10);
  const a = Math.max(0, Math.round((Number(audioSeconds) || 0) * 10) / 10);
  if (a <= 0) return 0;
  if (v >= a) return 1;
  return Math.max(1, Math.ceil(a / v));
}

function timestampName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function loadVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
    };
    const onLoaded = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth === 0) {
        cleanup();
        reject(new Error("video"));
        return;
      }
      const duration = video.duration;
      cleanup();
      resolve(duration);
    };
    video.onloadedmetadata = onLoaded;
    video.onerror = () => { cleanup(); reject(new Error("video")); };
    video.src = url;
  });
}

function loadAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
      audio.load();
    };
    const onLoaded = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        cleanup();
        reject(new Error("audio"));
        return;
      }
      const duration = audio.duration;
      cleanup();
      resolve(duration);
    };
    audio.onloadedmetadata = onLoaded;
    audio.onerror = () => { cleanup(); reject(new Error("audio")); };
    audio.src = url;
  });
}

/** Pre-read first 64KB to detect expired file references (Android/cloud). */
async function preReadFile(file) {
  await file.slice(0, REREAD_BYTES).arrayBuffer();
}

async function hasBackend() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("/health", { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = await res.json();
      return Boolean(body && body.ok && body.service === "loopsync");
    }
    return false;
  } catch {
    return false;
  }
}

function uploadWithProgress(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/process");
    xhr.responseType = "json";
    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }
    xhr.onload = () => {
      const body = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300 && body && body.ok && body.id) {
        resolve(body);
      } else {
        reject(new Error((body && body.error) || "Não foi possível enviar os arquivos."));
      }
    };
    xhr.onerror = () => reject(new Error("Não foi possível conectar ao serviço de processamento."));
    xhr.send(formData);
  });
}

async function pollJob(jobId, onProgress) {
  for (;;) {
    const res = await fetch(`/api/process/${jobId}`);
    if (!res.ok) throw new Error("Não foi possível acompanhar o processamento.");
    const body = await res.json();
    onProgress(body);
    if (body.status === "done") return body;
    if (body.status === "error") throw new Error(body.error || "Não foi possível gerar o vídeo.");
    if (body.status === "queued" || body.status === "processing") {
      await new Promise((r) => setTimeout(r, 650));
    }
  }
}

/* ─── spring config ──────────────────────────────────────────────── */

const springTransition = { type: "spring", stiffness: 260, damping: 26 };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.08 } } };
const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: springTransition },
};
const childFadeUp = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: springTransition },
};

/* ─── App ────────────────────────────────────────────────────────── */

export default function App() {
  const [screen, setScreen] = useState("form"); // form | processing | result
  const [videoFile, setVideoFile] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [videoDuration, setVideoDuration] = useState(NaN);
  const [audioDuration, setAudioDuration] = useState(NaN);
  const [videoName, setVideoName] = useState("");
  const [audioName, setAudioName] = useState("");
  const [videoCardSelected, setVideoCardSelected] = useState(false);
  const [audioCardSelected, setAudioCardSelected] = useState(false);
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

  const videoRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    videoRef.current = videoFile;
  }, [videoFile]);
  useEffect(() => {
    audioRef.current = audioFile;
  }, [audioFile]);

  /* ── file selection ── */
  const onSelectVideo = useCallback(async (file) => {
    if (!file) return;
    try {
      const duration = await loadVideoDuration(file);
      setVideoFile(file);
      setVideoDuration(duration);
      setVideoName(file.name);
      setVideoCardSelected(true);
    } catch {
      showToast("Não foi possível utilizar este arquivo. Escolha outro vídeo.", "error");
      if (videoInputRef.current) videoInputRef.current.value = "";
    }
  }, [showToast]);

  const onSelectAudio = useCallback(async (file) => {
    if (!file) return;
    try {
      const duration = await loadAudioDuration(file);
      setAudioFile(file);
      setAudioDuration(duration);
      setAudioName(file.name);
      setAudioCardSelected(true);
    } catch {
      showToast("Não foi possível utilizar este arquivo. Escolha outro áudio.", "error");
      if (audioInputRef.current) audioInputRef.current.value = "";
    }
  }, [showToast]);

  /* ── derived ── */
  const bothReady = videoFile && audioFile && Number.isFinite(videoDuration) && Number.isFinite(audioDuration);
  const loops = bothReady ? computeLoopCount(videoDuration, audioDuration) : 0;
  const infoExpanded = bothReady;

  /* ── cleanup ── */
  const clearOldJob = useCallback(() => {
    if (jobIdRef.current && result) {
      fetch(`/api/clear/${jobIdRef.current}`, { method: "POST" }).catch(() => {});
    }
    if (resultBlobUrlRef.current) {
      URL.revokeObjectURL(resultBlobUrlRef.current);
      resultBlobUrlRef.current = null;
    }
    jobIdRef.current = null;
  }, [result]);

  const resetToEdit = useCallback(() => {
    clearOldJob();
    busyRef.current = false;
    setScreen("form");
    setProgress(0);
    setProgressText("Preparando arquivos…");
  }, [clearOldJob]);

  const resetAll = useCallback(() => {
    // pause and clean up result video player
    if (resultVideoRef.current) {
      resultVideoRef.current.pause();
      resultVideoRef.current.removeAttribute("src");
      resultVideoRef.current.load();
    }
    if (resultBlobUrlRef.current) {
      URL.revokeObjectURL(resultBlobUrlRef.current);
      resultBlobUrlRef.current = null;
    }
    setVideoFile(null);
    setAudioFile(null);
    setVideoDuration(NaN);
    setAudioDuration(NaN);
    setVideoName("");
    setAudioName("");
    setVideoCardSelected(false);
    setAudioCardSelected(false);
    setResult(null);
    if (videoInputRef.current) videoInputRef.current.value = "";
    if (audioInputRef.current) audioInputRef.current.value = "";
    resetToEdit();
  }, [resetToEdit]);

  /* ── generate ── */
  const generate = useCallback(async () => {
    if (busyRef.current) return;
    const vFile = videoRef.current;
    const aFile = audioRef.current;
    if (!vFile || !aFile) {
      showToast("Selecione um vídeo e um áudio para continuar.", "error");
      return;
    }

    clearOldJob();
    busyRef.current = true;
    setScreen("processing");
    setProgress(2);
    setProgressText("Preparando…");

    try {
      // ── Pre-read check (Part 2) ──
      try {
        await preReadFile(vFile);
      } catch {
        showToast("Não foi possível ler o vídeo selecionado. Selecione o arquivo novamente.", "error");
        setVideoFile(null);
        setVideoDuration(NaN);
        setVideoName("");
        setVideoCardSelected(false);
        if (videoInputRef.current) videoInputRef.current.value = "";
        resetToEdit();
        return;
      }
      try {
        await preReadFile(aFile);
      } catch {
        showToast("Não foi possível ler o áudio selecionado. Selecione o arquivo novamente.", "error");
        setAudioFile(null);
        setAudioDuration(NaN);
        setAudioName("");
        setAudioCardSelected(false);
        if (audioInputRef.current) audioInputRef.current.value = "";
        resetToEdit();
        return;
      }

      const useServer = await hasBackend();

      if (useServer) {
        // ── Server mode ──
        const form = new FormData();
        form.append("video", vFile, vFile.name);
        form.append("audio", aFile, aFile.name);

        const uploadRes = await uploadWithProgress(form, (loaded) => {
          const percent = Math.max(2, Math.round(loaded * 5));
          setProgress(percent);
          setProgressText(`Enviando arquivos… ${Math.round(loaded * 100)}%`);
        });

        jobIdRef.current = uploadRes.id;
        setProgress(8);
        setProgressText("Reconhecendo arquivos…");

        const done = await pollJob(jobIdRef.current, (job) => {
          const percent = Math.max(8, job.percent || 0);
          setProgress(percent);
          if (job.phase === "probing") {
            setProgressText("Reconhecendo arquivos…");
          } else if (job.phase === "processing" || job.status === "processing") {
            setProgressText("Repetindo vídeo até o final do áudio…");
          } else if (job.status === "done") {
            setProgress(100);
            setProgressText("Finalizando…");
          }
        });

        const res = done.result;
        setResult({
          ...res,
          previewUrl: `${res.downloadUrl}?inline=1`,
          downloadUrl: res.downloadUrl,
          fileName: res.fileName,
        });
      } else {
        // ── Browser (wasm) mode ──

        // Size check (Part 2.4)
        if (vFile.size + aFile.size > MAX_WASM_TOTAL_BYTES) {
          showToast("Os arquivos são grandes demais para processar neste dispositivo. Tente um vídeo menor.", "error");
          resetToEdit();
          return;
        }

        setProgress(3);
        setProgressText("Carregando o motor de vídeo…");

        try {
          const { blob, actualDuration } = await processInBrowser({
            videoFile: vFile,
            audioFile: aFile,
            videoDuration,
            audioDuration,
            onProgress: ({ percent, text }) => {
              setProgress(percent);
              setProgressText(text);
            },
          });

          const blobUrl = URL.createObjectURL(blob);
          resultBlobUrlRef.current = blobUrl;

          setResult({
            videoName: vFile.name,
            audioName: aFile.name,
            videoDuration: formatDuration(videoDuration),
            audioDuration: formatDuration(audioDuration),
            outputDuration: formatDuration(actualDuration),
            loopCount: computeLoopCount(videoDuration, audioDuration),
            sizeBytes: blob.size,
            downloadUrl: blobUrl,
            previewUrl: blobUrl,
            fileName: `LoopSync_${timestampName()}.mp4`,
          });
        } catch (err) {
          console.error("LoopSync WASM error:", err);
          console.error("Last ffmpeg logs:", err._ffmpegLogs || "(none)");
          showToast(
            "Não foi possível processar estes arquivos neste dispositivo. Tente um vídeo menor ou em outro formato (MP4/H.264).",
            "error"
          );
          resetToEdit();
          return;
        }
      }

      setScreen("result");
    } catch (err) {
      console.error("LoopSync:", err);
      showToast(err && err.message ? err.message : "Não foi possível gerar o vídeo.", "error");
      resetToEdit();
    } finally {
      busyRef.current = false;
    }
  }, [videoDuration, audioDuration, clearOldJob, resetToEdit, showToast]);

  /* ── share ── */
  const shareResult = useCallback(async () => {
    if (!result) return;
    const href = result.downloadUrl;
    const fileName = result.fileName || "LoopSync.mp4";
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error("download");
      const blob = await response.blob();
      const file = new File([blob], fileName, { type: blob.type || "video/mp4" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        const blobUrl = URL.createObjectURL(blob);
        try {
          await navigator.share({ files: [file], title: "LoopSync" });
        } catch {
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally {
          setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
        }
        return;
      }
      const a = document.createElement("a");
      a.href = href;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      const a = document.createElement("a");
      a.href = href;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }, [result]);

  /* ─── RENDER ──────────────────────────────────────────────────── */

  return (
    <main className="page">
      {/* ── header ── */}
      <header className="hero">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 40 40" width="34" height="34" fill="none">
              <circle cx="20" cy="20" r="18" fill="#1d1a15" stroke="#ff8a3d" strokeWidth="2.5" />
              <path d="M16 13 L28 20 L16 27Z" fill="#ff8a3d" />
              <path d="M12 10 A14 14 0 0 1 30 14" stroke="#ff8a3d" strokeWidth="2" strokeLinecap="round" fill="none" />
              <path d="M28 30 A14 14 0 0 1 10 26" stroke="#ff8a3d" strokeWidth="2" strokeLinecap="round" fill="none" />
            </svg>
          </span>
          <div>
            <h1>LoopSync</h1>
            <p>Vídeo + música. Automaticamente.</p>
          </div>
        </div>
        <span className="privacy-badge" title="O conteúdo é processado pelo serviço local do app e os arquivos temporários são apagados.">
          🔒 Local &amp; privado
        </span>
      </header>

      <AnimatePresence mode="wait">
        {/* ─── FORM SCREEN ─── */}
        {screen === "form" && (
          <motion.form
            id="appForm"
            key="form"
            noValidate
            onSubmit={(e) => { e.preventDefault(); generate(); }}
            variants={stagger}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, y: -20, transition: springTransition }}
          >
            <motion.div className="grid" variants={fadeUp}>
              <motion.article
                className={`card${videoCardSelected ? " selected" : ""}`}
                data-card="video"
                variants={childFadeUp}
                whileHover={{ y: -4, transition: { duration: 0.2 } }}
              >
                <div className="card-head">
                  <span className="card-icon" aria-hidden="true">🎬</span>
                  <h2>Vídeo</h2>
                </div>
                <p className="card-state">{videoCardSelected ? "Vídeo selecionado" : "Nenhum vídeo selecionado"}</p>
                {videoName && <p className="card-file">{videoName}</p>}
                <button type="button" className="btn subtle" onClick={() => videoInputRef.current?.click()}>Selecionar vídeo</button>
                <input
                  type="file"
                  id="videoInput"
                  accept="video/*"
                  hidden
                  ref={videoInputRef}
                  onChange={(e) => onSelectVideo(e.target.files && e.target.files[0])}
                />
              </motion.article>

              <motion.article
                className={`card${audioCardSelected ? " selected" : ""}`}
                data-card="audio"
                variants={childFadeUp}
                whileHover={{ y: -4, transition: { duration: 0.2 } }}
              >
                <div className="card-head">
                  <span className="card-icon" aria-hidden="true">🎵</span>
                  <h2>Áudio</h2>
                </div>
                <p className="card-state">{audioCardSelected ? "Áudio selecionado" : "Nenhum áudio selecionado"}</p>
                {audioName && <p className="card-file">{audioName}</p>}
                <button type="button" className="btn subtle" onClick={() => audioInputRef.current?.click()}>Selecionar áudio</button>
                <input
                  type="file"
                  id="audioInput"
                  accept="audio/*"
                  hidden
                  ref={audioInputRef}
                  onChange={(e) => onSelectAudio(e.target.files && e.target.files[0])}
                />
              </motion.article>
            </motion.div>

            <AnimatePresence>
              {infoExpanded && (
                <motion.section
                  className="info"
                  id="infoPanel"
                  aria-live="polite"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={springTransition}
                  style={{ overflow: "hidden" }}
                >
                  <motion.div variants={stagger} initial="hidden" animate="show">
                    <motion.div className="info-row" variants={childFadeUp}>
                      <span>Duração do vídeo</span>
                      <strong id="infoVideoDuration">{formatDuration(videoDuration)}</strong>
                    </motion.div>
                    <motion.div className="info-row" variants={childFadeUp}>
                      <span>Duração do áudio</span>
                      <strong id="infoAudioDuration">{formatDuration(audioDuration)}</strong>
                    </motion.div>
                    <motion.div className="info-row" variants={childFadeUp}>
                      <span>Loops necessários</span>
                      <strong id="infoLoops">{String(loops)}</strong>
                    </motion.div>
                    <motion.p className="info-note" variants={childFadeUp}>Você pode gerar o resultado agora.</motion.p>
                  </motion.div>
                </motion.section>
              )}
            </AnimatePresence>

            <motion.button
              type="submit"
              className="btn primary generate"
              id="generateBtn"
              disabled={!bothReady}
              variants={childFadeUp}
              whileTap={{ scale: 0.97 }}
            >
              <span className="btn-label">Gerar vídeo</span>
              <span className="btn-spinner" aria-hidden="true"></span>
            </motion.button>
          </motion.form>
        )}

        {/* ─── PROCESSING SCREEN ─── */}
        {screen === "processing" && (
          <motion.section
            className="panel processing"
            id="processingPanel"
            key="processing"
            aria-live="polite"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, transition: springTransition }}
            transition={springTransition}
          >
            <div className="panel-title">
              <h2>Gerando seu vídeo...</h2>
              <p>Repetindo vídeo até o final do áudio</p>
            </div>
            <div className="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progress)}>
              <motion.div
                className="progress-fill"
                initial={{ width: "0%" }}
                animate={{ width: `${Math.max(0, Math.min(100, Math.round(progress)))}%` }}
                transition={{ type: "spring", stiffness: 120, damping: 20 }}
              />
            </div>
            <p className="progress-text" id="progressText">{progressText}</p>
            <div className="processing-spinner" aria-hidden="true">
              <motion.div
                className="spinner-ring"
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}
              />
            </div>
            <p className="hint">O processamento acontece de forma assíncrona e não trava a interface.</p>
          </motion.section>
        )}

        {/* ─── RESULT SCREEN ─── */}
        {screen === "result" && result && (
          <motion.section
            className="panel result"
            id="resultPanel"
            key="result"
            aria-live="polite"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, transition: springTransition }}
            transition={springTransition}
          >
            <motion.div
              className="result-icon"
              aria-hidden="true"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 320, damping: 18, delay: 0.1 }}
            >
              ✅
            </motion.div>
            <h2>Vídeo criado com sucesso!</h2>
            <p className="result-duration">Duração: <strong id="resultDuration">{result.outputDuration || result.audioDuration || "00:00"}</strong></p>

            <motion.div
              className="result-preview"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ ...springTransition, delay: 0.2 }}
            >
              <video
                id="resultVideo"
                ref={resultVideoRef}
                controls
                playsInline
                preload="metadata"
                src={result.previewUrl}
              />
            </motion.div>

            <motion.div
              className="actions"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...springTransition, delay: 0.3 }}
            >
              <a className="btn primary" id="saveBtn" href={result.downloadUrl} download={result.fileName || "LoopSync.mp4"} whileTap={{ scale: 0.97 }}>Salvar vídeo</a>
              <button type="button" className="btn subtle" id="shareBtn" onClick={shareResult} whileTap={{ scale: 0.97 }}>Compartilhar</button>
              <button type="button" className="btn ghost" id="resetBtn" onClick={resetAll} whileTap={{ scale: 0.97 }}>Criar outro</button>
            </motion.div>
            <p className="hint" id="resultMeta">
              {`Video: ${result.videoDuration} · Áudio: ${result.audioDuration} · Loops: ${result.loopCount} · ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB`}
            </p>
          </motion.section>
        )}
      </AnimatePresence>

      {/* ── Toast ── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            id="toast"
            className={`toast${toastType === "error" ? " error" : ""}`}
            role="status"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 18 }}
            transition={springTransition}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
