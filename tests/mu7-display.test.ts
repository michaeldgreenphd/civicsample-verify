import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  PLAIN_LANGUAGE_PROFILE,
  answerMeaning,
  parseReviewerGuide,
  reasonLabel,
  studyLabel,
  unitDisplay,
} from '../src/lib/mu7-display';
import { MU7_ANSWER_TEXT, MU7_REASON_MEANING, type Mu7UnitBlock } from '../src/lib/mu7-types';
import PILOT from './handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json';
import { reviewTarget } from '../src/lib/mu7-review-target';

const units = PILOT.units.map((entry) => entry.import.packet.unit as Mu7UnitBlock);

test('answer targets distinguish an area judgment from a condition-group judgment', () => {
  const area = units.find((u) => u.mapping_label.startsWith('Therapeutic area: Cardiovascular'))!;
  const row = units.find(
    (u) => u.family === 'ROW' && u.mapping_label.endsWith('Diabetes Mellitus'),
  )!;
  assert.equal(reviewTarget(area).title, 'Therapeutic area — Cardiovascular');
  assert.match(reviewTarget(area).meaning, /does not also confirm a condition group/);
  assert.equal(reviewTarget(row).title, 'Condition group — Diabetes Mellitus');
  assert.match(reviewTarget(row).meaning, /does not also confirm a therapeutic area/);
  const mental = units.find((u) => u.mapping_label.startsWith('Therapeutic area: Mental health'))!;
  assert.equal(reviewTarget(mental).title, 'Therapeutic area — Mental health');
  assert.match(unitDisplay(mental).title, /Depression/, 'the full packet explanation is retained');
});

test('answer targets confirm the displayed inclusion/exclusion without reversing removal answers', () => {
  for (const unit of units.filter((u) => u.family === 'SG')) {
    const before = structuredClone(unit);
    const target = reviewTarget(unit, PLAIN_LANGUAGE_PROFILE);
    if (unit.assignment_code.includes('_REMOVE_')) {
      assert.match(target.title, /^Exclusion check — /);
      assert.match(target.meaning, /^Agree confirms the exclusion\. Disagree means .* included\.$/);
    } else {
      assert.match(target.title, /^Inclusion check — /);
      assert.match(target.meaning, /^Agree confirms the inclusion\. Disagree means .* excluded\.$/);
    }
    assert.deepEqual(unit, before);
  }
});

test('answer targets retain historical assertions rather than reinterpreting old judgments', () => {
  const old = units.find((u) => u.assignment_code === 'K_KEEP_MALIGNANT_COMPATIBLE')!;
  assert.equal(reviewTarget(old).title, 'Neoplasm inclusion check');
  assert.match(reviewTarget(old).meaning, /malignant neoplasm, counted in the Neoplasms row/);
  assert.doesNotMatch(reviewTarget(old).meaning, /Agree confirms the inclusion/);
});

test('displayed inclusion/exclusion questions preserve polarity for every synthetic packet', () => {
  for (const unit of units) {
    const before = structuredClone(unit);
    const display = unitDisplay(unit, PLAIN_LANGUAGE_PROFILE);
    assert.equal(display.assertion, unit.display_text);
    assert.deepEqual(unit, before, 'rendering must not rewrite the packet');
    if (unit.family === 'SG') {
      assert.doesNotMatch(display.title, /Rule [DK]/);
      if (unit.display_decision?.startsWith('REMOVE:')) {
        assert.match(display.question, /appropriate to exclude .* from the/);
        assert.match(display.polarity!, /^Agree confirms the exclusion/);
        assert.match(display.decision!, /^Excluded from the/);
      } else {
        assert.match(display.question, /appropriate to include .* in the/);
        assert.match(display.polarity!, /^Agree confirms the inclusion/);
        assert.match(display.decision!, /^Included in the/);
      }
    }
  }
});

test('historical malignancy assertions stay visible rather than adopting the new clinical target', () => {
  const old = units.find((u) => u.assignment_code === 'K_KEEP_MALIGNANT_COMPATIBLE')!;
  assert.equal(unitDisplay(old).title, 'Neoplasm inclusion check');
  assert.equal(unitDisplay(old).question, 'Is this displayed classification right for this trial?');
  assert.equal(unitDisplay(old).polarity, null);
  assert.equal(unitDisplay(old).assertion, 'malignant neoplasm, counted in the Neoplasms row');
  assert.match(unitDisplay(old).basis, /outside .* cysts, hamartomas and precancerous conditions/);
  const unresolved = { ...old, assignment_code: 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY' };
  assert.match(unitDisplay(unresolved, PLAIN_LANGUAGE_PROFILE).question, /appropriate to include/);
  assert.match(unitDisplay(unresolved).basis, /without stating the diabetes type/);
});

test('reason labels are readable and changed meanings require the versioned profile', () => {
  for (const code of [...Object.keys(MU7_REASON_MEANING), 'NONMALIGNANT_NEOPLASM_STUDIED']) {
    assert.doesNotMatch(reasonLabel(code), /_/);
    assert.notEqual(reasonLabel(code), code);
  }
  assert.equal(reasonLabel('ORGAN_OF_ORIGIN_ONLY'), 'Cancer’s organ of origin only');
  assert.equal(
    reasonLabel('ORGAN_OF_ORIGIN_ONLY', PLAIN_LANGUAGE_PROFILE),
    'Cancer origin, spread or course only',
  );
  assert.equal(reasonLabel('PRECANCEROUS'), 'Precancerous condition');
  assert.equal(
    reasonLabel('PRECANCEROUS', PLAIN_LANGUAGE_PROFILE),
    'Cyst, hamartoma or precancerous condition only',
  );
  assert.equal(reasonLabel('NONMALIGNANT_NEOPLASM_STUDIED'), 'Nonmalignant neoplasm studied');
  assert.equal(answerMeaning('CANNOT_TELL'), MU7_ANSWER_TEXT.CANNOT_TELL.meaning);
  assert.match(answerMeaning('CANNOT_TELL', PLAIN_LANGUAGE_PROFILE), /lacks something you need/);
  assert.doesNotMatch(answerMeaning('CANNOT_TELL', PLAIN_LANGUAGE_PROFILE), /sparingly/);
  assert.equal(
    studyLabel('Figure 2 condition row: Diabetes Mellitus'),
    'Condition group: Diabetes Mellitus',
  );
});

test('guide parser retains all public instructions as text, tables and lists without interpreting markup', () => {
  const guide = readFileSync('docs/reviewer/REVIEWER_GUIDE_v81_r3.md', 'utf8');
  const parsed = parseReviewerGuide(guide);
  assert.equal(parsed.filter((b) => b.kind === 'heading' && b.level === 2).length, 8);
  assert.ok(parsed.some((b) => b.kind === 'table' && b.rows.some((row) => row.includes('Immune'))));
  assert.ok(
    parsed.some(
      (b) =>
        b.kind === 'paragraph' && b.text.includes('No additional narrower clinical definitions'),
    ),
  );
  assert.deepEqual(parseReviewerGuide('<script>alert(1)</script>\n\n[Open](javascript:alert(1))'), [
    { kind: 'paragraph', text: '<script>alert(1)</script>' },
    { kind: 'paragraph', text: '[Open](javascript:alert(1))' },
  ]);
});
