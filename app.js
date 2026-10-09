// The trial page. Everything here runs in the page; the engine runs in a
// worker. No function in this file opens a connection, and the CSP would
// refuse one if it did.
'use strict';

const DATA = self.CJCM_DATA;
const $ = (id) => document.getElementById(id);

const MEANING = {
  unauthorized_change: 'A balance moved with nothing on record to justify it.',
  reused_cause: 'A cause that already justified a write was used again.',
  amount_mismatch: "A cause exists, but the amount written doesn't match it.",
  untrusted_producer: 'The cause came from a service not allowed to issue it.',
  forged_cause: 'A derived event with no root cause behind it.',
  missing_change: 'An authorized cause with no write. The export may be missing it.',
  cause_without_id: 'A cause with no identity, so it cannot be checked for reuse.',
  late_event: 'An event arrived after its window closed.',
  capacity_exceeded: 'A balance fell outside what the monitor can see.',
  broken_chain: 'An approval with no request behind it: a step of the cause chain is missing.',
  chain_mismatch: 'The steps of the chain disagree: the amount or account approved is not what was requested.',
  reused_link: 'A request already approved was approved again: one request, two payouts.',
};
const CAUSE_FIELDS = ['id', 'type', 'account', 'asset', 'amount', 'time', 'producer', 'ref'];
const CHANGE_FIELDS = ['account', 'asset', 'delta', 'time', 'source'];
const REQUIRED = { causes: ['type', 'account', 'amount', 'time'], changes: ['account', 'delta', 'time'] };
const MAX_ROWS = 1000;
const MAX_ISSUES = 100;

// ---------- DOM helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function amount(s) {
  if (s == null || s === '') return '—';
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '−' : '') + grouped + (f ? '.' + f : '');
}

function when(iso) {
  if (!iso || iso.startsWith('0001-')) return '—';
  return iso.replace('T', ' ');
}

function plural(n, one, many) {
  return `${n.toLocaleString('en')} ${n === 1 ? one : (many || one + 's')}`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------- the engine worker ----------

let worker = null;
let ready = null;
let seq = 0;
const waiting = new Map();

function startEngine() {
  // A blob: worker inherits the page's CSP; a worker loaded from a URL would
  // get only the headers its own response carries.
  const base = new URL('.', location.href).href;
  const src = `importScripts(${JSON.stringify(base + 'wasm_exec.js')}, ${JSON.stringify(base + 'engine.js')}, ${JSON.stringify(base + 'worker.js')});`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  worker = new Worker(url);
  ready = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { URL.revokeObjectURL(url); resolve(m); return; }
      if (m.type === 'failed') { reject(new Error(m.error)); return; }
      const p = waiting.get(m.id);
      if (!p) return;
      waiting.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(JSON.parse(m.result));
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'the engine stopped');
      reject(err);
      for (const p of waiting.values()) p.reject(err);
      waiting.clear();
    };
  });
  return ready;
}

async function runEngine(causes, changes, request) {
  await ready;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, causes, changes, request }, [causes, changes]);
  }).catch((err) => {
    // The Go runtime does not survive a panic (out of memory, most often).
    // Start a fresh engine so the next run works, and report this one.
    worker.terminate();
    startEngine().catch(() => {});
    throw err;
  });
}

// ---------- rendering ----------

