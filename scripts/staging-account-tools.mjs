import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';

export class StagingAccountError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StagingAccountError';
    this.code = code;
  }
}

function refuse(code, message) {
  throw new StagingAccountError(code, message);
}

function objectWithKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Read private configuration without returning filesystem errors or input contents. */
export function readPrivateJson(path, repositoryRoot) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    refuse(
      'PRIVATE_PATH_REQUIRED',
      'Supply an absolute path to a private JSON file outside all repositories.',
    );
  }
  let resolved;
  let root;
  let info;
  try {
    resolved = realpathSync(path);
    root = realpathSync(repositoryRoot);
    info = statSync(resolved);
  } catch {
    refuse('PRIVATE_FILE_UNAVAILABLE', 'The private input file could not be read.');
  }
  const rel = relative(root, resolved);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    refuse(
      'REPOSITORY_INPUT_REFUSED',
      'Private inputs must remain outside the application repository.',
    );
  }
  for (let parent = dirname(resolved); ; parent = dirname(parent)) {
    if (existsSync(`${parent}${sep}.git`)) {
      refuse(
        'REPOSITORY_INPUT_REFUSED',
        'Private inputs must remain outside all Git repositories.',
      );
    }
    if (dirname(parent) === parent) break;
  }
  if (!info.isFile() || info.size > 65536 || (info.mode & 0o077) !== 0) {
    refuse(
      'PRIVATE_FILE_PERMISSIONS',
      'Inputs must be regular files under 64 KiB, readable only by their owner (chmod 600).',
    );
  }
  try {
    return JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    refuse('INVALID_PRIVATE_JSON', 'A private input is not readable, valid JSON.');
  }
}

/** Offline declaration validation is not evidence of a remotely verified environment. */
export function validateStagingConfig(config) {
  const keys = ['environment', 'stagingProjectRef', 'productionProjectRef', 'projectUrl'];
  if (!objectWithKeys(config, keys) || config.environment !== 'staging') {
    refuse(
      'STAGING_CONFIG_REQUIRED',
      'Only an exact staging configuration is accepted; credentials do not belong in this plan input.',
    );
  }
  const ref = /^[a-z][a-z0-9-]{2,62}$/;
  if (
    typeof config.stagingProjectRef !== 'string' ||
    !ref.test(config.stagingProjectRef) ||
    (config.productionProjectRef !== null &&
      (typeof config.productionProjectRef !== 'string' ||
        !ref.test(config.productionProjectRef) ||
        config.stagingProjectRef === config.productionProjectRef))
  ) {
    refuse(
      'DISTINCT_PROJECTS_REQUIRED',
      'Declare a valid staging project and either a distinct valid production project reference or explicit null when no production project exists.',
    );
  }
  if (config.projectUrl !== `https://${config.stagingProjectRef}.supabase.co`) {
    refuse(
      'STAGING_URL_MISMATCH',
      'Use the exact HTTPS Supabase staging project origin, with no path, query, port or credentials.',
    );
  }
}

export function validateStagingRoster(roster) {
  if (!Array.isArray(roster) || roster.length !== 5) {
    refuse('ROSTER_SIZE', 'The staging roster must contain exactly five distinct people.');
  }
  const counts = { INVESTIGATOR: 0, REVIEWER: 0, ADJUDICATOR: 0 };
  const emails = new Set();
  const names = new Set();
  for (const person of roster) {
    if (!objectWithKeys(person, ['email', 'displayName', 'role'])) {
      refuse(
        'ROSTER_FIELDS',
        'Each person requires only email, displayName and one role; pilot flags and multiple roles are refused.',
      );
    }
    if (typeof person.role !== 'string' || !Object.hasOwn(counts, person.role)) {
      refuse('ROSTER_ROLE', 'Each person must have one permitted study role.');
    }
    if (
      typeof person.email !== 'string' ||
      person.email.length > 254 ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(
        person.email,
      )
    ) {
      refuse(
        'ROSTER_EMAIL',
        'Each person needs a valid individual email address without surrounding whitespace.',
      );
    }
    if (
      typeof person.displayName !== 'string' ||
      person.displayName.trim().length === 0 ||
      person.displayName.length > 200 ||
      Array.from(person.displayName).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    ) {
      refuse(
        'ROSTER_NAME',
        'Each person needs a nonempty display name of at most 200 characters without control characters.',
      );
    }
    const email = person.email.toLowerCase();
    const name = person.displayName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    if (emails.has(email) || names.has(name)) {
      refuse('DUPLICATE_IDENTITY', 'Each individual may appear only once and hold only one role.');
    }
    emails.add(email);
    names.add(name);
    counts[person.role]++;
  }
  if (counts.INVESTIGATOR !== 2 || counts.REVIEWER !== 2 || counts.ADJUDICATOR !== 1) {
    refuse(
      'ROSTER_ROLE_COUNTS',
      'Exactly two investigators, two reviewers and one adjudicator are required.',
    );
  }
  return counts;
}

export function createStagingAccountPlan(config, roster) {
  validateStagingConfig(config);
  const roleCounts = validateStagingRoster(roster);
  return {
    operation: 'OFFLINE_STAGING_ACCOUNT_PLAN',
    status: 'BLOCKED_PENDING_VERIFIED_STAGING_PROVISIONING',
    environment: 'staging',
    declaredConfigurationValid: true,
    remoteProjectIdentityVerified: false,
    existingAccountNamespaceVerified: false,
    roleCounts,
    accountsCreated: 0,
    invitationsSent: 0,
    reviewerEnrollmentsCreated: 0,
    formalAssignmentsCreated: 0,
    credentialsGenerated: false,
    mutationsPerformed: false,
    requiredNextSteps: [
      'Verify the declared staging project and inspect existing Auth/application identities for conflicting roles before any creation.',
      'Use a separately reviewed, authorized staging bootstrap to link Auth users to single-role application users; do not send invitations.',
      'Keep roster accounts separate from investigator-operated synthetic pilot accounts.',
      'Do not enroll formal reviewers or create assignments while the formal phase remains locked.',
      'Run real JWT and RLS role-isolation probes before reporting staging access ready.',
    ],
  };
}
