// Adapter für die Dateien unter $STATE_DIR (.runner/), injizierbar über
// baseDir -- Vitest zeigt so nie auf das echte .runner/ (#198).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StateAdapter {
  read(name: string): string | null;
  write(name: string, content: string): void;
  exists(name: string): boolean;
}

export function createStateAdapter(baseDir: string): StateAdapter {
  return {
    read(name) {
      const path = join(baseDir, name);
      return existsSync(path) ? readFileSync(path, 'utf-8') : null;
    },
    write(name, content) {
      mkdirSync(baseDir, { recursive: true });
      writeFileSync(join(baseDir, name), content, 'utf-8');
    },
    exists(name) {
      return existsSync(join(baseDir, name));
    },
  };
}
