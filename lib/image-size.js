"use strict";

const MIN_SIDE = 16;
const MAX_SIDE = 7680;

function even(value) {
  if (value === "" || value == null) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return 0;
  let result = Math.round(numeric);
  result = Math.max(MIN_SIDE, Math.min(MAX_SIDE, result));
  if (result % 2 !== 0) result -= 1;
  return result;
}

function normalizeImageSize(choice) {
  if (!choice || choice.preset === "original") return null;
  const width = even(choice.width);
  const height = even(choice.height);
  return width && height ? { width, height } : null;
}

function imageScaleFilter(size) {
  const normalized = normalizeImageSize(size);
  if (!normalized) return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const { width, height } = normalized;
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

module.exports = { MIN_SIDE, MAX_SIDE, even, normalizeImageSize, imageScaleFilter };
