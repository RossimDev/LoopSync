export const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|bmp|tiff?|avif|heic|svg|ico|dpx|exr)$/i;
export const VIDEO_EXT = /\.(?:mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpeg|mpg|3gp|ts)$/i;
export const AUDIO_EXT = /\.(?:mp3|wav|m4a|aac|flac|ogg|oga|opus|wma|aiff|aif|weba)$/i;

export function kindOfFile(file) {
  const type = String((file && file.type) || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  const name = String((file && file.name) || "");
  if (IMAGE_EXT.test(name)) return "image";
  if (VIDEO_EXT.test(name)) return "video";
  if (AUDIO_EXT.test(name)) return "audio";
  return "unknown";
}

function withObjectUrl(file, tag, read) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement(tag);
    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      try { element.removeAttribute("src"); } catch { /* noop */ }
      try { element.load && element.load(); } catch { /* noop */ }
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      try {
        const result = callback();
        cleanup();
        resolve(result);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    element.onerror = () => finish(() => { throw new Error(tag); });
    read(element, finish);
    element.src = url;
  });
}

export function loadImageSize(file) {
  return withObjectUrl(file, "img", (image, finish) => {
    image.onload = () => finish(() => {
      const width = Number(image.naturalWidth || image.width);
      const height = Number(image.naturalHeight || image.height);
      if (!(width > 0 && height > 0)) throw new Error("image");
      return { width, height };
    });
  });
}

export function loadVideoMeta(file) {
  return withObjectUrl(file, "video", (video, finish) => {
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish(() => {
      const duration = Number(video.duration);
      const width = Number(video.videoWidth);
      const height = Number(video.videoHeight);
      if (!(Number.isFinite(duration) && duration > 0 && width > 0 && height > 0)) throw new Error("video");
      return { duration, width, height };
    });
  });
}

export async function loadVideoDuration(file) {
  return (await loadVideoMeta(file)).duration;
}

export function loadAudioDuration(file) {
  return withObjectUrl(file, "audio", (audio, finish) => {
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(() => {
      const duration = Number(audio.duration);
      if (!(Number.isFinite(duration) && duration > 0)) throw new Error("audio");
      return duration;
    });
  });
}

export async function readVisualFile(file) {
  const kind = kindOfFile(file);
  if (kind === "image") {
    const size = await loadImageSize(file);
    return { file, kind, duration: 0, ...size };
  }
  if (kind === "video") {
    const meta = await loadVideoMeta(file);
    return { file, kind, ...meta };
  }
  throw new Error("visual");
}
