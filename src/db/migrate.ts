import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Next.js reads .env.local; the standalone scripts must be pointed at it explicitly.
// In CI the variables come from the environment and the missing file is fine.
config({ path: '.env.local' });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local.');

  const pool = new Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: './src/db/migrations' });
  await pool.end();

  console.log('Migrations applied.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
