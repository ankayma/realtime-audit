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

// causes is one ArrayBuffer per causes file, in the order of
// request.cause_sources.
async function runEngine(causes, changes, request) {
  await ready;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, causes, changes, request }, [...causes, changes]);
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
  if (res.sources.length > 1) {
    root.append(h('ul', { class: 'stats' }, res.sources.map(src => h('li', {},
      h('code', {}, src.name), `: ${plural(src.read, 'row')} read of ${src.rows.toLocaleString('en')}`,
      src.type ? `, as ${src.type}` : '', src.producer ? ` from ${src.producer}` : ''))));
  }

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
        i.line ? `${fileLabel(i.file)}, line ${i.line}: ` : `${fileLabel(i.file)}: `, md(i.msg)))),
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

// Issues name a file: "causes", "changes", "settings", or a causes file's own name.
function fileLabel(f) { return ['causes', 'changes', 'settings'].includes(f) ? cap(f) : f; }

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

// Column choices: one map per causes file (parallel to files.causes), one for changes.
const mapping = { changes: {} };

function renderMapping(res) {
  const root = $('columns');
  const groups = res.sources.map((src, i) => ({
    label: src.name, fields: CAUSE_FIELDS, headers: src.headers, used: src.columns,
    required: REQUIRED.causes.filter(f => !(f === 'type' && files.causes[i] && stageOf(files.causes[i]).type)),
    set: (f, v) => { if (files.causes[i]) files.causes[i].columns[f] = v; },
  }));
  groups.push({
    label: 'Changes', fields: CHANGE_FIELDS, headers: res.headers.changes, used: res.columns.changes,
    required: REQUIRED.changes, set: (f, v) => { mapping.changes[f] = v; },
  });
  if (!groups.some(g => g.headers && g.headers.length)) { root.hidden = true; return; }
  root.replaceChildren(h('h3', {}, 'Columns used'),
    h('p', { class: 'muted' }, 'Change a column and the check runs again.'));
  const grid = h('div', { class: 'mapping-grid' });
  for (const g of groups) {
    if (!g.headers || !g.headers.length) continue;
    const used = g.used || {};
    const group = h('fieldset', {}, h('legend', {}, g.label));
    for (const f of g.fields) {
      const req = g.required.includes(f);
      const sel = h('select', {
        'data-file': g.label, 'data-field': f,
        class: req && !used[f] ? 'missing' : null,
        onchange: (e) => {
          g.set(f, e.target.value);
          runUser();
        },
      }, h('option', { value: '' }, '— none —'), g.headers.map(x => h('option', { value: x, selected: used[f] === x }, x)));
      group.append(h('label', {}, h('span', {}, f, req ? ' *' : ''), sel));
    }
    grid.append(group);
  }
  root.append(grid);
  root.hidden = false;
}

// ---------- inputs ----------

// files.causes: one entry per causes file, {file, stage, columns}; stage is
// "type@producer" from the chains setting, or "" when the rows name their own.
const files = { causes: [], changes: null };

function size(file) {
  return file.size < 1e6 ? `${Math.max(1, Math.round(file.size / 1e3))} KB` : `${(file.size / 1e6).toFixed(1)} MB`;
}

function ready2run() {
  return files.causes.length > 0 && !!files.changes;
}

