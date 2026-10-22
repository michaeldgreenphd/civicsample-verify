// Build identity: the commit a build artifact is made from. Resolved once, when the build (or the
// development server) starts, and baked into the artifact through next.config.ts; the running
// server never resolves HEAD at request time, because a later clean checkout would not change the
// artifact it serves. A dirty working tree yields no identity, so an export from it is refused.
import { execFileSync } from 'node:child_process';

export const UNVERIFIED = 'unverified-local-build';
export const COMMIT = /^[0-9a-f]{40}$/;

export function resolveBuildIdentity(cwd = process.cwd()) {
  try {
    const options = { cwd, encoding: 'utf8', stdio: 'pipe' };
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], options);
    if (dirty.trim()) return UNVERIFIED;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    return COMMIT.test(head) ? head : UNVERIFIED;
  } catch {
    return UNVERIFIED;
  }
}
