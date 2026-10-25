// Privileged Supabase staging administration, separate from the web application.
//
//   node scripts/supabase-admin.mjs plan           --config /abs/private/supabase-admin.json
//   node scripts/supabase-admin.mjs accounts       --config ... [--dry-run]
//   node scripts/supabase-admin.mjs accounts       --config ... --apply --confirm-project <ref> --plan-sha256 <hash> --credentials-out /abs/private/credentials.json
//   node scripts/supabase-admin.mjs reset-password --config ... --username <name> --apply --confirm-project <ref> --plan-sha256 <hash> --credentials-out ...
//   node scripts/supabase-admin.mjs lock|unlock    --config ... --username <name> --apply --confirm-project <ref> --plan-sha256 <hash>
//   node scripts/supabase-admin.mjs apply-schema   --config ... --apply --confirm-project <ref> --plan-sha256 <hash>
//
// The default is a dry run: the plan is printed and no remote request is made. Every mutation needs
// VERIFY_SUPABASE_ADMIN_APPLY=1, the staging reference typed back, and the SHA-256 of the plan
// generated for the same private configuration; the configuration must name the approved staging
// project. --dry-run together with --apply is refused. Passwords are generated here, appended to
// the private credentials file (mode 600, outside every repository, resolved through real paths)
// before the account is created, and never printed.
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
  REPEATABLE_SCHEMA_FILES,
  SCHEMA_FILE_MARKERS,
  SupabaseIdentityError,
  validateDatabaseDestination,
} from './supabase-identity-tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = ['plan', 'accounts', 'reset-password', 'lock', 'unlock', 'apply-schema'];

/** A PEM certificate from a private, owner-only file outside every repository. */
function readPrivateText(path) {
  const real = realpathSync(path);
  const info = statSync(real);
  if (!info.isFile() || info.size > 65536 || (info.mode & 0o077) !== 0)
    throw new SupabaseIdentityError(
      'DATABASE_CA_CERT',
      'The CA certificate must be a regular file under 64 KiB, readable only by its owner (chmod 600).',
    );
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')))
      throw new SupabaseIdentityError(
        'DATABASE_CA_CERT',
        'The CA certificate must live outside every Git repository.',
      );
    if (dirname(dir) === dir) break;
  }
  const text = readFileSync(real, 'utf8');
  if (!/-----BEGIN CERTIFICATE-----/.test(text))
    throw new SupabaseIdentityError('DATABASE_CA_CERT', 'The CA file is not a PEM certificate.');
  return text;
}

export function parse(argv) {
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
  if (options.flags.has('dry-run') && options.flags.has('apply'))
    throw new SupabaseIdentityError(
      'CONFLICTING_FLAGS',
      '--dry-run and --apply contradict each other; nothing was done.',
    );
  return { command, ...options };
}

/** A private output path: absolute, its existing parent resolved through real paths, no Git
 *  repository among the real ancestors, and the file itself not yet present. */
export function privateOutputPath(path, repositoryRoot = root) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new SupabaseIdentityError(
      'CREDENTIALS_OUT',
      'Pass --credentials-out with an absolute path outside every repository.',
    );
  const parent = dirname(resolve(path));
  let realParent;
  try {
    realParent = realpathSync(parent);
  } catch {
    throw new SupabaseIdentityError(
      'CREDENTIALS_OUT',
      'The credentials directory must exist before the run.',
    );
  }
  const target = join(realParent, basename(path));
  if (existsSync(target))
    throw new SupabaseIdentityError(
      'CREDENTIALS_OUT',
      'The credentials file exists; it is never overwritten or appended across runs.',
    );
  let realRoot = repositoryRoot;
  try {
    realRoot = realpathSync(repositoryRoot);
  } catch {
    /* keep the lexical root */
  }
  for (let dir = realParent; ; dir = dirname(dir)) {
    if (dir === realRoot || existsSync(join(dir, '.git')))
      throw new SupabaseIdentityError(
        'CREDENTIALS_OUT',
        'Credentials never go inside a Git repository (real path checked).',
      );
    if (dirname(dir) === dir) break;
  }
  return target;
}

/** Credentials are persisted one line per account, before the account exists remotely, so a
 *  failure after creation never loses a generated password. */
class CredentialsFile {
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, 'wx', 0o600);
    appendFileSync(
      this.fd,
      JSON.stringify({
        note: 'Private. One JSON object per line. Hand each line to its account holder out of band; delete after use.',
        writtenAt: new Date().toISOString(),
      }) + '\n',
    );
  }
  record(entry) {
    appendFileSync(this.fd, JSON.stringify(entry) + '\n');
  }
  close() {
    closeSync(this.fd);
  }
}

