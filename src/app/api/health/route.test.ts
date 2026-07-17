import { describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
vi.mock('@/db', () => ({ db: { execute: (...args: unknown[]) => execute(...args) } }));

describe('GET /api/health', () => {
  it('returns 200 and ok:true when the DB answers', async () => {
    execute.mockResolvedValueOnce(undefined);

    const { GET } = await import('./route');
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('version');
  });

  it('returns 503 and ok:false when the DB throws', async () => {
    execute.mockRejectedValueOnce(new Error('connection refused'));

    const { GET } = await import('./route');
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
  });
});
