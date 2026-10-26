// Account reconciliation uses a synthetic Auth/PostgREST gateway. No live configuration or
// credential is read, and no request leaves the process.
import assert from 'node:assert/strict';
import test from 'node:test';
import { provisionAccounts } from '../scripts/supabase-admin.mjs';
import {
  adminClient,
  APPROVED_STAGING_PROJECT_REFS,
  internalEmail,
  SupabaseIdentityError,
} from '../scripts/supabase-identity-tools.mjs';

const ref = APPROVED_STAGING_PROJECT_REFS[0];
const authId = '00000000-0000-4000-8000-000000000101';
const appId = '00000000-0000-4000-8000-000000000201';
const account = {
  username: 'syn-reviewer',
  displayName: 'Synthetic reviewer',
  role: 'REVIEWER',
  isPilotTestAccount: true,
};
const config = {
  project: {
    environment: 'staging',
    stagingProjectRef: ref,
    productionProjectRef: null,
    projectUrl: `https://${ref}.supabase.co`,
  },
  serviceRoleKey: `h.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.s`,
  databaseUrl: null,
  accounts: [account],
};
type Row = Record<string, unknown>;
type Call = { method: string; url: URL; body: Row | Row[] | undefined };
const linkedRow = (changes: Row = {}): Row => ({
  user_id: appId,
  auth_uid: authId,
  email: internalEmail(account.username, ref),
  display_name: account.displayName,
  role: account.role,
  is_pilot_test_account: account.isPilotTestAccount,
  practice_read_only: false,
  is_active: true,
  ...changes,
});

