// Fetch wrappers for the advanced-feature REST endpoints (specs 0011+):
// transcript documents, AI pricing, and — in later phases — bookmarks,
// subtitles, glossaries, reports, sentiment and email. Auth/session plumbing
// stays in auth.ts; this module only talks JSON.

import { authHeaders, HTTP_BASE } from './auth';

// ---- Transcript document (GET /api/sessions/{id}/transcript.json) ----------

export interface TranscriptParticipant {
  /** The peer id (never a user UUID). */
  id: string;
  name: string;
  language: string;
}

export interface TranscriptEvent {
  type: 'speech' | 'chat' | string;
  ts: string;
  speaker_id: string;
  speaker_name: string;
  lang: string;
  original: string;
  /** `{ lang: text }` for every target language in the room at capture time. */
  translations: Record<string, string>;
}

export interface ExportBookmark {
  ts: string;
  label?: string | null;
  /** Creator's display name (user UUIDs never leave the server). */
  by: string;
}

export interface TranscriptDoc {
  session: {
    id: string;
    room_name: string;
    started_at: string;
    ended_at?: string | null;
    duration_seconds: number;
    participants: TranscriptParticipant[];
  };
  events: TranscriptEvent[];
  bookmarks: ExportBookmark[];
  exported_at: string;
}

/** Full transcript document for a session, or null on 403/404/network error. */
export async function fetchTranscript(sessionId: string): Promise<TranscriptDoc | null> {
  try {
    const res = await fetch(
      `${HTTP_BASE}/api/sessions/${encodeURIComponent(sessionId)}/transcript.json`,
      { headers: authHeaders() },
    );
    if (!res.ok) return null;
    return (await res.json()) as TranscriptDoc;
  } catch {
    return null;
  }
}

// ---- Bookmarks (REST under /api/sessions/{id}/bookmarks) -------------------

export interface Bookmark {
  id: string;
  ts: string;
  label?: string | null;
  /** Creator's display name (user UUIDs never leave the server). */
  by: string;
  /** True when the viewer owns it — gates the edit/delete UI. */
  mine: boolean;
}

/** All participants' bookmarks, chronological; null on 403/404/network error. */
export async function fetchBookmarks(sessionId: string): Promise<Bookmark[] | null> {
  try {
    const res = await fetch(
      `${HTTP_BASE}/api/sessions/${encodeURIComponent(sessionId)}/bookmarks`,
      { headers: authHeaders() },
    );
    if (!res.ok) return null;
    return (await res.json()) as Bookmark[];
  } catch {
    return null;
  }
}

/**
 * Pin a moment. No `ts` is sent — the server stamps "now", avoiding client
 * clock skew; the in-call flow POSTs instantly and PATCHes the label after.
 */
export async function addBookmark(sessionId: string): Promise<Bookmark | null> {
  try {
    const res = await fetch(
      `${HTTP_BASE}/api/sessions/${encodeURIComponent(sessionId)}/bookmarks`,
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as Bookmark;
  } catch {
    return null;
  }
}

/** Relabel an owned bookmark (empty label clears it). */
export async function updateBookmarkLabel(
  sessionId: string,
  bookmarkId: string,
  label: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${HTTP_BASE}/api/sessions/${encodeURIComponent(sessionId)}/bookmarks/${encodeURIComponent(bookmarkId)}`,
      {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Delete an owned bookmark. */
export async function deleteBookmark(sessionId: string, bookmarkId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${HTTP_BASE}/api/sessions/${encodeURIComponent(sessionId)}/bookmarks/${encodeURIComponent(bookmarkId)}`,
      { method: 'DELETE', headers: authHeaders() },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ---- AI pricing (GET /api/billing/ai-pricing) -------------------------------

export interface AiPricing {
  report: { base: number; per_minute: number };
  sentiment: { base: number; per_participant: number; per_minute: number };
  email: { draft: number };
  suggestions: { per_minute: number; interval_seconds: number };
  /** False when the backend has no Resend credentials (email feature 503s). */
  email_enabled: boolean;
}

let pricingCache: AiPricing | null = null;

/** Per-feature user rates for cost previews. Cached for the page lifetime. */
export async function fetchAiPricing(): Promise<AiPricing | null> {
  if (pricingCache) return pricingCache;
  try {
    const res = await fetch(`${HTTP_BASE}/api/billing/ai-pricing`, { cache: 'no-store' });
    if (!res.ok) return null;
    pricingCache = (await res.json()) as AiPricing;
    return pricingCache;
  } catch {
    return null;
  }
}

// ---- Shared error shape ------------------------------------------------------

/** The 402 body every credit-charged AI endpoint returns on insufficient funds. */
export interface InsufficientCredits {
  error: 'insufficient_credits';
  required: number;
  available: number;
  feature: string;
}

/** Parse a 402 response body, or null when it isn't the standard shape. */
export async function parseInsufficient(res: Response): Promise<InsufficientCredits | null> {
  if (res.status !== 402) return null;
  try {
    const body = (await res.json()) as InsufficientCredits;
    return body.error === 'insufficient_credits' ? body : null;
  } catch {
    return null;
  }
}