/** Called only after main's explicit apply guards; exported for synthetic recovery tests. */
export async function provisionAccounts(client, config, credentials, result) {
  const ref = config.project.stagingProjectRef;
  for (const account of config.accounts) {
    const email = internalEmail(account.username, ref);
    const existing = await client.findAuthUserByEmail(email);
    if (existing) {
      // Reconcile a partial earlier run without replacing credentials. A linked identity must
      // match every immutable approved field; only its reviewed display name may be updated.
      const linked = await client.findAppUserByAuthUid(existing.id);
      if (linked) {
        const { userId, displayNameUpdated } = await client.reconcileLinkedAppUser(
          linked,
          existing.id,
          email,
          account.displayName,
          account.role,
          account.isPilotTestAccount === true,
        );
        result.actions.push({
          username: account.username,
          action: displayNameUpdated ? 'UPDATED_DISPLAY_NAME' : 'EXISTS_LINKED',
          authUserId: existing.id,
          appUserId: userId,
        });
      } else {
        const { userId } = await client.upsertAppUser(
          existing.id,
          email,
          account.displayName,
          account.role,
          account.isPilotTestAccount === true,
        );
        result.actions.push({
          username: account.username,
          action: 'LINKED_EXISTING_AUTH_USER',
          authUserId: existing.id,
          appUserId: userId,
          note: 'No password was generated; use reset-password if the original credential was never delivered.',
        });
      }
      continue;
    }
    const password = generatePassword();
    credentials.record({
      username: account.username,
      role: account.role,
      password,
      status: 'PENDING_CREATE',
    });
    const { id } = await client.createAuthUser(email, password, account.displayName, account.role);
    credentials.record({ username: account.username, authUserId: id, status: 'AUTH_USER_CREATED' });
    const { userId } = await client.upsertAppUser(
      id,
      email,
      account.displayName,
      account.role,
      account.isPilotTestAccount === true,
    );
    credentials.record({ username: account.username, appUserId: userId, status: 'LINKED' });
    result.actions.push({
      username: account.username,
      action: 'CREATED',
      authUserId: id,
      appUserId: userId,
    });
  }
}

/** Plan the bootstrap against the lineage already present: every non-repeatable file carries a
 *  version marker; a file is ALREADY_APPLIED when all its markers are present, PENDING when none
 *  is, and the lineage is refused when a file is partially applied or an applied file follows a
 *  pending one. Nothing is written until the whole plan is valid. Exported for the resume tests. */
export function planSchemaApplication(appliedVersions) {
  const applied = new Set(appliedVersions);
  const steps = [];
  let pending = false;
  for (const path of HOSTED_SCHEMA_FILES) {
    if (REPEATABLE_SCHEMA_FILES.includes(path)) {
      steps.push({ path, action: 'RUN_REPEATABLE' });
      continue;
    }
    const markers = SCHEMA_FILE_MARKERS[path];
    if (!markers || !markers.length)
      throw new SupabaseIdentityError(
        'SCHEMA_MARKERS',
        `${path} has no version marker; the lineage table is incomplete.`,
      );
    const present = markers.filter((m) => applied.has(m));
    if (present.length === markers.length) {
      if (pending)
        throw new SupabaseIdentityError(
          'SCHEMA_ORDER',
          `${path} is applied but an earlier file is not; the lineage is out of order. Nothing was changed.`,
        );
      steps.push({ path, action: 'ALREADY_APPLIED' });
    } else if (present.length) {
      throw new SupabaseIdentityError(
        'SCHEMA_PARTIAL',
        `${path} is partially applied; inspect the project before resuming. Nothing was changed.`,
      );
    } else {
      pending = true;
      steps.push({ path, action: 'APPLY' });
    }
  }
  const known = new Set(Object.values(SCHEMA_FILE_MARKERS).flat());
  const unknown = appliedVersions.filter((v) => !known.has(v));
  if (unknown.length)
    throw new SupabaseIdentityError(
      'SCHEMA_UNKNOWN',
      `The project carries ${unknown.length} version marker(s) this repository does not define; refusing to write.`,
    );
  return steps;
}

/** Apply the lineage through an adapter ({ query(sql) }) so the resume logic is testable without a
 *  server. Repeatable files run every time; applied files are skipped; pending files run in order. */
