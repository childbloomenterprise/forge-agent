// Scripted OpenAI-compatible model that performs Flask Task A, for quota-free rehearsals of the full TrueForge loop.
// Usage: node test/mock-flask-llm.mjs [port]   (default 9101; API key must be "good")
import http from 'node:http';

const port = Number(process.argv[2] ?? 9101);
const OLD = [
  '    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.',
  '    """',
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no"})',
].join('\n');
const NEW = [
  '    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.',
  '    The values ``0``, ``false``, ``no``, ``off`` and ``n`` (any case) disable',
  '    debug mode.',
  '    """',
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})',
].join('\n');

function script(step) {
  switch (step) {
    case 0:
      return [
        ['read_file', { path: 'src/flask/helpers.py', start_line: 25, end_line: 40 }],
        ['search', { query: 'get_debug_flag', glob: 'tests/*.py' }],
      ];
    case 1:
      return [['propose_edit', { path: 'src/flask/helpers.py', edits: [{ old_text: OLD, new_text: NEW }], summary: "Treat 'off' and 'n' as false in get_debug_flag" }]];
    case 2:
      return [['run_command', { command: `FLASK_DEBUG=OFF .venv/bin/python -c "import sys; sys.path.insert(0, 'src'); from flask.helpers import get_debug_flag; print(get_debug_flag())"` }]];
    default:
      return null;
  }
}

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer good') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":{"message":"invalid api key"}}');
      }
      const j = JSON.parse(body || '{}');
      const names = (j.tools ?? []).map((t) => t.function.name);
      const resolve = (n) => names.find((x) => x === n || x.endsWith(`__${n}`) || x.endsWith(`.${n}`) || x.endsWith(`_${n}`));
      const step = (j.messages ?? []).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
      const calls = (script(step) ?? []).map(([n, args]) => [resolve(n), args]).filter(([n]) => n);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: `m${step}`, object: 'chat.completion.chunk', created: 1, model: j.model };
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (calls.length) {
        const tool_calls = calls.map(([name, args], index) => ({ index, id: `c${step}_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: `Step ${step + 1}: ${calls.map(([n]) => n).join(', ')}. ` }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: { tool_calls }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        for (const w of 'Done: get_debug_flag now treats off and n as false, and the docstring says so.'.split(' '))
          send({ ...base, choices: [{ index: 0, delta: { content: `${w} ` }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`mock flask model on :${port}`));
