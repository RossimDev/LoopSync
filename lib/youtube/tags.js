"use strict";

/**
 * LoopSync — motor de sugestões de tags.
 *
 * Analisa título e/ou assunto informado pelo usuário e devolve palavras-chave
 * relacionadas. É 100% local (sem rede, sem custo de cota da API) e nada é
 * adicionado ao vídeo sem o usuário confirmar — as sugestões apenas aparecem
 * para seleção.
 *
 * Estratégia:
 *   1. normalização e remoção de stopwords (pt-BR + en);
 *   2. extração de unigramas/bigramas/trigramas do texto;
 *   3. expansão por léxico de domínio (música, games, vlog, tutorial, etc.);
 *   4. padrões comuns de tags do YouTube ("titulo oficial", "video completo"...);
 *   5. pontuação + deduplicação + respeito ao limite de 500 caracteres.
 */

const STOPWORDS = new Set([
  // pt-BR
  "a","o","as","os","um","uma","uns","umas","de","da","do","das","dos","em","no","na","nos","nas",
  "para","pra","por","com","sem","sob","sobre","entre","e","ou","mas","que","se","ao","aos","à","às",
  "este","esta","esse","essa","isso","isto","aquilo","meu","minha","seu","sua","nosso","nossa","eu",
  "voce","você","ele","ela","eles","elas","muito","mais","menos","ja","já","tambem","também","como",
  "quando","onde","qual","quais","ser","sao","são","foi","era","tem","ter","ha","há","la","lá","ca","cá",
  "ate","até","desde","the","and","for","with","of","to","in","on","at","is","are","was","were","this",
  "that","it","as","by","from","my","your","you","i","we","they","he","she","be","been","do","does",
  "did","have","has","had","not","no","but","or","if","then","than","so","very","can","will","just",
  "official","video","vídeo","novo","nova","full","hd","4k","mp4",
]);

/**
 * Léxico por domínio: quando uma palavra-chave do domínio aparece no texto,
 * os termos relacionados são sugeridos.
 */