function gateway(
  options: {
    appRows?: Row[];
    authExists?: boolean;
    failAppWrites?: number;
    deactivateBeforePatch?: boolean;
    concurrentInsert?: Row;
    restrictBeforePatch?: boolean;
    account?: {
      username: string;
      displayName: string;
      role: string;
      isPilotTestAccount?: boolean;
      practiceReadOnly?: boolean;
    };
  } = {},
) {
  const person = options.account ?? account;
  const configuration = { ...config, accounts: [person] };
  const appRows = options.appRows ?? [];
  const authRows: Row[] =
    options.authExists === false
      ? []
      : [{ id: authId, email: internalEmail(person.username, ref) }];
  const calls: Call[] = [];
  const records: Row[] = [];
  let remainingWriteFailures = options.failAppWrites ?? 0;
  const fetchMock = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, config.project.projectUrl);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    let result: unknown;
    if (url.pathname === '/auth/v1/admin/users' && method === 'GET') {
      result = { users: authRows };
    } else if (url.pathname === '/auth/v1/admin/users' && method === 'POST') {
      assert.equal(records.at(-1)?.status, 'PENDING_CREATE');
      assert.equal(
        records.at(-1)?.password,
        body.password,
        'the recoverable credential must be recorded before account creation',
      );
      authRows.push({ id: authId, ...body });
      result = authRows.at(-1);
    } else if (url.pathname === '/rest/v1/users') {
      const matches = (row: Row) =>
        [...url.searchParams].every(([key, value]) => {
          if (['select', 'on_conflict'].includes(key)) return true;
          if (value === 'is.null') return row[key] === null;
          return value === `eq.${String(row[key])}`;
        });
      if (method !== 'GET' && remainingWriteFailures-- > 0) {
        return new Response('{"message":"synthetic interruption"}', { status: 503 });
      }
      if (method === 'GET') {
        result = appRows.filter(matches);
      } else if (method === 'PATCH') {
        if (options.deactivateBeforePatch) appRows[0].is_active = false;
        if (options.restrictBeforePatch) appRows[0].practice_read_only = true;
        const rows = appRows.filter(matches);
        for (const row of rows) Object.assign(row, body);
        result = rows;
      } else if (method === 'POST') {
        if (options.concurrentInsert) appRows.push(options.concurrentInsert);
        const existing = appRows.find((row) => row.email === body[0].email);
        const ignore = new Headers(init?.headers).get('Prefer')?.includes('ignore-duplicates');
        if (existing && ignore) result = [];
        else if (existing) {
          Object.assign(existing, body[0]);
          result = [existing];
        } else {
          const row = { user_id: appId, is_active: true, ...body[0] };
          appRows.push(row);
          result = [row];
        }
      } else throw new Error(`Unexpected synthetic application request: ${method}`);
    } else throw new Error(`Unexpected synthetic request: ${method} ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  return {
    appRows,
    authRows,
    calls,
    records,
    async provision(providedCredentials: unknown = null) {
      const result = { actions: [] as Row[] };
      await provisionAccounts(
        adminClient(configuration, fetchMock as typeof fetch),
        configuration,
        { record: (entry: Row) => records.push(entry) },
        result,
        providedCredentials,
      );
      return result.actions;
    },
    mutations: () => calls.filter((call) => call.method !== 'GET'),
  };
}

test('account apply reconciles a reviewed display name without changing credentials or identity', async () => {
  const state = gateway({ appRows: [linkedRow({ display_name: 'Earlier synthetic name' })] });
  const actions = await state.provision();
  assert.equal(actions[0].action, 'UPDATED_DISPLAY_NAME');
  assert.equal(state.appRows[0].display_name, account.displayName);
  assert.deepEqual(
    state.mutations().map((call) => call.body),
    [{ display_name: account.displayName }],
  );
  assert.equal(state.records.length, 0, 'no new or reset password for an existing identity');
  assert.deepEqual(state.appRows[0], linkedRow());
});

test('account apply refuses immutable pilot status, role, deactivation and identity mismatches', async () => {
  for (const [changes, code] of [
    [{ is_pilot_test_account: false }, 'PILOT_STATUS_CONFLICT'],
    [{ role: 'ADJUDICATOR' }, 'ROLE_CONFLICT'],
    [{ is_active: false }, 'INACTIVE_APP_USER'],
    [{ email: 'syn-other@accounts.invalid' }, 'IDENTITY_CONFLICT'],
    [{ practice_read_only: true }, 'OBSERVER_STATUS_CONFLICT'],
  ] as [Row, string][]) {
    const row = linkedRow(changes);
    const state = gateway({ appRows: [row] });
    await assert.rejects(
      state.provision(),
      (e: unknown) => e instanceof SupabaseIdentityError && e.code === code,
    );
    assert.equal(state.mutations().length, 0, code);
    assert.deepEqual(state.appRows[0], linkedRow(changes), code);
    assert.equal(state.records.length, 0, code);
  }
});

test('provided credentials survive interrupted creation and are never used to reset existing accounts', async () => {
  const supplied = {
    projectRef: ref,
    accounts: [{ username: account.username, password: 'Synthetic-supplied-password-42' }],
  };
  const state = gateway({ authExists: false, failAppWrites: 1 });
  await assert.rejects(state.provision(supplied), /HTTP 503/);
  assert.equal(state.authRows[0].password, supplied.accounts[0].password);
  assert.equal(state.records[0].password, supplied.accounts[0].password);
  const alternate = {
    ...supplied,
    accounts: [{ ...supplied.accounts[0], password: 'Synthetic-alternative-password-43' }],
  };
  assert.equal((await state.provision(alternate))[0].action, 'LINKED_EXISTING_AUTH_USER');
  assert.equal(state.authRows[0].password, supplied.accounts[0].password);
  assert.equal(
    state.calls.filter((c) => c.url.pathname.startsWith('/auth/') && c.method !== 'GET').length,
    1,
  );
  assert.equal((await state.provision(supplied))[0].action, 'EXISTS_LINKED');
});

test('missing or malformed supplied credentials fail before any remote call or credential output', async () => {
  const state = gateway({ authExists: false });
  for (const supplied of [
    { projectRef: 'wrong-project', accounts: [] },
    { projectRef: ref, accounts: [] },
    { projectRef: ref, accounts: [{ username: account.username, password: 'short' }] },
    {
      projectRef: ref,
      accounts: [
        { username: account.username, password: 'Synthetic-valid-password-42' },
        { username: 'unknown', password: 'Synthetic-valid-password-43' },
      ],
    },
  ])
    await assert.rejects(
      state.provision(supplied),
      (e) => e instanceof SupabaseIdentityError && e.code === 'CREDENTIAL_SOURCE',
    );
  assert.equal(state.calls.length, 0);
  assert.equal(state.records.length, 0);
});

test('a new read-only investigator is restricted in its first application insert and cannot be elevated by a rerun', async () => {
  const person = {
    username: 'syn-observer',
    displayName: 'Synthetic observer',
    role: 'INVESTIGATOR',
    isPilotTestAccount: false,
    practiceReadOnly: true,
  };
  const state = gateway({ authExists: false, account: person });
  await state.provision({
    projectRef: ref,
    accounts: [{ username: person.username, password: 'Synthetic-observer-password-44' }],
  });
  const writes = state.mutations().filter((c) => c.url.pathname === '/rest/v1/users');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.equal((writes[0].body as Row[])[0].practice_read_only, true);
  assert.equal(state.appRows[0].practice_read_only, true);
  assert.equal((await state.provision())[0].action, 'EXISTS_LINKED');
  const wrongPlan = gateway({
    appRows: state.appRows,
    account: { ...person, practiceReadOnly: false },
  });
  await assert.rejects(
    wrongPlan.provision(),
    (e) => e instanceof SupabaseIdentityError && e.code === 'OBSERVER_STATUS_CONFLICT',
  );
  assert.equal(wrongPlan.mutations().length, 0);
  assert.equal(state.appRows[0].practice_read_only, true);
});

test('display-name writes cannot erase a concurrently imposed read-only restriction', async () => {
  const state = gateway({
    appRows: [linkedRow({ display_name: 'Earlier synthetic name' })],
    restrictBeforePatch: true,
  });
  await assert.rejects(
    state.provision(),
    (e) => e instanceof SupabaseIdentityError && e.code === 'APP_USER',
  );
  assert.equal(state.appRows[0].display_name, 'Earlier synthetic name');
  assert.equal(state.appRows[0].practice_read_only, true);
});

test('an exactly reconciled linked account is a no-op and remains idempotent', async () => {
  const state = gateway({ appRows: [linkedRow()] });
  assert.equal((await state.provision())[0].action, 'EXISTS_LINKED');
  assert.equal((await state.provision())[0].action, 'EXISTS_LINKED');
  assert.equal(state.mutations().length, 0);
  assert.equal(state.records.length, 0);
});

test('partial Auth creation resumes by linking the same identity and preserves its persisted password', async () => {
  const state = gateway({ authExists: false, failAppWrites: 1 });
  await assert.rejects(
    state.provision(),
    (e: unknown) => e instanceof SupabaseIdentityError && e.code === 'REMOTE_REFUSED',
  );
  assert.deepEqual(
    state.records.map((row) => row.status),
    ['PENDING_CREATE', 'AUTH_USER_CREATED'],
  );
  const password = state.records[0].password;
  assert.equal(state.authRows[0].password, password);
  assert.equal(state.appRows.length, 0);

  assert.equal((await state.provision())[0].action, 'LINKED_EXISTING_AUTH_USER');
  assert.deepEqual(state.appRows, [linkedRow()]);
  assert.equal(state.authRows[0].password, password);
  assert.equal(state.records.length, 2, 'resuming never generates a replacement password');
  assert.equal(
    state.calls.filter((call) => call.url.pathname.startsWith('/auth/') && call.method !== 'GET')
      .length,
    1,
  );
  assert.equal((await state.provision())[0].action, 'EXISTS_LINKED');
});

test('partial application linking preserves historical identities and refuses inactive or conflicting rows', async () => {
  for (const [changes, code] of [
    [{ auth_uid: null, is_active: false }, 'INACTIVE_APP_USER'],
    [{ auth_uid: null, is_pilot_test_account: false }, 'PILOT_STATUS_CONFLICT'],
    [{ auth_uid: null, role: 'ADJUDICATOR' }, 'ROLE_CONFLICT'],
    [{ auth_uid: '00000000-0000-4000-8000-000000000102' }, 'IDENTITY_CONFLICT'],
  ] as [Row, string][]) {
    const state = gateway({ appRows: [linkedRow(changes)] });
    await assert.rejects(
      state.provision(),
      (e: unknown) => e instanceof SupabaseIdentityError && e.code === code,
    );
    assert.equal(state.mutations().length, 0, code);
    assert.equal(state.records.length, 0, code);
    assert.deepEqual(state.appRows, [linkedRow(changes)], code);
  }

  const state = gateway({ appRows: [linkedRow({ auth_uid: null })] });
  assert.equal((await state.provision())[0].action, 'LINKED_EXISTING_AUTH_USER');
  assert.deepEqual(state.appRows, [linkedRow()]);
  assert.deepEqual(
    state.mutations().map((call) => call.body),
    [
      {
        auth_uid: authId,
        display_name: account.displayName,
      },
    ],
  );
});

test('display-name reconciliation fails if the account is deactivated while the write is pending', async () => {
  const state = gateway({
    appRows: [linkedRow({ display_name: 'Earlier synthetic name' })],
    deactivateBeforePatch: true,
  });
  await assert.rejects(
    state.provision(),
    (e: unknown) => e instanceof SupabaseIdentityError && e.code === 'APP_USER',
  );
  assert.equal(state.appRows[0].display_name, 'Earlier synthetic name');
  assert.equal(state.appRows[0].is_active, false);
  assert.equal(state.records.length, 0);
});

test('ambiguous and incomplete linked identities fail closed', async () => {
  const duplicate = gateway({ appRows: [linkedRow(), linkedRow()] });
  await assert.rejects(
    duplicate.provision(),
    (e: unknown) => e instanceof SupabaseIdentityError && e.code === 'APP_USER',
  );
  assert.equal(duplicate.mutations().length, 0);
  const incomplete = linkedRow();
  delete incomplete.is_pilot_test_account;
  const state = gateway({ appRows: [incomplete] });
  await assert.rejects(
    state.provision(),
    (e: unknown) => e instanceof SupabaseIdentityError && e.code === 'PILOT_STATUS_CONFLICT',
  );
  assert.equal(state.mutations().length, 0);
});

test('a concurrent application insertion is refused without overwriting its historical identity', async () => {
  const concurrent = linkedRow({ auth_uid: '00000000-0000-4000-8000-000000000102' });
  const state = gateway({ concurrentInsert: concurrent });
  await assert.rejects(
    state.provision(),
    (e: unknown) => e instanceof SupabaseIdentityError && e.code === 'APP_USER',
  );
  assert.deepEqual(state.appRows, [concurrent]);
  assert.equal(state.records.length, 0);
  assert.equal(state.mutations().length, 1);
});
