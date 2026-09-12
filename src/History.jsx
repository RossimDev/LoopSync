import React, { useCallback, useEffect, useState } from "react";
import { listHistory, deleteHistory, clearHistory, formatBytes, formatDate } from "./lib/history.js";
import { formatDuration } from "./lib/format.js";

function HistoryCard({ item, onDelete, onPreview }) {
  const { date, time } = formatDate(item.createdAt);
  const size = formatBytes(item.sizeBytes);
  const thumb = item.thumbDataUrl || item.thumbUrl || null;
  const gb = (Number(item.sizeBytes) || 0) / 1024 / 1024 / 1024;
  const mb = (Number(item.sizeBytes) || 0) / 1024 / 1024;

  return (
    <article className="history-card" data-testid={`history-${item.id}`}>
      <div className="history-thumb" onClick={() => onPreview && onPreview(item)}>
        {thumb ? (
          <img src={thumb} alt={item.fileName} loading="lazy" />
        ) : (
          <div className="history-thumb-placeholder">{item.isImage ? "🖼️" : "🎬"}</div>
        )}
        <span className="history-duration-badge">
          {item.outputDuration || (item.duration ? formatDuration(item.duration) : "") || ""}
        </span>
      </div>
      <div className="history-info">
        <strong className="history-filename" title={item.fileName}>{item.fileName}</strong>
        <div className="history-meta">
          <small>📅 {date} às {time}</small>
          <small>💾 {mb >= 1024 ? `${gb.toFixed(2)} GB` : `${mb.toFixed(1)} MB`} ({size})</small>
          {item.width && item.height && <small>📐 {item.width}×{item.height}</small>}
          {item.loopCount != null && <small>🔁 {item.loopCount} loops</small>}
          {item.videoQuality && <small>🎥 {item.videoQuality}</small>}
          {item.audioQuality && <small>🎵 {item.audioQuality}</small>}
        </div>
        {(item.originalVisualName || item.originalAudioName) && (
          <div className="history-sources">
            {item.originalVisualName && <small>🎬 {item.originalVisualName}</small>}
            {item.originalAudioName && <small>🎵 {item.originalAudioName}</small>}
          </div>
        )}
      </div>
      <div className="history-actions">
        {item.downloadUrl || item.jobId ? (
          <a
            className="btn subtle compact"
            href={item.downloadUrl || (item.jobId ? `/api/result/${item.jobId}?name=${encodeURIComponent(item.fileName)}` : "#")}
            download={item.fileName}
            target="_blank"
            rel="noreferrer"
            data-testid={`history-download-${item.id}`}
          >
            Baixar
          </a>
        ) : null}
        <button className="btn ghost compact" onClick={() => onDelete(item)} data-testid={`history-delete-${item.id}`}>🗑️</button>
      </div>
    </article>
  );
}

export default function History({ showToast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listHistory();
      setItems(list);
    } catch (e) {
      console.error(e);
      showToast && showToast("Erro ao carregar histórico.", "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (item) => {
    if (!confirm(`Remover "${item.fileName}" do histórico?`)) return;
    try {
      await deleteHistory(item.id);
      setItems((cur) => cur.filter((i) => i.id !== item.id));
      showToast && showToast("Removido do histórico.");
    } catch {
      showToast && showToast("Erro ao remover.", "error");
    }
  };

  const handleClear = async () => {
    if (!confirm(`Limpar todo o histórico (${items.length} itens)?`)) return;
    try {
      await clearHistory();
      setItems([]);
      showToast && showToast("Histórico limpo.");
    } catch {
      showToast && showToast("Erro ao limpar histórico.", "error");
    }
  };

  return (
    <section className="history-root" data-testid="history-mode">
      <div className="history-header">
        <div>
          <h2>🕘 Histórico</h2>
          <p>Visualize todos os trabalhos já feitos com nome, thumb, tamanho, data e hora.</p>
        </div>
        <div className="history-header-actions">
          <button className="btn ghost compact" onClick={load} disabled={loading}>🔄 Atualizar</button>
          <button className="btn danger compact" onClick={handleClear} disabled={!items.length}>🗑️ Limpar tudo</button>
        </div>
      </div>

      {loading ? (
        <p className="bases-empty">Carregando histórico...</p>
      ) : items.length === 0 ? (
        <p className="bases-empty">Nenhum vídeo gerado ainda. Seus trabalhos aparecerão aqui com thumbnail, tamanho em GB, data e hora.</p>
      ) : (
        <>
          <p className="history-count">{items.length} vídeo(s) no histórico</p>
          <div className="history-grid">
            {items.map((item) => (
              <HistoryCard key={item.id} item={item} onDelete={handleDelete} onPreview={setPreview} />
            ))}
          </div>
        </>
      )}

      {preview && (
        <div className="history-preview" role="dialog" aria-modal="true" onClick={() => setPreview(null)}>
          <div className="history-preview-box" onClick={(e) => e.stopPropagation()}>
            <header>
              <strong>{preview.fileName}</strong>
              <button aria-label="Fechar" onClick={() => setPreview(null)}>×</button>
            </header>
            <div className="history-preview-thumb">
              {preview.thumbDataUrl || preview.thumbUrl ? (
                <img src={preview.thumbDataUrl || preview.thumbUrl} alt={preview.fileName} />
              ) : (
                <div className="history-thumb-placeholder large">{preview.isImage ? "🖼️" : "🎬"}</div>
              )}
            </div>
            <div className="history-preview-meta">
              <p><strong>Arquivo:</strong> {preview.fileName}</p>
              <p><strong>Tamanho:</strong> {formatBytes(preview.sizeBytes)} ({(preview.sizeBytes / 1024 / 1024 / 1024).toFixed(3)} GB)</p>
              <p><strong>Data:</strong> {formatDate(preview.createdAt).full}</p>
              {preview.width && preview.height && <p><strong>Resolução:</strong> {preview.width}×{preview.height}</p>}
              {preview.outputDuration && <p><strong>Duração:</strong> {preview.outputDuration}</p>}
              {preview.originalVisualName && <p><strong>Visual base:</strong> {preview.originalVisualName}</p>}
              {preview.originalAudioName && <p><strong>Áudio base:</strong> {preview.originalAudioName}</p>}
              {preview.videoQuality && <p><strong>Qualidade vídeo:</strong> {preview.videoQuality}</p>}
              {preview.audioQuality && <p><strong>Qualidade áudio:</strong> {preview.audioQuality}</p>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
