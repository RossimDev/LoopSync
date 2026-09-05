"use strict";

/**
 * LoopSync — templates de configuração do YouTube.
 *
 * O objetivo é apenas permitir que um template já existente seja aplicado ao
 * fluxo do upload (não há sistema de criação de templates complexo): os
 * templates abaixo já vêm prontos com o app e são disponibilizados para todos
 * os usuários. Templates pessoais podem ser salvos a partir de uma
 * configuração atual, e ficam visíveis somente para o dono.
 *
 * Placeholders suportados em título/descrição:
 *   {arquivo} {filename} — nome do arquivo sem extensão
 *   {titulo}  {title}    — nome do arquivo formatado como título
 *   {data}    {date}     — data atual (dd/mm/aaaa)
 *   {hora}    {time}     — hora atual (hh:mm)
 *   {duracao}            — duração do vídeo (mm:ss ou hh:mm:ss)
 *   {canal}   {channel}  — nome do canal conectado
 *   {tamanho}            — tamanho do arquivo legível
 */

const BUILTIN_TEMPLATES = [
  {
    id: "tpl_loopsync_default",
    ownerId: null,
    builtin: true,
    name: "Padrão LoopSync",
    description: "Configuração básica gerada pelo LoopSync (vídeo + música em loop).",
    titlePattern: "{titulo}",
    descriptionTemplate:
      "Vídeo gerado com o LoopSync — o vídeo se repete automaticamente até o final da música.\n\n🎵 Trilha: {arquivo}\n📅 Publicado em {data}\n\n#LoopSync",
    tags: ["loopsync", "video com musica", "loop", "music video"],
    categoryId: "10",
    privacyStatus: "private",
    playlistId: null,
    madeForKids: false,
    language: "pt-BR",
    notifySubscribers: false,
  },
  {
    id: "tpl_musica",
    ownerId: null,
    builtin: true,
    name: "Música / Remix",
    description: "Ideal para faixas, sets, remixes e mixes.",
    titlePattern: "{titulo}",
    descriptionTemplate:
      "🎧 {titulo}\n\nProdução/DJ: {canal}\nLançamento: {data}\n\n▶️ Curta, comente e inscreva-se no canal para mais músicas.\n\n#musica #dj #mix",
    tags: ["musica", "music", "dj", "remix", "mix", "set", "electronic", "dance", "lancamento"],
    categoryId: "10",
    privacyStatus: "public",
    playlistId: null,
    madeForKids: false,
    language: "pt-BR",
    notifySubscribers: true,
  },
  {
    id: "tpl_shorts",
    ownerId: null,
    builtin: true,
    name: "Shorts / Vertical",
    description: "Para vídeos curtos verticais com descoberta rápida.",
    titlePattern: "{titulo} #shorts",
    descriptionTemplate: "{titulo}\n\n#shorts #viral",
    tags: ["shorts", "youtube shorts", "viral", "short video", "clip"],
    categoryId: "22",
    privacyStatus: "public",
    playlistId: null,
    madeForKids: false,
    language: "pt-BR",
    notifySubscribers: false,
  },
  {
    id: "tpl_vlog",
    ownerId: null,
    builtin: true,
    name: "Vlog",
    description: "Vlogs, rotina e dia a dia.",
    titlePattern: "{titulo} | Vlog {data}",
    descriptionTemplate:
      "Mais um vlog no canal! 🎥\n\n📅 {data}\n\nSe inscreva e ative o sininho para não perder os próximos vídeos.\n\n#vlog #rotina",
    tags: ["vlog", "rotina", "dia a dia", "lifestyle", "vlog brasil"],
    categoryId: "22",
    privacyStatus: "public",
    playlistId: null,
    madeForKids: false,
    language: "pt-BR",
    notifySubscribers: true,
  },
  {
    id: "tpl_tutorial",
    ownerId: null,
    builtin: true,
    name: "Tutorial / Aula",
    description: "Conteúdo educativo com passos e materiais.",
    titlePattern: "Como fazer {titulo} — passo a passo",
    descriptionTemplate:
      "Neste vídeo você aprende: {titulo}.\n\n📌 Capítulos:\n00:00 Introdução\n\n🔗 Links e materiais na descrição.\n\n#tutorial #comofazer",
    tags: ["tutorial", "como fazer", "passo a passo", "dicas", "aula", "aprender"],
    categoryId: "27",
    privacyStatus: "public",
    playlistId: null,
    madeForKids: false,
    language: "pt-BR",
    notifySubscribers: false,
  },
  {
    id: "tpl_gaming",
    ownerId: null,
    builtin: true,
    name: "Gaming / Gameplay",
    description: "Gameplays, lives cortadas e dicas de jogos.",
    titlePattern: "{titulo} — Gameplay",
    descriptionTemplate:
      "🎮 {titulo}\n\nJogo: {titulo}\nGravado em {data}\n\nDeixe seu like e se inscreva para mais gameplays!\n\n#gaming #gameplay",
    tags: ["gameplay", "games", "jogos", "game brasileiro", "dicas", "live"],
    categoryId: "20",
    privacyStatus: "public",
    playlistId: null,
    madeForKids: false,
    language: "pt-BR",
    notifySubscribers: true,
  },
];

