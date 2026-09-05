import React, { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useYouTubeData } from "./useYouTube.js";
import Uploader from "./Uploader.jsx";
import Library from "./Library.jsx";
import History from "./History.jsx";
import Connection from "./Connection.jsx";
import { YouTubeMark } from "./ui.jsx";

const TABS = [
  { id: "send", label: "Enviar", icon: "⬆️" },
  { id: "library", label: "Biblioteca", icon: "🗂️" },
  { id: "history", label: "Histórico", icon: "🕘" },
  { id: "connection", label: "Conexão", icon: "🔌" },
];

function readHashQuery() {
  const hash = String(window.location.hash || "");
  const index = hash.indexOf("?");
  if (index === -1) return {};
  const params = new URLSearchParams(hash.slice(index + 1));
  const out = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function clearHashQuery() {
  const hash = String(window.location.hash || "");
  const index = hash.indexOf("?");
  if (index === -1) return;
  const clean = hash.slice(0, index) || "#/youtube";
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${clean}`);
}

const ERROR_HINTS = {
  access_denied: "Você cancelou a autorização no Google. Nada foi alterado.",
  invalid_state: "A sessão de autorização expirou. Tente conectar novamente.",
  missing_code: "O Google não devolveu o código de autorização. Tente novamente.",
  invalidGrant: "Não foi possível trocar o código por tokens. Verifique o URI de redirecionamento no Google Cloud.",
  redirect_uri_mismatch: "O URI de redirecionamento não está cadastrado no Google Cloud Console.",
  unauthorized_client: "O cliente OAuth não está autorizado para este redirect URI.",
  invalid_client: "Credenciais inválidas. Confira GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.",
  youtubeSignupRequired: "Esta conta Google ainda não tem canal no YouTube. Crie o canal e tente de novo.",
  quotaExceeded: "Cota diária da YouTube Data API esgotada neste projeto.",
};

/**
 * Área YouTube do LoopSync: conexão do canal, upload com metadados completos,
 * biblioteca de descrições/tags/templates e histórico.
 */
export default function YouTube({ showToast, incomingVideo, onIncomingConsumed }) {
  const data = useYouTubeData();
  const [tab, setTab] = useState("send");
  const [applyRequest, setApplyRequest] = useState(null);

  const { connected, serverAvailable, ready, actions } = data;

  /* resultado do redirect OAuth (#/youtube?yt=connected|error) */
  useEffect(() => {
    const query = readHashQuery();
    if (!query.yt) return;
    clearHashQuery();
    if (query.yt === "connected") {
      setTab("send");
      actions.refreshStatus().then(async (status) => {
        if (status && status.connected) {
          await Promise.all([
            actions.refreshCategories({ force: true }),
            actions.refreshPlaylists({ force: true }),
            actions.refreshHistory(),
          ]);
        }
      });
      showToast("Canal conectado com sucesso! Agora selecione um vídeo para enviar.", "success");
    } else {
      setTab("connection");
      const reason = query.reason || "auth_failed";
      const detail = query.detail ? ` (${query.detail})` : "";
      showToast(ERROR_HINTS[reason] ? `${ERROR_HINTS[reason]}${detail}` : `Falha ao conectar: ${reason}${detail}`, "error");
      actions.refreshStatus();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ao conectar/desconectar, recarrega o que depende do canal */
  useEffect(() => {
    if (!connected) return;
    actions.refreshHistory();
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const useDescription = useCallback((description) => {
    setApplyRequest({ type: "description", payload: description, at: Date.now() });
    setTab("send");
  }, []);

  const useTagSet = useCallback((tagSet, options) => {
    setApplyRequest({ type: "tagSet", payload: tagSet, options, at: Date.now() });
    setTab("send");
  }, []);

  const useTemplate = useCallback((template) => {
    setApplyRequest({ type: "template", payload: template, at: Date.now() });
    setTab("send");
  }, []);

  const onApplyHandled = useCallback(() => setApplyRequest(null), []);

  if (!serverAvailable) {
    return (
      <div className="yt-root">
        <YouTubeHeader connected={false} />
        <Connection data={data} showToast={showToast} />
      </div>
    );
  }

  return (
    <div className="yt-root">
      <YouTubeHeader connected={connected} channel={data.channel} />

      <nav className="yt-tabs" role="tablist" aria-label="Seções do YouTube">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`yt-tab${tab === item.id ? " active" : ""}`}
            data-testid={`tab-${item.id}`}
            onClick={() => setTab(item.id)}
          >
            <span className="yt-tab-icon" aria-hidden="true">{item.icon}</span>
            {item.label}
            {item.id === "history" && data.history.length ? <span className="yt-tab-count">{data.history.length}</span> : null}
            {item.id === "connection" ? (
              <span className={`yt-tab-dot ${connected ? "on" : ""}`} aria-hidden="true" />
            ) : null}
          </button>
        ))}
      </nav>

      {!ready ? (
        <div className="yt-loading">Carregando módulo YouTube…</div>
      ) : (
        <>
        {/* O uploader continua montado (oculto) nas outras abas: a fila de
            vídeos, os metadados em edição e os uploads em andamento sobrevivem
            à navegação entre abas. */}
        <div className="yt-panel" data-testid="panel-send" hidden={tab !== "send"}>
          <Uploader
            data={data}
            showToast={showToast}
            incomingVideo={incomingVideo}
            onIncomingConsumed={onIncomingConsumed}
            applyRequest={applyRequest}
            onApplyHandled={onApplyHandled}
          />
        </div>

        <AnimatePresence mode="wait">
          {tab !== "send" ? (
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ type: "spring", stiffness: 260, damping: 28 }}
            >
              {tab === "library" ? (
                <Library
                  data={data}
                  showToast={showToast}
                  onUseDescription={useDescription}
                  onUseTagSet={useTagSet}
                  onUseTemplate={useTemplate}
                />
              ) : null}
              {tab === "history" ? <History data={data} showToast={showToast} /> : null}
              {tab === "connection" ? <Connection data={data} showToast={showToast} /> : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
        </>
      )}
    </div>
  );
}

function YouTubeHeader({ connected, channel }) {
  return (
    <header className="yt-header">
      <div className="yt-header-brand">
        <span className="yt-header-mark" aria-hidden="true">
          <YouTubeMark size={26} />
        </span>
        <div>
          <h1>YouTube</h1>
          <p>Envie seus vídeos direto para o canal, com descrições e tags salvas.</p>
        </div>
      </div>
      <div className="yt-header-status">
        {connected && channel ? (
          <span className="yt-channel-chip">
            {channel.thumbnail ? <img src={channel.thumbnail} alt="" /> : <span aria-hidden="true">📺</span>}
            <span>
              <strong>{channel.title}</strong>
              <small>canal conectado</small>
            </span>
          </span>
        ) : (
          <span className="yt-channel-chip off">
            <span aria-hidden="true">🔌</span>
            <span>
              <strong>Canal não conectado</strong>
              <small>conecte para enviar</small>
            </span>
          </span>
        )}
      </div>
    </header>
  );
}
