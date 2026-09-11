/**
 * LoopSync — presets de qualidade de áudio e vídeo (versão ESM para o navegador).
 *
 * Mantida em paridade com `lib/quality.js` (CJS, servidor); o script de
 * validação (`scripts/validate.js`) compara as duas versões.
 */

export const AUDIO_QUALITY_PRESETS = [
  { id: "96", label: "96 kbps · leve", bitrate: "96k" },
  { id: "128", label: "128 kbps · boa", bitrate: "128k" },
  { id: "192", label: "192 kbps · padrão", bitrate: "192k" },
  { id: "256", label: "256 kbps · alta", bitrate: "256k" },
  { id: "320", label: "320 kbps · máxima", bitrate: "320k" },
];

export const VIDEO_QUALITY_PRESETS = [
  { id: "auto", label: "Automática · copia o original quando possível (recomendado)", copyVideo: true, crf: null },
  { id: "best", label: "Máxima · CRF 17 (arquivo maior)", copyVideo: false, crf: 17 },
  { id: "high", label: "Alta · CRF 20", copyVideo: false, crf: 20 },
  { id: "balanced", label: "Equilibrada · CRF 23", copyVideo: false, crf: 23 },
  { id: "compact", label: "Menor arquivo · CRF 28", copyVideo: false, crf: 28 },
];

export const DEFAULT_AUDIO_QUALITY = "192";
export const DEFAULT_VIDEO_QUALITY = "auto";

function findPreset(list, id) {
  const wanted = String(id == null ? "" : id);
  return list.find((item) => item.id === wanted) || list[0];
}

export function normalizeAudioQuality(id) {
  return findPreset(AUDIO_QUALITY_PRESETS, id).id;
}

export function normalizeVideoQuality(id) {
  return findPreset(VIDEO_QUALITY_PRESETS, id).id;
}

export function resolveAudioQuality(id) {
  return findPreset(AUDIO_QUALITY_PRESETS, id);
}

export function resolveAudioBitrate(id) {
  return resolveAudioQuality(id).bitrate;
}

export function resolveVideoQuality(id) {
  return findPreset(VIDEO_QUALITY_PRESETS, id);
}

export function videoQualityShort(id) {
  const preset = resolveVideoQuality(id);
  return preset.crf == null ? "automática" : `CRF ${preset.crf}`;
}

export function audioQualityShort(id) {
  return resolveAudioBitrate(id);
}
