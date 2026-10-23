// The v7 leakage checker's self-test and pre-import packet audit (review threads on PR #8).
// Synthetic inputs only: the supplied synthetic pilot and broken copies of it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Import objects as the audit reads them; the negative cases mutate them field by field.
type Packet = Record<string, unknown> & { unit?: Record<string, unknown>; notices?: unknown[] };
type ImportUnit = Record<string, unknown> & { family?: unknown; packet: Packet };

const CHECKER = 'tools/check_public_repo_leakage_v7.py';
const PILOT = JSON.parse(
  readFileSync('tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json', 'utf8'),
) as { units: Array<{ import: ImportUnit }> };
const py = (args: string[]) => spawnSync('python3', [CHECKER, ...args], { encoding: 'utf8' });

function auditWith(mutate: (units: ImportUnit[]) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-packets-'));
  try {
    const units = PILOT.units.map((u) => JSON.parse(JSON.stringify(u.import)));
    mutate(units);
    const file = join(dir, 'packets.json');
    writeFileSync(file, JSON.stringify({ units }));
    const r = py(['--packets', file]);
    return { status: r.status, kinds: new Set(r.stdout.split('\n').map((l) => l.split('\t')[0])) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the negative control detects every planted violation (differential, paths withheld)', () => {
  const r = py(['--negative-control']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /5 of 5 checks hold/);
  assert.doesNotMatch(r.stdout, /MISSED/);
});

test('the packet audit accepts the supplied synthetic pilot unchanged', () => {
  const r = auditWith(() => {});
  assert.equal(r.status, 0);
});

test('the packet audit refuses what the database packet guards refuse (MU7-G14, G17, G18, G19)', () => {
  const cases: Array<[string, (units: ImportUnit[]) => void]> = [
    ['PACKET_UNIT_FIELDS', (u) => (u[0].packet.unit = {})],
    ['PACKET_UNIT_FIELDS', (u) => delete u[0].packet.unit],
    ['PACKET_UNIT_FIELDS', (u) => (u[0].packet.unit!.category = 'CARDIOVASCULAR')],
    [
      'PACKET_DISPLAY_TEXT',
      (u) => (u[0].packet.unit!.mapping_label = 'Therapeutic area: something else'),
    ],
    ['PACKET_DISPLAY_TEXT', (u) => (u[0].packet.unit!.display_text = 'probably in this area')],
    [
      'PACKET_DISPLAY_TEXT',
      (u) => (u.find((x) => x.family === 'SG')!.packet.unit!.display_decision = 'KEEP: kept'),
    ],
    [
      'PACKET_DISPLAY_TEXT',
      (u) => (u.find((x) => x.family === 'AREA')!.packet.unit!.display_note = 'A note.'),
    ],
    ['PACKET_NOTICE', (u) => (u[0].packet.notices = [])],
  ];
  for (const [kind, mutate] of cases) {
    const r = auditWith(mutate);
    assert.equal(r.status, 1, `expected ${kind}`);
    assert.ok(r.kinds.has(kind), `expected ${kind}, got ${[...r.kinds].join(', ')}`);
  }
});
