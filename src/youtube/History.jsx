import React, { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { youtubeApi, formatDate, formatBytes, formatDuration } from "./api.js";
import { Section, Button, StatusBadge, EmptyState, Spinner, ConfirmDialog } from "./ui.jsx";

const FILTERS = [
  { id: "all", label: "Todos" },
  { id: "queued", label: "Aguardando" },
  { id: "uploading", label: "Enviando" },
  { id: "processing", label: "Processando" },
  { id: "done", label: "Concluído" },
  { id: "error", label: "Erro" },
  { id: "cancelled", label: "Cancelado" },
];

const PRIVACY_LABEL = { public: "Público", unlisted: "Não listado", private: "Privado" };

/** Histórico de uploads do canal conectado. */
export default function History({ data, showToast, onRetry }) {
  const { history, loading, connected, actions } = data;
  const [filter, setFilter] = useState("all");
  const [confirmState, setConfirmState] = useState(null);

  const refresh = useCallback(async () => {
    await actions.refreshHistory();
  }, [actions]);

  useEffect(() => {
    if (!connected) return;
    refresh();
    const timer = setInterval(() => {
      const hasPending = history.some((item) => ["queued", "uploading", "processing"].includes(item.status));
      if (hasPending) refresh();
    }, 8000);
    return () => clearInterval(timer);
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = filter === "all" ? history : history.filter((item) => item.status === filter);

  if (!connected) {
    return (
      <EmptyState
        icon="🔒"
        title="Histórico disponível após conectar"
        description="Conecte seu canal do YouTube para ver os envios feitos pelo LoopSync."
      />
    );
  }

  return (
    <div className="yt-history">
      <Section
        icon="🕘"
        title="Histórico de uploads"
        subtitle={`${history.length} registro(s) neste dispositivo/conta`}
        aside={
          <Button variant="ghost" size="sm" icon="↻" onClick={refresh} disabled={loading.history}>
            {loading.history ? <Spinner /> : "Atualizar"}
          </Button>
        }
      >
        <div className="yt-filters" role="tablist" aria-label="Filtrar histórico">
          {FILTERS.map((option) => {
            const count = option.id === "all" ? history.length : history.filter((item) => item.status === option.id).length;
            return (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={filter === option.id}
                className={`yt-filter${filter === option.id ? " active" : ""}`}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
                {count ? <span>{count}</span> : null}
              </button>
            );
          })}
        </div>

        {items.length ? (
          <ul className="yt-history-list">
            {items.map((item) => (
              <motion.li
                key={item.id}
                className="yt-history-item"
                data-testid={`history-${item.id}`}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 28 }}
              >
                <div className="yt-history-thumb">
                  {item.thumbnailUrl ? (
                    <img src={item.thumbnailUrl} alt="" loading="lazy" />
                  ) : (
                    <span aria-hidden="true">🎬</span>
                  )}
                  {item.duration ? <span className="yt-history-duration">{formatDuration(item.duration)}</span> : null}
                </div>
                <div className="yt-history-info">
                  <strong title={item.title}>{item.title || item.fileName}</strong>
                  <small className="yt-history-file" title={item.fileName}>
                    {item.fileName} · {formatBytes(item.fileSize)}
                  </small>
                  <div className="yt-history-meta">
                    <StatusBadge status={item.status} />
                    <span>{formatDate(item.completedAt || item.createdAt)}</span>
                    <span>{item.channelTitle || "—"}</span>
                    <span>{PRIVACY_LABEL[item.privacyStatus] || item.privacyStatus}</span>
                    {item.categoryTitle ? <span>{item.categoryTitle}</span> : null}
                    {item.templateName ? <span className="yt-history-template">Template: {item.templateName}</span> : null}
                  </div>
                  {item.error ? <p className="yt-history-error">{item.error}</p> : null}
                  {item.thumbnailError ? <p className="yt-history-warn">Miniatura: {item.thumbnailError}</p> : null}
                  {item.playlistError ? <p className="yt-history-warn">Playlist: {item.playlistError}</p> : null}
                  {["queued", "uploading", "processing"].includes(item.status) ? (
                    <div className="yt-history-progress">
                      <span>{item.progress || 0}%</span>
                      <span>{formatBytes(item.received || 0)} / {formatBytes(item.fileSize)}</span>
                    </div>
                  ) : null}
                </div>
                <div className="yt-history-actions">
                  {item.videoUrl ? (
                    <a className="btn primary yt-btn yt-btn--sm" data-testid={`history-open-${item.id}`} href={item.videoUrl} target="_blank" rel="noreferrer noopener">
                      Abrir no YouTube
                    </a>
                  ) : null}
                  {item.status === "error" ? (
                    <Button variant="subtle" size="sm" icon="↻" onClick={() => onRetry && onRetry(item)}>
                      Retomar
                    </Button>
                  ) : null}
                  {["queued", "uploading"].includes(item.status) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="■"
                      onClick={async () => {
                        try {
                          await youtubeApi.uploads.cancel(item.id);
                          showToast("Envio cancelado.", "info");
                          refresh();
                        } catch (err) {
                          showToast(err.message, "error");
                        }
                      }}
                    >
                      Cancelar
                    </Button>
                  ) : null}
                  {item.videoId ? <span className="yt-history-id">ID: {item.videoId}</span> : null}
                  <Button variant="ghost" size="sm" icon="🗑" onClick={() => setConfirmState(item)}>
                    Remover
                  </Button>
                </div>
              </motion.li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon="🕘"
            title={filter === "all" ? "Nenhum upload ainda" : "Nenhum upload com este status"}
            description="Envie um vídeo pela aba Enviar para vê-lo aqui com thumbnail, status, canal, privacidade e link."
          />
        )}
      </Section>

      <ConfirmDialog
        open={Boolean(confirmState)}
        title="Remover do histórico?"
        description={confirmState ? `"${confirmState.title || confirmState.fileName}" será removido apenas deste histórico — o vídeo continua no YouTube.` : ""}
        confirmLabel="Remover"
        onCancel={() => setConfirmState(null)}
        onConfirm={async () => {
          const target = confirmState;
          setConfirmState(null);
          if (!target) return;
          try {
            await youtubeApi.uploads.remove(target.id);
            showToast("Registro removido do histórico.", "success");
            refresh();
          } catch (err) {
            showToast(err.message, "error");
          }
        }}
      />
    </div>
  );
}
