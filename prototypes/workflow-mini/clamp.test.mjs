// Behavioral acceptance tests for the workflow prototype fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './clamp.mjs';

test('C1: values inside bounds and at endpoints are preserved', () => {
  for (const value of [-2, -1.5, 0, 3]) assert.equal(clamp(value, -2, 3), value);
});

test('C2: values below and above bounds use the correct endpoint', () => {
  assert.equal(clamp(-8, -2, 3), -2);
  assert.equal(clamp(8, -2, 3), 3);
});

test('C2: equal bounds always give that bound', () => {
  for (const value of [-8, 2, 8]) assert.equal(clamp(value, 2, 2), 2);
});

test('C3: every argument rejects non-finite and non-number values', () => {
  for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined, true, {}, 1n]) {
    for (let index = 0; index < 3; index++) {
      const args = [1, 0, 2];
      args[index] = bad;
      assert.throws(() => clamp(...args), TypeError);
    }
  }
});

test('C4: reversed bounds fail explicitly', () => {
  assert.throws(() => clamp(1, 3, -2), RangeError);
});