export async function applySchemaWith(adapter, readFile, result) {
  const existing = await adapter.query("select to_regclass('public.app_schema_version') as t");
  const appliedVersions = existing.rows[0]?.t
    ? (await adapter.query('select version from public.app_schema_version')).rows.map(
        (r) => r.version,
      )
    : [];
  const steps = planSchemaApplication(appliedVersions);
  for (const step of steps) {
    if (step.action === 'ALREADY_APPLIED') {
      result.actions.push(step);
      continue;
    }
    await adapter.query(readFile(step.path));
    result.actions.push({
      path: step.path,
      action: step.action === 'APPLY' ? 'APPLIED' : 'RAN_REPEATABLE',
    });
  }
  const versions = await adapter.query(
    'select version from public.app_schema_version order by applied_at',
  );
  result.schemaVersions = versions.rows.map((r) => r.version);
  return result;
}

async function applySchema(config, result, plan) {
  if (!config.databaseUrl)
    throw new SupabaseIdentityError(
      'DATABASE_URL',
      'apply-schema needs databaseUrl in the private configuration.',
    );
  // The destination is part of the reviewed plan: a changed host, port, user or database fails here.
  const destination = validateDatabaseDestination(
    config.databaseUrl,
    config.project.stagingProjectRef,
  );
  if (JSON.stringify(destination) !== JSON.stringify(plan.database))
    throw new SupabaseIdentityError(
      'DESTINATION_MISMATCH',
      'The database destination differs from the reviewed plan; regenerate and review the plan. Nothing was changed.',
    );
  const { Client } = await import('pg');
  // TLS is always verified; the project's CA file (optional) is trusted in addition to the system
  // store. Certificate checks are never disabled.
  const ssl = { rejectUnauthorized: true };
  if (config.databaseCaCertPath) ssl.ca = readPrivateText(config.databaseCaCertPath);
  const db = new Client({ connectionString: config.databaseUrl, ssl });
  await db.connect();
  try {
    result.destination = destination;
    await applySchemaWith(
      { query: (sql) => db.query(sql) },
      (path) => readFileSync(`${root}/${path}`, 'utf8'),
      result,
    );
  } finally {
    await db.end();
  }
}

export async function main(argv, env) {
  const { command, flags, values } = parse(argv);
  if (!command || flags.has('help') || !COMMANDS.includes(command)) {
    console.log(
      `Commands: ${COMMANDS.join(', ')}. Dry run by default; --apply needs VERIFY_SUPABASE_ADMIN_APPLY=1, --confirm-project <staging ref> and --plan-sha256 <hash of the reviewed plan>. --dry-run and --apply never combine.`,
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
  if (command !== 'apply-schema') await client.assertAdminPrivileges();
  if (command === 'accounts') {
    const credentials = new CredentialsFile(privateOutputPath(values['credentials-out']));
    try {
      await provisionAccounts(client, config, credentials, result);
    } finally {
      credentials.close();
    }
    result.credentialsFile = credentials.path;
  } else if (command === 'reset-password' || command === 'lock' || command === 'unlock') {
    const account = config.accounts.find((a) => a.username === values.username);
    if (!account) throw new SupabaseIdentityError('USERNAME', 'The username is not in the roster.');
    const user = await client.findAuthUserByEmail(internalEmail(account.username, ref));
    if (!user)
      throw new SupabaseIdentityError('USERNAME', 'No Auth account exists for that username.');
    if (command === 'reset-password') {
      const credentials = new CredentialsFile(privateOutputPath(values['credentials-out']));
      try {
        const password = generatePassword();
        credentials.record({
          username: account.username,
          role: account.role,
          password,
          status: 'PENDING_RESET',
        });
        await client.setPassword(user.id, password);
        credentials.record({ username: account.username, status: 'RESET' });
      } finally {
        credentials.close();
      }
      result.actions.push({
        username: account.username,
        action: 'PASSWORD_RESET',
        note: 'A password change does not revoke issued tokens; run lock first when a session may be compromised, then unlock after the reset.',
      });
      result.credentialsFile = credentials.path;
    } else {
      const outcome = await client.setLocked(user.id, command === 'lock');
      result.actions.push({
        username: account.username,
        action: command === 'lock' ? 'LOCKED' : 'UNLOCKED',
        accountLocked: outcome.locked,
        appUserActive: outcome.isActive,
        note:
          command === 'lock'
            ? 'Sign-in and refresh are banned and an account lock is recorded (migration 0021), so issued access tokens are refused by every RLS helper and RPC immediately; the account is not deactivated.'
            : 'Sign-in restored and the account lock released.',
      });
    }
  } else if (command === 'apply-schema') {
    await applySchema(config, result, plan);
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const safe =
        error instanceof SupabaseIdentityError
          ? error
          : new SupabaseIdentityError(
              'FAILED',
              'The command could not be completed; no secret is shown.',
            );
      console.error(JSON.stringify({ code: safe.code, message: safe.message }));
      process.exitCode = 1;
    });
}
