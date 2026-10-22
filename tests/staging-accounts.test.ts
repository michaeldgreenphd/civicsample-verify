import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createStagingAccountPlan,
  readPrivateJson,
  validateStagingConfig,
  validateStagingRoster,
} from '../scripts/staging-account-tools.mjs';

const config = {
  environment: 'staging',
  stagingProjectRef: 'synthetic-staging',
  productionProjectRef: 'synthetic-production',
  projectUrl: 'https://synthetic-staging.supabase.co',
};
function roster() {
  return ['INVESTIGATOR', 'INVESTIGATOR', 'REVIEWER', 'REVIEWER', 'ADJUDICATOR'].map(
    (role, index) => ({
      email: `synthetic-person-${index}@example.invalid`,
      displayName: `Synthetic Person ${index}`,
      role,
    }),
  );
}
function refuses(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error: unknown) => error instanceof Error && 'code' in error && error.code === code,
  );
}

test('staging plan reports role counts without provisioning, identities, secrets or formal enrollment', () => {
  const plan = createStagingAccountPlan(config, roster());
  assert.deepEqual(plan.roleCounts, { INVESTIGATOR: 2, REVIEWER: 2, ADJUDICATOR: 1 });
  assert.equal(plan.accountsCreated, 0);
  assert.equal(plan.invitationsSent, 0);
  assert.equal(plan.reviewerEnrollmentsCreated, 0);
  assert.equal(plan.formalAssignmentsCreated, 0);
  assert.equal(plan.remoteProjectIdentityVerified, false);
  assert.equal(plan.existingAccountNamespaceVerified, false);
  assert.equal(plan.credentialsGenerated, false);
  assert.equal(plan.mutationsPerformed, false);
  for (const person of roster()) {
    assert.equal(JSON.stringify(plan).includes(person.email), false);
    assert.equal(JSON.stringify(plan).includes(person.displayName), false);
  }
  assert.equal(JSON.stringify(plan).includes(config.projectUrl), false);
  assert.match(plan.status, /^BLOCKED/);
});

test('explicitly absent production project permits an offline plan without weakening project isolation', () => {
  const plan = createStagingAccountPlan({ ...config, productionProjectRef: null }, roster());
  assert.equal(plan.declaredConfigurationValid, true);
  assert.equal(plan.remoteProjectIdentityVerified, false);
  assert.equal(plan.accountsCreated, 0);
  assert.equal(plan.invitationsSent, 0);
  assert.equal(plan.mutationsPerformed, false);
  refuses(
    () => validateStagingConfig({ ...config, productionProjectRef: config.stagingProjectRef }),
    'DISTINCT_PROJECTS_REQUIRED',
  );
  for (const productionProjectRef of [undefined, false, 0, [], {}]) {
    refuses(
      () => validateStagingConfig({ ...config, productionProjectRef }),
      'DISTINCT_PROJECTS_REQUIRED',
    );
  }
  const { productionProjectRef: omitted, ...missing } = config;
  assert.equal(omitted, config.productionProjectRef);
  refuses(() => validateStagingConfig(missing), 'STAGING_CONFIG_REQUIRED');
});

test('project declarations refuse production, ambiguous origins, matching references and embedded secrets', () => {
  refuses(
    () => validateStagingConfig({ ...config, environment: 'production' }),
    'STAGING_CONFIG_REQUIRED',
  );
  refuses(
    () => validateStagingConfig({ ...config, serviceRoleKey: 'synthetic-secret' }),
    'STAGING_CONFIG_REQUIRED',
  );
  refuses(
    () => validateStagingConfig({ ...config, productionProjectRef: config.stagingProjectRef }),
    'DISTINCT_PROJECTS_REQUIRED',
  );
  refuses(
    () => validateStagingConfig({ ...config, productionProjectRef: '' }),
    'DISTINCT_PROJECTS_REQUIRED',
  );
  for (const projectUrl of [
    'https://synthetic-production.supabase.co',
    'https://synthetic-staging.supabase.co.attacker.invalid',
    'http://synthetic-staging.supabase.co',
    'https://synthetic-staging.supabase.co:443',
    'https://synthetic-staging.supabase.co/',
    'https://synthetic-staging.supabase.co?project=production',
    'https://user:password@synthetic-staging.supabase.co',
  ])
    refuses(() => validateStagingConfig({ ...config, projectUrl }), 'STAGING_URL_MISMATCH');
});

