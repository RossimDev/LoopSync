import React, { useState } from "react";
import { motion } from "motion/react";
import { Section, Button, ConfirmDialog, EmptyState, Spinner } from "./ui.jsx";
import { formatDate } from "./api.js";

const SCOPE_LABELS = {
  "https://www.googleapis.com/auth/youtube.force-ssl": "Gerenciar sua conta do YouTube (uploads, playlists, miniaturas)",
  "https://www.googleapis.com/auth/youtube.upload": "Enviar vídeos para o seu canal",
  "https://www.googleapis.com/auth/youtube.readonly": "Ver canal, categorias e playlists",
  "https://www.googleapis.com/auth/youtube.force-ssl ": "",
  openid: "Identificar sua conta Google",
  "https://www.googleapis.com/auth/userinfo.email": "Ver seu e-mail (para identificar o dono dos dados)",
};

/** Painel de conexão com o canal do YouTube. */
export default function Connection({ data, showToast }) {
  const { status, connected, channel, serverAvailable, actions, playlists, categories } = data;
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const configured = Boolean(status && status.canUpload);

  if (!serverAvailable) {
    return (
      <Section icon="🖥️" title="YouTube exige o servidor do LoopSync" tone="danger">
        <EmptyState
          icon="🔌"
          title="Modo estático detectado"
          description="Esta página está rodando sem o servidor do LoopSync. O OAuth 2.0 e o envio de vídeos precisam do backend para proteger o client secret e os tokens — nunca ficam no navegador."
          action={
            <div className="yt-setup-steps">
              <ol>
                <li>Rode o LoopSync com <code>npm install</code> e depois <code>npm start</code>.</li>
                <li>Defina <code>GOOGLE_CLIENT_ID</code> e <code>GOOGLE_CLIENT_SECRET</code> no ambiente do servidor.</li>
                <li>Abra <code>http://localhost:3000</code> e use a aba YouTube.</li>
              </ol>
              <p className="yt-hint">Instruções completas em <code>docs/YOUTUBE_SETUP.md</code>.</p>
            </div>
          }
        />
      </Section>
    );
  }

  if (!configured) {
    return (
      <Section icon="🔑" title="Configurar a integração" subtitle="Faltam as credenciais do Google Cloud no servidor" tone="warn">
        <div className="yt-setup">
          <p>
            O LoopSync usa a API oficial (OAuth 2.0 + YouTube Data API v3). Para habilitar o envio real de vídeos,
            configure as credenciais no <strong>servidor</strong> — elas nunca chegam ao navegador.
          </p>
          <ol className="yt-setup-steps">
            <li>
              Crie um projeto no <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer noopener">Google Cloud Console</a> e
              ative a <strong>YouTube Data API v3</strong>.
            </li>
            <li>
              Em <em>Credenciais</em>, crie um <strong>ID do cliente OAuth 2.0</strong> do tipo <em>Aplicativo da Web</em> e adicione o
              URI de redirecionamento: <code>{(status && status.redirectUri) || "http://localhost:3000/api/youtube/auth/callback"}</code>
            </li>
            <li>
              Exporte as variáveis de ambiente e reinicie o servidor:
              <pre className="yt-code">{`GOOGLE_CLIENT_ID="....apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-..."
GOOGLE_REDIRECT_URI="${(status && status.redirectUri) || "http://localhost:3000/api/youtube/auth/callback"}"
npm start`}</pre>
            </li>
            <li>Enquanto o app estiver em “Teste”, adicione sua conta Google como <em>usuário de teste</em> na tela de consentimento.</li>
          </ol>
          <p className="yt-hint">Passo a passo detalhado (cotas, publicação, primeiros testes) em <code>docs/YOUTUBE_SETUP.md</code>.</p>
        </div>
      </Section>
    );
  }

  return (
    <div className="yt-connection">
      {connected && channel ? (
        <Section
          data-testid="connection-panel"
          icon="✅"
          title="Canal conectado"
          subtitle="Autenticado com OAuth 2.0 — tokens guardados apenas no servidor"
          tone="ok"
          aside={<span className="yt-badge tone-ok"><span className="yt-badge-dot" />Conectado</span>}
        >
          <motion.div className="yt-channel" layout>
            <div className="yt-channel-avatar">
              {channel.thumbnail ? <img src={channel.thumbnail} alt={`Foto do canal ${channel.title}`} /> : <span aria-hidden="true">📺</span>}
            </div>
            <dl className="yt-channel-info">
              <div><dt>Canal</dt><dd><strong>{channel.title || "—"}</strong></dd></div>
              <div><dt>Conta Google</dt><dd>{channel.email || channel.googleUserId || "—"}</dd></div>
              <div><dt>ID do canal</dt><dd className="mono">{channel.id || "—"}</dd></div>
              <div><dt>Inscritos</dt><dd>{channel.hiddenSubscriberCount ? "oculto" : (channel.subscriberCount || 0).toLocaleString("pt-BR")}</dd></div>
              <div><dt>Vídeos no canal</dt><dd>{(channel.videoCount || 0).toLocaleString("pt-BR")}</dd></div>
              <div><dt>Playlists carregadas</dt><dd>{playlists.length}</dd></div>
              <div><dt>Categorias</dt><dd>{categories.length}</dd></div>
              <div><dt>Conectado em</dt><dd>{formatDate(channel.connectedAt)}</dd></div>
              <div><dt>Token válido até</dt><dd>{formatDate(channel.tokenExpiresAt)} <span className="yt-hint-inline">(renovado automaticamente)</span></dd></div>
            </dl>
          </motion.div>

          <div className="yt-row-actions">
            <Button
              variant="ghost"
              size="sm"
              icon="↻"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await actions.refreshChannel();
                  await Promise.all([actions.refreshCategories({ force: true }), actions.refreshPlaylists({ force: true }), actions.refreshHistory()]);
                  showToast("Dados do canal atualizados.", "success");
                } catch (err) {
                  showToast(err.message || "Não foi possível atualizar.", "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Spinner /> : null} Atualizar dados
            </Button>
            <Button variant="danger" size="sm" icon="⏏" data-testid="disconnect-channel" onClick={() => setConfirmDisconnect(true)}>
              Desconectar canal
            </Button>
          </div>

          <div className="yt-security-note">
            <strong>🔒 Como seus dados são tratados</strong>
            <ul>
              <li>O <em>client secret</em>, o <em>access token</em> e o <em>refresh token</em> ficam só no servidor do LoopSync.</li>
              <li>O navegador recebe apenas: nome do canal, foto, e-mail, estatísticas e o estado dos uploads.</li>
              <li>Descrições, tags, templates e histórico são isolados por conta — ninguém acessa dados de outro usuário.</li>
              <li>A senha do Google nunca é pedida, vista ou armazenada: a autorização acontece no próprio Google.</li>
              <li>“Desconectar” revoga o token no Google e apaga as credenciais locais.</li>
            </ul>
          </div>
        </Section>
      ) : (
        <Section
          icon="🔌"
          title="Conectar canal do YouTube"
          subtitle="Autenticação oficial do Google (OAuth 2.0) com a YouTube Data API v3"
        >
          <div className="yt-connect">
            <p>Conecte sua conta para enviar vídeos direto para o canal, listar playlists, categorias e aplicar miniaturas.</p>
            <ul className="yt-scope-list">
              {(status && status.scopes ? status.scopes : []).map((scope) => (
                <li key={scope}>
                  <span className="yt-scope-check" aria-hidden="true">✓</span>
                  {SCOPE_LABELS[scope] || scope}
                </li>
              ))}
            </ul>
            <div className="yt-actions">
              <Button
                variant="primary"
                icon="▶"
                data-testid="connect-google"
                disabled={connecting}
                onClick={async () => {
                  setConnecting(true);
                  try {
                    await actions.startConnection("/#/youtube");
                  } catch (err) {
                    setConnecting(false);
                    showToast(err.message || "Não foi possível iniciar a conexão.", "error");
                  }
                }}
              >
                {connecting ? "Abrindo o Google…" : "Conectar com o Google"}
              </Button>
            </div>
            <p className="yt-hint">
              Você será redirecionado para <code>accounts.google.com</code>. Ao autorizar, o Google devolve apenas um código
              temporário — trocado no servidor por tokens que nunca aparecem no navegador nem em URLs.
            </p>
          </div>
        </Section>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        title="Desconectar o canal?"
        description="O acesso será revogado no Google e os tokens serão apagados deste servidor. Suas descrições, tags e histórico continuam salvos."
        confirmLabel="Desconectar"
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={async () => {
          setConfirmDisconnect(false);
          try {
            await actions.disconnect();
            showToast("Canal desconectado.", "success");
          } catch (err) {
            showToast(err.message || "Não foi possível desconectar.", "error");
          }
        }}
      />
    </div>
  );
}
