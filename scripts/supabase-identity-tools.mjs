// Privileged Supabase identity tooling, kept apart from the web application. Pure functions and a
// small Auth Admin / PostgREST client parameterised by fetch, so every behaviour is testable
// without a project. Nothing here is imported by src/. The service-role key lives only in a
// private configuration file outside every repository and is never printed or logged.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { readPrivateJson, validateStagingConfig } from './staging-account-tools.mjs';

export class SupabaseIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SupabaseIdentityError';
    this.code = code;
  }
}
const refuse = (code, message) => {
  throw new SupabaseIdentityError(code, message);
};
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** The staging project this repository is approved to administer (docs/SUPABASE_IDENTITY.md). A
 *  privileged configuration naming any other reference is refused before any request, whatever
 *  it calls itself; this list changes only through a reviewed commit. */
export const APPROVED_STAGING_PROJECT_REFS = Object.freeze([
  'xmuiduugdrqvhssmeacz', // Completed pilot; preserve its records.
  'wjntsoeifbelasidssmv', // Separate synthetic practice project selected by the investigator.
]);
export const ROLES = ['INVESTIGATOR', 'REVIEWER', 'ADJUDICATOR'];
export const USERNAME = /^[a-z][a-z0-9._-]{2,31}$/;
/** Reserved, never-deliverable domain (RFC 2606): usernames map to internal Auth identities and
 *  no reviewer supplies a personal e-mail address. Sign-in is username + password on the server. */
export const INTERNAL_EMAIL_DOMAIN = 'accounts.invalid';
export const internalEmail = (username, projectRef) =>
  `${username}@${projectRef}.${INTERNAL_EMAIL_DOMAIN}`;

/** Ordered SQL inputs for a hosted PostgreSQL/Supabase project. The local auth shim is never
 *  part of it: Supabase supplies the auth schema. The frozen-trial preflight runs before 0008. */
