import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ImageSizePicker from "./ImageSizePicker.jsx";
import QualityPicker from "./QualityPicker.jsx";
import { kindOfFile, loadImageSize, loadVideoMeta, loadAudioDuration } from "./lib/files.js";
import { formatDuration } from "./lib/format.js";
import { outputFileName } from "./lib/naming.js";
import { addHistoryEntry, createThumbFromVideoFile } from "./lib/history.js";

const STATUS_LABEL = {
  queued: "Aguardando",
  working: "Gerando",
  done: "Concluído",
  error: "Erro",
};

let nextId = 0;
function makeId(prefix) {
  nextId += 1;
  return `${prefix}_${Date.now().toString(36)}_${nextId.toString(36)}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function probeVisual(file, kind) {
  if (kind === "image") {
    const { width, height } = await loadImageSize(file);
    return { id: makeId("vis"), file, name: file.name, kind, duration: 0, width, height, size: file.size };
  }
  const { duration, width, height } = await loadVideoMeta(file);
  return { id: makeId("vis"), file, name: file.name, kind, duration, width, height, size: file.size };
}

function sourceResultText(result) {
  const duration = result.outputDuration || (Number.isFinite(result.actualDuration) ? formatDuration(result.actualDuration) : "00:00");
  const dimensions = result.width && result.height ? ` · ${result.width}×${result.height}` : "";
  return `${duration} · ${formatBytes(result.sizeBytes)}${dimensions}`;
}

export default function Batch({
  processPair,
  onSendToYouTube,
  showToast,
  seed = null,
  imageSize,
  onImageSizeChange,
  videoQuality,
  onVideoQualityChange,
  audioQuality,
  onAudioQualityChange,
}) {
  const [visuals, setVisuals] = useState([]);
  const [audios, setAudios] = useState([]);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [global, setGlobal] = useState({ total: 0, done: 0, percent: 0, text: "" });
  const [dragTarget, setDragTarget] = useState(null);
  const [previewId, setPreviewId] = useState(null);

  const visualInputRef = useRef(null);
  const audioInputRef = useRef(null);
  const busyRef = useRef(false);
  const seedRef = useRef(null);
  const blobUrlsRef = useRef(new Set());
  const rowsRef = useRef(rows);
  const visualsRef = useRef(visuals);
  const audiosRef = useRef(audios);

  useEffect(() => { rowsRef.current = rows; }, [rows]);
  useEffect(() => { visualsRef.current = visuals; }, [visuals]);
  useEffect(() => { audiosRef.current = audios; }, [audios]);

  useEffect(() => () => {
    for (const url of blobUrlsRef.current) URL.revokeObjectURL(url);
    blobUrlsRef.current.clear();
  }, []);

  const notify = useCallback((message, type = "info") => {
    if (typeof showToast === "function") showToast(message, type);
  }, [showToast]);

  const addFiles = useCallback(async (fileList, target = "visuals") => {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const addedVisuals = [];
    const addedAudios = [];
    const rejected = [];

    for (const file of files) {
      const kind = kindOfFile(file);
      try {
        if (kind === "image" || kind === "video") {
          addedVisuals.push(await probeVisual(file, kind));
        } else if (kind === "audio") {
          const duration = await loadAudioDuration(file);
          addedAudios.push({
            id: makeId("aud"), file, name: file.name, kind: "audio", duration, size: file.size,
          });
        } else {
          rejected.push(file.name || "arquivo sem nome");
        }
      } catch {
        rejected.push(file.name || "arquivo sem nome");
      }
    }

    if (addedVisuals.length) setVisuals((current) => [...current, ...addedVisuals]);
    if (addedAudios.length) setAudios((current) => [...current, ...addedAudios]);

    if (target === "visuals" && addedAudios.length && !addedVisuals.length) {
      notify("Este arquivo é um áudio — foi para a caixa de áudios.");
    } else if (target === "audios" && addedVisuals.length && !addedAudios.length) {
      notify("Este arquivo é um vídeo/imagem — foi para a caixa de vídeos.");
    } else if (addedVisuals.length && !addedAudios.length) {
      notify(`${addedVisuals.length} vídeo(s)/imagem(ns) na lista.`);
    } else if (addedAudios.length && !addedVisuals.length) {
      notify(`${addedAudios.length} áudio(s) na lista.`);
    } else if (addedVisuals.length || addedAudios.length) {
      notify(`${addedVisuals.length} vídeo(s)/imagem(ns) e ${addedAudios.length} áudio(s) na lista.`);
    }

    if (rejected.length) {
      notify(`Não reconheci: ${rejected.join(", ")}. Envie vídeo, imagem ou áudio.`, "error");
    }
  }, [notify]);

  useEffect(() => {
    if (!seed || seed.id == null || seedRef.current === seed.id) return;
    seedRef.current = seed.id;
    addFiles(seed.files, "visuals");
  }, [seed, addFiles]);

  const forgetResult = useCallback((result) => {
    const url = result && result.blobUrl;
    if (url && blobUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      blobUrlsRef.current.delete(url);
    }
  }, []);

  const removeVisual = useCallback((id) => {
    setVisuals((current) => current.filter((item) => item.id !== id));
    setRows((current) => current.filter((row) => {
      if (row.visualId !== id) return true;
      forgetResult(row.result);
      return false;
    }));
  }, [forgetResult]);

  const removeAudio = useCallback((id) => {
    setAudios((current) => current.filter((item) => item.id !== id));
    setRows((current) => current.filter((row) => {
      if (row.audioId !== id) return true;
      forgetResult(row.result);
      return false;
    }));
  }, [forgetResult]);

  const addPairs = useCallback((pairs) => {
    setRows((current) => {
      const keys = new Set(current.map((row) => `${row.visualId}|${row.audioId}`));
      const used = current.map((row) => row.fileName);
      const additions = [];
      for (const pair of pairs) {
        const key = `${pair.visual.id}|${pair.audio.id}`;
        if (keys.has(key)) continue;
        keys.add(key);
        const fileName = outputFileName(pair.audio.file.name, { used });
        used.push(fileName);
        additions.push({
          id: makeId("row"),
          visualId: pair.visual.id,
          audioId: pair.audio.id,
          fileName,
          status: "queued",
          percent: 0,
          text: "",
          error: null,
          result: null,
        });
      }
      return additions.length ? [...current, ...additions] : current;
    });
  }, []);

  const useVisualForAll = (visual) => addPairs(audios.map((audio) => ({ visual, audio })));
  const useAudioForAll = (audio) => addPairs(visuals.map((visual) => ({ visual, audio })));
  const pairInOrder = () => addPairs(
    Array.from({ length: Math.min(visuals.length, audios.length) }, (_, index) => ({ visual: visuals[index], audio: audios[index] }))
  );

  const changeRow = useCallback((rowId, patch) => {
    setRows((current) => current.map((row) => {
      if (row.id !== rowId) return row;
      forgetResult(row.result);
      const next = { ...row, ...patch };
      const audio = audiosRef.current.find((item) => item.id === next.audioId);
      const used = current.filter((item) => item.id !== rowId).map((item) => item.fileName);
      return {
        ...next,
        fileName: outputFileName(audio && audio.file ? audio.file.name : "video", { used }),
        status: "queued",
        percent: 0,
        text: "",
        error: null,
        result: null,
      };
    }));
  }, [forgetResult]);

  const removeRow = useCallback((id) => {
    setRows((current) => current.filter((row) => {
      if (row.id !== id) return true;
      forgetResult(row.result);
      return false;
    }));
    if (previewId === id) setPreviewId(null);
  }, [forgetResult, previewId]);

  const generateMany = useCallback(async (list) => {
    if (busyRef.current) {
      notify("Aguarde a geração em andamento terminar.");
      return;
    }
    const ids = Array.from(list || [], (item) => typeof item === "string" ? item : item.id);
    if (!ids.length) return;

    busyRef.current = true;
    setBusy(true);
    setGlobal({ total: ids.length, done: 0, percent: 0, text: "Preparando a fila…" });

    let completed = 0;
    for (const id of ids) {
      const row = rowsRef.current.find((item) => item.id === id);
      if (!row) continue;
      const visual = visualsRef.current.find((item) => item.id === row.visualId);
      const audio = audiosRef.current.find((item) => item.id === row.audioId);
      if (!visual || !audio) continue;

      setRows((current) => current.map((item) => item.id === id
        ? { ...item, status: "working", percent: 0, text: "Preparando…", error: null, result: null }
        : item));

      try {
        const result = await processPair({
          visual,
          audio,
          fileName: row.fileName,
          onProgress: (percent, text) => {
            const value = Math.max(0, Math.min(100, Number(percent) || 0));
            setRows((current) => current.map((item) => item.id === id
              ? { ...item, percent: value, text: text || "Gerando…" }
              : item));
            setGlobal({
              total: ids.length,
              done: completed,
              percent: Math.round(((completed + value / 100) / ids.length) * 100),
              text: text || "Gerando…",
            });
          },
        });
        if (result && result.blobUrl) blobUrlsRef.current.add(result.blobUrl);
        setRows((current) => current.map((item) => item.id === id
          ? { ...item, status: "done", percent: 100, text: "Concluído", result, error: null }
          : item));

        // Save to history
        try {
          let thumbDataUrl = null;
          if (result.blob) {
            thumbDataUrl = await createThumbFromVideoFile(result.blob);
          }
          await addHistoryEntry({
            fileName: result.fileName || row.fileName,
            sizeBytes: result.sizeBytes,
            width: result.width,
            height: result.height,
            duration: result.actualDuration,
            videoDuration: result.videoDuration,
            audioDuration: result.audioDuration,
            outputDuration: result.outputDuration,
            loopCount: result.loopCount,
            videoQuality: result.videoQuality,
            audioQuality: result.audioQuality,
            isImage: result.isImage || visual.kind === "image",
            originalVisualName: result.originalVisualName || visual.name,
            originalAudioName: result.originalAudioName || audio.name,
            thumbDataUrl,
            blobUrl: result.blobUrl,
            downloadUrl: result.downloadUrl,
            jobId: result.jobId,
          });
        } catch (e) {
          console.warn("Batch history save failed", e);
        }
      } catch (error) {
        setRows((current) => current.map((item) => item.id === id
          ? { ...item, status: "error", percent: 0, text: "Erro", result: null, error: error.message || "Não foi possível gerar este vídeo." }
          : item));
      }
      completed += 1;
      setGlobal({
        total: ids.length,
        done: completed,
        percent: Math.round((completed / ids.length) * 100),
        text: "Processando a fila…",
      });
    }

    busyRef.current = false;
    setBusy(false);
  }, [notify, processPair]);

  const downloadRow = useCallback(async (row) => {
    if (!row || row.status !== "done" || !row.result) return false;
    const source = row.result.blobUrl || row.result.downloadUrl;
    if (!source) return false;
    const response = await fetch(source);
    if (!response.ok) throw new Error("Não foi possível baixar o vídeo.");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = row.fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }, []);

  const doneRows = useMemo(() => rows.filter((row) => row.status === "done" && row.result), [rows]);
  const pendingRows = useMemo(() => rows.filter((row) => row.status !== "done"), [rows]);

  const downloadAll = useCallback(async () => {
    const ready = rowsRef.current.filter((row) => row.status === "done" && row.result);
    if (!ready.length) {
      notify("Nenhum vídeo pronto para baixar ainda.");
      return;
    }
    let downloaded = 0;
    for (const row of ready) {
      try {
        if (await downloadRow(row)) downloaded += 1;
      } catch (error) {
        notify(error.message, "error");
      }
      if (row !== ready[ready.length - 1]) await new Promise((resolve) => setTimeout(resolve, 600));
    }
    notify(`${downloaded} arquivo(s) baixado(s), cada um com o nome do próprio áudio.`);
  }, [downloadRow, notify]);

  const toHandoff = useCallback((row) => {
    const result = row.result || {};
    if (result.jobId) {
      return {
        sourceJobId: result.jobId,
        name: row.fileName,
        size: Number(result.sizeBytes || 0),
        previewUrl: result.previewUrl,
        title: "",
      };
    }
    return {
      file: result.file,
      name: row.fileName,
      size: Number(result.sizeBytes || (result.file && result.file.size) || 0),
      previewUrl: result.previewUrl,
      title: "",
    };
  }, []);

  const sendRows = useCallback((list) => {
    const ready = Array.from(list || []).filter((row) => row.status === "done" && row.result);
    if (!ready.length) {
      notify("Gere os vídeos antes de enviar para o YouTube.");
      return;
    }
    if (typeof onSendToYouTube === "function") onSendToYouTube(ready.map(toHandoff));
  }, [notify, onSendToYouTube, toHandoff]);

  const clearRows = useCallback(() => {
    for (const row of rowsRef.current) forgetResult(row.result);
    setRows([]);
    setPreviewId(null);
    setGlobal({ total: 0, done: 0, percent: 0, text: "" });
  }, [forgetResult]);

  const dropZone = useCallback((target) => ({
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
      addFiles(event.dataTransfer && event.dataTransfer.files, target);
    },
  }), [addFiles]);

  const completedCount = rows.filter((row) => row.status === "done").length;
  const pendingCount = rows.length - completedCount;
  const previewRow = rows.find((row) => row.id === previewId && row.result) || null;

  return (
    <section className="batch" data-testid="batch-mode">
      <div className="batch-input-grid">
        <section
          className={`batch-box${dragTarget === "visuals" ? " drop-active" : ""}`}
          data-testid="batch-visuals-box"
          {...dropZone("visuals")}
        >
          <header><div><span aria-hidden="true">🎬</span><h2>Vídeos ou imagens</h2></div><strong data-testid="batch-visual-count">{visuals.length}</strong></header>
          <button type="button" className="btn subtle" data-testid="batch-pick-visuals" onClick={() => visualInputRef.current?.click()} disabled={busy}>
            Selecione vídeos ou imagens
          </button>
          <p className="card-drop-hint">ou arraste os arquivos para cá</p>
          <input
            ref={visualInputRef}
            type="file"
            multiple
            accept="video/*,image/*"
            hidden
            data-testid="batch-visual-input"
            onChange={(event) => { addFiles(event.target.files, "visuals"); event.target.value = ""; }}
          />
          <div className="batch-source-list">
            {visuals.map((visual) => (
              <article key={visual.id} data-testid={`batch-visual-${visual.id}`}>
                <div><strong>{visual.kind === "image" ? "🖼️" : "🎬"} {visual.name}</strong><small>{visual.kind === "image" ? `${visual.width}×${visual.height}` : `${formatDuration(visual.duration)} · ${visual.width}×${visual.height}`}</small></div>
                <div className="batch-source-actions">
                  <button type="button" className="btn ghost compact" data-testid={`visual-for-all-${visual.id}`} onClick={() => useVisualForAll(visual)} disabled={!audios.length || busy}>Usar em todos os áudios</button>
                  <button type="button" className="icon-button" aria-label={`Remover ${visual.name}`} data-testid={`remove-visual-${visual.id}`} onClick={() => removeVisual(visual.id)} disabled={busy}>×</button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section
          className={`batch-box${dragTarget === "audios" ? " drop-active" : ""}`}
          data-testid="batch-audios-box"
          {...dropZone("audios")}
        >
          <header><div><span aria-hidden="true">🎵</span><h2>Áudios</h2></div><strong data-testid="batch-audio-count">{audios.length}</strong></header>
          <button type="button" className="btn subtle" data-testid="batch-pick-audios" onClick={() => audioInputRef.current?.click()} disabled={busy}>Selecione áudios</button>
          <p className="card-drop-hint">ou arraste os arquivos para cá</p>
          <input
            ref={audioInputRef}
            type="file"
            multiple
            accept="audio/*"
            hidden
            data-testid="batch-audio-input"
            onChange={(event) => { addFiles(event.target.files, "audios"); event.target.value = ""; }}
          />
          <div className="batch-source-list">
            {audios.map((audio) => (
              <article key={audio.id} data-testid={`batch-audio-${audio.id}`}>
                <div><strong>🎵 {audio.name}</strong><small>{formatDuration(audio.duration)}</small></div>
                <div className="batch-source-actions">
                  <button type="button" className="btn ghost compact" data-testid={`audio-for-all-${audio.id}`} onClick={() => useAudioForAll(audio)} disabled={!visuals.length || busy}>Usar em todos os vídeos</button>
                  <button type="button" className="icon-button" aria-label={`Remover ${audio.name}`} data-testid={`remove-audio-${audio.id}`} onClick={() => removeAudio(audio.id)} disabled={busy}>×</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>

      <div className="batch-pair-actions">
        <button type="button" className="btn ghost" data-testid="batch-pair-order" onClick={pairInOrder} disabled={!visuals.length || !audios.length || busy}>
          Combinar um a um <small>(1º com 1º, 2º com 2º…)</small>
        </button>
      </div>

      {visuals.some((visual) => visual.kind === "image") ? (
        <ImageSizePicker
          value={imageSize}
          onChange={onImageSizeChange}
          source={visuals.find((visual) => visual.kind === "image")}
          disabled={busy}
          idPrefix="batchImageSize"
        />
      ) : null}

      <QualityPicker
        videoQuality={videoQuality}
        onVideoQualityChange={onVideoQualityChange}
        audioQuality={audioQuality}
        onAudioQualityChange={onAudioQualityChange}
        disabled={busy}
        idPrefix="batchQuality"
      />

      <section className="batch-rows" data-testid="batch-rows">
        <header className="batch-rows-head">
          <div>
            <h2>Vídeos a gerar</h2>
            <p data-testid="batch-row-count">{rows.length} item(ns) · {completedCount} pronto(s) · {pendingCount} pendente(s)</p>
          </div>
          <button type="button" className="btn ghost compact" data-testid="batch-clear" onClick={clearRows} disabled={!rows.length || busy}>Limpar fila</button>
        </header>

        {!rows.length ? (
          <p className="batch-empty">Nada na fila ainda. Adicione vídeos/imagens e áudios e use “Usar em todos os áudios”, “Usar em todos os vídeos” ou “Combinar um a um”.</p>
        ) : (
          <div className="batch-row-list">
            {rows.map((row) => {
              const visual = visuals.find((item) => item.id === row.visualId);
              const audio = audios.find((item) => item.id === row.audioId);
              return (
                <article key={row.id} className="batch-row" data-testid={`batch-row-${row.id}`} data-status={row.status}>
                  <header>
                    <strong data-testid={`row-name-${row.id}`}>{row.fileName}</strong>
                    <span className={`batch-status ${row.status}`} data-testid={`row-status-${row.id}`}>{STATUS_LABEL[row.status]}</span>
                  </header>
                  <div className="batch-row-selects">
                    <label>Vídeo ou imagem
                      <select data-testid={`row-visual-select-${row.id}`} value={row.visualId} onChange={(event) => changeRow(row.id, { visualId: event.target.value })} disabled={busy}>
                        {visuals.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                    <label>Áudio (define o nome)
                      <select data-testid={`row-audio-select-${row.id}`} value={row.audioId} onChange={(event) => changeRow(row.id, { audioId: event.target.value })} disabled={busy}>
                        {audios.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                  </div>
                  {row.status === "working" ? (
                    <div className="batch-row-progress"><span style={{ width: `${row.percent}%` }} /><small>{row.text} · {Math.round(row.percent)}%</small></div>
                  ) : null}
                  {row.error ? <p className="batch-row-error" data-testid={`row-error-${row.id}`}>{row.error}</p> : null}
                  {row.result ? <p className="batch-row-result" data-testid={`row-result-${row.id}`}>{sourceResultText(row.result)}</p> : null}
                  <div className="batch-row-actions">
                    <button type="button" className="btn primary compact" data-testid={`row-generate-${row.id}`} onClick={() => generateMany([row])} disabled={busy || !visual || !audio}>Gerar</button>
                    {row.result ? <button type="button" className="btn ghost compact" data-testid={`row-preview-${row.id}`} onClick={() => setPreviewId(row.id)}>Ver</button> : null}
                    {row.result ? <a className="btn subtle compact" data-testid={`row-download-${row.id}`} download={row.fileName} href={row.result.downloadUrl || row.result.blobUrl} onClick={(event) => { event.preventDefault(); downloadRow(row).catch((error) => notify(error.message, "error")); }}>Baixar</a> : null}
                    {row.result ? <button type="button" className="btn youtube compact" data-testid={`row-youtube-${row.id}`} onClick={() => sendRows([row])}>YouTube</button> : null}
                    <button type="button" className="btn ghost compact" data-testid={`row-remove-${row.id}`} onClick={() => removeRow(row.id)} disabled={busy}>Remover</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {busy ? (
          <div className="batch-global-progress" aria-live="polite">
            <div className="progress-track"><span style={{ width: `${global.percent}%` }} /></div>
            <p>{global.text} · {global.done}/{global.total}</p>
          </div>
        ) : null}

        <div className="batch-footer-actions">
          <button type="button" className="btn primary" data-testid="batch-generate-all" onClick={() => generateMany(pendingRows)} disabled={!pendingRows.length || busy}>Gerar todos ({pendingRows.length})</button>
          <button type="button" className="btn subtle" data-testid="batch-download-all" onClick={downloadAll} disabled={busy}>Baixar todos ({doneRows.length})</button>
          <button type="button" className="btn youtube" data-testid="batch-send-all" onClick={() => sendRows(doneRows)} disabled={busy}>Enviar todos para o YouTube</button>
        </div>
      </section>

      {previewRow ? (
        <div className="batch-preview" data-testid="batch-preview" role="dialog" aria-modal="true" aria-label={`Prévia de ${previewRow.fileName}`}>
          <div>
            <header><strong>{previewRow.fileName}</strong><button type="button" aria-label="Fechar prévia" onClick={() => setPreviewId(null)}>×</button></header>
            <video controls playsInline preload="metadata" src={previewRow.result.previewUrl || previewRow.result.blobUrl || previewRow.result.downloadUrl} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

export { STATUS_LABEL, probeVisual };
