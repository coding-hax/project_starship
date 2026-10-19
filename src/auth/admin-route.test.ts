import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ADMIN_API_ROOT = fileURLToPath(new URL('../app/api/admin', import.meta.url));

function findRouteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...findRouteFiles(path));
    } else if (entry.name === 'route.ts') {
      files.push(path);
    }
  }
  return files;
}

/**
 * #1224 AK2 — a later-added route under `src/app/api/admin/` that forgets
 * `guardAdmin(` would leave the role check out entirely; this reads every
 * route file by hand so that omission fails here instead of staying open.
 */
describe('jede Route unter src/app/api/admin/ ruft guardAdmin( auf', () => {
  const routeFiles = findRouteFiles(ADMIN_API_ROOT);

  it('findet mindestens eine Route-Datei (kein stiller Leerlauf)', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it.each(routeFiles)('%s', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(source).toContain('guardAdmin(');
  });
});
