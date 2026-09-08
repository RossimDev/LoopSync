export const MEDIA_EXTENSIONS = [
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "wma", "aiff", "aif", "weba",
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpeg", "mpg", "3gp", "ts",
  "jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "avif", "heic", "svg",
];
const MEDIA_EXTENSION_SET = new Set(MEDIA_EXTENSIONS);
export const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
export const MAX_BASE_LENGTH = 100;

export function baseName(name) {
  const leaf = String(name == null ? "" : name).replace(/\\/g, "/").split("/").pop() || "";
  const match = leaf.match(/\.([a-z0-9]{1,8})$/i);
  if (match && MEDIA_EXTENSION_SET.has(match[1].toLowerCase())) {
    return leaf.slice(0, -match[0].length);
  }
  return leaf;
}

export function sanitizeBaseName(name, { fallback = "video" } = {}) {
  let value = baseName(name)
    .replace(INVALID_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  if (value.length > MAX_BASE_LENGTH) {
    value = value.slice(0, MAX_BASE_LENGTH).replace(/[. ]+$/g, "");
  }
  if (value) return value;

  let safeFallback = baseName(fallback)
    .replace(INVALID_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, MAX_BASE_LENGTH)
    .replace(/[. ]+$/g, "");
  return safeFallback || "video";
}

export function outputFileName(audioName, { extension = "mp4", used = [] } = {}) {
  const base = sanitizeBaseName(audioName);
  const ext = String(extension || "mp4").replace(/^\.+/, "").replace(/[^a-z0-9]/gi, "").toLowerCase() || "mp4";
  const occupied = new Set(Array.from(used || [], (name) => String(name || "").toLowerCase()));
  let candidate = `${base}.${ext}`;
  if (!occupied.has(candidate.toLowerCase())) return candidate;
  for (let index = 2; index <= 9999; index += 1) {
    candidate = `${base} (${index}).${ext}`;
    if (!occupied.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (9999).${ext}`;
}