test('roster requires exactly five distinct single-role identities and keeps pilot accounts separate', () => {
  refuses(() => validateStagingRoster(roster().slice(0, 4)), 'ROSTER_SIZE');
  const duplicateEmail = roster();
  duplicateEmail[4].email = duplicateEmail[0].email.toUpperCase();
  refuses(() => validateStagingRoster(duplicateEmail), 'DUPLICATE_IDENTITY');
  const duplicateName = roster();
  duplicateName[4].displayName = '  SYNTHETIC   PERSON 0  ';
  refuses(() => validateStagingRoster(duplicateName), 'DUPLICATE_IDENTITY');
  const wrongCounts = roster();
  wrongCounts[0].role = 'REVIEWER';
  refuses(() => validateStagingRoster(wrongCounts), 'ROSTER_ROLE_COUNTS');
  const unknownRole = roster();
  unknownRole[0].role = '__proto__';
  refuses(() => validateStagingRoster(unknownRole), 'ROSTER_ROLE');
  for (const extra of [
    { is_pilot_test_account: false },
    { is_pilot_test_account: true },
    { roles: ['INVESTIGATOR', 'REVIEWER'] },
  ]) {
    refuses(
      () => validateStagingRoster([{ ...roster()[0], ...extra }, ...roster().slice(1)]),
      'ROSTER_FIELDS',
    );
  }
  refuses(
    () =>
      validateStagingRoster([
        { ...roster()[0], role: ['INVESTIGATOR', 'REVIEWER'] },
        ...roster().slice(1),
      ]),
    'ROSTER_ROLE',
  );
  refuses(
    () => validateStagingRoster([{ ...roster()[0], email: 'not-an-email' }, ...roster().slice(1)]),
    'ROSTER_EMAIL',
  );
  refuses(
    () =>
      validateStagingRoster([{ ...roster()[0], displayName: '\nsecret' }, ...roster().slice(1)]),
    'ROSTER_NAME',
  );
});

test('private inputs must be owner-only external regular files and cannot enter through a symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'verify-staging-plan-path-'));
  try {
    const repository = join(directory, 'repository');
    mkdirSync(repository);
    mkdirSync(join(repository, '.git'));
    const external = join(directory, 'private.json');
    writeFileSync(external, '{"synthetic":true}', { mode: 0o600 });
    assert.deepEqual(readPrivateJson(external, repository), { synthetic: true });
    refuses(() => readPrivateJson('relative.json', repository), 'PRIVATE_PATH_REQUIRED');
    refuses(
      () => readPrivateJson(join(directory, 'missing.json'), repository),
      'PRIVATE_FILE_UNAVAILABLE',
    );
    chmodSync(external, 0o644);
    refuses(() => readPrivateJson(external, repository), 'PRIVATE_FILE_PERMISSIONS');
    chmodSync(external, 0o600);
    const inside = join(repository, 'private.json');
    writeFileSync(inside, '{}', { mode: 0o600 });
    const link = join(directory, 'linked.json');
    symlinkSync(inside, link);
    refuses(() => readPrivateJson(link, repository), 'REPOSITORY_INPUT_REFUSED');
    const otherRepository = join(directory, 'other');
    mkdirSync(otherRepository);
    writeFileSync(join(otherRepository, '.git'), 'gitdir: synthetic');
    writeFileSync(join(otherRepository, 'private.json'), '{}', { mode: 0o600 });
    refuses(
      () => readPrivateJson(join(otherRepository, 'private.json'), repository),
      'REPOSITORY_INPUT_REFUSED',
    );
    writeFileSync(external, 'synthetic-private-value is not JSON');
    refuses(() => readPrivateJson(external, repository), 'INVALID_PRIVATE_JSON');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI performs an offline private dry run, refuses apply, sanitizes failures and preserves files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'verify-staging-plan-cli-'));
  try {
    const configPath = join(directory, 'config.json');
    const rosterPath = join(directory, 'roster.json');
    const configText = JSON.stringify(config);
    const rosterText = JSON.stringify(roster());
    writeFileSync(configPath, configText, { mode: 0o600 });
    writeFileSync(rosterPath, rosterText, { mode: 0o600 });
    const script = resolve('scripts/staging-accounts.mjs');
    const args = [script, '--config', configPath, '--roster', rosterPath];
    const result = spawnSync(process.execPath, [...args, '--dry-run'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).accountsCreated, 0);
    assert.equal(result.stderr, '');
    for (const person of roster()) assert.equal(result.stdout.includes(person.email), false);
    const apply = spawnSync(process.execPath, [...args, '--apply'], { encoding: 'utf8' });
    assert.equal(apply.status, 1);
    assert.equal(JSON.parse(apply.stderr).code, 'APPLY_BLOCKED');
    assert.equal(apply.stdout, '');
    assert.equal(readFileSync(configPath, 'utf8'), configText);
    assert.equal(readFileSync(rosterPath, 'utf8'), rosterText);
    assert.deepEqual(readdirSync(directory).sort(), ['config.json', 'roster.json']);
    writeFileSync(rosterPath, 'synthetic-private-content malformed');
    const malformed = spawnSync(process.execPath, [...args, '--dry-run'], { encoding: 'utf8' });
    assert.equal(malformed.status, 1);
    assert.equal(JSON.parse(malformed.stderr).code, 'INVALID_PRIVATE_JSON');
    assert.equal(malformed.stderr.includes('synthetic-private-content'), false);
    assert.equal(malformed.stderr.includes(directory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
