import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, applyReplacements, computeHunks } from '../src/edits/staging';

const original = 'a\nb\nc\nd\ne\n';
const proposed = 'a\nB\nc\nd\nx\ne\nf\n';

test('computeHunks splits independent changes', () => {
  const hunks = computeHunks(original, proposed);
  assert.equal(hunks.length, 3);
  assert.deepEqual(hunks[0], { index: 0, originalStart: 1, removed: ['b\n'], added: ['B\n'] });
  assert.deepEqual(hunks[1], { index: 1, originalStart: 4, removed: [], added: ['x\n'] });
  assert.deepEqual(hunks[2], { index: 2, originalStart: 5, removed: [], added: ['f\n'] });
});

test('applyHunks: all, none, subset', () => {
  const hunks = computeHunks(original, proposed);
  assert.equal(applyHunks(original, hunks, new Set([0, 1, 2])), proposed);
  assert.equal(applyHunks(original, hunks, new Set()), original);
  assert.equal(applyHunks(original, hunks, new Set([1])), 'a\nb\nc\nd\nx\ne\n');
  assert.equal(applyHunks(original, hunks, new Set([0, 2])), 'a\nB\nc\nd\ne\nf\n');
});

test('new file is one hunk', () => {
  const hunks = computeHunks('', 'x\ny\n');
  assert.equal(hunks.length, 1);
  assert.equal(applyHunks('', hunks, new Set([0])), 'x\ny\n');
});

test('applyReplacements validates matches', () => {
  assert.equal(applyReplacements('foo bar', [{ old_text: 'bar', new_text: 'baz' }]), 'foo baz');
  assert.throws(() => applyReplacements('foo', [{ old_text: 'nope', new_text: '' }]), /not found/);
  assert.throws(() => applyReplacements('a a', [{ old_text: 'a', new_text: 'b' }]), /more than once/);
  assert.equal(applyReplacements('', [{ old_text: '', new_text: 'new' }]), 'new');
});
