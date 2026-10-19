import { config } from 'dotenv';
import { uuidv7 } from 'uuidv7';
import { createInvite } from '@/auth/invite';
import { findAdminUserId } from '@/auth/session';
import { relyingParty } from '@/auth/webauthn';
import { db } from '@/db';
import { users } from '@/db/schema';

// Next.js reads .env.local; the standalone scripts must be pointed at it
// explicitly, before `db`/`relyingParty` below are first used (src/db/migrate.ts
// follows the same order) — both resolve `process.env` lazily, on first call,
// so this runs after the imports but before `main()`.
config({ path: '.env.local' });

/**
 * The one-time handgrip that replaces the old "empty database opens
 * registration" gate (AK5, AK6). Creates the admin account and hands back an
 * invite link that binds to it — redeeming it in `/einladung/<token>` attaches
 * a passkey to this account instead of minting a new one (see
 * `src/db/schema.ts`'s doc comment on `invites.userId`).
 *
 * Refuses outright if an admin already exists — there is exactly one way to
 * become admin, and it is this script, run once.
 */
async function main() {
  const existing = await findAdminUserId();
  if (existing) {
    console.error('Es existiert bereits ein Admin-Konto. Abgebrochen.');
    process.exit(1);
  }

  const adminId = uuidv7();
  await db.insert(users).values({ id: adminId, role: 'admin', displayName: 'Admin' });

  const { token } = await createInvite({
    createdBy: adminId,
    userId: adminId,
    label: 'Admin-Bootstrap',
  });

  const { origin } = relyingParty();
  console.log('Admin-Konto angelegt.');
  console.log('Einladungslink (einmalig gültig):');
  console.log(`${origin}/einladung/${token}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
