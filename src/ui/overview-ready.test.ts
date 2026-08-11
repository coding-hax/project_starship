import { describe, expect, it } from 'vitest';
import {
  INITIAL_REVEAL_STATE,
  nextRevealState,
  type RevealAction,
  type RevealState,
} from './overview-ready';

function apply(state: RevealState, ...actions: RevealAction[]): RevealState {
  return actions.reduce(nextRevealState, state);
}

describe('nextRevealState', () => {
  it('stays hidden while any registered block is still loading', () => {
    const state = apply(
      INITIAL_REVEAL_STATE,
      { kind: 'register', id: 'ring', ready: false },
      { kind: 'register', id: 'termine', ready: false },
      { kind: 'settle' },
    );

    expect(state.revealed).toBe(false);
  });

  it('stays hidden when only some blocks have answered', () => {
    const state = apply(
      INITIAL_REVEAL_STATE,
      { kind: 'register', id: 'ring', ready: false },
      { kind: 'register', id: 'termine', ready: false },
      { kind: 'register', id: 'ring', ready: true },
      { kind: 'settle' },
    );

    expect(state.revealed).toBe(false);
  });

  it('reveals only once the last block has answered', () => {
    const state = apply(
      INITIAL_REVEAL_STATE,
      { kind: 'register', id: 'ring', ready: false },
      { kind: 'register', id: 'termine', ready: false },
      { kind: 'register', id: 'ring', ready: true },
      { kind: 'settle' },
      { kind: 'register', id: 'termine', ready: true },
      { kind: 'settle' },
    );

    expect(state.revealed).toBe(true);
  });

  it('reveals immediately when no block registers at all (alle Module aus)', () => {
    // The empty registry is vacuously "all ready" — without this the screen would
    // hang hidden forever with nothing left to wait for.
    expect(apply(INITIAL_REVEAL_STATE, { kind: 'settle' }).revealed).toBe(true);
  });

  it('never reveals before settle, even with every block ready', () => {
    // `register` alone must not flip it: settle is dispatched from the provider's
    // own effect, which runs after the children's, and that ordering is the only
    // thing guaranteeing the registry is complete when it is evaluated.
    const state = apply(INITIAL_REVEAL_STATE, { kind: 'register', id: 'ring', ready: true });

    expect(state.revealed).toBe(false);
  });

  it('latches: a block registering later cannot hide the screen again', () => {
    const revealed = apply(
      INITIAL_REVEAL_STATE,
      { kind: 'register', id: 'ring', ready: true },
      { kind: 'settle' },
    );
    expect(revealed.revealed).toBe(true);

    const after = apply(
      revealed,
      { kind: 'register', id: 'spaet', ready: false },
      { kind: 'settle' },
    );

    expect(after.revealed).toBe(true);
    expect(after).toBe(revealed);
  });

  it('drops a block that unmounts while still loading, and reveals without it', () => {
    const state = apply(
      INITIAL_REVEAL_STATE,
      { kind: 'register', id: 'ring', ready: true },
      { kind: 'register', id: 'termine', ready: false },
      { kind: 'settle' },
    );
    expect(state.revealed).toBe(false);

    const after = apply(state, { kind: 'unregister', id: 'termine' }, { kind: 'settle' });

    expect(after.revealed).toBe(true);
  });

  it('returns the identical state for a no-op register, so the effect loop terminates', () => {
    const state = apply(INITIAL_REVEAL_STATE, { kind: 'register', id: 'ring', ready: false });

    expect(nextRevealState(state, { kind: 'register', id: 'ring', ready: false })).toBe(state);
    expect(nextRevealState(state, { kind: 'unregister', id: 'unbekannt' })).toBe(state);
    expect(nextRevealState(state, { kind: 'settle' })).toBe(state);
  });
});
