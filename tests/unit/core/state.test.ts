import { describe, it, expect } from '@jest/globals';

const { signState, verifyState } = await import('../../../Core/Auth/state.js');

const SECRET = 'intuit-state-secret';
const NOW = 1_700_000_000_000;

describe('OAuth state HMAC signing', () => {
  it('round-trips tenantId and nonce', () => {
    const state = signState({ tenantId: 't-1', nonce: 'n-1' }, SECRET, { now: NOW });
    expect(verifyState(state, SECRET, { now: NOW })).toEqual({ tenantId: 't-1', nonce: 'n-1' });
  });

  it('rejects a tampered payload/signature', () => {
    const state = signState({ tenantId: 't-1', nonce: 'n-1' }, SECRET, { now: NOW });
    const [body] = state.split('.');
    const forged = `${body}.deadbeef`;
    expect(() => verifyState(forged, SECRET, { now: NOW })).toThrow(/signature/i);
  });

  it('rejects a state signed with a different secret', () => {
    const state = signState({ tenantId: 't-1', nonce: 'n-1' }, SECRET, { now: NOW });
    expect(() => verifyState(state, 'other-secret', { now: NOW })).toThrow(/signature/i);
  });

  it('rejects an expired state', () => {
    const state = signState({ tenantId: 't-1', nonce: 'n-1' }, SECRET, { now: NOW, ttlMs: 10 * 60 * 1000 });
    expect(() => verifyState(state, SECRET, { now: NOW + 11 * 60 * 1000 })).toThrow(/expired/i);
  });

  it('rejects a malformed state', () => {
    expect(() => verifyState('not-a-state', SECRET, { now: NOW })).toThrow(/malformed/i);
  });
});
