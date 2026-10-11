import { test, expect } from '@playwright/test';
import fs from 'node:fs';

// Every request the page makes, in order. The claim on the page is that after
// load there are none.
function recordRequests(page) {
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  return seen;
}

async function loaded(page) {
  await page.goto('/');
  await expect(page.locator('#engine-status')).toHaveText('Engine loaded. Nothing else will be fetched.');
  await expect(page.locator('#sample-result .match')).toBeVisible();
}

const sample = () => JSON.parse(fs.readFileSync(new URL('../dist/data.js', import.meta.url), 'utf8')
  .replace(/^self\.CJCM_DATA=/, '').replace(/;\s*$/, '')).sample;

const asFile = (f) => ({ name: f.name, mimeType: 'text/plain', buffer: Buffer.from(f.text) });

// causes is one file or a list, one per source; files already chosen are removed first.
async function dropFiles(page, causes, changes) {
  const remove = page.locator('#cause-sources .remove');
  while (await remove.count()) await remove.first().click();
  await page.setInputFiles('#file-causes', [causes].flat().map(asFile));
  await page.setInputFiles('#file-changes', asFile(changes));
}

const sampleFiles = (s) => [{ name: 'requests.csv', text: s.requests }, { name: 'approvals.csv', text: s.approvals }];

async function setSampleConfig(page) {
  await page.selectOption('#opt-window', '60');
  await page.fill('#opt-grace', '0');
  await page.check('#opt-amounts');
  await page.check('#opt-require-id');
  await page.locator('.advanced summary').click();
  await page.fill('#opt-producers', '');
  await page.fill('#opt-derived', '');
  await page.fill('#opt-roots', '');
  await page.fill('#opt-chains', 'withdrawal.requested@user-api > withdrawal.approved@admin-console');
  await page.fill('#opt-single', 'deposit, withdrawal');
}

const CHAIN_FINDINGS = [['reused_link', 'A-2'], ['broken_chain', 'A-3'], ['chain_mismatch', 'A-4'], ['untrusted_producer', 'A-5']];

async function expectChainFindings(rows) {
  for (const [type, id] of CHAIN_FINDINGS) await expect(rows.filter({ hasText: type })).toContainText(id);
  await expect(rows.filter({ hasText: 'A-1' })).toHaveCount(0);
}

test('sample case loads with its findings', async ({ page }) => {
  await loaded(page);
  await expectChainFindings(page.locator('#sample-result table.findings tbody tr'));
});

test('dropped sample files give the repository alerts, with no request after load', async ({ page }) => {
  const requests = recordRequests(page);
  await loaded(page);
  const atLoad = requests.length;

  const s = sample();
  await setSampleConfig(page);
  await dropFiles(page, sampleFiles(s), { name: 'changes.csv', text: s.changes });
  // Each file's source is guessed from its name.
  const sources = page.locator('#cause-sources select');
  await expect(sources.nth(0)).toHaveValue('withdrawal.requested@user-api');
  await expect(sources.nth(1)).toHaveValue('withdrawal.approved@admin-console');
  await page.click('#run');
  await expectChainFindings(page.locator('#result table.findings tbody tr'));
  await expect(page.locator('#result')).toContainText('requests.csv: 3 rows read of 3, as withdrawal.requested from user-api');

  const download = page.waitForEvent('download');
  await page.locator('#result').getByRole('button', { name: 'Download alerts.jsonl' }).click();
  const file = await (await download).path();
  expect(fs.readFileSync(file, 'utf8')).toBe(s.alerts);

  expect(requests.slice(atLoad).filter(u => !u.startsWith('blob:'))).toEqual([]);
});

