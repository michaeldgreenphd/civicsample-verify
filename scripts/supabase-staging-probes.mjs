import { URLSearchParams } from 'node:url';
import { validateStagingConfig } from './staging-account-tools.mjs';

const roles = ['INVESTIGATOR', 'INVESTIGATOR', 'REVIEWER', 'REVIEWER', 'ADJUDICATOR'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const syntheticCase = /^(?:HO4-TESTFX-|DEV4-TESTFX-|CAL4-TESTFX-|SYN-)[A-Za-z0-9-]{1,40}$/;
const fixturePatterns = {
  predictionCaseId: /^HO4-TESTFX-[A-Za-z0-9-]{1,30}$/,
  reviewerAReviewId: uuid,
  reviewerBReviewId: uuid,
  auditId: /^[1-9][0-9]{0,15}$/,
  developmentCaseId: /^DEV4-TESTFX-[A-Za-z0-9-]{1,30}$/,
  calibrationCaseId: /^CAL4-TESTFX-[A-Za-z0-9-]{1,30}$/,
  pilotCaseId: /^SYN-[A-Za-z0-9-]{1,40}$/,
  mappingCaseId: /^MC-SYN-[A-Z0-9][A-Z0-9-]{1,40}$/,
};
const probeNames = [
  'existing_staging_sessions',
  'prediction_table_blinding',
  'independent_review_isolation',
  'audit_table_blinding',
  'development_registry_blinding',
  'unassigned_calibration_blinding',
  'unassigned_pilot_blinding',
  'mapping_confirmation_isolation',
];

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function refuse() {
  // Neither configuration, remote errors, URLs nor token contents may reach reports.
  throw new Error('Staging preflight input or response refused.');
}

export function validateProbeConfig(config) {
  if (!exactKeys(config, ['project', 'publicAnonKey', 'accounts', 'fixtures'])) refuse();
  try {
    validateStagingConfig(config.project);
  } catch {
    refuse();
  }
  const key = config.publicAnonKey;
  if (typeof key !== 'string' || key.length > 8192) refuse();
  if (!/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)) {
    // This only rejects privileged keys. Auth validates real user tokens remotely;
    // decoding the public anon key does not establish its authenticity.
    try {
      if (
        key.split('.').length !== 3 ||
        JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role !== 'anon'
      )
        refuse();
    } catch {
      refuse();
    }
  }
  if (!Array.isArray(config.accounts) || config.accounts.length !== 5) refuse();
  for (const [index, account] of config.accounts.entries()) {
    if (
      !exactKeys(account, ['role', 'authUserId', 'appUserId', 'accessToken']) ||
      account.role !== roles[index] ||
      !uuid.test(account.authUserId) ||
      !uuid.test(account.appUserId) ||
      typeof account.accessToken !== 'string' ||
      account.accessToken.length < 10 ||
      account.accessToken.length > 8192 ||
      /\s/.test(account.accessToken) ||
      account.accessToken === key
    )
      refuse();
  }
  for (const field of ['authUserId', 'appUserId', 'accessToken']) {
    if (new Set(config.accounts.map((account) => account[field].toLowerCase())).size !== 5)
      refuse();
  }
  if (!config.fixtures || typeof config.fixtures !== 'object' || Array.isArray(config.fixtures))
    refuse();
  for (const [field, value] of Object.entries(config.fixtures)) {
    if (
      !Object.hasOwn(fixturePatterns, field) ||
      typeof value !== 'string' ||
      !fixturePatterns[field].test(value)
    )
      refuse();
  }
  if (
    config.fixtures.reviewerAReviewId &&
    config.fixtures.reviewerAReviewId === config.fixtures.reviewerBReviewId
  )
    refuse();
}

export function blockedPreflight(reason = 'PRIVATE_STAGING_CONFIG_UNAVAILABLE') {
  return {
    status: 'BLOCKED',
    scope:
      'Read-only Auth/PostgREST preflight against declared staging; not full Supabase acceptance.',
    reason,
    mutationsPerformed: false,
    accountsCreated: 0,
    invitationsSent: 0,
    checks: probeNames.map((id) => ({
      id,
      status: 'UNTESTED',
      reason: 'PREREQUISITES_UNAVAILABLE',
    })),
    fullSupabaseAcceptance: 'UNTESTED',
    untested: [
      'Investigator judgment-write denial and all other mutation paths',
      'Complete RPC/view/API/export and browser leakage coverage',
      'Adjudication authorization timing, lock and concurrency behavior',
      'MFA enrollment, token revocation and refresh behavior',
      'Deployed schema checksum and external project staging designation verification',
    ],
  };
}

