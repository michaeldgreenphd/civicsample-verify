// Privileged Supabase staging administration, separate from the web application.
//
//   node scripts/supabase-admin.mjs plan      --config /abs/private/supabase-admin.json
//   node scripts/supabase-admin.mjs accounts  --config ... --dry-run
//   node scripts/supabase-admin.mjs accounts  --config ... --apply --confirm-project <ref> --plan-sha256 <hash> --credentials-out /abs/private/credentials.json
//   node scripts/supabase-admin.mjs reset-password --config ... --username <name> --apply --confirm-project <ref> --plan-sha256 <hash> --credentials-out ...
//   node scripts/supabase-admin.mjs lock|unlock --config ... --username <name> --apply --confirm-project <ref> --plan-sha256 <hash>
//   node scripts/supabase-admin.mjs apply-schema --config ... --apply --confirm-project <ref> --plan-sha256 <hash>
//
// The default is a dry run that prints the plan and performs no remote request. Every mutation
// needs VERIFY_SUPABASE_ADMIN_APPLY=1, the staging reference typed back, and the SHA-256 of the
// plan generated for the same private configuration. Passwords are generated here, written only
// to the private credentials file (mode 600, outside every repository) and never printed.
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adminClient,
  assertApplyAuthorized,
  buildBootstrapPlan,
  generatePassword,
  HOSTED_SCHEMA_FILES,
  internalEmail,
  planSha256,
  readAdminConfig,
  SupabaseIdentityError,
} from './supabase-identity-tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = ['plan', 'accounts', 'reset-password', 'lock', 'unlock', 'apply-schema'];

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { flags: new Set(), values: {} };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--'))
      throw new SupabaseIdentityError('USAGE', `Unexpected argument ${arg}.`);
    const name = arg.slice(2);
    if (['dry-run', 'apply', 'help'].includes(name)) options.flags.add(name);
    else if (
      ['config', 'username', 'confirm-project', 'plan-sha256', 'credentials-out'].includes(name)
    ) {
      if (i + 1 >= rest.length)
        throw new SupabaseIdentityError('USAGE', `--${name} needs a value.`);
      options.values[name] = rest[++i];
    } else throw new SupabaseIdentityError('USAGE', `Unknown option --${name}.`);
  }
  return { command, ...options };
}
function privateOutputPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new SupabaseIdentityError(
      'CREDENTIALS_OUT',
      'Pass --credentials-out with an absolute path outside every repository.',
    );
  const resolved = resolve(path);
  if (existsSync(resolved))
    throw new SupabaseIdentityError(
      'CREDENTIALS_OUT',
      'The credentials file exists; it is never overwritten.',
    );
  for (let parent = dirname(resolved); ; parent = dirname(parent)) {
    if (existsSync(`${parent}/.git`))
      throw new SupabaseIdentityError(
        'CREDENTIALS_OUT',
        'Credentials never go inside a Git repository.',
      );
    if (dirname(parent) === parent) break;
  }
  return resolved;
}
function writeCredentials(path, entries) {
  writeFileSync(
    path,
    JSON.stringify(
      {
        writtenAt: new Date().toISOString(),
        note: 'Private. Hand each line to its account holder out of band; delete after use.',
        entries,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
}

async function main(argv, env) {
  const { command, flags, values } = parse(argv);
  if (!command || flags.has('help') || !COMMANDS.includes(command)) {
    console.log(
      `Commands: ${COMMANDS.join(', ')}. Dry run by default; --apply needs VERIFY_SUPABASE_ADMIN_APPLY=1, --confirm-project <staging ref> and --plan-sha256 <hash of the reviewed plan>.`,
    );
    return 0;
  }
  const configPath = values.config ?? env.VERIFY_SUPABASE_ADMIN_CONFIG;
  if (!configPath) {
    console.log(
      JSON.stringify(
        {
          status: 'BLOCKED',
          reason: 'PRIVATE_ADMIN_CONFIG_UNAVAILABLE',
          mutationsPerformed: false,
          hint: 'Pass --config /absolute/private/supabase-admin.json (outside all repositories, mode 600) or set VERIFY_SUPABASE_ADMIN_CONFIG.',
        },
        null,
        2,
      ),
    );
    return 2;
  }
  const config = readAdminConfig(configPath, root);
  const plan = buildBootstrapPlan(config, root);
  const hash = planSha256(plan);
  if (command === 'plan' || !flags.has('apply')) {
    console.log(
      JSON.stringify(
        { status: 'DRY_RUN', command, planSha256: hash, plan, mutationsPerformed: false },
        null,
        2,
      ),
    );
    return 0;
  }
  assertApplyAuthorized({
    env,
    confirmProject: values['confirm-project'],
    planHash: values['plan-sha256'],
    config,
    repositoryRoot: root,
  });
  const client = adminClient(config);
  const ref = config.project.stagingProjectRef;
  const result = {
    status: 'APPLIED',
    command,
    projectRef: ref,
    planSha256: hash,
    mutationsPerformed: true,
    actions: [],
  };
  if (command === 'accounts') {
    const out = privateOutputPath(values['credentials-out']);
    const credentials = [];
    for (const account of config.accounts) {
      const email = internalEmail(account.username, ref);
      if (await client.findAuthUserByEmail(email)) {
        result.actions.push({ username: account.username, action: 'SKIPPED_EXISTS' });
        continue;
      }
      const password = generatePassword();
      const { id } = await client.createAuthUser(
        email,
        password,
        account.displayName,
        account.role,
      );
      const { userId } = await client.upsertAppUser(id, email, account.displayName, account.role);
      credentials.push({ username: account.username, password, role: account.role });
      result.actions.push({
        username: account.username,
        action: 'CREATED',
        authUserId: id,
        appUserId: userId,
      });
    }
    writeCredentials(out, credentials);
    result.credentialsFile = out;
  } else if (command === 'reset-password' || command === 'lock' || command === 'unlock') {
    const account = config.accounts.find((a) => a.username === values.username);
    if (!account) throw new SupabaseIdentityError('USERNAME', 'The username is not in the roster.');
    const email = internalEmail(account.username, ref);
    const user = await client.findAuthUserByEmail(email);
    if (!user)
      throw new SupabaseIdentityError('USERNAME', 'No Auth account exists for that username.');
    if (command === 'reset-password') {
      const out = privateOutputPath(values['credentials-out']);
      const password = generatePassword();
      await client.setPassword(user.id, password);
      writeCredentials(out, [{ username: account.username, password, role: account.role }]);
      result.actions.push({
        username: account.username,
        action: 'PASSWORD_RESET',
        note: 'Existing sessions are not revoked by a password change; lock the account first when a session may be compromised.',
      });
      result.credentialsFile = out;
    } else {
      await client.setLocked(user.id, command === 'lock');
      result.actions.push({
        username: account.username,
        action: command === 'lock' ? 'LOCKED' : 'UNLOCKED',
      });
    }
  } else if (command === 'apply-schema') {
    if (!config.databaseUrl)
      throw new SupabaseIdentityError(
        'DATABASE_URL',
        'apply-schema needs databaseUrl in the private configuration.',
      );
    const { Client } = await import('pg');
    const { readFileSync } = await import('node:fs');
    const db = new Client({
      connectionString: config.databaseUrl,
      ssl: { rejectUnauthorized: true },
    });
    await db.connect();
    try {
      const existing = await db.query("select to_regclass('public.app_schema_version') as t");
      if (existing.rows[0].t)
        throw new SupabaseIdentityError(
          'SCHEMA_EXISTS',
          'The project already carries a schema lineage; this runner applies to a fresh project only. Nothing was changed.',
        );
      for (const path of HOSTED_SCHEMA_FILES) {
        await db.query(readFileSync(`${root}/${path}`, 'utf8'));
        result.actions.push({ action: 'APPLIED', path });
      }
      const versions = await db.query(
        'select version from public.app_schema_version order by applied_at',
      );
      result.schemaVersions = versions.rows.map((r) => r.version);
    } finally {
      await db.end();
    }
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2), process.env);
} catch (error) {
  const safe =
    error instanceof SupabaseIdentityError
      ? error
      : new SupabaseIdentityError(
          'FAILED',
          'The command could not be completed; no secret is shown.',
        );
  console.error(JSON.stringify({ code: safe.code, message: safe.message }));
  process.exitCode = 1;
}
