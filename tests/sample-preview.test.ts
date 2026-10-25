import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSamplePreview } from '../src/lib/sample-preview';
import { getSamplePreview, readSamplePreviewFile } from '../src/server/sample-preview';
import { ACCOUNTS, HttpError, login, sessionCookie } from '../src/lib/auth';
import { GET, POST } from '../src/app/api/[...path]/route';
import { syntheticSamplePreview } from './sample-preview-fixture';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('preview requires 100 distinct mappings, fixed presentation and no hidden fields', () => {
  const good = syntheticSamplePreview();
  assert.equal(parseSamplePreview(good).units.length, 100);
  for (const mutate of [
    (p: typeof good) => {
      p.units.pop();
    },
    (p: typeof good) => {
      p.units[1] = p.units[0];
    },
    (p: typeof good) => {
      p.units[0].display.question = 'Changed question';
    },
    (p: typeof good) => {
      Object.assign(p.units[0].packet, { ai_rationale: 'SYNTHETIC_HIDDEN' });
    },
    (p: typeof good) => {
      p.units[0].packet.trial.registry_url = 'https://invalid.example';
    },
    (p: typeof good) => {
      p.units[99].subtype_required = false;
    },
    (p: typeof good) => {
      p.guide.profile_id = 'unknown';
    },
  ]) {
    const copy = structuredClone(good);
    mutate(copy);
    assert.throws(() => parseSamplePreview(copy));
  }
  assert.ok(good.units[99].subtype_required);
  assert.ok(!good.units[99].reason_codes.some((r) => r.code === 'TYPE_2_STATED'));
});

test('private preview refuses changed bytes, insecure file permissions, symlinks and modified guide', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-preview-'));
  const file = join(dir, 'mapping-input.json');
  try {
    // macOS tmpdir may be /var/...; the loader deliberately accepts only the real path.
    const { realpathSync } = await import('node:fs');
    const actual = join(realpathSync(dir), 'mapping-input.json');
    const bytes = JSON.stringify(syntheticSamplePreview());
    writeFileSync(file, bytes, { mode: 0o600 });
    assert.equal((await readSamplePreviewFile(actual, sha(bytes))).units.length, 100);
    await assert.rejects(readSamplePreviewFile(actual, 'f'.repeat(64)), /integrity check/);
    chmodSync(file, 0o644);
    await assert.rejects(readSamplePreviewFile(actual, sha(bytes)), /integrity check/);
    chmodSync(file, 0o600);
    symlinkSync(actual, join(dir, 'alias.json'));
    await assert.rejects(
      readSamplePreviewFile(join(realpathSync(dir), 'alias.json'), sha(bytes)),
      /integrity check/,
    );
    const bad = syntheticSamplePreview();
    bad.guide.text += 'changed';
    const changed = JSON.stringify(bad);
    writeFileSync(file, changed);
    await assert.rejects(readSamplePreviewFile(actual, sha(changed)), /integrity check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview routes deny reviewers, adjudicator and anonymous users before private file access; no write route', async () => {
  process.env.VERIFY_DATA_BACKEND = 'local';
  process.env.VERIFY_DEMO_PASSWORD = 'synthetic-preview-route-password';
  process.env.VERIFY_PREPARATION_PREVIEW_FILE = '/nonexistent-private-preview.json';
  process.env.VERIFY_PREPARATION_PREVIEW_SHA256 = 'a'.repeat(64);
  for (const account of ['reviewer-a', 'reviewer-b', 'adjudicator']) {
    const cookie = sessionCookie(login(account, 'synthetic-preview-route-password'));
    for (const path of ['/api/mu7/admin/preview', '/api/mu7/admin/preview/1']) {
      const response = await GET(
        new Request(`http://localhost:3100${path}`, {
          headers: { host: 'localhost:3100', cookie },
        }),
      );
      assert.equal(response.status, 403);
      assert.match(response.headers.get('Cache-Control')!, /no-store/);
      assert.ok(!(await response.text()).includes('nonexistent-private'));
    }
  }
  const response = await GET(
    new Request('http://localhost:3100/api/mu7/admin/preview', {
      headers: { host: 'localhost:3100' },
    }),
  );
  assert.equal(response.status, 401);
  await assert.rejects(
    getSamplePreview({ ...ACCOUNTS.investigator, practiceReadOnly: true }),
    (e: unknown) => e instanceof HttpError && e.status === 403,
  );
  const cookie = sessionCookie(login('investigator', 'synthetic-preview-route-password'));
  const write = await POST(
    new Request('http://localhost:3100/api/mu7/admin/preview', {
      method: 'POST',
      headers: { host: 'localhost:3100', origin: 'http://localhost:3100', cookie },
      body: '{}',
    }),
  );
  assert.equal(write.status, 404);
  delete process.env.VERIFY_PREPARATION_PREVIEW_FILE;
  delete process.env.VERIFY_PREPARATION_PREVIEW_SHA256;
});
