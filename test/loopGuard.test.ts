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

test('pauses read-only tools past the hard limit until an edit', () => {
  const g = new LoopGuard();
  for (let i = 0; i < 14; i++) g.note('search', { query: `q${i}` });
  assert.match(g.blocked('search') ?? '', /Exploration limit reached/);
  assert.equal(g.blocked('propose_edit'), undefined);
  g.note('propose_edit', {});
  assert.equal(g.blocked('search'), undefined);
});
