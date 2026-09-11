"use strict";

/**
 * LoopSync — presets de qualidade de áudio e vídeo.
 *
 * Compartilhado entre o servidor (CJS) e o navegador (ESM). Os valores são
 * resolvidos ANTES de gerar o vídeo e viram argumentos do ffmpeg:
 *
 *   - áudio  → `-b:a <bitrate>` (AAC);
 *   - vídeo  → cópia do stream original (sem recodificar) quando o preset é
 *     "auto" e o caminho de cópia é possível; caso contrário, recodifica com
 *     libx264 usando o CRF do preset.
 */

const AUDIO_QUALITY_PRESETS = [
  { id: "96", label: "96 kbps · leve", bitrate: "96k" },
  { id: "128", label: "128 kbps · boa", bitrate: "128k" },
  { id: "192", label: "192 kbps · padrão", bitrate: "192k" },
  { id: "256", label: "256 kbps · alta", bitrate: "256k" },
  { id: "320", label: "320 kbps · máxima", bitrate: "320k" },
];

const VIDEO_QUALITY_PRESETS = [
  { id: "auto", label: "Automática · copia o original quando possível (recomendado)", copyVideo: true, crf: null },
  { id: "best", label: "Máxima · CRF 17 (arquivo maior)", copyVideo: false, crf: 17 },
  { id: "high", label: "Alta · CRF 20", copyVideo: false, crf: 20 },
  { id: "balanced", label: "Equilibrada · CRF 23", copyVideo: false, crf: 23 },
  { id: "compact", label: "Menor arquivo · CRF 28", copyVideo: false, crf: 28 },
];

const DEFAULT_AUDIO_QUALITY = "192";
const DEFAULT_VIDEO_QUALITY = "auto";

function findPreset(list, id) {
  const wanted = String(id == null ? "" : id);
  return list.find((item) => item.id === wanted) || list[0];
}

function normalizeAudioQuality(id) {
  return findPreset(AUDIO_QUALITY_PRESETS, id).id;
}

function normalizeVideoQuality(id) {
  return findPreset(VIDEO_QUALITY_PRESETS, id).id;
}

/** Devolve o preset completo (usado para montar os argumentos do ffmpeg). */
function resolveAudioQuality(id) {
  return findPreset(AUDIO_QUALITY_PRESETS, id);
}

function resolveAudioBitrate(id) {
  return resolveAudioQuality(id).bitrate;
}

function resolveVideoQuality(id) {
  return findPreset(VIDEO_QUALITY_PRESETS, id);
}

/** Rótulo curto para exibição no resultado. */
function videoQualityShort(id) {
  const preset = resolveVideoQuality(id);
  return preset.crf == null ? "automática" : `CRF ${preset.crf}`;
}

function audioQualityShort(id) {
  return resolveAudioBitrate(id);
}

module.exports = {
  AUDIO_QUALITY_PRESETS,
  VIDEO_QUALITY_PRESETS,
  DEFAULT_AUDIO_QUALITY,
  DEFAULT_VIDEO_QUALITY,
  normalizeAudioQuality,
  normalizeVideoQuality,
  resolveAudioQuality,
  resolveAudioBitrate,
  resolveVideoQuality,
  videoQualityShort,
  audioQualityShort,
};
