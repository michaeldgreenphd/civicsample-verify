// Privileged Supabase identity tooling, kept apart from the web application. Pure functions and a
// small Auth Admin / PostgREST client parameterised by fetch, so every behaviour is testable
// without a project. Nothing here is imported by src/. The service-role key lives only in a
// private configuration file outside every repository and is never printed or logged.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
export const APPROVED_STAGING_PROJECT_REFS = Object.freeze(['xmuiduugdrqvhssmeacz']);
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
];
export const EXPECTED_SCHEMA_VERSION = '6.0.1-mapping-confirmation-review-fixes';
/** app_schema_version markers each file writes; used by the resumable schema runner. */
export const SCHEMA_FILE_MARKERS = Object.freeze({
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
});
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
    if (!exactKeys(account, ['username', 'displayName', 'role']))
      refuse(
        'ROSTER_FIELDS',
        'Each account has exactly username, displayName and role; no e-mail addresses.',
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
  if (!exactKeys(config, ['project', 'serviceRoleKey', 'databaseUrl', 'accounts']))
    refuse(
      'ADMIN_CONFIG_KEYS',
      'The admin configuration has exactly project, serviceRoleKey, databaseUrl and accounts.',
    );
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
  if (config.databaseUrl !== null) {
    let url;
    try {
      url = new URL(config.databaseUrl);
    } catch {
      refuse('DATABASE_URL', 'databaseUrl is null or a postgresql:// URL of the staging project.');
    }
    if (
      !/^postgres(ql)?:$/.test(url.protocol) ||
      !url.hostname.includes(config.project.stagingProjectRef)
    )
      refuse(
        'DATABASE_URL',
        'databaseUrl must be a postgresql:// URL whose host names the staging project reference.',
      );
  }
  validateRoster(config.accounts);
  return config;
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
      displayNameSha256: sha256(a.displayName.normalize('NFKC')),
      isPilotTestAccount: false,
      authUser:
        'created with email_confirm: true and a generated password written only to the private credentials file',
      applicationUser:
        'public.users row with auth_uid linked by the service role; no invitation e-mail',
    })),
    databaseUrlDeclared: config.databaseUrl !== null,
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
    /** Lock or unlock an account. A ban blocks new sign-ins and refreshes but Supabase documents
     *  that already-issued access tokens stay valid until they expire, so the application row is
     *  deactivated as well: every RLS helper and RPC checks public.users.is_active, which closes
     *  the remaining window immediately for this application. */
    async setLocked(id, locked) {
      await call('PUT', `/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        ban_duration: locked ? '876000h' : 'none',
      });
      const rows = await call(
        'PATCH',
        `/rest/v1/users?auth_uid=eq.${encodeURIComponent(id)}`,
        locked
          ? { is_active: false, deactivated_at: new Date().toISOString() }
          : { is_active: true, deactivated_at: null },
        { Prefer: 'return=representation' },
      );
      if (!Array.isArray(rows) || rows.length !== 1)
        refuse('APP_USER', 'The application user row was not updated.');
      return { appUserId: rows[0].user_id, isActive: rows[0].is_active };
    },
    /** The application row linked to an Auth user, if any. */
    async findAppUserByAuthUid(id) {
      const rows = await call(
        'GET',
        `/rest/v1/users?auth_uid=eq.${encodeURIComponent(id)}&select=user_id,email,role,is_active`,
      );
      return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    },
    /** Application roster row, linked by auth_uid so no claim-by-e-mail step is needed. */
    async upsertAppUser(authUid, email, displayName, role) {
      const rows = await call(
        'POST',
        '/rest/v1/users?on_conflict=email',
        [
          {
            auth_uid: authUid,
            email: email.toLowerCase(),
            display_name: displayName,
            role,
            is_pilot_test_account: false,
          },
        ],
        { Prefer: 'resolution=merge-duplicates,return=representation' },
      );
      if (!Array.isArray(rows) || rows.length !== 1)
        refuse('APP_USER', 'The application user row was not confirmed.');
      return { userId: rows[0].user_id };
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
