import { describe, expect, it } from 'vitest';
import { buildRecipientRefs, validEmail } from './email-utils';

describe('validEmail', () => {
  it('accepts plausible addresses', () => {
    expect(validEmail('a@b.co')).toBe(true);
    expect(validEmail('first.last+tag@sub.example.com')).toBe(true);
  });

  it('rejects malformed addresses', () => {
    for (const bad of [
      'nope',
      '@b.co',
      'a@',
      'a@nodot',
      'a@.dot',
      'a@dot.',
      'a b@x.co',
      'a@b@c.co',
      `${'a'.repeat(255)}@x.co`,
    ]) {
      expect(validEmail(bad), bad).toBe(false);
    }
  });
});

describe('buildRecipientRefs', () => {
  it('maps chips to refs with cc flags', () => {
    const refs = buildRecipientRefs({
      participants: ['p1', 'p2'],
      emails: ['Ext@X.com'],
      cc: ['boss@x.com'],
    });
    expect(refs).toEqual([
      { kind: 'participant', peer_id: 'p1' },
      { kind: 'participant', peer_id: 'p2' },
      { kind: 'email', email: 'ext@x.com', cc: false },
      { kind: 'email', email: 'boss@x.com', cc: true },
    ]);
  });

  it('dedupes peers and case-insensitive addresses across to/cc', () => {
    const refs = buildRecipientRefs({
      participants: ['p1', 'p1'],
      emails: ['a@x.co', 'A@X.CO'],
      cc: ['a@x.co', ' '],
    });
    expect(refs).toEqual([
      { kind: 'participant', peer_id: 'p1' },
      { kind: 'email', email: 'a@x.co', cc: false },
    ]);
  });
});