export const HOSTED_SCHEMA_FILES = [
  'schema.sql',
  'migrations/0002_v3_review_design.sql',
  'migrations/0003_v4_record_categories_module_b.sql',
  'migrations/0004_synthetic_verify_workflow.sql',
  'migrations/0005_review_integrity_fixes.sql',
  'migrations/0006_reference_integrity.sql',
  'migrations/0007_frozen_contract_guards.sql',
  'migrations/preflight_frozen_trial_compatibility.sql',
  'migrations/0008_trial_packet_and_concurrency_guards.sql',
  'migrations/0009_canonical_packet_and_lock_state_guards.sql',
  'migrations/0010_investigator_judgment_boundary.sql',
  'migrations/0011_v5_trial_label_verification.sql',
  'migrations/0012_v5_training_examples.sql',
  'migrations/0013_v5_independent_finality_guards.sql',
  'migrations/0014_legacy_pilot_and_packet_guards.sql',
  'migrations/0015_v5_review_fixes.sql',
  'migrations/0016_mapping_confirmation.sql',
  'migrations/0017_v5_rubric_binding.sql',
  'migrations/0018_mapping_confirmation_review_fixes.sql',
  'migrations/0019_v5_rubric_binding_reconciliation.sql',
  'migrations/0020_mapping_confirmation_completeness_and_serialization.sql',
  'migrations/0021_account_locks.sql',
  'migrations/0022_service_role_admin_grants.sql',
  'migrations/0023_service_role_truncate_revoke.sql',
  'migrations/0024_v7_mapping_units.sql',
  'migrations/0025_v7_review_fixes.sql',
  'migrations/0026_v7_lifecycle_and_gates.sql',
  'migrations/0027_service_role_least_privilege.sql',
  'migrations/0028_v7_gate_specifications_v8_1.sql',
  'migrations/0029_v7_versioned_gate_approvals.sql',
  'migrations/0030_v7_current_unit_freeze_gates.sql',
  'migrations/0031_practice_observer.sql',
  'migrations/0032_v7_freeze_gates_v8_4.sql',
  'migrations/0033_v8_design_foundation.sql',
  'migrations/0034_v8_synthetic_identifiers.sql',
  'migrations/0035_v81_subtype_probability.sql',
  'migrations/0036_v81_judgment_history.sql',
  'migrations/0037_v81_reviewer_profile.sql',
];
export const EXPECTED_SCHEMA_VERSION = '8.1.2-reviewer-profile';
/** app_schema_version markers each file writes; used by the resumable schema runner. */
export const SCHEMA_FILE_MARKERS = Object.freeze({
  'schema.sql': ['1.0.0'],
  'migrations/0002_v3_review_design.sql': ['3.0.0'],
  'migrations/0003_v4_record_categories_module_b.sql': ['4.0.0'],
  'migrations/0004_synthetic_verify_workflow.sql': ['4.0.1-synthetic'],
  'migrations/0005_review_integrity_fixes.sql': ['4.0.2-review-integrity'],
  'migrations/0006_reference_integrity.sql': ['4.0.3-reference-integrity'],
  'migrations/0007_frozen_contract_guards.sql': ['4.0.4-frozen-contract'],
  'migrations/0008_trial_packet_and_concurrency_guards.sql': [
    '4.0.5-trial-packet-concurrency-guards',
  ],
  'migrations/0009_canonical_packet_and_lock_state_guards.sql': [
    '4.0.6-canonical-packet-lock-state',
  ],
  'migrations/0010_investigator_judgment_boundary.sql': ['4.0.7-investigator-judgment-boundary'],
  'migrations/0011_v5_trial_label_verification.sql': ['5.0.0'],
  'migrations/0012_v5_training_examples.sql': ['5.1.0'],
  'migrations/0013_v5_independent_finality_guards.sql': ['5.1.1-independent-finality'],
  'migrations/0014_legacy_pilot_and_packet_guards.sql': ['5.1.2-legacy-pilot-packet-guards'],
  'migrations/0015_v5_review_fixes.sql': ['5.1.3-v5-review-fixes'],
  'migrations/0016_mapping_confirmation.sql': ['6.0.0-mapping-confirmation'],
  'migrations/0017_v5_rubric_binding.sql': ['5.1.4-v5-rubric-binding'],
  'migrations/0018_mapping_confirmation_review_fixes.sql': [
    '6.0.1-mapping-confirmation-review-fixes',
  ],
  'migrations/0019_v5_rubric_binding_reconciliation.sql': ['5.1.5-v5-rubric-reconciliation'],
  'migrations/0020_mapping_confirmation_completeness_and_serialization.sql': [
    '6.0.2-mapping-confirmation-completeness-serialization',
  ],
  'migrations/0021_account_locks.sql': ['6.0.3-account-locks'],
  'migrations/0022_service_role_admin_grants.sql': ['6.0.4-service-role-admin-grants'],
  'migrations/0023_service_role_truncate_revoke.sql': ['6.0.5-service-role-truncate-revoke'],
  'migrations/0024_v7_mapping_units.sql': ['7.0.0'],
  'migrations/0025_v7_review_fixes.sql': ['7.0.1-v7-review-fixes'],
  'migrations/0026_v7_lifecycle_and_gates.sql': ['7.0.2-v7-lifecycle-and-gates'],
  'migrations/0027_service_role_least_privilege.sql': ['6.0.6-service-role-least-privilege'],
  'migrations/0028_v7_gate_specifications_v8_1.sql': ['7.0.3-v7-gate-specifications-v8-1'],
  'migrations/0029_v7_versioned_gate_approvals.sql': ['7.0.4-v7-versioned-gate-approvals'],
  'migrations/0030_v7_current_unit_freeze_gates.sql': ['7.0.5-v7-current-unit-freeze-gates'],
  'migrations/0031_practice_observer.sql': ['7.0.6-practice-observer'],
  'migrations/0032_v7_freeze_gates_v8_4.sql': ['7.0.7-v7-freeze-gates-v8-4'],
  'migrations/0033_v8_design_foundation.sql': ['8.0.0-v8-design-foundation'],
  'migrations/0034_v8_synthetic_identifiers.sql': ['8.0.1-v8-synthetic-identifiers'],
  'migrations/0035_v81_subtype_probability.sql': ['8.1.0-subtype-probability'],
  'migrations/0036_v81_judgment_history.sql': ['8.1.1-judgment-history'],
  'migrations/0037_v81_reviewer_profile.sql': ['8.1.2-reviewer-profile'],
});
/** Files that write no marker and may run on every bootstrap (a check, not a change). */
export const REPEATABLE_SCHEMA_FILES = Object.freeze([
  'migrations/preflight_frozen_trial_compatibility.sql',
]);
/** Dashboard settings the plan requires; they are verified by hand, never set by this tool. */
export const AUTH_SETTINGS = [
  {
    setting: 'Allow new users to sign up',
    value: 'disabled',
    why: 'Only admin-created accounts; existing users still sign in.',
  },
  {
    setting: 'Email provider: confirm email',
    value: 'not relied upon',
    why: 'Accounts are created confirmed (email_confirm: true); internal addresses are never deliverable.',
  },
  {
    setting: 'Password minimum length',
    value: '12 or more',
    why: 'Supabase hashes and checks passwords; no custom password storage.',
  },
  {
    setting: 'Leaked password protection',
    value: 'enabled',
    why: 'Supabase-side check; no app code.',
  },
  {
    setting: 'Multi-factor authentication (TOTP)',
    value: 'enabled',
    why: 'Investigator sessions need aal2 (require_investigator_mfa, default true); no MFA bypass exists.',
  },
  {
    setting: 'Site URL / redirect allow list',
    value: 'staging origin only',
    why: 'No production origin until a separate deployment approval.',
  },
];