/** Categoria padrão usada quando a lista da API ainda não foi carregada. */
const CATEGORY_FALLBACK = [
  { id: "1", title: "Film & Animation" },
  { id: "2", title: "Autos & Vehicles" },
  { id: "10", title: "Music" },
  { id: "15", title: "Pets & Animals" },
  { id: "17", title: "Sports" },
  { id: "19", title: "Travel & Events" },
  { id: "20", title: "Gaming" },
  { id: "22", title: "People & Blogs" },
  { id: "23", title: "Comedy" },
  { id: "24", title: "Entertainment" },
  { id: "25", title: "News & Politics" },
  { id: "26", title: "Howto & Style" },
  { id: "27", title: "Education" },
  { id: "28", title: "Science & Technology" },
  { id: "29", title: "Nonprofits & Activism" },
];

const PRIVACY_OPTIONS = [
  { id: "public", label: "Público", hint: "Qualquer pessoa pode assistir." },
  { id: "unlisted", label: "Não listado", hint: "Só quem tem o link assiste." },
  { id: "private", label: "Privado", hint: "Somente você e quem você autorizar." },
];

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatDate(date = new Date()) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function formatTime(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function titleFromFileName(fileName) {
  const base = String(fileName || "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/[-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return "Vídeo";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Aplica os placeholders de um template ao vídeo selecionado.
 */
function resolveTemplate(template, context = {}) {
  if (!template) return null;
  const now = new Date(context.date ? new Date(context.date) : Date.now());
  const fileName = context.fileName || "";
  const replacements = {
    arquivo: fileName.replace(/\.[a-z0-9]{1,5}$/i, ""),
    filename: fileName,
    titulo: context.title || titleFromFileName(fileName),
    title: context.title || titleFromFileName(fileName),
    data: formatDate(now),
    date: now.toISOString().slice(0, 10),
    hora: formatTime(now),
    time: formatTime(now),
    duracao: Number.isFinite(Number(context.duration)) ? formatDuration(context.duration) : "",
    duration: Number.isFinite(Number(context.duration)) ? formatDuration(context.duration) : "",
    canal: context.channelTitle || "",
    channel: context.channelTitle || "",
    tamanho: formatBytes(context.fileSize),
    size: formatBytes(context.fileSize),
  };

  const apply = (text) =>
    String(text || "").replace(/\{(\w+)\}/g, (match, key) => {
      const value = replacements[String(key).toLowerCase()];
      return value === undefined ? match : value;
    });

  return {
    id: template.id,
    name: template.name,
    title: apply(template.titlePattern || template.title || "").trim(),
    description: apply(template.descriptionTemplate || template.description || ""),
    tags: Array.isArray(template.tags) ? [...template.tags] : [],
    categoryId: template.categoryId ? String(template.categoryId) : null,
    privacyStatus: template.privacyStatus || "private",
    playlistId: template.playlistId || null,
    madeForKids: Boolean(template.madeForKids),
    language: template.language || "pt-BR",
    notifySubscribers: Boolean(template.notifySubscribers),
  };
}

module.exports = {
  BUILTIN_TEMPLATES,
  CATEGORY_FALLBACK,
  PRIVACY_OPTIONS,
  resolveTemplate,
  titleFromFileName,
  formatDuration,
  formatDate,
  formatTime,
  formatBytes,
};
