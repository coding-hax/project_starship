import { describe, expect, it } from 'vitest';

describe('deliberately red', () => {
  it('fails on purpose to prove a red PR cannot be merged', () => {
    expect(1).toBe(2);
  });
});
