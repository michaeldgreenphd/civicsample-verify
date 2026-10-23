// REAL Supabase staging checks (read-only and sign-in only). They run only when two private files
// are named: VERIFY_SUPABASE_WEB_CONFIG (publishable key) and VERIFY_SUPABASE_SIGNIN (synthetic
// account passwords). Without them every check is BLOCKED, never a pass. Nothing here imports
// records, changes the schema, enrols a factor or creates an account.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PostgrestClient } from '../src/lib/postgrest';
import { supabaseWebConfig } from '../src/lib/supabase-config';
import { SupabaseAuth } from '../src/lib/supabase-auth';
import { mapconfPublicError } from '../src/server/mapconf';
import { ServiceError } from '../src/server/service';

const webPath = process.env.VERIFY_SUPABASE_WEB_CONFIG;
const signInPath = process.env.VERIFY_SUPABASE_SIGNIN;
const required = process.env.VERIFY_SUPABASE_REQUIRE === '1';
const options = {
  skip:
    !webPath || !signInPath
      ? required
        ? false
        : 'BLOCKED: private web configuration and synthetic sign-in file not named'
      : false,
};
function privateJson(path: string) {
  const real = realpathSync(path);
  assert.equal(statSync(real).mode & 0o077, 0, 'private files must be mode 600');
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    assert.ok(
      !existsSync(join(dir, '.git')),
      'private files must live outside every Git repository',
    );
    if (dirname(dir) === dir) break;
  }
  return JSON.parse(readFileSync(real, 'utf8'));
}
function runtime() {
  assert.ok(
    webPath && signInPath,
    'BLOCKED: VERIFY_SUPABASE_WEB_CONFIG and VERIFY_SUPABASE_SIGNIN are required',
  );
  const web = privateJson(webPath!);
  const signIn = privateJson(signInPath!) as {
    accounts: { username: string; role: string; password: string }[];
  };
  const config = supabaseWebConfig({
    VERIFY_DATA_BACKEND: 'supabase',
    VERIFY_SUPABASE_URL: web.project.projectUrl,
    VERIFY_SUPABASE_PUBLISHABLE_KEY: web.publishableKey,
    VERIFY_SUPABASE_ACCOUNT_DOMAIN_REF: web.accountDomainRef,
    VERIFY_SITE_ORIGIN: web.siteOrigin,
  });
  return { config, auth: new SupabaseAuth(config), accounts: signIn.accounts };
}
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof ServiceError) return e.status;
    throw e;
  }
};

test(
  'staging: every synthetic account signs in by username, verifies with Auth and resolves its application role',
  options,
  async () => {
    const { config, auth, accounts } = runtime();
    assert.ok(accounts.length >= 5);
    for (const account of accounts) {
      const session = await auth.signIn(account.username, account.password);
      const user = await auth.verify(session.accessToken);
      assert.equal(
        user.aal,
        'aal1',
        `${account.username} signs in at aal1 before any second factor`,
      );
      const client = new PostgrestClient(config, session.accessToken, mapconfPublicError);
      const who = await client.rpc<
        { user_id: string; role: string; is_pilot_test_account: boolean }[]
      >('rpc_whoami', {});
      assert.equal(who.length, 1, `${account.username} resolves to one application user`);
      assert.equal(who[0].role, account.role);
      const rows = await client.select<{ user_id: string }>('users', 'select=user_id');
      assert.ok(rows.length >= 1, 'a user reads at least their own row');
      await auth.signOut(session.accessToken);
      await assert.rejects(auth.verify(session.accessToken), /Sign in to continue/);
    }
  },
);

test(
  'staging: access denials hold on real PostgREST (anonymous, cross-role, investigator without second factor)',
  options,
  async () => {
    const { config, auth, accounts } = runtime();
    const anon = new PostgrestClient(config, '', mapconfPublicError);
    for (const relation of ['users', 'mc_cases', 'mc_responses', 'reviewers'])
      assert.ok(
        [401, 403].includes(await status(anon.select(relation, 'select=*&limit=1'))),
        `anonymous ${relation}`,
      );
    const reviewer = accounts.find((a) => a.role === 'REVIEWER')!;
    const adjudicator = accounts.find((a) => a.role === 'ADJUDICATOR')!;
    const investigator = accounts.find((a) => a.role === 'INVESTIGATOR')!;
    const r = await auth.signIn(reviewer.username, reviewer.password);
    const rc = new PostgrestClient(config, r.accessToken, mapconfPublicError);
    assert.equal(
      (await rc.select('users', 'select=user_id')).length,
      1,
      'a reviewer sees only their own user row',
    );
    assert.equal((await rc.select('mc_responses', 'select=response_id')).length, 0);
    assert.equal(
      await status(
        rc.rpc('rpc_mc_phase', {
          p_event_type: 'CLOSED',
          p_attestation: 'synthetic attestation text for denial',
          p_app_git_sha: 'x',
        }),
      ),
      403,
    );
    const a = await auth.signIn(adjudicator.username, adjudicator.password);
    const ac = new PostgrestClient(config, a.accessToken, mapconfPublicError);
    assert.equal(
      await status(
        ac.rpc('rpc_mc_create_campaign', {
          p: {
            condition_set_id: 'X',
            condition_set_status: 'PROPOSED',
            rubric_version: 'R',
            rubric_sha256: 'a'.repeat(64),
          },
        }),
      ),
      403,
    );
    const i = await auth.signIn(investigator.username, investigator.password);
    const ic = new PostgrestClient(config, i.accessToken, mapconfPublicError);
    // require_investigator_mfa defaults to true: an aal1 investigator is refused by the database.
    assert.equal(
      await status(ic.rpc('rpc_mc_completion_summary', {})),
      403,
      'investigator without aal2 is refused',
    );
    for (const s of [r, a, i]) await auth.signOut(s.accessToken);
  },
);
