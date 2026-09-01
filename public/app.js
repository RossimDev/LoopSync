"use strict";

const state = {
  videoFile: null,
  audioFile: null,
  videoDuration: NaN,
  audioDuration: NaN,
  videoUrl: null,
  audioUrl: null,
  jobId: null,
  result: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

const els = {
  form: $("appForm"),
  videoCard: document.querySelector('[data-card="video"]'),
  audioCard: document.querySelector('[data-card="audio"]'),
  videoState: $("videoState"),
  audioState: $("audioState"),
  videoFile: $("videoFile"),
  audioFile: $("audioFile"),
  videoInput: $("videoInput"),
  audioInput: $("audioInput"),
  selectVideoBtn: $("selectVideoBtn"),
  selectAudioBtn: $("selectAudioBtn"),
  infoPanel: $("infoPanel"),
  infoVideoDuration: $("infoVideoDuration"),
  infoAudioDuration: $("infoAudioDuration"),
  infoLoops: $("infoLoops"),
  generateBtn: $("generateBtn"),
  processingPanel: $("processingPanel"),
  progressBar: $("progressBar"),
  progressFill: $("progressFill"),
  progressText: $("progressText"),
  resultPanel: $("resultPanel"),
  resultDuration: $("resultDuration"),
  resultMeta: $("resultMeta"),
  saveBtn: $("saveBtn"),
  shareBtn: $("shareBtn"),
  resetBtn: $("resetBtn"),
  toast: $("toast"),
};

let toastTimer = null;

function showToast(message, type = "info") {
  els.toast.textContent = message;
  els.toast.classList.toggle("error", type === "error");
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add("visible"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove("visible");
    setTimeout(() => {
      els.toast.hidden = true;
      els.toast.textContent = "";
    }, 220);
  }, 3600);
}

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
    video.onerror = () => {
      cleanup();
      reject(new Error("video"));
    };
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
    audio.onerror = () => {
      cleanup();
      reject(new Error("audio"));
    };
    audio.src = url;
  });
}

async function onSelectVideo(file) {
  if (!file) return;
  try {
    const duration = await loadVideoDuration(file);
    state.videoFile = file;
    state.videoDuration = duration;
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = URL.createObjectURL(file);
    els.videoFile.textContent = file.name;
    els.videoFile.hidden = false;
    els.videoState.textContent = "Vídeo selecionado";
    els.videoCard.classList.add("selected");
    updateInfo();
    if (state.processing) resetToEdit();
  } catch {
    showToast("Não foi possível utilizar este arquivo. Escolha outro vídeo.", "error");
    els.videoInput.value = "";
  }
}

async function onSelectAudio(file) {
  if (!file) return;
  try {
    const duration = await loadAudioDuration(file);
    state.audioFile = file;
    state.audioDuration = duration;
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(file);
    els.audioFile.textContent = file.name;
    els.audioFile.hidden = false;
    els.audioState.textContent = "Áudio selecionado";
    els.audioCard.classList.add("selected");
    updateInfo();
    if (state.processing) resetToEdit();
  } catch {
    showToast("Não foi possível utilizar este arquivo. Escolha outro áudio.", "error");
    els.audioInput.value = "";
  }
}

function updateInfo() {
  const ready = state.videoFile && state.audioFile && Number.isFinite(state.videoDuration) && Number.isFinite(state.audioDuration);
  els.infoPanel.hidden = !ready;
  if (!ready) return;
  els.infoVideoDuration.textContent = formatDuration(state.videoDuration);
  els.infoAudioDuration.textContent = formatDuration(state.audioDuration);
  els.infoLoops.textContent = String(computeLoopCount(state.videoDuration, state.audioDuration));
  els.generateBtn.disabled = false;
}

function resetSelections() {
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.videoUrl = state.audioUrl = null;
  state.videoFile = state.audioFile = null;
  state.videoDuration = state.audioDuration = NaN;
  els.videoInput.value = "";
  els.audioInput.value = "";
  els.videoFile.textContent = "";
  els.audioFile.textContent = "";
  els.videoFile.hidden = true;
  els.audioFile.hidden = true;
  els.videoState.textContent = "Nenhum vídeo selecionado";
  els.audioState.textContent = "Nenhum áudio selecionado";
  els.videoCard.classList.remove("selected");
  els.audioCard.classList.remove("selected");
  els.infoPanel.hidden = true;
  els.generateBtn.disabled = true;
}

