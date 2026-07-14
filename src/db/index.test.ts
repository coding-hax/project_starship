import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Importing the db module must never need a database.
 *
 * `next build` imports every route to collect page data. When this module threw on
 * import, a deploy without DATABASE_URL failed with "Failed to collect page data for
 * /api/auth/login/options" — a message that points nowhere near the actual cause.
 * A missing variable has to surface at the first query, not at import.
 */
describe('db module', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('imports without DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', '');

    const module = await import('./index');
    expect(module.db).toBeDefined();
  });

  it('complains at the first query, and says which variable is missing', async () => {
    vi.stubEnv('DATABASE_URL', '');

    const { db } = await import('./index');
    // Touching the proxy is what forces the connection.
    expect(() => db.select()).toThrow(/DATABASE_URL is not set/);
  });
});
