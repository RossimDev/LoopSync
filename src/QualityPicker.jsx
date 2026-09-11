import React from "react";
import { AUDIO_QUALITY_PRESETS, VIDEO_QUALITY_PRESETS } from "./lib/quality.js";

/**
 * Seleção de qualidade de áudio e vídeo, escolhida ANTES de gerar o vídeo.
 * Compartilhada entre o modo Vídeo único e o modo Em massa.
 */
export default function QualityPicker({
  videoQuality,
  onVideoQualityChange,
  audioQuality,
  onAudioQualityChange,
  disabled = false,
  idPrefix = "quality",
}) {
  const videoValue = videoQuality || "auto";
  const audioValue = audioQuality || "192";

  return (
    <div className="quality-picker" data-testid="quality-picker">
      <div className="quality-picker-grid">
        <label className="quality-field">
          <span className="quality-label">Qualidade do vídeo</span>
          <select
            id={`${idPrefix}VideoQuality`}
            data-testid="quality-video-select"
            value={videoValue}
            onChange={(event) => {
              if (typeof onVideoQualityChange === "function") onVideoQualityChange(event.target.value);
            }}
            disabled={disabled}
          >
            {VIDEO_QUALITY_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>
        </label>
        <label className="quality-field">
          <span className="quality-label">Qualidade do áudio</span>
          <select
            id={`${idPrefix}AudioQuality`}
            data-testid="quality-audio-select"
            value={audioValue}
            onChange={(event) => {
              if (typeof onAudioQualityChange === "function") onAudioQualityChange(event.target.value);
            }}
            disabled={disabled}
          >
            {AUDIO_QUALITY_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="quality-note">
        Escolha antes de criar: “Automática” copia o vídeo original sem recodificar quando possível; as demais opções recodificam com a qualidade indicada. O áudio é sempre convertido para AAC no bitrate escolhido.
      </p>
    </div>
  );
}
