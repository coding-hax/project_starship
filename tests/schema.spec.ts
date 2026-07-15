import { expect, test } from '@playwright/test';
import { getTableColumns, getTableName, isTable } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { withDb } from './helpers';

/**
 * #28: the deployed database drifted from src/db/schema.ts because a migration
 * was committed but never applied — /api/sync/pull crashed with 500 on a table
 * that simply was not there. `pnpm db:migrate` runs against a fresh Postgres in
 * this job (see ci.yml), so a missing table or column here means the *migrations
 * themselves* — not just the code — fail to reproduce the schema. That is a
 * different failure mode than schema-drift (ci.yml), which only compares
 * schema.ts against the migration files without ever touching a real database.
 */
const tables = Object.values(schema).filter(isTable);

for (const table of tables) {
  const tableName = getTableName(table);

  test(`table "${tableName}" exists with all columns from src/db/schema.ts`, async () => {
    const expectedColumns = Object.values(getTableColumns(table)).map((column) => column.name);

    const actualColumns = await withDb(async (client) => {
      const { rows } = await client.query(
        'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
        [tableName],
      );
      return rows.map((row) => row.column_name as string);
    });

    expect(new Set(actualColumns)).toEqual(new Set(expectedColumns));
  });
}
