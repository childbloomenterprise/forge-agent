// @ts-check
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const log = $('log'), input = /** @type {HTMLTextAreaElement} */ ($('input'));
  const send = /** @type {HTMLButtonElement} */ ($('send')), cancel = /** @type {HTMLButtonElement} */ ($('cancel'));
  const bubbles = new Map(), tools = new Map(), cards = new Map();

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const add = (node) => { const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30; log.appendChild(node); if (stick) log.scrollTop = log.scrollHeight; return node; };
  const scroll = () => { log.scrollTop = log.scrollHeight; };

  function bubble(id, threadId) {
    let b = bubbles.get(id);
    if (!b) {
      b = add(el('div', 'msg assistant'));
      if (threadId && threadId !== 'main') b.appendChild(el('div', 'meta', `subagent ${threadId}`));
      b.body = b.appendChild(el('div', 'body'));
      bubbles.set(id, b);
    }
    return b;
  }

  function review(m) {
    const card = add(el('div', 'card'));
    card.appendChild(el('h4', '', `${m.isNew ? 'New file' : 'Edit'}: ${m.path}`));
    if (m.summary) card.appendChild(el('div', 'meta', m.summary));
    const boxes = m.hunks.map((h) => {
      const wrap = card.appendChild(el('div', 'hunk'));
      const label = wrap.appendChild(el('label'));
      const box = /** @type {HTMLInputElement} */ (label.appendChild(el('input')));
      box.type = 'checkbox'; box.checked = true;
      label.appendChild(document.createTextNode(` Hunk ${h.index + 1} · line ${h.start + 1} (−${h.removed.length} +${h.added.length})`));
      const pre = wrap.appendChild(el('pre'));
      h.removed.forEach((l) => pre.appendChild(el('div', 'del', '- ' + l.replace(/\n$/, ''))));
      h.added.forEach((l) => pre.appendChild(el('div', 'add', '+ ' + l.replace(/\n$/, ''))));
      return box;
    });
    const row = card.appendChild(el('div', 'row'));
    const finish = (accepted) => {
      card.classList.add('decided');
      row.replaceChildren(el('span', '', accepted.length ? `Accepted ${accepted.length}/${m.hunks.length} hunk(s)` : 'Rejected'));
      boxes.forEach((b) => (b.disabled = true));
      cards.delete(m.id);
    };
    cards.set(m.id, finish);
    const decide = (accepted) => { vscode.postMessage({ type: 'decision', id: m.id, accepted }); finish(accepted); };
    const btn = (text, cls, fn) => { const b = row.appendChild(el('button', cls, text)); b.onclick = fn; };
    btn('Reject all', 'secondary', () => decide([]));
    btn('Accept selected', 'secondary', () => decide(boxes.flatMap((b, i) => (b.checked ? [m.hunks[i].index] : []))));
    btn('Accept all', '', () => decide(m.hunks.map((h) => h.index)));
    scroll();
  }

  function approve(m) {
    const card = add(el('div', 'card'));
    card.appendChild(el('h4', '', `Approve ${m.name}?`));
    card.appendChild(el('pre', '', m.detail));
    const row = card.appendChild(el('div', 'row'));
    const decide = (allow) => { vscode.postMessage({ type: 'decision', id: m.id, allow }); card.classList.add('decided'); row.replaceChildren(el('span', '', allow ? 'Allowed' : 'Denied')); };
    const deny = row.appendChild(el('button', 'secondary', 'Deny')); deny.onclick = () => decide(false);
    const allow = row.appendChild(el('button', '', 'Allow')); allow.onclick = () => decide(true);
    scroll();
  }

  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'user': add(el('div', 'msg user', m.text)); scroll(); break;
      case 'delta': bubble(m.id, m.threadId).body.textContent += m.text; if (log.scrollHeight - log.scrollTop - log.clientHeight < 60) scroll(); break;
      case 'message': {
        if (m.text) bubble(m.id, m.threadId).body.textContent = m.text;
        else if (bubbles.has(m.id) && !bubbles.get(m.id).body.textContent) { bubbles.get(m.id).remove(); }
        for (const t of m.toolCalls) {
          const node = add(el('div', 'msg tool'));
          const d = node.appendChild(el('details'));
          d.appendChild(el('summary', '', `${m.threadId !== 'main' ? '[' + m.threadId + '] ' : ''}${t.name} ${t.preview}`));
          d.appendChild(el('pre', '', t.args));
          tools.set(t.id, d);
        }
        break;
      }
      case 'tool': { const d = tools.get(m.toolCallId); if (d) { const p = d.appendChild(el('pre', 'meta', m.result)); p.title = 'tool result'; } break; }
      case 'thread': add(el('div', 'thread', m.status === 'created' ? `▶ subagent ${m.threadId} started${m.title ? ': ' + m.title : ''}` : `■ subagent ${m.threadId} finished`)); break;
      case 'status': add(el('div', `status ${m.level}`, m.text)); scroll(); if (m.level !== 'info') { const b = $('banner'); b.textContent = m.text; b.hidden = false; } break;
      case 'review': review(m); break;
      case 'reviewDone': cards.get(m.id)?.(m.accepted); break;
      case 'context': {
        const card = add(el('div', 'card context'));
        const d = card.appendChild(el('details'));
        d.open = true;
        d.appendChild(el('summary', '', `Context: ${m.items.length} file(s), ${m.used}/${m.budget} tokens`));
        const t = d.appendChild(el('table'));
        const head = t.appendChild(el('tr'));
        ['File', 'Why', 'Tokens'].forEach((h) => head.appendChild(el('th', '', h)));
        for (const i of m.items) {
          const r = t.appendChild(el('tr', i.mode));
          r.appendChild(el('td', 'path', i.path));
          r.appendChild(el('td', '', i.reason));
          r.appendChild(el('td', 'num', i.mode === 'omitted' ? 'over budget' : `${i.tokens} (${i.mode})`));
        }
        scroll();
        break;
      }
      case 'approve': approve(m); break;
      case 'running': send.disabled = m.value; cancel.disabled = !m.value; if (m.value) $('banner').hidden = true; break;
      case 'model': $('model').textContent = m.text; break;
      case 'clear': log.replaceChildren(); bubbles.clear(); tools.clear(); $('banner').hidden = true; break;
    }
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); } });
  cancel.onclick = () => vscode.postMessage({ type: 'cancel' });
  $('new').onclick = () => vscode.postMessage({ type: 'newSession' });
  vscode.postMessage({ type: 'ready' });
})();