const LEXICON = [
  {
    id: "musica-eletronica",
    triggers: ["eletronica", "eletrônica", "electronic", "edm", "house", "techno", "trance", "dubstep", "rave", "dj", "discotecagem"],
    terms: ["electronic", "electronic music", "edm", "dance music", "dj set", "dj mix", "house", "techno", "trance", "rave", "club mix", "festival", "party mix", "bass", "remix"],
  },
  {
    id: "musica-geral",
    triggers: ["musica", "música", "music", "song", "cancao", "canção", "som", "audio", "áudio", "trilha", "faixa", "single", "album", "álbum", "ep", "beat", "instrumental"],
    terms: ["musica", "music", "music video", "official audio", "novo som", "lancamento", "lançamento", "playlist", "mix", "remix", "cover", "instrumental", "beat", "lyrics", "letra", "audio oficial"],
  },
  {
    id: "remix-mashup",
    triggers: ["remix", "mashup", "edit", "bootleg", "flip", "vip mix"],
    terms: ["remix", "official remix", "mashup", "edit", "bootleg", "vip mix", "dj remix", "extended mix", "radio edit", "remix 2025"],
  },
  {
    id: "dj-set",
    triggers: ["set", "live set", "mixtape", "dj mix", "boiler room", "live"],
    terms: ["dj set", "live set", "mixtape", "dj mix", "full set", "live performance", "club set", "boiler room", "set completo"],
  },
  {
    id: "funk-brasil",
    triggers: ["funk", "baile", "mandelao", "mandela", "brasil", "brazil", "favela", "carioca", "paulista"],
    terms: ["funk", "funk brasil", "baile funk", "funk carioca", "funk paulista", "mandelao", "brasil", "brazil", "musica brasileira", "lancamento funk"],
  },
  {
    id: "sertanejo-pagode",
    triggers: ["sertanejo", "pagode", "samba", "forro", "forró", "piseiro", "arrocha", "sofrencia", "sofrência"],
    terms: ["sertanejo", "sertanejo universitario", "pagode", "samba", "forro", "piseiro", "arrocha", "sofrencia", "musica brasileira", "modao"],
  },
  {
    id: "rap-hiphop",
    triggers: ["rap", "hip hop", "hiphop", "trap", "freestyle", "rima", "mc", "drill"],
    terms: ["rap", "hip hop", "trap", "drill", "freestyle", "rima", "mc", "rap nacional", "trap brasil", "beat"],
  },
  {
    id: "lofi-chill",
    triggers: ["lofi", "lo-fi", "chill", "relaxar", "relax", "estudar", "study", "dormir", "sleep", "calma", "ambient"],
    terms: ["lofi", "lofi hip hop", "chill", "chill beats", "study music", "musica para estudar", "relaxing music", "musica para dormir", "ambient", "focus music"],
  },
  {
    id: "rock-metal",
    triggers: ["rock", "metal", "punk", "guitarra", "banda", "hardcore", "indie"],
    terms: ["rock", "metal", "punk", "indie rock", "guitarra", "banda", "hardcore", "rock nacional", "live session"],
  },
  {
    id: "games",
    triggers: ["game", "gameplay", "jogo", "jogos", "playstation", "xbox", "nintendo", "pc gamer", "fortnite", "minecraft", "gta", "free fire", "valorant", "lol", "roblox", "fifa", "ea fc"],
    terms: ["gameplay", "games", "jogos", "walkthrough", "let's play", "dicas", "guia", "pro player", "pc gamer", "console", "game brasileiro"],
  },
  {
    id: "vlog-lifestyle",
    triggers: ["vlog", "dia a dia", "rotina", "viagem", "travel", "passeio", "familia", "família", "casal", "vida"],
    terms: ["vlog", "rotina", "dia a dia", "lifestyle", "viagem", "travel vlog", "daily vlog", "familia", "bastidores", "vlog brasil"],
  },
  {
    id: "tutorial-educacao",
    triggers: ["tutorial", "como fazer", "aprender", "aula", "curso", "dica", "dicas", "passo a passo", "guia", "educacao", "educação"],
    terms: ["tutorial", "como fazer", "passo a passo", "dicas", "aula", "curso", "aprender", "guia completo", "do zero", "explicado"],
  },
  {
    id: "tech",
    triggers: ["tech", "tecnologia", "review", "unboxing", "setup", "software", "app", "iphone", "android", "pc", "hardware"],
    terms: ["tecnologia", "review", "unboxing", "setup", "tech", "gadgets", "software", "app", "hardware", "vale a pena"],
  },
  {
    id: "fitness-saude",
    triggers: ["treino", "fitness", "academia", "dieta", "emagrecer", "saude", "saúde", "yoga", "crossfit", "corrida"],
    terms: ["treino", "fitness", "academia", "dieta", "emagrecimento", "saude", "yoga", "crossfit", "corrida", "exercicios em casa"],
  },
  {
    id: "culinaria",
    triggers: ["receita", "comida", "culinaria", "culinária", "cozinha", "food", "bolo", "almoco", "almoço", "jantar", "restaurante"],
    terms: ["receita", "comida", "culinaria", "cozinha", "food", "receita facil", "como fazer", "comida brasileira", "restaurante", "saboroso"],
  },
  {
    id: "shorts",
    triggers: ["short", "shorts", "vertical", "9x16", "reels", "tiktok", "clip", "corte"],
    terms: ["shorts", "youtube shorts", "short video", "vertical", "clip", "cortes", "tiktok", "reels", "viral"],
  },
  {
    id: "cristao-gospel",
    triggers: ["gospel", "louvor", "adoracao", "adoração", "igreja", "jesus", "deus", "culto", "oracao", "oração"],
    terms: ["gospel", "louvor", "adoracao", "musica gospel", "igreja", "culto", "oracao", "hino", "cristao"],
  },
];

const GENERIC_SUFFIXES = [
  "youtube",
  "canal",
  "brasil",
  "2025",
  "novo",
  "completo",
];

const MAX_TOTAL_CHARS = 500; // limite oficial do YouTube para a soma das tags
const MAX_TAGS = 40;

function slug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  const normalized = slug(text);
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token.length > 1);
}

function ngrams(tokens, size) {
  const out = [];
  for (let i = 0; i + size <= tokens.length; i += 1) {
    const gram = tokens.slice(i, i + size).join(" ");
    out.push(gram);
  }
  return out;
}

function isMeaningful(token) {
  if (token.length < 2) return false;
  if (STOPWORDS.has(token)) return false;
  if (/^\d+$/.test(token)) return false;
  return true;
}

/**
 * Limpa uma lista de tags vindas do usuário: sem vírgulas (quebrariam o
 * formato da API), sem duplicadas, sem vazias e dentro do limite de 500 chars.
 */
