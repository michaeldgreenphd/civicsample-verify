import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('three-model mapping runner: synthetic authorization, budget and privacy regressions', () => {
  const result = spawnSync(
    process.env.VERIFY_ANALYSIS_PYTHON ?? 'python3',
    ['-m', 'unittest', 'discover', '-s', 'scripts/ai-mapping-review', '-p', 'test_*.py', '-q'],
    { encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
