import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createStagingAccountPlan,
  readPrivateJson,
  StagingAccountError,
} from './staging-account-tools.mjs';

const usage =
  'node scripts/staging-accounts.mjs --config /private/staging-config.json --roster /private/staging-roster.json --dry-run';
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      `${usage}\nOffline validation only. Config keys: environment, stagingProjectRef, productionProjectRef, projectUrl. Set productionProjectRef to null only when no production project exists.\nRoster: five objects with email, displayName, role. Private inputs must be outside Git repositories with mode 600.\nNo accounts, credentials, invitations or enrollments are created. --apply is unavailable.`,
    );
  } else {
    if (args.includes('--apply')) {
      throw new StagingAccountError(
        'APPLY_BLOCKED',
        'Account creation is blocked until staging identity, existing account namespace and authorized bootstrap are independently verified. No changes were made.',
      );
    }
    if (
      args.length !== 5 ||
      args[0] !== '--config' ||
      args[2] !== '--roster' ||
      args[4] !== '--dry-run'
    ) {
      throw new StagingAccountError('USAGE', usage);
    }
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const config = readPrivateJson(args[1], root);
    const roster = readPrivateJson(args[3], root);
    console.log(JSON.stringify(createStagingAccountPlan(config, roster), null, 2));
  }
} catch (error) {
  const safe =
    error instanceof StagingAccountError
      ? error
      : new StagingAccountError(
          'PLAN_FAILED',
          'The offline plan could not be completed. No changes were made.',
        );
  console.error(
    JSON.stringify({ code: safe.code, message: safe.message, mutationsPerformed: false }),
  );
  process.exitCode = 1;
}
