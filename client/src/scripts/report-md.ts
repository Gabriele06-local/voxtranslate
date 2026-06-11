// Pure helpers for the AI report UI (spec 0014) — kept dependency-free so the
// vitest node environment can cover them: a minimal Markdown renderer for the
// model's output (escape-first, so transcript content can never inject HTML)
// and the client-side cost estimate mirroring the server formula.

/** Escape `& < >` — runs before any tag-producing transform. */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline Markdown on already-escaped text: `code`, **bold**, *italic*. */
const inline = (s: string): string =>
  escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

/**
 * Render the report Markdown (headings, bullet/numbered lists, paragraphs,
 * bold/italic/code) to HTML. Hand-rolled on purpose: the input is model
 * output in a known dialect, and a parser dependency isn't worth it. All
 * text is HTML-escaped before any tags are added.
 */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  const closeList = (): void => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      // The report's own sections are `##` — render as h3/h4 inside the card.
      const tag = h[1].length <= 2 ? 'h3' : 'h4';
      out.push(`<${tag}>${inline(h[2])}</${tag}>`);
    } else if (bullet || num) {
      flushPara();
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) {
        closeList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((bullet ?? num)![1])}</li>`);
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara();
  closeList();
  return out.join('');
}

/**
 * Client-side preview of the server's report cost:
 * `base + per_minute × ⌈minutes⌉`, minimum one minute — must stay in sync with
 * `billed_minutes` / `report_cost` in `server/src/ai/`.
 */
export function estimateReportCost(
  pricing: { base: number; per_minute: number },
  durationSeconds: number,
): number {
  const minutes = Math.max(1, Math.ceil(Math.max(0, durationSeconds) / 60));
  return pricing.base + pricing.per_minute * minutes;
}