function renderResult(root, res, opts = {}) {
  root.replaceChildren();
  if (res.error) {
    root.append(h('div', { class: 'box bad' }, h('strong', {}, 'The engine could not run: '), res.error));
    return;
  }
  const s = res.stats;
  const read = h('p', { class: 'stats' },
    `Read ${plural(s.causes_read, 'cause')} of ${s.cause_rows.toLocaleString('en')} rows and ${plural(s.changes_read, 'change')} of ${s.change_rows.toLocaleString('en')} rows`,
    s.windows ? `, ${plural(s.balances, 'balance')} over ${plural(s.windows, 'window')}, ${when(s.from)} to ${when(s.to)}.` : '.');
  root.append(read);

  const notes = [];
  if (s.causes_without_id) notes.push(`Causes: ${plural(s.causes_without_id, 'row has', 'rows have')} no id. A cause without an id can't be checked for reuse.`);
  if (s.causes_without_producer) notes.push(`Causes: ${plural(s.causes_without_producer, 'row has', 'rows have')} no producer.`);
  if (s.changes_without_source) notes.push(`Changes: ${plural(s.changes_without_source, 'row has', 'rows have')} no source.`);
  for (const w of res.warnings) notes.push(w);
  if (notes.length) root.append(h('ul', { class: 'box warn' }, notes.map(n => h('li', {}, n))));

  if (res.issues.length) {
    const shown = res.issues.slice(0, MAX_ISSUES);
    root.append(h('div', { class: 'box bad' },
      h('p', {}, h('strong', {}, plural(res.issues.length, 'line', 'lines') + " didn't fit"), ' and were left out of the check:'),
      h('ul', { class: 'issues' }, shown.map(i => h('li', {},
        i.line ? `${cap(i.file)}, line ${i.line}: ` : `${cap(i.file)}: `, md(i.msg)))),
      res.issues.length > shown.length ? h('p', { class: 'muted' }, `… and ${(res.issues.length - shown.length).toLocaleString('en')} more.`) : null));
  }

  if (opts.expected != null) {
    const same = alertsJSONL(res.alerts) === opts.expected;
    root.append(h('p', { class: same ? 'match' : 'box bad' }, same
      ? 'Identical to examples/chain2/alerts.jsonl in the engine repository.'
      : 'This differs from examples/chain2/alerts.jsonl in the engine repository.'));
  }

  const nIssuesBlocking = res.issues.some(i => !i.line);
  if (!res.findings.length) {
    if (!nIssuesBlocking && (s.causes_read || s.changes_read)) {
      root.append(h('div', { class: 'box good' }, h('strong', {}, 'No findings. '),
        'Every write in these files has an unspent cause from an accepted producer',
        res.request && res.request.check_amounts ? ', and the amounts add up per balance and window.' : '.',
        ' That holds for these files and this configuration only.'));
    }
    return;
  }

  // Findings table, filterable by type.
  const counts = {};
  for (const f of res.findings) counts[f.type] = (counts[f.type] || 0) + 1;
  const body = h('tbody');
  let filter = null;
  const fill = () => {
    body.replaceChildren();
    const rows = res.findings.filter(f => !filter || f.type === filter);
    for (const f of rows.slice(0, MAX_ROWS)) {
      body.append(h('tr', {},
        h('td', {}, h('code', { title: MEANING[f.type] || '' }, f.type)),
        h('td', {}, f.account),
        h('td', {}, f.asset || ''),
        h('td', {}, (f.cause_ids || []).join(', ') || '—'),
        h('td', { class: 'num' }, amount(f.amount)),
        h('td', {}, when(f.time)),
      ));
    }
    if (rows.length > MAX_ROWS) {
      body.append(h('tr', {}, h('td', { colspan: 6, class: 'muted' }, `Showing ${MAX_ROWS.toLocaleString('en')} of ${rows.length.toLocaleString('en')}. Download alerts.jsonl or findings.csv for all.`)));
    }
  };
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter findings by type' });
  const chip = (label, type) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(filter === type),
    onclick: (e) => {
      filter = type;
      for (const b of chips.children) b.setAttribute('aria-pressed', 'false');
      e.currentTarget.setAttribute('aria-pressed', 'true');
      fill();
    },
  }, label);
  chips.append(chip(`All ${res.findings.length}`, null));
  for (const [t, n] of Object.entries(counts)) chips.append(chip(`${t} ${n}`, t));

  root.append(
    h('h3', {}, plural(res.findings.length, 'finding')),
    h('ul', { class: 'meanings' }, Object.keys(counts).map(t => h('li', {}, h('code', {}, t), ' — ', MEANING[t] || ''))),
    chips,
    h('div', { class: 'table-wrap' }, h('table', { class: 'findings' },
      h('thead', {}, h('tr', {}, ['Type', 'Account', 'Asset', 'Cause id', 'Amount', 'Time'].map(c => h('th', { scope: 'col', class: c === 'Amount' ? 'num' : null }, c)))),
      body)),
  );
  fill();

  root.append(
    h('h3', {}, 'Per account'),
    h('p', { class: 'muted' }, 'Unjustified: the movement no authorized cause accounts for. Observed delta in windows with an unauthorized change, plus observed minus authorized where amounts mismatch.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Account', 'Asset', 'Findings', 'Unjustified'].map(c => h('th', { scope: 'col', class: c === 'Findings' || c === 'Unjustified' ? 'num' : null }, c)))),
      h('tbody', {}, res.accounts.slice(0, MAX_ROWS).map(a => h('tr', {},
        h('td', {}, a.account), h('td', {}, a.asset || ''), h('td', { class: 'num' }, a.findings), h('td', { class: 'num' }, amount(a.unjustified)))))))
  );

  root.append(h('p', { class: 'downloads' },
    h('button', { type: 'button', onclick: () => download('alerts.jsonl', alertsJSONL(res.alerts), 'application/x-ndjson') }, 'Download alerts.jsonl'),
    ' ',
    h('button', { type: 'button', class: 'secondary', onclick: () => download('findings.csv', findingsCSV(res.findings), 'text/csv') }, 'Download findings.csv'),
  ));

  root.append(h('details', { class: 'raw' },
    h('summary', {}, `The engine's alerts, as written (${res.alerts.length})`),
    h('pre', {}, res.alerts.slice(0, 50).map(a => JSON.stringify(a, null, 2)).join('\n'),
      res.alerts.length > 50 ? `\n… ${res.alerts.length - 50} more in alerts.jsonl` : '')));
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Renders `code` spans in engine messages.
function md(msg) {
  return msg.split(/(`[^`]*`)/).map(p => p.startsWith('`') && p.endsWith('`') && p.length > 1 ? h('code', {}, p.slice(1, -1)) : p);
}

function alertsJSONL(alerts) {
  // Same key order and spacing as Go's encoding/json, which wrote them.
  return alerts.map(a => JSON.stringify(a)).join('\n') + (alerts.length ? '\n' : '');
}

function findingsCSV(findings) {
  const head = 'type,account,asset,cause_ids,amount,time,window_start,window_end\n';
  return head + findings.map(f => [f.type, f.account, f.asset, (f.cause_ids || []).join(' '), f.amount, f.time, f.window_start, f.window_end].map(csvCell).join(',')).join('\n') + '\n';
}

// ---------- column mapping ----------

const mapping = { causes: {}, changes: {} };

function renderMapping(res) {
  const root = $('columns');
  const files = [['causes', CAUSE_FIELDS, res.headers.causes], ['changes', CHANGE_FIELDS, res.headers.changes]];
  if (!files.some(([, , hs]) => hs && hs.length)) { root.hidden = true; return; }
  root.replaceChildren(h('h3', {}, 'Columns used'),
    h('p', { class: 'muted' }, 'Change a column and the check runs again.'));
  const grid = h('div', { class: 'mapping-grid' });
  for (const [file, fields, headers] of files) {
    if (!headers || !headers.length) continue;
    const used = res.columns[file] || {};
    const group = h('fieldset', {}, h('legend', {}, cap(file)));
    for (const f of fields) {
      const req = REQUIRED[file].includes(f);
      const sel = h('select', {
        'data-file': file, 'data-field': f,
        class: req && !used[f] ? 'missing' : null,
        onchange: (e) => {
          mapping[file][f] = e.target.value;
          runUser();
        },
      }, h('option', { value: '' }, '— none —'), headers.map(x => h('option', { value: x, selected: used[f] === x }, x)));
      group.append(h('label', {}, h('span', {}, f, req ? ' *' : ''), sel));
    }
    grid.append(group);
  }
  root.append(grid);
  root.hidden = false;
}

// ---------- inputs ----------

const files = { causes: null, changes: null };

function setFile(kind, file) {
  files[kind] = file;
  mapping[kind] = {};
  $(`name-${kind}`).textContent = file ? `${file.name} · ${(file.size / 1e6).toFixed(file.size < 1e5 ? 3 : 1)} MB` : 'Drop a file or click to choose';
  $(`drop-${kind}`).classList.toggle('has-file', !!file);
  $('run').disabled = !(files.causes && files.changes);
}

function wireDrop(kind) {
  const zone = $(`drop-${kind}`);
  const input = $(`file-${kind}`);
  input.addEventListener('change', () => { if (input.files[0]) setFile(kind, input.files[0]); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const dropped = [...e.dataTransfer.files];
    if (dropped.length === 2) {
      // Both at once: guess which is which by name, else by drop order.
      const isChanges = (f) => /change|effect|write|balance/i.test(f.name);
      const [a, b] = dropped;
      const changesFirst = isChanges(a) && !isChanges(b);
      setFile('causes', changesFirst ? b : a);
      setFile('changes', changesFirst ? a : b);
    } else if (dropped[0]) {
      setFile(kind, dropped[0]);
    }
  });
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
}

function list(id) {
  return $(id).value.split(',').map(s => s.trim()).filter(Boolean);
}

function request() {
  const nonEmpty = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v));
  return {
    window_seconds: Number($('opt-window').value),
    grace_seconds: Math.max(0, Number($('opt-grace').value) || 0),
    trusted_producers: list('opt-producers'),
    derived_types: list('opt-derived'),
    root_types: list('opt-roots'),
    single_actor_types: list('opt-single'),
    chains: $('opt-chains').value,
    check_amounts: $('opt-amounts').checked,
    require_cause_id: $('opt-require-id').checked,
    cause_columns: nonEmpty(mapping.causes),
    change_columns: nonEmpty(mapping.changes),
  };
}

function applyRequest(r) {
  const w = $('opt-window');
  if (![...w.options].some(o => Number(o.value) === r.window_seconds)) {
    w.append(h('option', { value: r.window_seconds }, `${r.window_seconds} s`));
  }
  w.value = String(r.window_seconds);
  $('opt-grace').value = r.grace_seconds;
  $('opt-producers').value = r.trusted_producers.join(', ');
  $('opt-derived').value = r.derived_types.join(', ');
  $('opt-roots').value = r.root_types.join(', ');
  $('opt-single').value = (r.single_actor_types || []).join(', ');
  $('opt-chains').value = r.chains || '';
  if (r.chains) $('settings').querySelector('.advanced').open = true;
  $('opt-amounts').checked = r.check_amounts;
  $('opt-require-id').checked = r.require_cause_id;
}

const LARGE = 150e6;
let running = false;

async function runUser() {
  if (!files.causes || !files.changes || running) return;
  const section = $('result-section');
  const out = $('result');
  section.hidden = false;
  const total = files.causes.size + files.changes.size;
  out.replaceChildren(h('p', { class: 'stats', role: 'status' },
    total > LARGE ? `Running on ${(total / 1e6).toFixed(0)} MB. This is above what a browser tab reliably holds; if it fails, use the audit CLI.` : 'Running…'));
  running = true;
  $('run').disabled = true;
  const t0 = performance.now();
  try {
    const req = request();
    const [c, d] = await Promise.all([files.causes.arrayBuffer(), files.changes.arrayBuffer()]);
    const res = await runEngine(c, d, req);
    res.request = req;
    renderMapping(res);
    renderResult(out, res);
    out.prepend(h('p', { class: 'muted' }, `${files.causes.name} + ${files.changes.name} · ${((performance.now() - t0) / 1000).toFixed(1)} s in this browser`));
  } catch (err) {
    out.replaceChildren(h('div', { class: 'box bad' }, h('strong', {}, 'The run failed: '), err.message,
      total > 50e6 ? ' Large inputs can exhaust the memory a browser gives a page; the audit CLI runs the same check without that limit.' : ''));
  } finally {
    running = false;
    $('run').disabled = !(files.causes && files.changes);
  }
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- start ----------

async function main() {
  const s = DATA.sample;
  $('sample-causes').textContent = s.causes;
  $('sample-changes').textContent = s.changes;
  $('sample-causes-n').textContent = `(${s.causes.trim().split('\n').length} rows)`;
  $('sample-changes-n').textContent = `(${s.changes.trim().split('\n').length} rows)`;

  for (const b of document.querySelectorAll('[data-template]')) {
    b.addEventListener('click', () => download(b.dataset.template, DATA.templates[b.dataset.template], 'text/csv'));
  }
  wireDrop('causes');
  wireDrop('changes');
  $('settings').addEventListener('submit', (e) => { e.preventDefault(); runUser(); });
  $('load-sample').addEventListener('click', () => {
    applyRequest(s.request);
    setFile('causes', new File([s.causes], 'causes.csv', { type: 'text/csv' }));
    setFile('changes', new File([s.changes], 'changes.csv', { type: 'text/csv' }));
    runUser();
  });

  const status = $('engine-status');
  try {
    const info = await startEngine();
    $('build-live').textContent = `engine sha256 (computed here):  ${info.sha256 || 'unavailable (needs https or localhost)'}`;
    if (info.sha256 && info.sha256 !== DATA.build.sha256) {
      $('build-live').classList.add('bad');
    }
    status.textContent = 'Engine loaded. Nothing else will be fetched.';
    status.classList.add('ok');
    $('run').disabled = !(files.causes && files.changes);
  } catch (err) {
    status.textContent = `The engine could not start: ${err.message}`;
    status.classList.add('bad');
    return;
  }

  const enc = new TextEncoder();
  try {
    const res = await runEngine(enc.encode(s.causes).buffer, enc.encode(s.changes).buffer, s.request);
    res.request = s.request;
    renderResult($('sample-result'), res, { expected: s.alerts });
    $('sample-result').prepend(h('p', { class: 'muted' },
      'Chain: withdrawal.requested@user-api > withdrawal.approved@admin-console. 60 s windows, amount check on, cause id required.'));
  } catch (err) {
    $('sample-result').replaceChildren(h('div', { class: 'box bad' }, err.message));
  }
}

main();