function showScreen(name) {
  els.form.hidden = name !== "form";
  els.processingPanel.hidden = name !== "processing";
  els.resultPanel.hidden = name !== "result";
}

function setProgress(percent, text) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  els.progressFill.style.width = `${clamped}%`;
  els.progressBar.setAttribute("aria-valuenow", String(clamped));
  if (text) els.progressText.textContent = text;
}

function resetToEdit() {
  state.jobId = null;
  state.result = null;
  state.busy = false;
  showScreen("form");
  els.generateBtn.classList.remove("loading");
  els.generateBtn.disabled = !(state.videoFile && state.audioFile);
  setProgress(0, "");
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
    if (!res.ok) {
      throw new Error("Não foi possível acompanhar o processamento.");
    }
    const body = await res.json();
    onProgress(body);
    if (body.status === "done") return body;
    if (body.status === "error") throw new Error(body.error || "Não foi possível gerar o vídeo.");
    if (body.status === "queued" || body.status === "processing") {
      await new Promise((r) => setTimeout(r, 650));
    }
  }
}

async function generate() {
  if (state.busy) return;
  if (!state.videoFile || !state.audioFile) {
    showToast("Selecione um vídeo e um áudio para continuar.", "error");
    return;
  }

  state.busy = true;
  state.result = null;
  showScreen("processing");
  els.generateBtn.classList.add("loading");
  setProgress(2, "Enviando arquivos…");

  try {
    const form = new FormData();
    form.append("video", state.videoFile, state.videoFile.name);
    form.append("audio", state.audioFile, state.audioFile.name);

    const uploadRes = await uploadWithProgress(form, (loaded) => {
      const percent = Math.max(2, Math.round(loaded * 5));
      setProgress(percent, `Enviando arquivos… ${Math.round(loaded * 100)}%`);
    });

    state.jobId = uploadRes.id;
    setProgress(8, "Reconhecendo arquivos…");

    const done = await pollJob(state.jobId, (job) => {
      const percent = Math.max(8, job.percent || 0);
      if (job.phase === "probing") {
        setProgress(percent, "Reconhecendo arquivos…");
      } else if (job.phase === "processing" || job.status === "processing") {
        setProgress(percent, "Repetindo vídeo até o final do áudio…");
      } else if (job.status === "done") {
        setProgress(100, "Finalizando…");
      }
    });

    state.result = done.result;
    showResult(done.result);
  } catch (err) {
    if (state.result) return;
    showToast(err && err.message ? err.message : "Não foi possível gerar o vídeo.", "error");
    resetToEdit();
  } finally {
    els.generateBtn.classList.remove("loading");
    state.busy = false;
  }
}

function showResult(result) {
  showScreen("result");
  els.resultDuration.textContent = result.outputDuration || result.audioDuration || "00:00";
  const name = result.fileName || "LoopSync.mp4";
  els.saveBtn.href = result.downloadUrl || "#";
  els.saveBtn.setAttribute("download", name);
  els.resultMeta.textContent = `Video: ${result.videoDuration} · Áudio: ${result.audioDuration} · Loops: ${result.loopCount} · ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function triggerDownload(url, fileName) {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || "LoopSync.mp4";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function shareResult() {
  const result = state.result;
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
      } catch (err) {
        // Share was cancelled or unavailable in this browser; fall back to a
        // regular download from the already-fetched blob.
        triggerDownload(blobUrl, fileName);
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
      }
      return;
    }

    triggerDownload(href, fileName);
  } catch (err) {
    triggerDownload(href, fileName);
  }
}

function bindEvents() {
  els.selectVideoBtn.addEventListener("click", () => els.videoInput.click());
  els.selectAudioBtn.addEventListener("click", () => els.audioInput.click());
  els.videoInput.addEventListener("change", (e) => onSelectVideo(e.target.files && e.target.files[0]));
  els.audioInput.addEventListener("change", (e) => onSelectAudio(e.target.files && e.target.files[0]));
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    generate();
  });
  els.shareBtn.addEventListener("click", shareResult);
  els.resetBtn.addEventListener("click", () => {
    resetSelections();
    resetToEdit();
  });
}

bindEvents();
resetToEdit();
