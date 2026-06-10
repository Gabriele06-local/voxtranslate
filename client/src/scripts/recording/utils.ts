// Composite recording (spec 0010) — pure helpers with injectable browser deps
// so the logic is unit-testable in node.

/** WebM codec preference: vp9 → vp8 → container default. */
export const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/**
 * First supported recording mime type, or '' to let MediaRecorder pick its
 * default. `isSupported` is injectable for tests.
 */
export function pickMimeType(
  isSupported: (t: string) => boolean = (t) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
): string {
  return MIME_CANDIDATES.find((t) => isSupported(t)) ?? '';
}

/** `voxtranslate-{room}-{YYYY-MM-DD-HHmm}.webm` (room slugged for safety). */
export function recordingFilename(room: string, date: Date): string {
  const slug =
    room
      .split('')
      .filter((c) => /[A-Za-z0-9_-]/.test(c))
      .join('')
      .slice(0, 40) || 'call';
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `voxtranslate-${slug}-${stamp}.webm`;
}

/** Elapsed recording time as `MM:SS` (minutes keep growing past 99). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Feature-detect everything the composite recorder needs (Safari lacks parts). */
export function isRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

/** Up to two initials for the placeholder disc ("Ada Lovelace" → "AL"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/** Stable hue per name — same hash as app.ts `avatarGradient`. */
export function hueOf(name: string): number {
  let hash = 0;
  for (const ch of name) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}
