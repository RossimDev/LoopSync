import React from "react";
import {
  IMAGE_SIZE_PRESETS,
  imageSizeForPreset,
  normalizeImageSize,
  describeImageSize,
  MIN_SIDE,
  MAX_SIDE,
} from "./lib/image-size.js";

export default function ImageSizePicker({
  value,
  onChange,
  source,
  disabled = false,
  idPrefix = "imageSize",
}) {
  const current = value || { preset: "original", width: 0, height: 0 };
  const size = normalizeImageSize(current);
  const description = describeImageSize(current, source);

  const emit = (next) => {
    if (typeof onChange === "function") onChange(next);
  };

  const choosePreset = (event) => {
    emit(imageSizeForPreset(event.target.value, current));
  };

  const changeSide = (side) => (event) => {
    emit({ ...current, preset: "custom", [side]: event.target.value });
  };

  return (
    <div className="image-size-picker" data-testid="image-size-picker">
      <label className="image-size-label" htmlFor={`${idPrefix}Preset`}>Resolução de saída</label>
      <select
        id={`${idPrefix}Preset`}
        className="image-size-select"
        data-testid="image-size-select"
        value={current.preset || "original"}
        onChange={choosePreset}
        disabled={disabled}
      >
        {IMAGE_SIZE_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>{preset.label}</option>
        ))}
      </select>

      {current.preset === "custom" ? (
        <div className="image-size-custom">
          <label htmlFor={`${idPrefix}Width`}>
            Largura
            <input
              id={`${idPrefix}Width`}
              data-testid="image-size-width"
              type="number"
              min={MIN_SIDE}
              max={MAX_SIDE}
              step="2"
              inputMode="numeric"
              value={current.width ?? ""}
              onChange={changeSide("width")}
              disabled={disabled}
            />
          </label>
          <span aria-hidden="true">×</span>
          <label htmlFor={`${idPrefix}Height`}>
            Altura
            <input
              id={`${idPrefix}Height`}
              data-testid="image-size-height"
              type="number"
              min={MIN_SIDE}
              max={MAX_SIDE}
              step="2"
              inputMode="numeric"
              value={current.height ?? ""}
              onChange={changeSide("height")}
              disabled={disabled}
            />
          </label>
        </div>
      ) : null}

      <p className="image-size-summary" data-testid="image-size-summary">
        {size
          ? `Saída ${description} — a foto é escalada para caber e o resto do quadro vira barras pretas (nada é esticado).`
          : `Saída na resolução ${description}.`}
      </p>
    </div>
  );
}
