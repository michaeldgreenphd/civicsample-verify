import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolveBuildIdentity, UNVERIFIED } from './build-identity.mjs';

const commit = resolveBuildIdentity();
if (
  commit === UNVERIFIED ||
  (process.env.RENDER_GIT_COMMIT && process.env.RENDER_GIT_COMMIT !== commit)
)
  throw new Error('Hosted build requires a clean checkout at the deployment commit.');
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
if (resolveBuildIdentity() !== commit) throw new Error('Checkout changed during build.');
writeFileSync('.next/verify-build.json', JSON.stringify({ commit }) + '\n');
