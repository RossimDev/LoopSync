export const MIN_SIDE = 16;
export const MAX_SIDE = 7680;

export function even(value) {
  if (value === "" || value == null) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return 0;
  let result = Math.round(numeric);
  result = Math.max(MIN_SIDE, Math.min(MAX_SIDE, result));
  if (result % 2 !== 0) result -= 1;
  return result;
}

export function normalizeImageSize(choice) {
  if (!choice || choice.preset === "original") return null;
  const width = even(choice.width);
  const height = even(choice.height);
  return width && height ? { width, height } : null;
}

export function imageScaleFilter(size) {
  const normalized = normalizeImageSize(size);
  if (!normalized) return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const { width, height } = normalized;
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

export const IMAGE_SIZE_PRESETS = [
  { id: "original", label: "Manter a resolução da foto (padrão)" },
  { id: "1920x1080", label: "1920×1080 · horizontal (16:9)", width: 1920, height: 1080 },
  { id: "1280x720", label: "1280×720 · horizontal HD", width: 1280, height: 720 },
  { id: "1080x1920", label: "1080×1920 · vertical (9:16 — Shorts/Reels)", width: 1080, height: 1920 },
  { id: "1080x1080", label: "1080×1080 · quadrado (1:1)", width: 1080, height: 1080 },
  { id: "custom", label: "Personalizado…" },
];

export const DEFAULT_IMAGE_SIZE = { preset: "original", width: 0, height: 0 };

export function imageSizeForPreset(id, previous = DEFAULT_IMAGE_SIZE) {
  const preset = IMAGE_SIZE_PRESETS.find((item) => item.id === id) || IMAGE_SIZE_PRESETS[0];
  if (preset.id === "original") return { ...DEFAULT_IMAGE_SIZE };
  if (preset.id === "custom") {
    const normalized = normalizeImageSize(previous);
    return {
      preset: "custom",
      width: normalized ? normalized.width : 1920,
      height: normalized ? normalized.height : 1080,
    };
  }
  return { preset: preset.id, width: preset.width, height: preset.height };
}

export function describeImageSize(choice, source) {
  const size = normalizeImageSize(choice);
  if (size) return `${size.width}×${size.height}`;
  const width = even(source && source.width);
  const height = even(source && source.height);
  return width && height ? `da foto (${width}×${height})` : "da foto";
}