test('runs offline after load', async ({ page, context }) => {
  await loaded(page);
  await context.setOffline(true);

  const s = sample();
  await setSampleConfig(page);
  await dropFiles(page, sampleFiles(s), { name: 'changes.csv', text: s.changes });
  await page.click('#run');
  await expectChainFindings(page.locator('#result table.findings tbody tr'));

  // The templates are a clean ledger.
  const t = await page.evaluate(() => self.CJCM_DATA.clean);
  await dropFiles(page, { name: 'causes.csv', text: t.causes }, { name: 'changes.csv', text: t.changes });
  await page.fill('#opt-producers', '');
  await page.fill('#opt-derived', '');
  await page.fill('#opt-roots', '');
  await page.fill('#opt-chains', 'deposit.detected@chain-indexer > deposit.credited@deposit-service\nwithdrawal.requested@user-api > withdrawal.approved@admin-console');
  await page.fill('#opt-single', 'deposit, withdrawal, deposit.credited, withdrawal.approved');
  await page.check('#opt-amounts');
  await page.click('#run');
  await expect(page.locator('#result .box.good')).toContainText('No findings.');
  await expect(page.locator('#result .box.warn')).toHaveCount(0);

  // The same templates read as single-source causes: warned.
  await page.fill('#opt-chains', '');
  await page.click('#run');
  await expect(page.locator('#result .box.warn')).toContainText('Every cause here comes from a single source');
});

test('one txid credited three times in one window is found', async ({ page }) => {
  await loaded(page);
  const causes = 'id,type,account,amount,time\n' +
    ['05', '20', '35'].map(s => `TX-501,deposit,acct-7,1000,2026-09-01T10:00:${s}Z`).join('\n') + '\n';
  const changes = 'account,delta,time\n' +
    ['05', '20', '35'].map(s => `acct-7,1000,2026-09-01T10:00:${s}Z`).join('\n') + '\n';
  await dropFiles(page, { name: 'causes.csv', text: causes }, { name: 'changes.csv', text: changes });
  await page.click('#run');
  const rows = page.locator('#result table.findings tbody tr');
  await expect(rows.filter({ hasText: 'reused_cause' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'reused_cause' })).toContainText('TX-501');
  await expect(rows.filter({ hasText: 'reused_cause' })).toContainText('2,000');
});

test('the page cannot open a connection', async ({ page }) => {
  await loaded(page);
  const blocked = await page.evaluate(async () => {
    try { await fetch('/index.html'); return false; } catch { return true; }
  });
  expect(blocked).toBe(true);
});

test('bad rows are reported by line, and a missing column can be mapped', async ({ page }) => {
  await loaded(page);
  const causes = 'id,type,account,amount,time,producer\n' +
    'D-1,deposit,u-1,100,2026-09-01T14:02:11Z,svc\n' +
    'D-2,deposit,u-1,100,yesterday,svc\n';
  const changes = 'holder,delta,time\nu-1,100,2026-09-01T14:02:11Z\n';
  await dropFiles(page, { name: 'causes.csv', text: causes }, { name: 'changes.csv', text: changes });
  await page.click('#run');
  const issues = page.locator('#result .issues');
  await expect(issues).toContainText('causes.csv, line 3: time is not a date: "yesterday". Expected ISO 8601');
  await expect(issues).toContainText('Changes: column account not found. Found: holder, delta, time. Pick one.');

  await page.selectOption('select[data-file="Changes"][data-field="account"]', 'holder');
  await expect(page.locator('#result .issues')).not.toContainText('column account not found');
  await expect(page.locator('#result .stats').first()).toContainText('Read 1 cause of 2 rows and 1 change of 1 rows');
});

test('the sample button loads three files, two of them causes', async ({ page }) => {
  await loaded(page);
  await page.click('#load-sample');
  await expect(page.locator('#cause-sources li')).toHaveCount(2);
  await expect(page.locator('#name-changes')).toContainText('changes.csv');
  await expectChainFindings(page.locator('#result table.findings tbody tr'));
});

test('a causes file without a type column needs its source', async ({ page }) => {
  await loaded(page);
  const s = sample();
  await page.setInputFiles('#file-causes', [...sampleFiles(s), { name: 'changes.csv', text: s.changes }].map(asFile));
  // The ledger export dropped with them goes to Changes.
  await expect(page.locator('#cause-sources li')).toHaveCount(2);
  await expect(page.locator('#name-changes')).toContainText('changes.csv');
  await page.locator('#cause-sources select').nth(1).selectOption('');
  await page.click('#run');
  await expect(page.locator('#result .issues')).toContainText('approvals.csv: column type not found');
});
