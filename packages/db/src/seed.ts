import './env.js';
import bcrypt from 'bcrypt';
import { createDbClient } from './client.js';
import { users } from './schema.js';

const SEED_PASSWORD = 'Admin123!@#456';
const SEED_USERS = [
  { email: 'admin@example.com', name: 'Admin', role: 'admin' as const },
  { email: 'csm1@example.com', name: 'CSM One', role: 'csm' as const },
  { email: 'csm2@example.com', name: 'CSM Two', role: 'csm' as const },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');

  const { db, close } = createDbClient({ connectionString: url });

  console.warn('═══════════════════════════════════════════════');
  console.warn('  CHANGE THESE BEFORE PRODUCTION');
  console.warn('═══════════════════════════════════════════════');
  for (const u of SEED_USERS) {
    console.warn(`  ${u.email.padEnd(20)} / ${SEED_PASSWORD}  (${u.role})`);
  }
  console.warn('═══════════════════════════════════════════════');

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);

  // Insert each row individually so ON CONFLICT DO NOTHING applies against
  // the partial unique index on (email) WHERE deleted_at IS NULL.
  for (const u of SEED_USERS) {
    await db
      .insert(users)
      .values({
        email: u.email,
        name: u.name,
        role: u.role,
        passwordHash,
      })
      .onConflictDoNothing();
  }

  console.warn('Seed complete.');
  await close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
