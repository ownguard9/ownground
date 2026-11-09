// XSS regression verifier for the OwnGround v4 site remediation
// (audit finding 1). Serves site/ locally and drives it in the
// Playwright headless shell with MALICIOUS ids/names stubbed via RPC:
// a community id that breaks out of a JS string, a campaign id with a
// quote, names/descriptions/sources/references carrying <script> and
// onerror payloads. Asserts no alert/dialog fires, no script executes,
// the payloads render as harmless text, links are built with
// encodeURIComponent, and no inline event handler exists anywhere in
// the rendered DOM. Also exercises the v4 asset actions end to end
// against a stubbed wallet: attest bond 0.1 + 10% of the claim,
// dispute bond 0.05 + 0.01 storage, auto-resolve of an expired dispute,
// and claiming a failed payout.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const SHELL = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const SITE = '/home/hatch/workspace/commonhold/site';
const PORT = 8144;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: SITE, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const browser = await puppeteer.launch({
  executablePath: SHELL,
  args: ['--no-sandbox', '--disable-gpu'],
});

const EVIL_COMMUNITY_ID = "x');alert(document.domain);//";
const EVIL_CAMPAIGN_ID = "camp');alert(1);//";
const DAY_NS = 86400000000000;
const nowNs = () => BigInt(Date.now()) * 1000000n;

// Shared stub state, read by the fetch override from localStorage so
// each page can carry its own fixture.
function installStub() {
  const realFetch = window.fetch.bind(window);
  window.__alerts = [];
  window.alert = (m) => { window.__alerts.push(String(m)); };
  const enc = (v) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
  const ok = (v) => Promise.resolve(new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 'q', result: { result: enc(v) } }),
    { headers: { 'Content-Type': 'application/json' } }));
  const err = (m) => Promise.resolve(new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 'q', error: { message: m } }),
    { headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, opts) => {
    const u = String(url);
    if (!u.includes('rpc.testnet')) return realFetch(url, opts);
    let body = {};
    try { body = JSON.parse(opts && opts.body ? opts.body : '{}'); } catch (_) { /* ignore */ }
    if (body.method === 'query' && body.params && body.params.request_type === 'call_function') {
      const m = body.params.method_name;
      let args = {};
      try { args = JSON.parse(atob(body.params.args_base64)); } catch (_) { /* ignore */ }
      // Fixtures live in localStorage so they survive navigation; the
      // fetch override itself is installed on every document.
      let fx = {};
      try { fx = JSON.parse(localStorage.getItem('__ogXssFixtures') || '{}'); } catch (_) { fx = {}; }
      if (m === 'list_communities') return ok(fx.listCommunities || []);
      if (m === 'get_community') return ok(fx.community || null);
      if (m === 'get_treasury') return ok(fx.treasury || {});
      if (m === 'get_campaign') return ok((fx.campaigns || {})[args.campaign_id] || null);
      if (m === 'get_policies') return ok(fx.policies || { amendments: [] });
      if (m === 'get_asset') return ok(fx.asset || null);
      if (m === 'get_revenue') return ok(fx.revenue || []);
      if (m === 'get_expenses') return ok(fx.expenses || []);
      if (m === 'get_distributions') return ok(fx.distributions || []);
      if (m === 'get_last_proposal_id') return ok(0);
      if (m === 'get_policy' || m === 'get_proposals') return err('stub: dao read failed');
      return err('stub: no such method ' + m);
    }
    if (body.method === 'query' && body.params && body.params.request_type === 'view_account') {
      return err("account doesn't exist");
    }
    return err('stub: no such method');
  };
}

const zeroTreasury = {
  treasury: '0', locked: '0', total_expenses: '0', retained: '0',
  distributable: '0', spendable: '0', total_contributions: '0',
  total_payouts: '0', total_bonds_held: '0',
};
const basePolicy = { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 1000 };
const baseSpending = { max_single_expense: '0', min_treasury_reserve: '0', allowed_categories: ['ops'] };
const baseActivity = { capital_per_near: 1, work_per_revenue_record: 1, work_per_revenue_near: 1 };

