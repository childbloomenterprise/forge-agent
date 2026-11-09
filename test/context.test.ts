import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextEngine, extractKeywords, parseMentions } from '../src/context/engine';
import { Workspace } from '../src/workspace';

const FLASK = process.env.FLASK_DIR ?? path.join(os.homedir(), 'flask');
const hasFlask = fs.existsSync(path.join(FLASK, 'src/flask/cli.py'));

const TASK_A = "Make get_debug_flag treat 'off' and 'n' as false, case-insensitively, and update its docstring.";
const TASK_B =
  'Add a built-in CLI command that prints the app config as JSON, masking values whose keys contain SECRET, PASSWORD, TOKEN or KEY. Register it so it shows in help, add a test and document it.';

test('keywords and mentions', () => {
  assert.deepEqual(extractKeywords('Fix get_debug_flag docstring masking keys'), ['fix', 'get_debug_flag', 'get', 'debug', 'flag', 'docstring', 'mask', 'key']);
  assert.deepEqual(parseMentions('look at @src/flask/cli.py and @symbol:FlaskGroup, mail a@b'), ['src/flask/cli.py', 'symbol:FlaskGroup']);
});

test('Task A ranks helpers.py first', { skip: !hasFlask }, async () => {
  const pack = await new ContextEngine(new Workspace(FLASK)).build(TASK_A, 12000);
  assert.equal(pack.items[0].path, 'src/flask/helpers.py');
  assert.ok(pack.used <= 12000);
});

test('Task B finds cli.py, its tests and docs within budget', { skip: !hasFlask }, async () => {
  const pack = await new ContextEngine(new Workspace(FLASK)).build(TASK_B, 12000);
  const paths = pack.items.map((i) => i.path);
  console.log(pack.items.map((i) => `${i.path} ${i.mode} ${i.tokens} | ${i.reason}`).join('\n'));
  assert.ok(paths.slice(0, 3).includes('src/flask/cli.py'), paths.join(','));
  assert.ok(paths.includes('tests/test_cli.py'));
  assert.ok(paths.includes('docs/cli.rst'));
  assert.ok(pack.used <= 12000, `used ${pack.used}`);
  assert.ok(pack.items.every((i) => i.reason.length > 0));
});

test('@mentions are forced first', { skip: !hasFlask }, async () => {
  const pack = await new ContextEngine(new Workspace(FLASK)).build('explain @symbol:locate_app and @src/flask/sessions.py', 12000);
  assert.deepEqual(pack.items.slice(0, 2).map((i) => i.path).sort(), ['src/flask/cli.py', 'src/flask/sessions.py']);
});
