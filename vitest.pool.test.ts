import { afterEach, describe, expect, it, vi } from 'vitest';
import { slotWorkerLimit } from './vitest.pool.mts';

describe('slotWorkerLimit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('leaves single-slot runs unchanged (SLOT_COUNT=1)', () => {
    expect(slotWorkerLimit(1, 12)).toEqual({});
  });

  it('defaults to unchanged when SLOT_COUNT env is unset', () => {
    // This process itself may run under a runner slot with SLOT_COUNT set
    // (ADR-0014) -- stub it so the "unset" case is deterministic here too.
    vi.stubEnv('SLOT_COUNT', '');
    expect(slotWorkerLimit()).toEqual({});
  });

  it('caps workers to the fair share of cores for a multi-slot run', () => {
    expect(slotWorkerLimit(3, 12)).toEqual({ maxWorkers: 4, minWorkers: 1 });
  });

  it('clamps to at least one worker when the fair share rounds down to zero', () => {
    expect(slotWorkerLimit(3, 2)).toEqual({ maxWorkers: 1, minWorkers: 1 });
  });

  it('clamps to at least one worker for a large SLOT_COUNT', () => {
    expect(slotWorkerLimit(10, 6)).toEqual({ maxWorkers: 1, minWorkers: 1 });
  });
});