/** Only internally constructed read endpoints can carry an existing user token. */
async function read(config, account, path, fetchImpl) {
  if (!(
    path === '/auth/v1/user' ||
    path === '/rest/v1/rpc/rpc_whoami' ||
    /^\/rest\/v1\/(?:frozen_predictions_v4|reviews|audit_log|development_registry_v4|calibration_cases_v4|cases|mc_cases|mc_responses)\?/.test(
      path,
    )
  ))
    refuse();
  const url = new URL(path, config.project.projectUrl);
  if (url.origin !== config.project.projectUrl) refuse();
  const response = await fetchImpl(url.href, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    headers: {
      apikey: config.publicAnonKey,
      Authorization: `Bearer ${account.accessToken}`,
      Accept: 'application/json',
    },
    signal: globalThis.AbortSignal.timeout(10000),
  });
  // Also reject mocked/custom fetch implementations that followed a redirect.
  if (
    response.redirected ||
    (response.url && new URL(response.url).origin !== url.origin) ||
    (response.status >= 300 && response.status < 400)
  )
    refuse();
  if (response.status === 403) return { forbidden: true };
  if (response.status !== 200) refuse();
  const text = await response.text();
  if (text.length > 65536) refuse();
  return { body: JSON.parse(text) };
}
function tablePath(table, select, field, value) {
  const query = new URLSearchParams({ select, [field]: `eq.${value}`, limit: '3' });
  return `/rest/v1/${table}?${query}`;
}
function rows(result) {
  if (result.forbidden) return null;
  if (!Array.isArray(result.body)) refuse();
  return result.body;
}