function looksLikeServiceRoleKey(key) {
  if (typeof key !== 'string' || key.length < 20 || key.length > 8192 || /\s/.test(key))
    return false;
  if (/^sb_secret_[A-Za-z0-9_-]{10,}$/.test(key)) return true;
  try {
    const parts = key.split('.');
    return (
      parts.length === 3 &&
      JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role === 'service_role'
    );
  } catch {
    return false;
  }
}
export function validateRoster(accounts) {
  if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 12)
    refuse('ROSTER_SIZE', 'The roster needs between one and twelve accounts.');
  const names = new Set();
  const counts = { INVESTIGATOR: 0, REVIEWER: 0, ADJUDICATOR: 0 };
  for (const account of accounts) {
    if (
      !exactKeys(account, ['username', 'displayName', 'role']) &&
      !exactKeys(account, ['username', 'displayName', 'role', 'isPilotTestAccount'])
    )
      refuse(
        'ROSTER_FIELDS',
        'Each account has username, displayName, role and optionally isPilotTestAccount; no e-mail addresses.',
      );
    if (
      account.isPilotTestAccount !== undefined &&
      account.isPilotTestAccount !== true &&
      account.isPilotTestAccount !== false
    )
      refuse('ROSTER_PILOT_FLAG', 'isPilotTestAccount is true or false.');
    if (account.isPilotTestAccount === true && account.role !== 'REVIEWER')
      refuse(
        'ROSTER_PILOT_FLAG',
        'Only a REVIEWER account can be a pilot test account (it takes synthetic pilot mappings; schema rule).',
      );
    if (typeof account.username !== 'string' || !USERNAME.test(account.username))
      refuse(
        'ROSTER_USERNAME',
        'Usernames are 3 to 32 lower-case letters, digits, dot, underscore or hyphen, starting with a letter.',
      );
    if (account.username.includes('@'))
      refuse('ROSTER_USERNAME', 'A username is not an e-mail address.');
    if (!ROLES.includes(account.role)) refuse('ROSTER_ROLE', 'Each account holds one study role.');
    if (
      typeof account.displayName !== 'string' ||
      !account.displayName.trim() ||
      account.displayName.length > 200 ||
      Array.from(account.displayName).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      refuse(
        'ROSTER_NAME',
        'Each account needs a display name of at most 200 characters without control characters.',
      );
    if (names.has(account.username)) refuse('DUPLICATE_USERNAME', 'Usernames are unique.');
    names.add(account.username);
    counts[account.role]++;
  }
  if (counts.INVESTIGATOR < 1)
    refuse(
      'ROSTER_INVESTIGATOR',
      'At least one investigator account is required to bootstrap the application roster.',
    );
  return counts;
}
/** The private admin configuration: project declaration, service-role key, optional database URL
 *  and the username roster. Refused unless it names the staging project exactly. */
