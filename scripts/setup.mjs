import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { parseEnv } from 'node:util';

const accounts = {
  investigator: 'VERIFY_INVESTIGATOR_PASSWORD',
  'reviewer-a': 'VERIFY_REVIEWER_A_PASSWORD',
  'reviewer-b': 'VERIFY_REVIEWER_B_PASSWORD',
  adjudicator: 'VERIFY_ADJUDICATOR_PASSWORD',
};
const existing = existsSync('.env.local');
if (existing && !process.argv.includes('--individual-credentials')) {
  console.log(
    '.env.local kept unchanged. To prepare separate local role passwords, run npm run setup -- --individual-credentials.',
  );
} else {
  const original = existing ? readFileSync('.env.local', 'utf8') : '';
  const configured = parseEnv(original);
  // Preserve every existing setting/password. Only add missing role credentials.
  const additions = [];
  for (const variable of Object.values(accounts)) {
    if (!configured[variable]) {
      configured[variable] = randomBytes(24).toString('base64url');
      additions.push(`${variable}=${configured[variable]}`);
    } else if (configured[variable].length < 16) {
      throw new Error(
        `${variable} is too short; update it locally before generating the access sheet.`,
      );
    }
  }
  if (!existing) additions.push('VERIFY_DB_DIR=.local/pglite');
  if (!existing) {
    writeFileSync('.env.local', additions.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  } else if (additions.length) {
    appendFileSync(
      '.env.local',
      (original.endsWith('\n') ? '' : '\n') + additions.join('\n') + '\n',
    );
  }
  chmodSync('.env.local', 0o600);
  mkdirSync('.local', { recursive: true, mode: 0o700 });
  const sheet = [
    'CivicSample Verify — private local synthetic pilot access',
    'Use only on the computer running the application, with separate browser profiles.',
    'Suggested local URL: http://127.0.0.1:3001 (match the port printed by your server).',
    'These are role accounts for testing, not clinician invitations or formal-study identities.',
    '',
    ...Object.entries(accounts).map(([account, variable]) => `${account}: ${configured[variable]}`),
    '',
    'Keep the investigator and adjudicator credentials with the investigator.',
    'Share only the assigned reviewer credential with each pilot tester.',
    'Restart the local server after changing configuration. Existing database records are preserved.',
    'Never commit this file, paste it into a PR, or expose this local pilot through a public tunnel.',
    '',
  ].join('\n');
  writeFileSync('.local/pilot-access.txt', sheet, { mode: 0o600 });
  chmodSync('.local/pilot-access.txt', 0o600);
  console.log(
    'Local role credentials ready in .local/pilot-access.txt (private file). Existing settings and pilot data were preserved. Restart the server to use the credentials.',
  );
}
