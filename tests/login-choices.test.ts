import assert from 'node:assert/strict';
import test from 'node:test';
import { publicLoginChoices } from '../src/lib/login-choices';

test('public login labels preserve spaces and contain no account permissions', () => {
  assert.deepEqual(publicLoginChoices(''), []);
  const choices = [{ username: 'synthetic-user', label: 'Synthetic Person' }];
  assert.deepEqual(publicLoginChoices(JSON.stringify(choices)), choices);
  for (const extra of [
    { role: 'INVESTIGATOR' },
    { password: 'synthetic-secret' },
    { authUserId: 'x' },
  ]) {
    assert.throws(
      () => publicLoginChoices(JSON.stringify([{ ...choices[0], ...extra }])),
      /choices are invalid/,
    );
  }
});

test('invalid or ambiguous public login configuration is refused without echoing input', () => {
  for (const raw of [
    'private-secret-input',
    '{}',
    '[null]',
    JSON.stringify([{ username: 'a b', label: 'Example' }]),
    JSON.stringify([{ username: 'example', label: '<script>' }]),
    JSON.stringify([{ username: 'example', label: ' Same ' }]),
    JSON.stringify([
      { username: 'one', label: 'Same' },
      { username: 'two', label: 'same' },
    ]),
    JSON.stringify([
      { username: 'one', label: 'First' },
      { username: 'one', label: 'Second' },
    ]),
  ]) {
    assert.throws(() => publicLoginChoices(raw), {
      message: 'The public sign-in choices are invalid.',
    });
  }
});