export function validateAdminConfig(config, approvedRefs = APPROVED_STAGING_PROJECT_REFS) {
  if (
    !exactKeys(config, ['project', 'serviceRoleKey', 'databaseUrl', 'accounts']) &&
    !exactKeys(config, [
      'project',
      'serviceRoleKey',
      'databaseUrl',
      'databaseCaCertPath',
      'accounts',
    ])
  )
    refuse(
      'ADMIN_CONFIG_KEYS',
      'The admin configuration has exactly project, serviceRoleKey, databaseUrl, accounts and optionally databaseCaCertPath.',
    );
  if (config.databaseCaCertPath !== undefined && config.databaseCaCertPath !== null) {
    // The PostgreSQL server certificate is verified against this CA file (the project's CA from
    // the dashboard) in addition to the system store; certificate checks are never disabled.
    if (typeof config.databaseCaCertPath !== 'string' || !isAbsolute(config.databaseCaCertPath))
      refuse(
        'DATABASE_CA_CERT',
        'databaseCaCertPath is an absolute path to the project CA certificate (PEM), outside every repository.',
      );
  }
  try {
    validateStagingConfig(config.project);
  } catch (error) {
    refuse('ADMIN_CONFIG_PROJECT', error.message);
  }
  if (!approvedRefs.includes(config.project.stagingProjectRef))
    refuse(
      'PROJECT_NOT_APPROVED',
      'The configuration names a project that this repository is not approved to administer; only the recorded staging reference is accepted.',
    );
  if (!looksLikeServiceRoleKey(config.serviceRoleKey))
    refuse(
      'SERVICE_ROLE_KEY_REQUIRED',
      'Privileged provisioning needs the service-role (secret) key of the staging project; the anon or publishable key cannot administer accounts.',
    );
  if (config.databaseUrl !== null)
    validateDatabaseDestination(config.databaseUrl, config.project.stagingProjectRef);
  validateRoster(config.accounts);
  return config;
}
/** The exact PostgreSQL destination of the approved staging project: the direct host
 *  db.<ref>.supabase.co (user postgres, port 5432) or a Supabase pooler host with the
 *  project-qualified user postgres.<ref> (port 5432 session or 6543 transaction mode), database
 *  postgres. Anything else, including look-alike hosts, is refused. Returns the non-secret
 *  identity that the plan binds. */
