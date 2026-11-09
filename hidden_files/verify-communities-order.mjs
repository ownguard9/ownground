// One-off check: the communities list shows the pinned showcase first,
// then newest first. Serves site/ locally, stubs RPC (the sandbox cannot
// reach live RPC), and asserts the rendered card order after the
// HIDDEN_COMMUNITIES filter. Run from /tmp/og-test/ (puppeteer-core
// lives there; ESM bare imports resolve from the file's own directory).
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const SHELL = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const SITE = '/home/hatch/workspace/commonhold/site';
const PORT = 8141;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: SITE, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const browser = await puppeteer.launch({ executablePath: SHELL, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGE ERROR:', String(e).slice(0, 200)); });

// Stub RPC: list_communities in creation order (oldest first), as onchain.
await page.evaluateOnNewDocument(() => {
  const realFetch = window.fetch.bind(window);
  const enc = (v) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
  const ids = ['lagos-energy-cooperative', 'lagos-energy-cooperative-2', 'lagos-energy-cooperative-3', 'house-cooperative', 'phynic-club', 'oceanic-group'];
  const names = {
    'lagos-energy-cooperative-3': 'Lagos Energy Cooperative',
    'house-cooperative': 'House cooperative',
    'phynic-club': 'Phynic club',
    'oceanic-group': 'Oceanic group',
  };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('rpc.testnet')) {
      let body = {};
      try { body = JSON.parse(opts && opts.body ? opts.body : '{}'); } catch (_) { /* ignore */ }
      if (body.method === 'query' && body.params && body.params.request_type === 'call_function') {
        const m = body.params.method_name;
        let args = {};
        try { args = JSON.parse(atob(body.params.args_base64)); } catch (_) { /* ignore */ }
        if (m === 'list_communities') {
          return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', result: { result: enc(ids) } }), { headers: { 'Content-Type': 'application/json' } }));
        }
        if (m === 'get_community') {
          const c = { id: args.community_id, name: names[args.community_id] || args.community_id, description: '', dao_id: 'vehicle-coop.testnet', members: ['a.testnet'], policy: { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 1000 }, spending_policy: { max_single_expense: '0', min_treasury_reserve: '0', allowed_categories: [] }, activity_policy: { capital_per_near: 1, work_per_revenue_record: 1, work_per_revenue_near: 1 }, capital_points: [], dispute_window_ns: 604800000000000, timelock_ns: 259200000000000, campaign_ids: [], asset_ids: [], total_contributions: '0', total_revenue: '0', total_acquisitions: '0', total_payouts: '0' };
          return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', result: { result: enc(c) } }), { headers: { 'Content-Type': 'application/json' } }));
        }
        if (m === 'get_treasury') {
          return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', result: { result: enc({ treasury: '0', locked: '0' }) } }), { headers: { 'Content-Type': 'application/json' } }));
        }
      }
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', error: { message: 'stub: no such method' } }), { headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch(url, opts);
  };
});

await page.goto(`${BASE}/communities.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));
const order = await page.evaluate(() => {
  const links = Array.from(document.querySelectorAll('#list a'));
  return links.map((a) => a.textContent.trim());
});
console.log('rendered order:', JSON.stringify(order));
check('pinned showcase (Lagos Energy Cooperative) is first', order[0] === 'Lagos Energy Cooperative', order[0]);
check('newest community (Oceanic group) is second, after the pin', order[1] === 'Oceanic group', order[1]);
check('next newest (Phynic club) is third', order[2] === 'Phynic club', order[2]);
check('oldest non-pinned community (House cooperative) is last', order[order.length - 1] === 'House cooperative', order[order.length - 1]);
check('hidden demo runs are not listed', !order.some((n) => n === 'lagos-energy-cooperative' || n === 'lagos-energy-cooperative-2'), order.join(', '));
check('4 communities listed', order.length === 4, String(order.length));
check('no page errors', pageErrors === 0, pageErrors + ' page errors');

await browser.close();
server.kill();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECKS FAILED');
process.exit(failures === 0 ? 0 : 1);
