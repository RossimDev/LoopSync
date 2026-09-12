import React, { useCallback, useEffect, useState } from "react";
import { listBases, deleteBase, getBaseFile, formatBytes, saveBase } from "./lib/bases.js";
import { kindOfFile } from "./lib/files.js";
import { formatDuration } from "./lib/format.js";

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function Bases({ showToast, onUseVisual, onUseAudio, currentVisual, currentAudio }) {
  const [bases, setBases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all"); // all, video, image, audio

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listBases();
      setBases(items);
    } catch (e) {
      console.error(e);
      showToast && showToast("Não foi possível carregar as bases.", "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaveCurrentVisual = async () => {
    if (!currentVisual || !currentVisual.file) {
      showToast && showToast("Nenhum vídeo ou imagem selecionado para salvar.", "error");
      return;
    }
    try {
      await saveBase(currentVisual.file, { name: currentVisual.name });
      showToast && showToast(`Base visual "${currentVisual.name}" salva!`);
      load();
    } catch (e) {
      showToast && showToast(e.message || "Erro ao salvar base visual.", "error");
    }
  };

  const handleSaveCurrentAudio = async () => {
    if (!currentAudio || !currentAudio.file) {
      showToast && showToast("Nenhum áudio selecionado para salvar.", "error");
      return;
    }
    try {
      await saveBase(currentAudio.file, { name: currentAudio.name });
      showToast && showToast(`Base de áudio "${currentAudio.name}" salva!`);
      load();
    } catch (e) {
      showToast && showToast(e.message || "Erro ao salvar base de áudio.", "error");
    }
  };

  const handleUse = async (base) => {
    try {
      const file = await getBaseFile(base.id);
      if (!file) {
        showToast && showToast("Não foi possível carregar o arquivo da base.", "error");
        return;
      }
      const kind = kindOfFile(file);
      if (kind === "audio") {
        onUseAudio && onUseAudio(file);
        showToast && showToast(`Áudio base "${base.name}" carregado.`);
      } else {
        onUseVisual && onUseVisual(file);
        showToast && showToast(`Visual base "${base.name}" carregado.`);
      }
    } catch (e) {
      showToast && showToast("Erro ao usar base: " + (e.message || ""), "error");
    }
  };

  const handleDelete = async (base) => {
    if (!confirm(`Remover base "${base.name}"?`)) return;
    try {
      await deleteBase(base.id);
      showToast && showToast("Base removida.");
      load();
    } catch {
      showToast && showToast("Erro ao remover base.", "error");
    }
  };

  const filtered = bases.filter((b) => {
    if (filter === "all") return true;
    if (filter === "visual") return b.kind === "video" || b.kind === "image";
    return b.kind === filter;
  });

  const visuals = filtered.filter((b) => b.kind === "video" || b.kind === "image");
  const audios = filtered.filter((b) => b.kind === "audio");

  return (
    <section className="bases-root" data-testid="bases-mode">
      <div className="bases-header">
        <div>
          <h2>📚 Minhas Bases</h2>
          <p>Salve vídeos, fotos e áudios para reutilizar sempre que quiser.</p>
        </div>
        <div className="bases-save-actions">
          <button type="button" className="btn subtle compact" onClick={handleSaveCurrentVisual} disabled={!currentVisual} data-testid="save-visual-base">
            💾 Salvar vídeo/foto atual
          </button>
          <button type="button" className="btn subtle compact" onClick={handleSaveCurrentAudio} disabled={!currentAudio} data-testid="save-audio-base">
            💾 Salvar áudio atual
          </button>
        </div>
      </div>

      <div className="bases-filters">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Todos ({bases.length})</button>
        <button className={filter === "visual" ? "active" : ""} onClick={() => setFilter("visual")}>🎬 Visuais ({bases.filter(b => b.kind === "video" || b.kind === "image").length})</button>
        <button className={filter === "video" ? "active" : ""} onClick={() => setFilter("video")}>🎬 Vídeos ({bases.filter(b => b.kind === "video").length})</button>
        <button className={filter === "image" ? "active" : ""} onClick={() => setFilter("image")}>🖼️ Fotos ({bases.filter(b => b.kind === "image").length})</button>
        <button className={filter === "audio" ? "active" : ""} onClick={() => setFilter("audio")}>🎵 Áudios ({bases.filter(b => b.kind === "audio").length})</button>
      </div>

      {loading ? (
        <p className="bases-empty">Carregando bases...</p>
      ) : filtered.length === 0 ? (
        <p className="bases-empty">
          Nenhuma base salva ainda. Selecione um vídeo/imagem e um áudio na aba LoopSync e clique em "Salvar como base".
        </p>
      ) : (
        <>
          {(filter === "all" || filter === "visual" || filter === "video" || filter === "image") && visuals.length > 0 && (
            <div className="bases-section">
              <h3>🎬 Visuais ({visuals.length})</h3>
              <div className="bases-grid">
                {visuals.map((base) => (
                  <article key={base.id} className="base-card" data-testid={`base-${base.id}`}>
                    <div className="base-card-icon">{base.kind === "image" ? "🖼️" : "🎬"}</div>
                    <div className="base-card-info">
                      <strong title={base.name}>{base.name}</strong>
                      <small>
                        {base.width && base.height ? `${base.width}×${base.height} · ` : ""}
                        {base.duration ? `${formatDuration(base.duration)} · ` : ""}
                        {formatBytes(base.sizeBytes)} · {formatDate(base.createdAt)}
                      </small>
                      {base.server && <small className="base-server-badge">☁️ servidor</small>}
                    </div>
                    <div className="base-card-actions">
                      <button className="btn primary compact" onClick={() => handleUse(base)} data-testid={`use-base-${base.id}`}>Usar</button>
                      <button className="btn ghost compact" onClick={() => handleDelete(base)} data-testid={`delete-base-${base.id}`}>🗑️</button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}

          {(filter === "all" || filter === "audio") && audios.length > 0 && (
            <div className="bases-section">
              <h3>🎵 Áudios ({audios.length})</h3>
              <div className="bases-grid">
                {audios.map((base) => (
                  <article key={base.id} className="base-card" data-testid={`base-${base.id}`}>
                    <div className="base-card-icon">🎵</div>
                    <div className="base-card-info">
                      <strong title={base.name}>{base.name}</strong>
                      <small>
                        {base.duration ? `${formatDuration(base.duration)} · ` : ""}
                        {formatBytes(base.sizeBytes)} · {formatDate(base.createdAt)}
                      </small>
                      {base.server && <small className="base-server-badge">☁️ servidor</small>}
                    </div>
                    <div className="base-card-actions">
                      <button className="btn primary compact" onClick={() => handleUse(base)} data-testid={`use-base-${base.id}`}>Usar</button>
                      <button className="btn ghost compact" onClick={() => handleDelete(base)} data-testid={`delete-base-${base.id}`}>🗑️</button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
