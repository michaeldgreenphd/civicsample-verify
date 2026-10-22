import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

const disposablePattern = /^verify_handoff_[0-9]+_[0-9a-f]{16}$/;

export function disposableUrl(baseUrl, databaseName) {
  assert.match(databaseName, disposablePattern);
  const url = new URL(baseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('A PostgreSQL test URL is required');
  }
  if (/(?:^|\.)supabase\.(?:co|com)$/.test(url.hostname)) {
    throw new Error('The native auth shim must never run on Supabase');
  }
  url.pathname = `/${databaseName}`;
  // Connection-string options must not redirect the session to another database.
  for (const key of ['database', 'dbname', 'host', 'hostaddr', 'port', 'user', 'password']) {
    if (url.searchParams.has(key)) throw new Error('Ambiguous test connection parameters');
  }
  return url.toString();
}

export async function withDisposableHandoffDatabase(
  baseUrl,
  operation,
  makeClient = (url) => new Client({ connectionString: url }),
) {
  const databaseName = `verify_handoff_${Date.now()}_${randomBytes(8).toString('hex')}`;
  const target = disposableUrl(baseUrl, databaseName);
  const control = makeClient(baseUrl);
  await control.connect();
  let created = false;
  try {
    const version = Number(
      (await control.query("select current_setting('server_version_num')::integer as version"))
        .rows[0].version,
    );
    if (version < 160000 || version >= 170000) {
      throw new Error('This verification requires native PostgreSQL 16');
    }
    await control.query(`create database ${databaseName} template template0`);
    created = true;
    return await operation(target);
  } finally {
    try {
      if (created) {
        await control.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
          [databaseName],
        );
        await control.query(`drop database ${databaseName}`);
      }
    } finally {
      await control.end();
    }
  }
}

export function adaptPreservedSuite(source, adapterUrl) {
  const imports = [
    "import { PGlite } from '@electric-sql/pglite';",
    "import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';",
  ];
  if (imports.some((line) => source.split(line).length !== 2)) {
    throw new Error('Unexpected preserved suite imports; refusing to rewrite test logic');
  }
  const replacement = `import { PGlite, pgcrypto } from ${JSON.stringify(adapterUrl)};`;
  return source.replace(imports[0], replacement).replace(imports[1], '');
}

export function inspectSuiteResult(output, expectedCount) {
  assert.equal(output.summary.n, expectedCount, 'Unexpected supplied step count');
  assert.equal(output.results.length, expectedCount, 'Incomplete supplied results');
  const failures = output.results.filter((row) => row.pass !== true);
  assert.equal(output.summary.fail, failures.length, 'Contradictory supplied result summary');
  assert.equal(
    output.summary.pass,
    expectedCount - failures.length,
    'Contradictory supplied pass count',
  );
  return {
    count: expectedCount,
    pass: expectedCount - failures.length,
    fail: failures.length,
    failedStepIds: failures.map((row) => row.id),
    steps: output.results.map((row) => ({ id: row.id, pass: row.pass === true })),
  };
}
