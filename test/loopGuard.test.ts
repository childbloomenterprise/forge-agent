import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard } from '../src/mcp/loopGuard';

test('flags repeated identical read-only calls', () => {
  const g = new LoopGuard();
  assert.equal(g.note('search', { query: 'routes_command' }), undefined);
  assert.match(g.note('search', { query: 'routes_command' }) ?? '', /already called search/);
  assert.equal(g.note('search', { query: 'shell_command' }), undefined);
});

test('nudges after long exploration and resets on edit', () => {
  const g = new LoopGuard();
  const notes = Array.from({ length: 8 }, (_, i) => g.note('read_file', { path: `f${i}` }));
  assert.match(notes[7] ?? '', /propose the edits now/);
  g.note('propose_edit', {});
  assert.equal(g.note('read_file', { path: 'x' }), undefined);
});