async function alerts(page) {
  return page.evaluate(() => window.__alerts || []);
}
async function noInlineHandlers(page) {
  return page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('*').forEach((n) => {
      for (const a of n.attributes || []) {
        if (a.name.toLowerCase().startsWith('on')) bad.push(n.tagName + '[' + a.name + ']');
      }
    });
    return bad;
  });
}

try {
  // ---------- Page 0: escapeHtml unit check + index page ----------
  const page0 = await browser.newPage();
  const dialogs0 = [];
  page0.on('dialog', (d) => { dialogs0.push(d.message()); d.dismiss().catch(() => {}); });
  page0.on('pageerror', (e) => console.log('PAGE0 ERROR:', String(e).slice(0, 200)));
  await page0.evaluateOnNewDocument(installStub);
  await page0.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  const esc = await page0.evaluate(() => ({
    apos: escapeHtml("a'b"),
    all: escapeHtml(`a'b"c<d>&e`),
    noHandlers: [...document.querySelectorAll('*')].filter((n) =>
      [...(n.attributes || [])].some((a) => a.name.toLowerCase().startsWith('on'))).length,
  }));
  check('escapeHtml escapes apostrophes', esc.apos === 'a&#39;b', esc.apos);
  check('escapeHtml escapes all five characters', esc.all === 'a&#39;b&quot;c&lt;d&gt;&amp;e', esc.all);
  check('index page has no inline event handlers', esc.noHandlers === 0, String(esc.noHandlers));
  check('index page fires no alert', (await alerts(page0)).length === 0 && dialogs0.length === 0);
  await page0.close();

  // ---------- Page 1: communities list with a malicious id ----------
  const page1 = await browser.newPage();
  const dialogs1 = [];
  page1.on('dialog', (d) => { dialogs1.push(d.message()); d.dismiss().catch(() => {}); });
  page1.on('pageerror', (e) => console.log('PAGE1 ERROR:', String(e).slice(0, 200)));
  await page1.evaluateOnNewDocument(installStub);
  await page1.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page1.evaluate(({ id, basePolicy, baseSpending, baseActivity, zeroTreasury }) => {
    localStorage.setItem('__ogXssFixtures', JSON.stringify({
      listCommunities: [id],
      community: {
        id, name: '<script>alert("xss-name")</script>',
        description: '"><img src=x onerror=alert(2)>',
        dao_id: 'evil-dao.testnet', members: ['alice.testnet'],
        campaign_ids: [], asset_ids: [], total_revenue: '0', total_payouts: '0',
        total_contributions: '0', policy: basePolicy, spending_policy: baseSpending,
        activity_policy: baseActivity, capital_points: [],
        dispute_window_ns: 604800000000000, timelock_ns: 259200000000000,
      },
      treasury: zeroTreasury,
    }));
  }, { id: EVIL_COMMUNITY_ID, basePolicy, baseSpending, baseActivity, zeroTreasury });
  await page1.goto(`${BASE}/communities.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  const list = await page1.evaluate((id) => {
    const listEl = document.getElementById('list');
    const a = listEl ? listEl.querySelector('a') : null;
    return {
      text: listEl ? listEl.textContent : '',
      html: listEl ? listEl.innerHTML : '',
      href: a ? a.getAttribute('href') : null,
      dataId: a ? a.getAttribute('data-community-id') : null,
      expectedHref: 'community.html?id=' + encodeURIComponent(id),
      onclickCount: document.querySelectorAll('[onclick]').length,
      inlineHandlers: [...document.querySelectorAll('*')].filter((n) =>
        [...(n.attributes || [])].some((x) => x.name.toLowerCase().startsWith('on'))).length,
    };
  }, EVIL_COMMUNITY_ID);
  check('malicious community id rides in the data attribute as plain text, never as code', list.dataId === EVIL_COMMUNITY_ID, list.dataId);
  check('malicious name renders as text, not a script element', list.text.includes('<script>alert("xss-name")</script>') && !list.html.includes('<script>alert'), list.html.slice(0, 200));
  check('malicious description renders escaped, no live img tag', list.text.includes('"><img src=x onerror=alert(2)>') && !list.html.includes('<img src=x onerror'), list.html.slice(0, 200));
  check('community link href is encodeURIComponent built', list.href === list.expectedHref, list.href);
  check('communities page has no onclick attributes', list.onclickCount === 0, String(list.onclickCount));
  check('communities page has no inline event handlers at all', list.inlineHandlers === 0, String(list.inlineHandlers));
  check('communities page fires no alert', (await alerts(page1)).length === 0 && dialogs1.length === 0, JSON.stringify(await alerts(page1)));
  // The delegated click caches the row: prevent the navigation, click,
  // and check the session cache was written for the malicious id.
  const cached = await page1.evaluate((id) => {
    const a = document.querySelector('#list a');
    a.addEventListener('click', (e) => e.preventDefault(), { once: true });
    a.click();
    try {
      const raw = sessionStorage.getItem('ownground-community-' + id);
      return raw ? JSON.parse(raw).c.name : null;
    } catch (_) { return null; }
  }, EVIL_COMMUNITY_ID);
  check('delegated list click caches the malicious row without executing it', cached === '<script>alert("xss-name")</script>', String(cached));
  check('still no alert after clicking the malicious row', (await alerts(page1)).length === 0 && dialogs1.length === 0);
  await page1.close();

  // ---------- Page 2: community page with a malicious campaign id ----------
  const page2 = await browser.newPage();
  const dialogs2 = [];
  page2.on('dialog', (d) => { dialogs2.push(d.message()); d.dismiss().catch(() => {}); });
  page2.on('pageerror', (e) => console.log('PAGE2 ERROR:', String(e).slice(0, 200)));
  await page2.evaluateOnNewDocument(installStub);
  await page2.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page2.evaluate((evilCamp) => {
    const DAY = 86400000000000;
    const nowNs = BigInt(Date.now()) * 1000000n;
    localStorage.setItem('__ogXssFixtures', JSON.stringify({
      community: {
        id: 'evil-club', name: 'Evil <b>Club</b>', description: 'x',
        dao_id: 'evil-dao.testnet',
        members: ['alice.testnet', 'bob.testnet', 'carol.testnet'],
        campaign_ids: [evilCamp, 'funded-camp'], asset_ids: [],
        policy: { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 1000 },
        spending_policy: { max_single_expense: '0', min_treasury_reserve: '0', allowed_categories: ['ops'] },
        activity_policy: { capital_per_near: 1, work_per_revenue_record: 1, work_per_revenue_near: 1 },
        capital_points: [], dispute_window_ns: 7 * DAY, timelock_ns: 3 * DAY,
        total_contributions: '0', total_revenue: '0', total_payouts: '0',
      },
      treasury: { treasury: '0', locked: '0', total_expenses: '0', retained: '0', distributable: '0', spendable: '0', total_contributions: '0', total_payouts: '0', total_bonds_held: '0' },
      campaigns: {
        [evilCamp]: {
          id: evilCamp, asset_name: '<svg onload=alert(3)>', category: 'energy',
          target: '10000000000000000000000000', raised: '0', status: 'Open',
          deadline: (nowNs + BigInt(7 * DAY)).toString(), contributors: [],
        },
        'funded-camp': {
          id: 'funded-camp', asset_name: 'Generator', category: 'energy',
          target: '10000000000000000000000000', raised: '10000000000000000000000000', status: 'Funded',
          deadline: (nowNs + BigInt(7 * DAY)).toString(),
          contributors: [['alice.testnet', '5000000000000000000000000'], ['bob.testnet', '5000000000000000000000000']],
        },
      },
      policies: { amendments: [] },
      distributions: [],
    }));
  }, EVIL_CAMPAIGN_ID);
  await page2.goto(`${BASE}/community.html?id=evil-club`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  await page2.evaluate(() => {
    walletAccountId = 'alice.testnet';
    window.__walletCalls = [];
    window.walletCall = async (contractId, method, args, deposit, gas) => {
      window.__walletCalls.push({ contractId, method, args, deposit, gas });
      return {};
    };
    return loadCommunity();
  });
  await new Promise((r) => setTimeout(r, 2500));
  const comm = await page2.evaluate((evilCamp) => {
    const camps = document.getElementById('campaigns');
    return {
      text: camps ? camps.textContent : '',
      html: camps ? camps.innerHTML : '',
      hasMaliciousNameAsText: camps ? camps.textContent.includes('<svg onload=alert(3)>') : false,
      hasLiveSvg: camps ? camps.innerHTML.includes('<svg onload') : false,
      onclickCount: document.querySelectorAll('[onclick]').length,
      inlineHandlers: [...document.querySelectorAll('*')].filter((n) =>
        [...(n.attributes || [])].some((x) => x.name.toLowerCase().startsWith('on'))).length,
      allocSumBefore: document.getElementById('allocSum-funded-camp')
        ? document.getElementById('allocSum-funded-camp').textContent : null,
    };
  }, EVIL_CAMPAIGN_ID);
  check('malicious campaign name renders as text', comm.hasMaliciousNameAsText, comm.text.slice(0, 160));
  check('malicious campaign name does not become a live element', comm.hasLiveSvg === false);
  check('community page has no onclick attributes', comm.onclickCount === 0, String(comm.onclickCount));
  check('community page has no inline event handlers at all', comm.inlineHandlers === 0, String(comm.inlineHandlers));
  check('allocation total starts at 10000', comm.allocSumBefore === '10000', comm.allocSumBefore);
  // Delegated allocation input: changing a share updates the live sum.
  await page2.evaluate(() => {
    const inp = document.querySelector('input[data-alloc]');
    inp.value = '6000';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const allocSum = await page2.evaluate(() => document.getElementById('allocSum-funded-camp').textContent);
  check('delegated allocation input updates the live sum', allocSum === '11000', allocSum);
  // Click every campaign button for the malicious id: contribute (empty
  // amount), refund, cancel (DAO proposal). None may execute script.
  await page2.evaluate((evilCamp) => {
    const btns = [...document.querySelectorAll('#campaigns button[data-campaign-id]')]
      .filter((b) => b.getAttribute('data-campaign-id') === evilCamp);
    btns.forEach((b) => b.click());
  }, EVIL_CAMPAIGN_ID);
  await new Promise((r) => setTimeout(r, 2000));
  const commCalls = await page2.evaluate(() => window.__walletCalls || []);
  check('refund on the malicious campaign reaches the wallet as a plain refund call', commCalls.some((c) => c.method === 'refund' && c.args.campaign_id === "camp');alert(1);//"), JSON.stringify(commCalls));
  check('cancel on the malicious campaign creates a DAO proposal, not script', commCalls.some((c) => c.method === 'add_proposal'), JSON.stringify(commCalls));
  check('community page fires no alert after clicking malicious campaign buttons', (await alerts(page2)).length === 0 && dialogs2.length === 0, JSON.stringify(await alerts(page2)));
  await page2.close();

  // ---------- Page 3: asset page, malicious revenue + v4 actions ----------
  const page3 = await browser.newPage();
  const dialogs3 = [];
  page3.on('dialog', (d) => { dialogs3.push(d.message()); d.dismiss().catch(() => {}); });
  page3.on('pageerror', (e) => console.log('PAGE3 ERROR:', String(e).slice(0, 200)));
  await page3.evaluateOnNewDocument(installStub);
  await page3.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page3.evaluate(() => {
    const DAY = 86400000000000;
    const nowNs = BigInt(Date.now()) * 1000000n;
    localStorage.setItem('__ogXssFixtures', JSON.stringify({
      asset: {
        id: 'asset-1', community_id: 'comm-1', name: '<img src=x onerror=alert(9)>',
        category: 'energy', seller: 'seller.testnet', status: 'Active',
        value: '10000000000000000000000000', revenue_onchain: '0',
        expenses_total: '0', distributed_total: '0', epoch: 0,
        work_points: [], expense_count: 0, bond_forfeits: '0', allocations: [],
      },
      community: {
        id: 'comm-1', dao_id: 'dao.testnet',
        members: ['alice.testnet', 'bob.testnet', 'carol.testnet'],
        policy: { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 1000 },
        spending_policy: { max_single_expense: '0', min_treasury_reserve: '0', allowed_categories: ['ops'] },
        activity_policy: { capital_per_near: 1, work_per_revenue_record: 1, work_per_revenue_near: 1 },
        capital_points: [], dispute_window_ns: 7 * DAY, timelock_ns: 3 * DAY,
        campaign_ids: [], asset_ids: ['asset-1'],
        total_contributions: '0', total_revenue: '0', total_payouts: '0',
      },
      treasury: { treasury: '0', locked: '0', total_expenses: '0', retained: '0', distributable: '0', spendable: '0', total_contributions: '0', total_payouts: '0', total_bonds_held: '0' },
      revenue: [
        { id: 0, amount: '1000000000000000000000000', source: "';alert(4);//", reference: '<img src=x onerror=alert(5)>', status: 'Pending', recorded_at: '0', recorded_by: 'alice.testnet', attestor: null, verified_at: null, points_awarded: 0, epoch: 0, bond_attestor: null, bond_status: null },
        { id: 1, amount: '2000000000000000000000000', source: 'rent', reference: 'inv-2', status: 'Verified', recorded_at: '0', recorded_by: 'alice.testnet', attestor: 'carol.testnet', verified_at: (nowNs - BigInt(DAY)).toString(), points_awarded: 2, epoch: 0, bond_attestor: 'carol.testnet', bond_status: 'Held' },
        { id: 2, amount: '500000000000000000000000', source: 'rent2', reference: 'inv-3', status: 'Disputed', recorded_at: '0', recorded_by: 'alice.testnet', attestor: 'carol.testnet', verified_at: (nowNs - BigInt(10 * DAY)).toString(), disputed_at: (nowNs - BigInt(8 * DAY)).toString(), points_awarded: 1, epoch: 0, bond_attestor: 'carol.testnet', bond_status: 'Held' },
      ],
      expenses: [
        { amount: '100000000000000000000000', recipient: 'bob.testnet', description: '"><script>alert(6)</script>', category: 'ops', recorded_at: '0' },
      ],
      distributions: [
        { id: 0, asset_id: 'asset-1', distributed: '1000000000000000000000000', ownership_payouts: [['alice.testnet', '500000000000000000000000']], activity_payouts: [], member_total: '500000000000000000000000', retention: '0', maintenance: '0', activity_pool: '0', ownership_pool: '500000000000000000000000', total_work_points: 0, unpaid: ['bob.testnet'], executed_at: '0' },
      ],
    }));
  });
  await page3.goto(`${BASE}/asset.html?id=asset-1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  await page3.evaluate(() => {
    walletAccountId = 'bob.testnet';
    window.__walletCalls = [];
    window.walletCall = async (contractId, method, args, deposit, gas) => {
      window.__walletCalls.push({ contractId, method, args, deposit, gas });
      return {};
    };
    return loadAsset();
  });
  await new Promise((r) => setTimeout(r, 2500));
  const asset = await page3.evaluate(() => {
    const rev = document.getElementById('revenueList');
    const dist = document.getElementById('distributionList');
    const exp = document.getElementById('expenseList');
    return {
      revText: rev ? rev.textContent : '',
      revHtml: rev ? rev.innerHTML : '',
      distText: dist ? dist.textContent : '',
      expText: exp ? exp.textContent : '',
      onclickCount: document.querySelectorAll('[onclick]').length,
      inlineHandlers: [...document.querySelectorAll('*')].filter((n) =>
        [...(n.attributes || [])].some((x) => x.name.toLowerCase().startsWith('on'))).length,
    };
  });
  check('malicious revenue source renders as text', asset.revText.includes("';alert(4);//"), asset.revText.slice(0, 200));
  check('malicious revenue reference renders as text, no live img', asset.revText.includes('<img src=x onerror=alert(5)>') && !asset.revHtml.includes('<img src=x onerror'), asset.revHtml.slice(0, 200));
  check('malicious expense description renders as text', asset.expText.includes('"><script>alert(6)</script>'), asset.expText.slice(0, 160));
  check('attested entry is labelled member-attested claim, never verified', asset.revText.includes('Member-attested claim') && !asset.revText.includes('Verified by attestation'), asset.revText.slice(0, 300));
  check('attest button shows the amount-scaled bond (0.2 NEAR for a 1 NEAR claim)', asset.revText.includes('Attest (0.200 NEAR bond)'), asset.revText.slice(0, 300));
  check('dispute UI shows the 0.05 NEAR bond', asset.revText.includes('0.05 NEAR bond'), asset.revText.slice(0, 300));
  check('expired dispute shows its auto-resolve time and action', asset.revText.includes('Auto-resolve expired dispute') && asset.revText.includes('can now be auto-resolved'), asset.revText.slice(0, 400));
  check('failed payout shows a Claim payout button for the wallet', asset.distText.includes('Claim payout'), asset.distText.slice(0, 300));
  check('asset page has no onclick attributes', asset.onclickCount === 0, String(asset.onclickCount));
  check('asset page has no inline event handlers at all', asset.inlineHandlers === 0, String(asset.inlineHandlers));
  check('asset page fires no alert on load', (await alerts(page3)).length === 0 && dialogs3.length === 0, JSON.stringify(await alerts(page3)));
  // Click each v4 action and check the exact wallet call it makes.
  await page3.evaluate(() => {
    const click = (sel) => { const b = document.querySelector(sel); if (b) b.click(); };
    click('button[data-action="attest"]');
  });
  await new Promise((r) => setTimeout(r, 800));
  await page3.evaluate(() => {
    const click = (sel) => { const b = document.querySelector(sel); if (b) b.click(); };
    click('button[data-action="dispute"]');
  });
  await new Promise((r) => setTimeout(r, 800));
  await page3.evaluate(() => {
    const click = (sel) => { const b = document.querySelector(sel); if (b) b.click(); };
    click('button[data-action="auto-resolve"]');
  });
  await new Promise((r) => setTimeout(r, 800));
  await page3.evaluate(() => {
    const click = (sel) => { const b = document.querySelector(sel); if (b) b.click(); };
    click('button[data-action="claim-payout"]');
  });
  await new Promise((r) => setTimeout(r, 800));
  const assetCalls = await page3.evaluate(() => window.__walletCalls || []);
  const find = (m) => assetCalls.find((c) => c.method === m);
  check('attest attaches bond + storage: 0.2 NEAR bond + 0.01 for a 1 NEAR claim', (() => {
    const c = find('attest_revenue');
    return !!c && c.args.entry_id === 0 && c.deposit === '210000000000000000000000';
  })(), JSON.stringify(find('attest_revenue')));
  check('dispute attaches 0.05 NEAR bond + 0.01 NEAR storage', (() => {
    const c = find('dispute_revenue');
    return !!c && c.args.entry_id === 1 && c.deposit === '60000000000000000000000';
  })(), JSON.stringify(find('dispute_revenue')));
  check('auto-resolve calls resolve_dispute_expired', (() => {
    const c = find('resolve_dispute_expired');
    return !!c && c.args.entry_id === 2 && c.args.asset_id === 'asset-1';
  })(), JSON.stringify(find('resolve_dispute_expired')));
  check('claim payout calls claim_failed_payout with the distribution id', (() => {
    const c = find('claim_failed_payout');
    return !!c && c.args.distribution_id === 0;
  })(), JSON.stringify(find('claim_failed_payout')));
  check('asset page fires no alert after clicking every action', (await alerts(page3)).length === 0 && dialogs3.length === 0, JSON.stringify(await alerts(page3)));
  await page3.close();

  // ---------- Page 4: create page has no inline handlers ----------
  const page4 = await browser.newPage();
  page4.on('pageerror', (e) => console.log('PAGE4 ERROR:', String(e).slice(0, 200)));
  await page4.evaluateOnNewDocument(installStub);
  await page4.goto(`${BASE}/create.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2000));
  const createHandlers = await page4.evaluate(() => [...document.querySelectorAll('*')].filter((n) =>
    [...(n.attributes || [])].some((x) => x.name.toLowerCase().startsWith('on'))).length);
  check('create page has no inline event handlers', createHandlers === 0, String(createHandlers));
  await page4.close();
} catch (e) {
  console.log('VERIFIER CRASHED:', e && e.stack ? e.stack.slice(0, 1000) : String(e));
  failures++;
} finally {
  await browser.close().catch(() => {});
  server.kill();
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
