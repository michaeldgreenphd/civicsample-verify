// The export build identity: captured when the build starts (scripts/build-identity.mjs, baked by
// next.config.ts) or supplied by the deployment; never resolved from HEAD at request time, because
// a later clean checkout does not change the artifact a server is already serving.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBuildIdentity, UNVERIFIED } from '../scripts/build-identity.mjs';
import { appGitSha } from '../src/server/tlv5';

test('build identity names the checked-out commit only for a clean working tree, at build time', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-build-identity-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init', '--quiet');
    git('config', 'user.email', 'synthetic@example.invalid');
    git('config', 'user.name', 'Synthetic');
    writeFileSync(join(root, 'rubric.txt'), 'synthetic rubric v1\n');
    git('add', 'rubric.txt');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'synthetic');
    const head = git('rev-parse', 'HEAD');
    assert.equal(resolveBuildIdentity(root), head);
    writeFileSync(join(root, 'rubric.txt'), 'synthetic rubric v2\n');
    assert.equal(resolveBuildIdentity(root), UNVERIFIED, 'tracked change');
    git('checkout', '--', 'rubric.txt');
    writeFileSync(join(root, 'extra.sql'), '-- synthetic\n');
    assert.equal(resolveBuildIdentity(root), UNVERIFIED, 'untracked file');
    rmSync(join(root, 'extra.sql'));
    // A later clean checkout of another commit does not change a baked identity: the artifact keeps
    // the commit it was built from, whatever HEAD says now.
    const baked = resolveBuildIdentity(root);
    writeFileSync(join(root, 'rubric.txt'), 'synthetic rubric v3\n');
    git('add', 'rubric.txt');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'later');
    assert.notEqual(git('rev-parse', 'HEAD'), baked);
    assert.equal(appGitSha(undefined, baked), baked);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const bare = mkdtempSync(join(tmpdir(), 'verify-no-repo-'));
  try {
    assert.equal(resolveBuildIdentity(bare), UNVERIFIED);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('appGitSha prefers the deployment identity, then the baked identity, and never resolves HEAD', () => {
  assert.equal(appGitSha('e'.repeat(40), 'f'.repeat(40)), 'e'.repeat(40));
  assert.equal(appGitSha(undefined, 'f'.repeat(40)), 'f'.repeat(40));
  assert.equal(appGitSha('not-a-commit', 'f'.repeat(40)), 'f'.repeat(40));
  assert.equal(appGitSha('0'.repeat(40), 'f'.repeat(40)), 'f'.repeat(40));
  assert.equal(appGitSha(undefined, UNVERIFIED), UNVERIFIED);
  assert.equal(appGitSha(undefined, undefined), UNVERIFIED);
  assert.equal(appGitSha('', ''), UNVERIFIED);
});
