export function formatDuration(seconds) {
  const numeric = Number(seconds);
  const totalSeconds = Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (value) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
