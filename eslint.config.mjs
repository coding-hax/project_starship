import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Prettier owns formatting; ESLint must not fight it.
  prettier,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'src/db/migrations/**',
    'playwright-report/**',
    'test-results/**',
    // Serwist build output, not source.
    'public/sw.js',
    'public/swe-worker-*.js',
  ]),
]);

export default eslintConfig;