export async function runStagingPreflight(config, fetchImpl = fetch) {
  const report = blockedPreflight();
  try {
    validateProbeConfig(config);
  } catch {
    report.reason = 'INVALID_PRIVATE_STAGING_CONFIG';
    return report;
  }
  const identities = [];
  try {
    for (const account of config.accounts) {
      const auth = await read(config, account, '/auth/v1/user', fetchImpl);
      if (auth.forbidden || auth.body?.id !== account.authUserId) refuse();
      const who = rows(await read(config, account, '/rest/v1/rpc/rpc_whoami', fetchImpl));
      if (
        !who ||
        who.length !== 1 ||
        who[0].user_id !== account.appUserId ||
        who[0].role !== account.role ||
        who[0].is_pilot_test_account !== false ||
        (account.role === 'INVESTIGATOR' && who[0].investigator_session_ok !== true)
      )
        refuse();
      identities.push(who[0]);
    }
    if (
      typeof identities[2].reviewer_pseudo_id !== 'string' ||
      !identities[2].reviewer_pseudo_id ||
      typeof identities[3].reviewer_pseudo_id !== 'string' ||
      !identities[3].reviewer_pseudo_id ||
      identities[2].reviewer_pseudo_id === identities[3].reviewer_pseudo_id
    )
      refuse();
    report.checks[0] = {
      id: probeNames[0],
      status: 'PASS',
      reason: 'FIVE_DISTINCT_EXISTING_NONPILOT_SESSIONS_VERIFIED',
    };
  } catch {
    report.status = 'FAIL';
    report.reason = 'AUTH_OR_ROLE_VERIFICATION_FAILED';
    report.checks[0] = {
      id: probeNames[0],
      status: 'FAIL',
      reason: 'AUTH_OR_ROLE_VERIFICATION_FAILED',
    };
    return report;
  }

  async function probe(index, fields, operation) {
    const check = report.checks[index];
    if (fields.some((field) => !config.fixtures[field])) {
      check.reason = 'POSITIVE_CONTROL_FIXTURE_NOT_SUPPLIED';
      return;
    }
    try {
      const present = await operation();
      check.status = present ? 'PASS' : 'UNTESTED';
      check.reason = present
        ? 'POSITIVE_CONTROL_AND_DENIALS_OBSERVED'
        : 'POSITIVE_CONTROL_NOT_VISIBLE';
    } catch {
      check.status = 'FAIL';
      check.reason = 'PROBE_FAILED_OR_UNEXPECTED_ACCESS';
    }
  }
  const f = config.fixtures;
  const investigators = config.accounts.slice(0, 2);
  const reviewers = config.accounts.slice(2, 4);
  const blinded = config.accounts.slice(2);
  async function deny(accounts, path) {
    for (const account of accounts) {
      const result = rows(await read(config, account, path, fetchImpl));
      if (result !== null && result.length !== 0) refuse();
    }
  }
  async function investigatorControl(path, validRow, negativeAccounts) {
    for (const account of investigators) {
      const result = rows(await read(config, account, path, fetchImpl));
      if (!result || result.length === 0) return false;
      if (!result.every(validRow)) refuse();
    }
    await deny(negativeAccounts, path);
    return true;
  }
  await probe(1, ['predictionCaseId'], () =>
    investigatorControl(
      tablePath('frozen_predictions_v4', 'case_id', 'case_id', f.predictionCaseId),
      (row) => row.case_id === f.predictionCaseId,
      blinded,
    ),
  );
  await probe(2, ['reviewerAReviewId', 'reviewerBReviewId'], async () => {
    const paths = [f.reviewerAReviewId, f.reviewerBReviewId].map((id) =>
      tablePath('reviews', 'review_id,case_id,reviewer_pseudo_id', 'review_id', id),
    );
    for (const [index, account] of reviewers.entries()) {
      const own = rows(await read(config, account, paths[index], fetchImpl));
      if (!own || own.length === 0) return false;
      if (
        own.length !== 1 ||
        own[0].review_id !== [f.reviewerAReviewId, f.reviewerBReviewId][index] ||
        !syntheticCase.test(own[0].case_id) ||
        own[0].reviewer_pseudo_id !== identities[index + 2].reviewer_pseudo_id
      )
        refuse();
    }
    await deny([reviewers[0]], paths[1]);
    await deny([reviewers[1]], paths[0]);
    return true;
  });
  await probe(3, ['auditId'], () =>
    investigatorControl(
      tablePath('audit_log', 'audit_id,entity_id', 'audit_id', f.auditId),
      (row) => String(row.audit_id) === f.auditId && syntheticCase.test(row.entity_id),
      blinded,
    ),
  );
  await probe(4, ['developmentCaseId'], () =>
    investigatorControl(
      tablePath('development_registry_v4', 'dev_case_id', 'dev_case_id', f.developmentCaseId),
      (row) => row.dev_case_id === f.developmentCaseId,
      reviewers,
    ),
  );
  await probe(5, ['calibrationCaseId'], () =>
    investigatorControl(
      tablePath('calibration_cases_v4', 'cal_case_id', 'cal_case_id', f.calibrationCaseId),
      (row) => row.cal_case_id === f.calibrationCaseId,
      reviewers,
    ),
  );
  await probe(6, ['pilotCaseId'], () =>
    investigatorControl(
      tablePath('cases', 'case_id,mode', 'case_id', f.pilotCaseId),
      (row) => row.case_id === f.pilotCaseId && row.mode === 'PILOT',
      reviewers,
    ),
  );
  // Mapping confirmation (migration 0016): the investigator reads the synthetic mapping; the
  // adjudicator reads neither the mapping nor any response before the campaign closes and
  // adjudication is authorized. Reviewers may be assigned, so they are not probed here.
  await probe(7, ['mappingCaseId'], async () => {
    const adjudicator = [config.accounts[4]];
    const present = await investigatorControl(
      tablePath('mc_cases', 'case_id,record_category', 'case_id', f.mappingCaseId),
      (row) => row.case_id === f.mappingCaseId && row.record_category === 'SYNTHETIC_PILOT',
      adjudicator,
    );
    if (!present) return false;
    await deny(
      adjudicator,
      tablePath('mc_responses', 'response_id,case_id', 'case_id', f.mappingCaseId),
    );
    return true;
  });
  report.status = report.checks.some((check) => check.status === 'FAIL')
    ? 'FAIL'
    : report.checks.some((check) => check.status === 'UNTESTED')
      ? 'BLOCKED'
      : 'PREFLIGHT_PASS';
  report.reason =
    report.status === 'PREFLIGHT_PASS'
      ? 'LIMITED_READ_PROBES_ONLY'
      : report.status === 'FAIL'
        ? 'ONE_OR_MORE_PROBES_FAILED'
        : 'POSITIVE_CONTROL_FIXTURES_UNAVAILABLE';
  return report;
}
