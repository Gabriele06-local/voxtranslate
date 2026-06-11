// Sentiment timeline renderer (spec 0015): a vanilla-canvas line chart of the
// per-window mood scores (-1..1), with bookmark markers as vertical lines and
// key moments as emphasized dots. No chart library; DPR-aware so it stays
// crisp on retina displays.

export interface TimelinePoint {
  /** Window start, seconds from session start. */
  t: number;
  /** Mood score, -1 (very negative) .. 1 (very positive). */
  score: number;
}

export interface TimelineOptions {
  points: TimelinePoint[];
  /** Total session length — fixes the x axis even when windows are sparse. */
  durationSeconds: number;
  /** Bookmark offsets (seconds) drawn as vertical dashed lines. */
  bookmarks?: number[];
  /** Key-moment offsets (seconds) drawn as emphasized dots on the line. */
  keyMoments?: TimelinePoint[];
}

const PAD = { top: 10, right: 10, bottom: 18, left: 30 };

/** Resolve a CSS custom property (the chart follows the app theme). */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function fmtTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}h` : `${m}m`;
}

/** Paint the timeline into `canvas`, sized to its CSS box at the device DPR. */
export function drawSentimentTimeline(canvas: HTMLCanvasElement, opts: TimelineOptions): void {
  const cssWidth = canvas.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 120;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const w = cssWidth - PAD.left - PAD.right;
  const h = cssHeight - PAD.top - PAD.bottom;
  const duration = Math.max(1, opts.durationSeconds);
  const x = (t: number) => PAD.left + (Math.min(t, duration) / duration) * w;
  const y = (score: number) => PAD.top + ((1 - Math.max(-1, Math.min(1, score))) / 2) * h;

  const muted = cssVar('--muted', '#8a90a8');
  const accent = cssVar('--accent', '#3b82f6');
  const warning = cssVar('--warning', '#f59e0b');

  // Frame: top/zero/bottom guides + score labels.
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = muted;
  ctx.strokeStyle = muted;
  for (const [score, label] of [[1, '+1'], [0, '0'], [-1, '-1']] as const) {
    ctx.globalAlpha = score === 0 ? 0.6 : 0.25;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y(score));
    ctx.lineTo(PAD.left + w, y(score));
    ctx.setLineDash(score === 0 ? [] : [3, 3]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.fillText(label, PAD.left - 6, y(score));
  }
  // X axis end label (session length).
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.globalAlpha = 0.9;
  ctx.fillText(fmtTime(duration), PAD.left + w, PAD.top + h + 4);
  ctx.fillText('0m', PAD.left, PAD.top + h + 4);
  ctx.globalAlpha = 1;

  // Bookmark markers behind the line.
  for (const t of opts.bookmarks ?? []) {
    ctx.strokeStyle = warning;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x(t), PAD.top);
    ctx.lineTo(x(t), PAD.top + h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  const points = [...opts.points].sort((a, b) => a.t - b.t);
  if (!points.length) return;

  // The mood line.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(x(p.t), y(p.score));
    else ctx.lineTo(x(p.t), y(p.score));
  });
  ctx.stroke();

  // Window dots.
  ctx.fillStyle = accent;
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(x(p.t), y(p.score), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Key moments pop: bigger ring in the score's direction color.
  for (const m of opts.keyMoments ?? []) {
    ctx.beginPath();
    ctx.arc(x(m.t), y(m.score), 5, 0, Math.PI * 2);
    ctx.strokeStyle = m.score < 0 ? cssVar('--danger', '#ef4444') : accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
