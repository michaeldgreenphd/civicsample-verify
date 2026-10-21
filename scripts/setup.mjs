import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  console.log(
    '.env.local already exists; kept unchanged. Use its VERIFY_DEMO_PASSWORD to sign in.',
  );
} else {
  const password = randomBytes(18).toString('base64url');
  writeFileSync('.env.local', `VERIFY_DEMO_PASSWORD=${password}\nVERIFY_DB_DIR=.local/pglite\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    `Created local synthetic credentials. Pilot password: ${password}\nAccounts: investigator, reviewer-a, reviewer-b, adjudicator.\nRun npm run dev and open http://127.0.0.1:3000.`,
  );
}