// The stages declared in the chains setting, in order.
function stages() {
  const out = [];
  for (const line of $('opt-chains').value.split(/[;\n]/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    for (const part of line.split('>')) {
      const [type, producer = ''] = part.split('@').map(s => s.trim());
      if (type) out.push({ type, producer, key: producer ? `${type}@${producer}` : type });
    }
  }
  return out;
}

function stageOf(entry) {
  const [type = '', producer = ''] = entry.stage.split('@');
  return { type, producer };
}

// Guesses a file's stage from its name: "approvals.csv" is the stage whose
// type ends in "approved", "requests.csv" the one ending in "requested".
function guessStage(name) {
  const n = name.toLowerCase();
  const hits = stages().filter(s => {
    const last = s.type.split('.').pop().toLowerCase().replace(/e?d$/, '');
    return last.length >= 4 && n.includes(last);
  });
  const best = hits.find(s => n.includes(s.type.split('.')[0].toLowerCase())) || hits[0];
  return best ? best.key : '';
}

function addCauses(list) {
  for (const file of list) {
    files.causes.push({ file, stage: guessStage(file.name), columns: {} });
  }
  renderSources();
}

function setChanges(file) {
  files.changes = file;
  mapping.changes = {};
  $('name-changes').textContent = file ? `${file.name} · ${size(file)}` : 'Drop a file or click to choose';
  $('drop-changes').classList.toggle('has-file', !!file);
  $('run').disabled = !ready2run();
}

function renderSources() {
  const list = $('cause-sources');
  const all = stages();
  list.replaceChildren(...files.causes.map((entry, i) => {
    if (entry.stage && !all.some(s => s.key === entry.stage)) entry.stage = '';
    return h('li', {},
      h('span', { class: 'src-name' }, `${entry.file.name} · ${size(entry.file)}`),
      h('label', {}, h('span', { class: 'muted' }, 'source'),
        h('select', {
          'aria-label': `Source of ${entry.file.name}`,
          onchange: (e) => { entry.stage = e.target.value; },
        },
        h('option', { value: '' }, 'rows have their own type column'),
        all.map(s => h('option', { value: s.key, selected: entry.stage === s.key },
          s.producer ? `${s.producer} · ${s.type}` : s.type)))),
      h('button', {
        type: 'button', class: 'remove', 'aria-label': `Remove ${entry.file.name}`,
        onclick: () => { files.causes.splice(i, 1); renderSources(); },
      }, '✕'));
  }));
  const n = files.causes.length;
  $('name-causes').textContent = n
    ? `${plural(n, 'file')}. Drop more to add a source.`
    : 'Drop one or more files, or click to choose';
  $('drop-causes').classList.toggle('has-file', n > 0);
  $('run').disabled = !ready2run();
}

function wireDrop(kind) {
  const zone = $(`drop-${kind}`);
  const input = $(`file-${kind}`);
  const take = (list) => {
    if (kind === 'changes') {
      if (list[0]) setChanges(list[0]);
      return;
    }
    // Several files on Causes: a ledger export among them goes to Changes.
    const isChanges = (f) => /change|effect|ledger|balance_write/i.test(f.name);
    const rest = [];
    for (const f of list) {
      if (list.length > 1 && !files.changes && isChanges(f)) setChanges(f);
      else rest.push(f);
    }
    addCauses(rest);
  };
  input.addEventListener('change', () => { take([...input.files]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    take([...e.dataTransfer.files]);
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
    change_columns: nonEmpty(mapping.changes),
    cause_sources: files.causes.map(entry => ({
      name: entry.file.name, ...stageOf(entry), columns: nonEmpty(entry.columns),
    })),
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
  if (!ready2run() || running) return;
  const section = $('result-section');
  const out = $('result');
  section.hidden = false;
  const total = files.causes.reduce((n, c) => n + c.file.size, 0) + files.changes.size;
  out.replaceChildren(h('p', { class: 'stats', role: 'status' },
    total > LARGE ? `Running on ${(total / 1e6).toFixed(0)} MB. This is above what a browser tab reliably holds; if it fails, use the audit CLI.` : 'Running…'));
  running = true;
  $('run').disabled = true;
  const t0 = performance.now();
  try {
    const req = request();
    const c = await Promise.all(files.causes.map(entry => entry.file.arrayBuffer()));
    const d = await files.changes.arrayBuffer();
    const res = await runEngine(c, d, req);
    res.request = req;
    renderMapping(res);
    renderResult(out, res);
    out.prepend(h('p', { class: 'muted' }, `${files.causes.map(c => c.file.name).join(' + ')} + ${files.changes.name} · ${((performance.now() - t0) / 1000).toFixed(1)} s in this browser`));
  } catch (err) {
    out.replaceChildren(h('div', { class: 'box bad' }, h('strong', {}, 'The run failed: '), err.message,
      total > 50e6 ? ' Large inputs can exhaust the memory a browser gives a page; the audit CLI runs the same check without that limit.' : ''));
  } finally {
    running = false;
    $('run').disabled = !ready2run();
  }
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- start ----------

async function main() {
  const s = DATA.sample;
  $('sample-requests').textContent = s.requests;
  $('sample-approvals').textContent = s.approvals;
  $('sample-changes').textContent = s.changes;

  for (const b of document.querySelectorAll('[data-template]')) {
    b.addEventListener('click', () => download(b.dataset.template, DATA.templates[b.dataset.template], 'text/csv'));
  }
  wireDrop('causes');
  wireDrop('changes');
  $('opt-chains').addEventListener('input', renderSources);
  $('settings').addEventListener('submit', (e) => { e.preventDefault(); runUser(); });
  $('load-sample').addEventListener('click', () => {
    applyRequest(s.request);
    files.causes = s.request.cause_sources.map(src => ({
      file: new File([s[src.name.replace('.csv', '')]], src.name, { type: 'text/csv' }),
      stage: `${src.type}@${src.producer}`, columns: {},
    }));
    renderSources();
    setChanges(new File([s.changes], 'changes.csv', { type: 'text/csv' }));
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
    $('run').disabled = !ready2run();
  } catch (err) {
    status.textContent = `The engine could not start: ${err.message}`;
    status.classList.add('bad');
    return;
  }

  const enc = new TextEncoder();
  try {
    const res = await runEngine([enc.encode(s.requests).buffer, enc.encode(s.approvals).buffer], enc.encode(s.changes).buffer, s.request);
    res.request = s.request;
    renderResult($('sample-result'), res, { expected: s.alerts });
    $('sample-result').prepend(h('p', { class: 'muted' },
      'requests.csv as withdrawal.requested from user-api, approvals.csv as withdrawal.approved from admin-console. Chain: withdrawal.requested@user-api > withdrawal.approved@admin-console. 60 s windows, amount check on, cause id required.'));
  } catch (err) {
    $('sample-result').replaceChildren(h('div', { class: 'box bad' }, err.message));
  }
}

main();
