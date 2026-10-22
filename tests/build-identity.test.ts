// The export build identity: an injected commit wins; otherwise only a clean checkout names its
// commit, so a manifest never attests to a commit that lacks the code that produced the bundle.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appGitSha } from '../src/server/tlv5';

test('appGitSha names the checked-out commit only for a clean working tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-build-identity-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const saved = process.env.VERIFY_APP_GIT_SHA;
  delete process.env.VERIFY_APP_GIT_SHA;
  try {
    git('init', '--quiet');
    git('config', 'user.email', 'synthetic@example.invalid');
    git('config', 'user.name', 'Synthetic');
    writeFileSync(join(root, 'rubric.txt'), 'synthetic rubric v1\n');
    git('add', 'rubric.txt');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'synthetic');
    const head = git('rev-parse', 'HEAD');
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(appGitSha(root), head);
    // An uncommitted change to a tracked file: the commit no longer describes the running code.
    writeFileSync(join(root, 'rubric.txt'), 'synthetic rubric v2\n');
    assert.equal(appGitSha(root), 'unverified-local-build');
    git('checkout', '--', 'rubric.txt');
    assert.equal(appGitSha(root), head);
    // An untracked file counts too (a new migration or fixture that the commit does not carry).
    writeFileSync(join(root, 'extra.sql'), '-- synthetic\n');
    assert.equal(appGitSha(root), 'unverified-local-build');
    // The injected build identity wins; a malformed one is ignored.
    process.env.VERIFY_APP_GIT_SHA = 'e'.repeat(40);
    assert.equal(appGitSha(root), 'e'.repeat(40));
    process.env.VERIFY_APP_GIT_SHA = 'not-a-commit';
    assert.equal(appGitSha(root), 'unverified-local-build');
    // Outside a repository there is no verified identity.
    delete process.env.VERIFY_APP_GIT_SHA;
    const bare = mkdtempSync(join(tmpdir(), 'verify-no-repo-'));
    try {
      assert.equal(appGitSha(bare), 'unverified-local-build');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    if (saved === undefined) delete process.env.VERIFY_APP_GIT_SHA;
    else process.env.VERIFY_APP_GIT_SHA = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