export function validateDatabaseDestination(databaseUrl, projectRef) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    refuse(
      'DATABASE_URL',
      'databaseUrl is null or a postgresql:// URL of the approved staging project.',
    );
  }
  if (!/^postgres(ql)?:$/.test(url.protocol))
    refuse('DATABASE_URL', 'databaseUrl must use the postgresql:// scheme.');
  const host = url.hostname.toLowerCase();
  const port = url.port ? Number(url.port) : 5432;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  const direct = host === `db.${projectRef}.supabase.co` && port === 5432 && user === 'postgres';
  const pooler =
    /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) &&
    (port === 5432 || port === 6543) &&
    user === `postgres.${projectRef}`;
  if (!(direct || pooler) || database !== 'postgres' || url.search || url.hash)
    refuse(
      'DATABASE_DESTINATION',
      'databaseUrl must name the approved project exactly: db.<ref>.supabase.co:5432 as postgres, or a Supabase pooler host as postgres.<ref> on 5432/6543, database postgres.',
    );
  return {
    host,
    port,
    database,
    user,
    mode: direct ? 'direct' : port === 6543 ? 'pooler-transaction' : 'pooler-session',
  };
}
export function readAdminConfig(
  path,
  repositoryRoot,
  approvedRefs = APPROVED_STAGING_PROJECT_REFS,
) {
  const config = readPrivateJson(path, repositoryRoot);
  return validateAdminConfig(config, approvedRefs);
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** Random 24-byte password, base64url (32 characters); meets any sensible length policy. */
export const generatePassword = () => randomBytes(24).toString('base64url');

/** The bootstrap plan: exact target, ordered SQL inputs with hashes, settings and accounts. It is
 *  the artefact an apply must reference by hash, and it carries no secret. */
export function buildBootstrapPlan(
  config,
  repositoryRoot,
  readFile = (p) => readFileSync(`${repositoryRoot}/${p}`, 'utf8'),
  approvedRefs = APPROVED_STAGING_PROJECT_REFS,
) {
  validateAdminConfig(config, approvedRefs);
  const files = HOSTED_SCHEMA_FILES.map((path) => {
    const text = readFile(path);
    if (
      /create schema (if not exists )?auth\b|create function auth\.uid|set_config\('request\.jwt\.claims'/i.test(
        text,
      ) &&
      !/^-- supabase_test_shim/m.test(text)
    )
      refuse(
        'AUTH_SHIM_REFUSED',
        `${path} defines the auth schema; the local shim never reaches Supabase.`,
      );
    if (/MU7X-TEST-ONLY-GATE-SPECIFICATION/.test(text))
      refuse(
        'TEST_SHIM_REFUSED',
        `${path} carries the test-only gate specification; it never reaches Supabase.`,
      );
    return { path, sha256: sha256(text), bytes: Buffer.byteLength(text) };
  });
  const ref = config.project.stagingProjectRef;
  return {
    plan: 'SUPABASE_STAGING_BOOTSTRAP_PLAN',
    generatedFor: {
      environment: 'staging',
      projectRef: ref,
      projectUrl: config.project.projectUrl,
      productionProjectRef: config.project.productionProjectRef,
    },
    mutationsPerformed: false,
    schema: {
      appliesTo:
        'a fresh project without public.app_schema_version; the runner refuses an existing lineage',
      expectedFinalVersion: EXPECTED_SCHEMA_VERSION,
      files,
      excluded: [
        'supabase_test_shim/auth_shim.sql (local PGlite/PostgreSQL only; Supabase provides auth.uid() and auth.jwt())',
      ],
    },
    authSettings: AUTH_SETTINGS,
    accounts: config.accounts.map((a) => ({
      username: a.username,
      internalEmail: internalEmail(a.username, ref),
      role: a.role,
      // Every field the apply provisions is bound into the reviewed hash; the display name as a
      // digest so the plan discloses no name.
      displayNameSha256: sha256(a.displayName),
      // A pilot test account (REVIEWER only) is enrolled with PILOT scope and takes synthetic
      // pilot mappings; the flag is immutable in public.users, so it is bound into the plan.
      isPilotTestAccount: a.isPilotTestAccount === true,
      authUser:
        'created with email_confirm: true and a generated password written only to the private credentials file',
      applicationUser:
        'link public.users by auth_uid; reconcile only display_name on matching active identities; refuse role or pilot-status conflicts; no invitation e-mail',
    })),
    // The exact destination (non-secret identity) is bound into the reviewed hash; apply-schema
    // refuses a configuration whose destination differs from the plan.
    database:
      config.databaseUrl === null ? null : validateDatabaseDestination(config.databaseUrl, ref),
    notes: [
      'Normal application access uses verified user sessions and RLS/RPC authorization; the service-role key never enters the web application.',
      'Password resets are investigator-managed through this tool (Auth Admin updateUserById); Supabase stores and checks passwords.',
      'Formal activation, real sample import, freeze, invitations and production deployment are outside this plan.',
    ],
  };
}
export const planSha256 = (plan) => sha256(JSON.stringify(plan));

// ---------------------------------------------------------------------------------------------
// Auth Admin / PostgREST client (service role, server-side only)
// ---------------------------------------------------------------------------------------------
export function adminClient(config, fetchImpl = fetch) {
  const origin = config.project.projectUrl;
  const appUserColumns = 'user_id,auth_uid,email,display_name,role,is_pilot_test_account,is_active';
  function requireAppIdentity(row, authUid, email, role, pilot, allowUnlinked = false) {
    if (!row || typeof row.user_id !== 'string' || typeof row.display_name !== 'string')
      refuse('APP_USER', 'The application identity was not returned completely.');
    if (row.role !== role)
      refuse('ROLE_CONFLICT', 'The existing application role differs from the reviewed plan.');
    if (row.is_pilot_test_account !== pilot)
      refuse(
        'PILOT_STATUS_CONFLICT',
        'The existing immutable pilot status differs from the reviewed plan.',
      );
    if (row.is_active !== true)
      refuse('INACTIVE_APP_USER', 'The application account is inactive; it cannot be reactivated.');
    if (
      typeof row.email !== 'string' ||
      row.email.toLowerCase() !== email.toLowerCase() ||
      (row.auth_uid !== authUid && !(allowUnlinked && row.auth_uid === null))
    )
      refuse(
        'IDENTITY_CONFLICT',
        'The existing application identity differs from the reviewed plan.',
      );
  }
  function oneAppUser(rows, allowMissing = false) {
    if (!Array.isArray(rows) || rows.length > 1 || (!allowMissing && rows.length !== 1))
      refuse('APP_USER', 'Exactly one application user row must be confirmed.');
    return rows[0] ?? null;
  }
  async function updateAppUser(row, body) {
    // Inactive rows and concurrently linked identities are never overwritten. Role and pilot
    // status cannot change under the preserved users_update_check database trigger.
    const authFilter = row.auth_uid === null ? 'is.null' : `eq.${encodeURIComponent(row.auth_uid)}`;
    return oneAppUser(
      await call(
        'PATCH',
        `/rest/v1/users?user_id=eq.${encodeURIComponent(row.user_id)}&auth_uid=${authFilter}&is_active=eq.true`,
        body,
        { Prefer: 'return=representation' },
      ),
    );
  }
  async function call(method, path, body, headers = {}) {
    const url = new URL(path, origin);
    if (url.origin !== origin) refuse('ORIGIN', 'Requests go to the declared staging origin only.');
    const response = await fetchImpl(url.href, {
      method,
      redirect: 'error',
      cache: 'no-store',
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: globalThis.AbortSignal.timeout(15000),
    });
    if (response.redirected || (response.status >= 300 && response.status < 400))
      refuse('REDIRECT', 'The staging origin redirected; refusing.');
    const text = await response.text();
    if (text.length > 262144) refuse('RESPONSE_SIZE', 'Unexpected response size.');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      refuse('RESPONSE_FORMAT', 'Unexpected response format.');
    }
    if (!response.ok)
      refuse(
        'REMOTE_REFUSED',
        `The project refused ${method} ${url.pathname} (HTTP ${response.status}).`,
      );
    return json;
  }
  return {
    /** Auth Admin: list users by page; used to find an account by its internal address. */
    async findAuthUserByEmail(email) {
      for (let page = 1; page <= 20; page++) {
        const result = await call('GET', `/auth/v1/admin/users?page=${page}&per_page=50`);
        const users = Array.isArray(result?.users) ? result.users : [];
        const hit = users.find(
          (u) => typeof u.email === 'string' && u.email.toLowerCase() === email.toLowerCase(),
        );
        if (hit) return { id: hit.id, email: hit.email };
        if (users.length < 50) return null;
      }
      return null;
    },
    async createAuthUser(email, password, displayName, role) {
      const user = await call('POST', '/auth/v1/admin/users', {
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
        app_metadata: { verify_role: role, provisioned_by: 'supabase-admin-tool' },
      });
      if (typeof user?.id !== 'string')
        refuse('CREATE_USER', 'The project did not return a user id.');
      return { id: user.id };
    },
    async setPassword(id, password) {
      await call('PUT', `/auth/v1/admin/users/${encodeURIComponent(id)}`, { password });
    },
    /** Lock or unlock an account, reversibly. A ban blocks new sign-ins and refreshes but Supabase
     *  documents that already-issued access tokens stay valid until they expire, so an
     *  account_locks row (migration 0021) is written first: every identity helper and RPC
     *  resolves a locked user to no user, which refuses the token immediately. Deactivation
     *  (permanent by the preserved users_update_check trigger) is never used for a lock. */
    async setLocked(id, locked, actor = 'supabase-admin-tool') {
      const app = await this.findAppUserByAuthUid(id);
      if (!app) refuse('APP_USER', 'No application row is linked to this Auth user.');
      if (locked) {
        // Resumable: a run interrupted after the lock row was written (for example by a failed
        // Auth request) is completed by running lock again; the existing row is kept and the ban
        // is applied. Banning an already banned user is harmless.
        const existing = await call(
          'GET',
          `/rest/v1/account_locks?user_id=eq.${encodeURIComponent(app.user_id)}&released_at=is.null&select=lock_id`,
        );
        if (!Array.isArray(existing) || existing.length === 0) {
          const rows = await call(
            'POST',
            '/rest/v1/account_locks',
            [{ user_id: app.user_id, locked_by: actor }],
            {
              Prefer: 'return=representation',
            },
          );
          if (!Array.isArray(rows) || rows.length !== 1)
            refuse('APP_USER', 'The account lock was not recorded.');
        }
        await call('PUT', `/auth/v1/admin/users/${encodeURIComponent(id)}`, {
          ban_duration: '876000h',
        });
      } else {
        await call('PUT', `/auth/v1/admin/users/${encodeURIComponent(id)}`, {
          ban_duration: 'none',
        });
        await call(
          'PATCH',
          `/rest/v1/account_locks?user_id=eq.${encodeURIComponent(app.user_id)}&released_at=is.null`,
          { released_at: new Date().toISOString(), released_by: actor },
          { Prefer: 'return=representation' },
        );
      }
      const open = await call(
        'GET',
        `/rest/v1/account_locks?user_id=eq.${encodeURIComponent(app.user_id)}&released_at=is.null&select=lock_id`,
      );
      return {
        appUserId: app.user_id,
        locked: Array.isArray(open) && open.length > 0,
        isActive: app.is_active,
      };
    },
    /** Hardened projects expose no table to service_role until migration 0022 grants the admin
     *  path explicitly (BYPASSRLS does not bypass grants). Checked before any account mutation so
     *  a missing grant is reported by name instead of leaving an Auth-only account. */
    async assertAdminPrivileges() {
      for (const [table, column] of [
        ['users', 'user_id'],
        ['account_locks', 'lock_id'],
      ]) {
        const url = new URL(`/rest/v1/${table}?select=${column}&limit=1`, origin);
        const response = await fetchImpl(url.href, {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
          headers: {
            apikey: config.serviceRoleKey,
            Authorization: `Bearer ${config.serviceRoleKey}`,
            Accept: 'application/json',
          },
          signal: globalThis.AbortSignal.timeout(15000),
        });
        if (response.status === 401 || response.status === 403 || response.status === 404)
          refuse(
            'ADMIN_PRIVILEGES_MISSING',
            `service_role cannot read public.${table} (HTTP ${response.status}); apply migration 0022_service_role_admin_grants.sql before provisioning. Nothing was changed.`,
          );
        if (!response.ok)
          refuse(
            'REMOTE_REFUSED',
            `The project refused the privilege check on public.${table} (HTTP ${response.status}).`,
          );
      }
    },
    /** The application row linked to an Auth user, if any. */
    async findAppUserByAuthUid(id) {
      const rows = await call(
        'GET',
        `/rest/v1/users?auth_uid=eq.${encodeURIComponent(id)}&select=${appUserColumns}`,
      );
      return oneAppUser(rows, true);
    },
    /** Existing users keep their identity, role, pilot status, locks and password. The account
     *  apply command may reconcile only the display name that its reviewed plan hashes. */
    async reconcileLinkedAppUser(
      row,
      authUid,
      email,
      displayName,
      role,
      isPilotTestAccount = false,
    ) {
      const pilot = isPilotTestAccount === true;
      requireAppIdentity(row, authUid, email, role, pilot);
      if (row.display_name === displayName)
        return { userId: row.user_id, displayNameUpdated: false };
      const updated = await updateAppUser(row, { display_name: displayName });
      requireAppIdentity(updated, authUid, email, role, pilot);
      if (updated.display_name !== displayName)
        refuse('APP_USER', 'The reviewed display name was not confirmed.');
      return { userId: updated.user_id, displayNameUpdated: true };
    },
    /** Application roster row, linked by auth_uid so no claim-by-e-mail step is needed. */
    async upsertAppUser(authUid, email, displayName, role, isPilotTestAccount = false) {
      const pilot = isPilotTestAccount === true;
      const existing = oneAppUser(
        await call(
          'GET',
          `/rest/v1/users?email=eq.${encodeURIComponent(email.toLowerCase())}&select=${appUserColumns}`,
        ),
        true,
      );
      if (existing) {
        requireAppIdentity(existing, authUid, email, role, pilot, true);
        if (existing.auth_uid === authUid)
          return this.reconcileLinkedAppUser(existing, authUid, email, displayName, role, pilot);
        const linked = await updateAppUser(existing, {
          auth_uid: authUid,
          display_name: displayName,
        });
        requireAppIdentity(linked, authUid, email, role, pilot);
        if (linked.display_name !== displayName)
          refuse('APP_USER', 'The reviewed display name was not confirmed.');
        return { userId: linked.user_id };
      }
      const rows = await call(
        'POST',
        '/rest/v1/users?on_conflict=email',
        [
          {
            auth_uid: authUid,
            email: email.toLowerCase(),
            display_name: displayName,
            role,
            is_pilot_test_account: pilot,
          },
        ],
        // A concurrent account insertion is not authority to overwrite that identity. Refuse
        // the empty return and let a subsequent authorized run reconcile it explicitly.
        { Prefer: 'resolution=ignore-duplicates,return=representation' },
      );
      const inserted = oneAppUser(rows);
      requireAppIdentity(inserted, authUid, email, role, pilot);
      if (inserted.display_name !== displayName)
        refuse('APP_USER', 'The reviewed display name was not confirmed.');
      return { userId: inserted.user_id };
    },
    async schemaVersions() {
      const rows = await call(
        'GET',
        '/rest/v1/app_schema_version?select=version&order=applied_at.asc',
      );
      return Array.isArray(rows) ? rows.map((r) => r.version) : [];
    },
  };
}

/** Apply guards: explicit environment opt-in, the staging reference typed back, and the hash of a
 *  reviewed plan generated from the same configuration. */
export function assertApplyAuthorized({
  env,
  confirmProject,
  planHash,
  config,
  repositoryRoot,
  approvedRefs = APPROVED_STAGING_PROJECT_REFS,
}) {
  validateAdminConfig(config, approvedRefs);
  if (env.VERIFY_SUPABASE_ADMIN_APPLY !== '1')
    refuse(
      'APPLY_NOT_ENABLED',
      'Set VERIFY_SUPABASE_ADMIN_APPLY=1 to allow a remote mutation. Nothing was changed.',
    );
  if (confirmProject !== config.project.stagingProjectRef)
    refuse(
      'CONFIRM_PROJECT',
      'Pass --confirm-project with the exact staging project reference. Nothing was changed.',
    );
  const expected = planSha256(buildBootstrapPlan(config, repositoryRoot, undefined, approvedRefs));
  if (typeof planHash !== 'string' || planHash.toLowerCase() !== expected)
    refuse(
      'PLAN_HASH',
      'Pass --plan-sha256 with the hash of the reviewed plan generated for this configuration. Nothing was changed.',
    );
}
