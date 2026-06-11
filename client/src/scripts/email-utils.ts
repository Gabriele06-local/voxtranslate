// Pure helpers for the follow-up email composer (spec 0016). Standalone so
// vitest (node environment) can import them — i18n.ts touches `navigator` at
// module level and must stay out of this dependency graph.

import type { RecipientRef } from './api';

/** Mirror of the server's pragmatic address check — reject typos client-side
 *  before a round-trip; the server remains the real gate. */
export function validEmail(s: string): boolean {
  if (s.length > 254 || /\s/.test(s)) return false;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return false;
  const domain = s.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

/** What the composer chips hold: participant peer ids (To) and raw addresses
 *  split into To / CC lists. */
export interface ComposerRecipients {
  participants: string[];
  emails: string[];
  cc: string[];
}

/** Build the request payload from the chip state; dedup is cosmetic here (the
 *  server collapses dupes again after resolving participants to accounts). */
export function buildRecipientRefs(r: ComposerRecipients): RecipientRef[] {
  const refs: RecipientRef[] = [];
  const seenPeers = new Set<string>();
  const seenEmails = new Set<string>();
  for (const peerId of r.participants) {
    if (seenPeers.has(peerId)) continue;
    seenPeers.add(peerId);
    refs.push({ kind: 'participant', peer_id: peerId });
  }
  for (const [list, cc] of [
    [r.emails, false],
    [r.cc, true],
  ] as const) {
    for (const raw of list) {
      const email = raw.trim().toLowerCase();
      if (!email || seenEmails.has(email)) continue;
      seenEmails.add(email);
      refs.push({ kind: 'email', email, cc });
    }
  }
  return refs;
}
