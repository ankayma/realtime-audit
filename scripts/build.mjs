// Builds dist/ from site/ and the engine pinned in cjcm.lock.
//
//   node scripts/build.mjs            # clones the engine at the pinned commit
//   CJCM_DIR=../cjcm node scripts/build.mjs   # uses a local checkout, which must be at that commit
//
// Output is a static directory with no external references. The engine is
// embedded in engine.js as base64 because the page's CSP has connect-src
// 'none': it cannot fetch anything, not even its own .wasm.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const cache = path.join(root, '.cache');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();

const lock = Object.fromEntries(
  fs.readFileSync(path.join(root, 'cjcm.lock'), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('=', 2)),
);

// The engine source, at the pinned commit and nothing else.
let src = process.env.CJCM_DIR && path.resolve(process.env.CJCM_DIR);
if (!src) {
  src = path.join(cache, 'cjcm');
  if (!fs.existsSync(src)) {
    fs.mkdirSync(cache, { recursive: true });
    run('git', ['clone', '--quiet', lock.repo, src]);
  }
  run('git', ['-C', src, 'fetch', '--quiet', 'origin']);
  run('git', ['-C', src, 'checkout', '--quiet', '--detach', lock.commit]);
}
const head = run('git', ['-C', src, 'rev-parse', 'HEAD']);
if (head !== lock.commit) {
  throw new Error(`engine checkout ${src} is at ${head}, cjcm.lock pins ${lock.commit}`);
}
if (run('git', ['-C', src, 'status', '--porcelain', '--untracked-files=no'])) {
  throw new Error(`engine checkout ${src} has uncommitted changes; the hash would not match the commit`);
}

const goVersion = run('go', ['env', 'GOVERSION']);
if (goVersion !== lock.go) {
  console.warn(`warning: building with ${goVersion}, cjcm.lock pins ${lock.go}; the wasm hash will differ from a pinned build`);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const wasmPath = path.join(cache, 'cjcm.wasm');
fs.mkdirSync(cache, { recursive: true });
run('go', ['build', '-trimpath', '-ldflags=-s -w -buildid=', '-o', wasmPath, './cmd/wasm'], {
  cwd: src, env: { ...process.env, GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0' },
});
const wasm = fs.readFileSync(wasmPath);
const sha256 = createHash('sha256').update(wasm).digest('hex');

// Static files, as written.
for (const f of fs.readdirSync(path.join(root, 'site'))) {
  fs.copyFileSync(path.join(root, 'site', f), path.join(dist, f));
}
fs.copyFileSync(path.join(run('go', ['env', 'GOROOT']), 'lib', 'wasm', 'wasm_exec.js'), path.join(dist, 'wasm_exec.js'));
fs.writeFileSync(path.join(dist, 'engine.js'), `self.CJCM_WASM=${JSON.stringify(wasm.toString('base64'))};\n`);

// The sample case and the templates come from the engine repository, so the
// page shows exactly what the repository's tests check.
const read = p => fs.readFileSync(path.join(src, p), 'utf8');
const data = {
  build: { commit: lock.commit, go: goVersion, sha256, repo: lock.repo.replace(/\.git$/, '') },
  // The sample case: two sources, the user's request AND the admin's approval.
  sample: {
    causes: read('examples/chain2/causes.csv'),
    changes: read('examples/chain2/changes.csv'),
    alerts: read('examples/chain2/alerts.jsonl'),
    request: {
      window_seconds: 60, grace_seconds: 0, trusted_producers: [], derived_types: [], root_types: [],
      single_actor_types: ['deposit', 'withdrawal'],
      chains: 'withdrawal.requested@user-api > withdrawal.approved@admin-console',
      check_amounts: true, require_cause_id: true,
    },
  },
  templates: { 'causes.csv': read('templates/causes.csv'), 'changes.csv': read('templates/changes.csv') },
};
fs.writeFileSync(path.join(dist, 'data.js'), `self.CJCM_DATA=${JSON.stringify(data)};\n`);

// Placeholders in the HTML.
const html = path.join(dist, 'index.html');
fs.writeFileSync(html, fs.readFileSync(html, 'utf8')
  .replaceAll('{{SHA256}}', sha256)
  .replaceAll('{{COMMIT}}', lock.commit)
  .replaceAll('{{COMMIT_SHORT}}', lock.commit.slice(0, 7))
  .replaceAll('{{GO}}', goVersion));

const manifest = fs.readdirSync(dist).sort().map(f => {
  const b = fs.readFileSync(path.join(dist, f));
  return `${createHash('sha256').update(b).digest('hex')}  ${f}`;
}).join('\n') + '\n';
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), manifest);

console.log(`engine ${lock.commit.slice(0, 7)} ${goVersion}  cjcm.wasm ${(wasm.length / 1e6).toFixed(2)} MB  sha256 ${sha256}`);
console.log(manifest);