function normalizeTags(tags, { maxTotal = MAX_TOTAL_CHARS, maxCount = MAX_TAGS } = {}) {
  const seen = new Set();
  const out = [];
  let total = 0;

  const queue = [];
  for (const raw of Array.isArray(tags) ? tags : String(tags || "").split(",")) {
    // vírgula separa tags (mesmo comportamento do campo de tags do YouTube)
    for (const part of String(raw == null ? "" : raw).split(",")) queue.push(part);
  }

  for (const raw of queue) {
    const tag = String(raw || "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    if (!tag) continue;
    const key = slug(tag);
    if (!key || seen.has(key)) continue;
    const cost = tag.length + (out.length ? 1 : 0);
    if (total + cost > maxTotal) continue;
    seen.add(key);
    out.push(tag);
    total += cost;
    if (out.length >= maxCount) break;
  }
  return out;
}

function tagsTotalLength(tags) {
  return (tags || []).reduce((acc, tag, index) => acc + tag.length + (index ? 1 : 0), 0);
}

/**
 * Gera sugestões de tags a partir de título/assunto.
 *
 * @param {object} input
 * @param {string} [input.title] título do vídeo
 * @param {string} [input.subject] assunto/tema informado pelo usuário
 * @param {string} [input.description] descrição (usada como contexto extra)
 * @param {string[]} [input.baseTags] tags já escolhidas (para evitar duplicar)
 * @param {number} [input.limit] quantidade máxima de sugestões
 * @returns {{suggestions: Array<{tag:string,score:number,source:string}>}}
 */
function suggestTags(input = {}) {
  const title = String(input.title || "").trim();
  const subject = String(input.subject || "").trim();
  const description = String(input.description || "").trim();
  const baseTags = new Set((input.baseTags || []).map((tag) => slug(tag)).filter(Boolean));
  const limit = Number(input.limit || 24);

  const primaryText = `${title} ${subject}`.trim();
  const contextText = `${primaryText} ${description}`.trim();

  const scored = new Map();
  const add = (tag, score, source) => {
    const clean = String(tag || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!clean) return;
    const key = slug(clean);
    if (!key || baseTags.has(key)) return;
    const existing = scored.get(key);
    if (existing) {
      existing.score += score;
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      scored.set(key, { tag: clean.toLowerCase(), score, sources: [source] });
    }
  };

  if (!contextText) return { suggestions: [] };

  const titleTokens = tokenize(primaryText);
  const contextTokens = tokenize(contextText);

  // 1. título inteiro (tag forte)
  const titleTag = slug(title);
  if (titleTag && titleTag.length <= 60) add(titleTag, 12, "titulo");

  // 2. unigramas relevantes
  const unigramCount = new Map();
  for (const token of contextTokens) {
    if (!isMeaningful(token)) continue;
    unigramCount.set(token, (unigramCount.get(token) || 0) + 1);
  }
  for (const [token, count] of unigramCount) {
    const inTitle = titleTokens.includes(token);
    add(token, 3 + Math.min(count, 4) + (inTitle ? 4 : 0), "palavra-chave");
  }

  // 3. bigramas/trigramas (caudas longas são ótimas no YouTube)
  const titleFiltered = titleTokens.filter((token) => !STOPWORDS.has(token));
  for (const gram of ngrams(titleFiltered, 2)) add(gram, 8, "expressao");
  for (const gram of ngrams(titleFiltered, 3)) add(gram, 9, "expressao");

  // 4. expansão por léxico de domínio
  const haystack = slug(contextText);
  for (const domain of LEXICON) {
    const hits = domain.triggers.filter((trigger) => haystack.includes(trigger));
    if (!hits.length) continue;
    const bonus = Math.min(hits.length * 2, 8);
    for (const term of domain.terms) add(term, 4 + bonus, `tema:${domain.id}`);
  }

  // 5. padrões comuns do YouTube com as palavras mais fortes do título
  const strongTokens = titleFiltered.slice(0, 4);
  const strongPhrase = strongTokens.join(" ");
  const patterns = [
    `${strongPhrase}`,
    `${strongPhrase} oficial`,
    `${strongPhrase} completo`,
    `${strongPhrase} 2025`,
    `${strongPhrase} lyrics`,
    `${strongPhrase} ao vivo`,
    `${strongPhrase} brasil`,
  ];
  for (const pattern of patterns) {
    if (slug(pattern)) add(pattern, 5, "padrao");
  }

  // 6. termos genéricos de descoberta
  for (const suffix of GENERIC_SUFFIXES) add(suffix, 1, "generico");

  const suggestions = [...scored.values()]
    .map((item) => ({ tag: item.tag, score: Math.round(item.score), source: item.sources[0] }))
    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag))
    .slice(0, Math.max(1, limit));

  // Garante que a lista caiba no limite total junto com as tags atuais.
  const baseLength = tagsTotalLength([...baseTags]);
  const allowed = Math.max(0, MAX_TOTAL_CHARS - baseLength);
  const fitted = [];
  let total = 0;
  for (const item of suggestions) {
    const cost = item.tag.length + (fitted.length || baseTags.size ? 1 : 0);
    if (total + cost > allowed) continue;
    total += cost;
    fitted.push(item);
  }

  return { suggestions: fitted, totalChars: baseLength + total, maxTotalChars: MAX_TOTAL_CHARS };
}

module.exports = {
  suggestTags,
  normalizeTags,
  tagsTotalLength,
  slug,
  tokenize,
  STOPWORDS,
  LEXICON,
  MAX_TOTAL_CHARS,
  MAX_TAGS,
};
