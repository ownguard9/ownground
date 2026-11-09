// Local headless verification for the OwnGround create flow:
// DAO creation via the factory + post-create redirect + banner placement.
// Serves site/ locally, drives it in the Playwright headless shell.
// NOTE: sandboxed Chromium cannot reach live RPC, so all RPC calls are
// stubbed (fetch override). The onchain proof for the factory call lives
// in scripts/create-dao-factory-test.mjs + dao-factory-test-log.json.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const SHELL = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const SITE = '/home/hatch/workspace/commonhold/site';
const PORT = 8137;
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

// ---------- Test A: page renders, novice path, unit checks ----------
// The novice path shows no DAO choice: the shared account is set up
// automatically, and the only DAO mention is the small advanced link.
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR:', String(e).slice(0, 300)));
await page.goto(`${BASE}/create.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));

const dom = await page.evaluate(() => {
  const btn = document.getElementById('createBtn');
  const status = document.getElementById('pageStatus');
  const daoName = document.getElementById('cDaoName');
  const daoIdPreview = document.getElementById('daoIdPreview');
  const newPanel = document.getElementById('daoNewPanel');
  const autoPanel = document.getElementById('daoAutoPanel');
  const existingPanel = document.getElementById('daoExistingPanel');
  const radios = document.querySelectorAll('input[name="daoChoice"]');
  const daoInput = document.getElementById('cDao');
  const advLink = document.getElementById('useExistingDaoLink');
  const depositNote = newPanel ? newPanel.textContent : '';
  const rows = Array.from(document.querySelectorAll('.dao-option')).map((row) => {
    const input = row.querySelector('input[type="radio"]');
    const span = row.querySelector('span');
    const ir = input ? input.getBoundingClientRect() : null;
    const sr = span ? span.getBoundingClientRect() : null;
    const cs = window.getComputedStyle(row);
    return {
      value: input ? input.value : null,
      label: span ? span.textContent.trim() : null,
      checked: input ? input.checked : false,
      selected: row.classList.contains('selected'),
      rowDisplay: cs.display,
      fontWeight: cs.fontWeight,
      background: cs.backgroundColor,
      inputLeft: ir ? ir.left : null,
      inputWidth: ir ? ir.width : null,
      inputCentreY: ir ? ir.top + ir.height / 2 : null,
      spanLeft: sr ? sr.left : null,
      spanCentreY: sr ? sr.top + sr.height / 2 : null,
    };
  });
  return {
    h1Text: document.querySelector('main h1') ? document.querySelector('main h1').textContent.trim() : null,
    statusUnderButton: btn && status ? btn.nextElementSibling === status : false,
    statusInPanel: status ? !!status.closest('.panel') : false,
    choiceValues: Array.from(radios).map((r) => r.value),
    choiceRows: rows,
    newPanelVisible: newPanel ? newPanel.style.display !== 'none' : false,
    autoPanelHidden: autoPanel ? autoPanel.style.display === 'none' : false,
    existingPanelHidden: existingPanel ? existingPanel.style.display === 'none' : false,
    daoInputPresent: !!daoInput,
    daoInputHidden: daoInput ? daoInput.closest('#daoExistingPanel').style.display === 'none' : false,
    advLinkVisible: advLink ? advLink.style.display !== 'none' : false,
    advLinkText: advLink ? advLink.textContent : null,
    depositNoteHas10: depositNote.includes('10 NEAR'),
    depositNoteNotFee: depositNote.toLowerCase().includes('not a fee'),
    depositNoteHas2Approve: depositNote.includes('2 of them must approve'),
    daoNamePlaceholder: daoName ? daoName.placeholder : null,
    previewText: daoIdPreview ? daoIdPreview.textContent : null,
    mode: daoMode(),
  };
});
check('H1 is "Create a community"', dom.h1Text === 'Create a community', dom.h1Text);
check('Status sits directly under the Create community button', dom.statusUnderButton === true);
check('Status is inside the form panel', dom.statusInPanel === true);
check('Two DAO choice options, create and auto', JSON.stringify(dom.choiceValues) === JSON.stringify(['create', 'auto']), JSON.stringify(dom.choiceValues));
check('First option reads "Create a new DAO for this community"', dom.choiceRows[0] && dom.choiceRows[0].label === 'Create a new DAO for this community', dom.choiceRows[0] ? dom.choiceRows[0].label : null);
check('Second option reads "I don\'t have a DAO address"', dom.choiceRows[1] && dom.choiceRows[1].label === "I don't have a DAO address", dom.choiceRows[1] ? dom.choiceRows[1].label : null);
check('Each option is a flex row', dom.choiceRows.every((r) => r.rowDisplay === 'flex'), JSON.stringify(dom.choiceRows.map((r) => r.rowDisplay)));
check('Radio sits inline left of its label, on the same line', dom.choiceRows.every((r) => r.inputLeft < r.spanLeft && Math.abs(r.inputCentreY - r.spanCentreY) <= 12), JSON.stringify(dom.choiceRows.map((r) => [r.inputLeft, r.spanLeft, r.inputCentreY, r.spanCentreY])));
check('Radio is narrow, not stretched full width', dom.choiceRows.every((r) => r.inputWidth > 0 && r.inputWidth < 40), JSON.stringify(dom.choiceRows.map((r) => r.inputWidth)));
check('Create option is selected by default', dom.choiceRows[0] && dom.choiceRows[0].checked && dom.choiceRows[0].selected);
check('Selected row label is bold', dom.choiceRows[0] && Number(dom.choiceRows[0].fontWeight) >= 700, dom.choiceRows[0] ? dom.choiceRows[0].fontWeight : null);
check('Selected row has a highlighted background', dom.choiceRows[0] && dom.choiceRows[0].background !== 'rgba(0, 0, 0, 0)' && dom.choiceRows[0].background !== 'transparent', dom.choiceRows[0] ? dom.choiceRows[0].background : null);
check('Unselected row is not bold or highlighted', dom.choiceRows[1] && !dom.choiceRows[1].selected && Number(dom.choiceRows[1].fontWeight) < 700 && (dom.choiceRows[1].background === 'rgba(0, 0, 0, 0)' || dom.choiceRows[1].background === 'transparent'), JSON.stringify(dom.choiceRows[1]));
check('New shared account panel visible by default', dom.newPanelVisible === true);
check('Auto panel hidden by default', dom.autoPanelHidden === true);
check('Existing DAO panel hidden by default', dom.existingPanelHidden === true);
check('Manual DAO account input still present in the DOM', dom.daoInputPresent === true);
check('Manual DAO account field hidden by default', dom.daoInputHidden === true);
check('Advanced link visible by default', dom.advLinkVisible === true);
check('Advanced link reads "Already have a DAO? Use it instead"', dom.advLinkText === 'Already have a DAO? Use it instead', dom.advLinkText);
check('Deposit note states 10 NEAR', dom.depositNoteHas10 === true);
check('Deposit note says it is not a fee', dom.depositNoteNotFee === true);
check('Deposit note says 2 of the members must approve', dom.depositNoteHas2Approve === true);
check('Shared account preview prompts for a name', (dom.previewText || '').includes('Pick a name'));
check('Default DAO mode is create', dom.mode === 'create', dom.mode);

// Type a community name: shared account name auto-fills and the preview updates.
await page.type('#cName', 'House cooperative');
await new Promise((r) => setTimeout(r, 500));
const derived = await page.evaluate(() => ({
  daoName: document.getElementById('cDaoName').value,
  preview: document.getElementById('daoIdPreview').textContent,
}));
check('Shared account name derives from community name', derived.daoName === 'house-cooperative', derived.daoName);
check('Shared account preview shows the full id', derived.preview.includes('house-cooperative.sputnikv2.testnet'), derived.preview);

// Switch to "I don't have a DAO address": the name field hides, the
// auto panel shows, the preview still derives from the community name,
// and the selected styling moves to the auto row.
await page.click('#daoOptAuto');
await new Promise((r) => setTimeout(r, 300));
const auto = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.dao-option')).map((row) => {
    const cs = window.getComputedStyle(row);
    const input = row.querySelector('input[type="radio"]');
    return { value: input ? input.value : null, checked: input ? input.checked : false, selected: row.classList.contains('selected'), fontWeight: cs.fontWeight, background: cs.backgroundColor };
  });
  return {
    mode: daoMode(),
    rows,
    newHidden: document.getElementById('daoNewPanel').style.display === 'none',
    autoVisible: document.getElementById('daoAutoPanel').style.display !== 'none',
    autoPreview: document.getElementById('daoAutoPreview') ? document.getElementById('daoAutoPreview').textContent : null,
    derivedName: daoNameValue(),
  };
});
check('Auto option switches the form to auto mode', auto.mode === 'auto', auto.mode);
check('Auto option hides the name field panel', auto.newHidden === true);
check('Auto option shows the auto panel', auto.autoVisible === true);
check('Auto preview shows the derived shared account id', (auto.autoPreview || '').includes('house-cooperative.sputnikv2.testnet'), auto.autoPreview);
check('Auto mode derives the DAO name from the community name', auto.derivedName === 'house-cooperative', auto.derivedName);
check('Selected styling moves to the auto row', auto.rows[1] && auto.rows[1].checked && auto.rows[1].selected && Number(auto.rows[1].fontWeight) >= 700, JSON.stringify(auto.rows[1]));
check('Create row loses the selected styling in auto mode', auto.rows[0] && !auto.rows[0].selected && Number(auto.rows[0].fontWeight) < 700, JSON.stringify(auto.rows[0]));

// Switch back to "Create a new DAO": the name field returns.
await page.click('#daoOptCreate');
await new Promise((r) => setTimeout(r, 300));
const backToCreate = await page.evaluate(() => ({
  mode: daoMode(),
  newVisible: document.getElementById('daoNewPanel').style.display !== 'none',
  autoHidden: document.getElementById('daoAutoPanel').style.display === 'none',
  daoName: document.getElementById('cDaoName').value,
}));
check('Create option returns to create mode', backToCreate.mode === 'create', backToCreate.mode);
check('Create option shows the name field again', backToCreate.newVisible && backToCreate.autoHidden && backToCreate.daoName === 'house-cooperative', JSON.stringify(backToCreate));

// Toggle to the manual path via the advanced link and back.
await page.click('#useExistingDaoLink');
await new Promise((r) => setTimeout(r, 300));
const toggled = await page.evaluate(() => ({
  newHidden: document.getElementById('daoNewPanel').style.display === 'none',
  existingVisible: document.getElementById('daoExistingPanel').style.display !== 'none',
  advLinkHidden: document.getElementById('useExistingDaoLink').style.display === 'none',
  mode: daoMode(),
}));
check('Advanced link shows the manual DAO field', toggled.newHidden && toggled.existingVisible && toggled.advLinkHidden, JSON.stringify(toggled));
check('Advanced link switches the form to the existing DAO path', toggled.mode === 'existing', toggled.mode);
await page.click('#useNewDaoLink');
await new Promise((r) => setTimeout(r, 300));
const toggledBack = await page.evaluate(() => ({
  newVisible: document.getElementById('daoNewPanel').style.display !== 'none',
  existingHidden: document.getElementById('daoExistingPanel').style.display === 'none',
  mode: daoMode(),
}));
check('Back link returns to the create path', toggledBack.newVisible && toggledBack.existingHidden && toggledBack.mode === 'create', JSON.stringify(toggledBack));

// Unit checks: name validation, factory args construction, constants.
const units = await page.evaluate(() => {
  const enc = (o) => b64Utf8(JSON.stringify(o));
  const args = daoInitArgs('house-coop', 'House', ['peter-vehicles.testnet', 'felix-vehicles.testnet', 'grace-vehicles.testnet', 'daniel-vehicles.testnet']);
  const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(enc(args)), (c) => c.charCodeAt(0))));
  const council = decoded.policy.roles.find((r) => r.name === 'council');
  return {
    validOk: validateDaoName('lagos-energy') === '',
    validShort: validateDaoName('a') !== '',
    validUpper: validateDaoName('Bad Name') !== '',
    validLeadHyphen: validateDaoName('-bad') !== '',
    validTrailHyphen: validateDaoName('bad-') !== '',
    validTwoChar: validateDaoName('ab') === '',
    factoryId: window.DAO_FACTORY_ID,
    deposit: window.STORAGE.createDao,
    gas150: window.GAS_150,
    argsName: decoded.config.name,
    argsPurpose: decoded.config.purpose,
    argsThreshold: decoded.policy.default_vote_policy.threshold,
    argsWeightKind: decoded.policy.default_vote_policy.weight_kind,
    argsCouncil: council ? council.kind.Group : null,
    argsBond: decoded.policy.proposal_bond,
    argsPeriod: decoded.policy.proposal_period,
    unicodeRoundTrip: (() => {
      const s = 'Café — test';
      return new TextDecoder().decode(Uint8Array.from(atob(b64Utf8(s)), (c) => c.charCodeAt(0))) === s;
    })(),
  };
});
check('validateDaoName accepts a good name', units.validOk);
check('validateDaoName rejects a 1 char name', units.validShort);
check('validateDaoName rejects uppercase/spaces', units.validUpper);
check('validateDaoName rejects a leading hyphen', units.validLeadHyphen);
check('validateDaoName rejects a trailing hyphen', units.validTrailHyphen);
check('validateDaoName accepts a 2 char name', units.validTwoChar);
check('Factory id is sputnikv2.testnet', units.factoryId === 'sputnikv2.testnet', units.factoryId);
check('DAO deposit is 10 NEAR in yocto', units.deposit === '10000000000000000000000000', units.deposit);
check('DAO gas is 150 TGas', units.gas150 === '150000000000000', units.gas150);
check('Factory args config name is the DAO name', units.argsName === 'house-coop', units.argsName);
check('Factory args purpose is the description', units.argsPurpose === 'House');
check('Factory args threshold is absolute Weight 2', units.argsThreshold === '2', String(units.argsThreshold));
check('Factory args weight kind is RoleWeight', units.argsWeightKind === 'RoleWeight');
check('Factory args council is exactly the 4 members', JSON.stringify([...units.argsCouncil].sort()) === JSON.stringify(['daniel-vehicles.testnet', 'felix-vehicles.testnet', 'grace-vehicles.testnet', 'peter-vehicles.testnet'].sort()), JSON.stringify(units.argsCouncil));
check('Factory args proposal bond is 1 NEAR', units.argsBond === '1000000000000000000000000');
check('Factory args proposal period is 7 days', units.argsPeriod === '604800000000000');
check('b64Utf8 round trips non-ASCII text', units.unicodeRoundTrip);
await page.close();

// ---------- Test B: post-create redirect ----------
// Seed a pending community creation (step "community") and stub RPC so
// the tx reads as confirmed and the community reads as existing. The
// page must redirect to community.html?id=house-cooperative.
const page2 = await browser.newPage();
page2.on('pageerror', (e) => console.log('PAGE2 ERROR:', String(e).slice(0, 300)));
await page2.evaluateOnNewDocument(() => {
  const pending = {
    step: 'community', daoName: '', daoId: 'vehicle-coop.testnet',
    fields: { name: 'House cooperative', description: 'House', members: ['peter-vehicles.testnet', 'felix-vehicles.testnet', 'grace-vehicles.testnet'], polMembers: 60, polTreasury: 25, polMaint: 15, polActivity: 10, spCap: '1', spReserve: '1', spCats: 'maintenance, operations', actCapital: '1', actRecord: '1', actNear: '1' },
  };
  localStorage.setItem('ownground-pending-community', JSON.stringify(pending));
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('rpc.testnet')) {
      let body = {};
      try { body = JSON.parse(opts && opts.body ? opts.body : '{}'); } catch (_) { /* ignore */ }
      const method = body.method;
      if (method === 'tx') {
        return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'tx', result: { status: { SuccessValue: '' } } }), { headers: { 'Content-Type': 'application/json' } }));
      }
      if (method === 'query' && body.params && body.params.request_type === 'call_function') {
        const m = body.params.method_name;
        if (m === 'get_community') {
          const bytes = Array.from(new TextEncoder().encode(JSON.stringify({ id: 'house-cooperative', name: 'House cooperative', description: 'House', dao_id: 'vehicle-coop.testnet' })));
          return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', result: { result: bytes } }), { headers: { 'Content-Type': 'application/json' } }));
        }
        if (m === 'get_policy') {
          const bytes = Array.from(new TextEncoder().encode(JSON.stringify({ roles: [{ name: 'council', kind: { Group: ['a'] } }] })));
          return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', result: { result: bytes } }), { headers: { 'Content-Type': 'application/json' } }));
        }
      }
      if (method === 'query' && body.params && body.params.request_type === 'view_account') {
        return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', result: { amount: '10000000000000000000000000' } }), { headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', error: { message: 'stub: no such account' } }), { headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch(url, opts);
  };
});
await page2.goto(`${BASE}/create.html?transactionHashes=FAKEHASH123`, { waitUntil: 'domcontentloaded', timeout: 30000 });
let redirected = false;
try {
  await page2.waitForFunction(() => window.location.href.includes('community.html?id=house-cooperative'), { timeout: 30000 });
  redirected = true;
} catch (_) {
  redirected = false;
}
check('Confirmed community creation redirects to the community page', redirected, await page2.url());
await page2.close();

// ---------- Test C: taken-name check runs before signing ----------
// Stub view_account so the DAO name is taken, stub walletCall to record
// calls, fill the form as a connected wallet, and tap Create. The page
// must refuse with "That name is taken" and never call the wallet.
// Then flip the stub so the name is free and confirm the factory call
// is made (the check gates signing, it does not block a free name).
const page3 = await browser.newPage();
page3.on('pageerror', (e) => console.log('PAGE3 ERROR:', String(e).slice(0, 300)));
await page3.evaluateOnNewDocument(() => {
  localStorage.removeItem('ownground-pending-community');
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('rpc.testnet')) {
      let body = {};
      try { body = JSON.parse(opts && opts.body ? opts.body : '{}'); } catch (_) { /* ignore */ }
      if (body.method === 'query' && body.params && body.params.request_type === 'view_account') {
        const taken = window.__ogAccountTaken;
        if (taken) {
          return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', result: { amount: '10000000000000000000000000' } }), { headers: { 'Content-Type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', error: { message: "account doesn't exist" } }), { headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', error: { message: 'stub: no such method' } }), { headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch(url, opts);
  };
});
await page3.goto(`${BASE}/create.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));
await page3.evaluate(() => {
  window.__ogAccountTaken = true;
  window.__ogWalletCalls = [];
  window.walletCall = async (contractId, method, args, deposit, gas) => {
    window.__ogWalletCalls.push({ contractId, method, deposit, gas });
    return {};
  };
  walletAccountId = 'clearsite587.testnet';
  document.getElementById('cName').value = 'Taken Club';
  document.getElementById('cName').dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('cMembers').value = 'clearsite587.testnet\npeter-vehicles.testnet';
  document.getElementById('cMembers').dispatchEvent(new Event('input', { bubbles: true }));
});
await page3.click('#createBtn');
await new Promise((r) => setTimeout(r, 3000));
const taken = await page3.evaluate(() => ({
  status: document.getElementById('pageStatus') ? document.getElementById('pageStatus').textContent : '',
  walletCalls: window.__ogWalletCalls || [],
}));
check('Taken name refuses before signing', taken.status.indexOf('That name is taken') >= 0, taken.status.slice(0, 80));
check('Taken name never opens the wallet', taken.walletCalls.length === 0, JSON.stringify(taken.walletCalls));

await page3.evaluate(() => {
  window.__ogAccountTaken = false;
  window.__ogWalletCalls = [];
});
await page3.click('#createBtn');
await new Promise((r) => setTimeout(r, 3000));
const free = await page3.evaluate(() => ({
  status: document.getElementById('pageStatus') ? document.getElementById('pageStatus').textContent : '',
  walletCalls: window.__ogWalletCalls || [],
}));
check('Free name proceeds to the factory call', free.walletCalls.length === 1 && free.walletCalls[0].contractId === 'sputnikv2.testnet' && free.walletCalls[0].method === 'create', JSON.stringify(free.walletCalls));
check('Free name sends the factory deposit, not a community call', free.walletCalls.length === 1 && free.walletCalls[0].deposit === '10000000000000000000000000', JSON.stringify(free.walletCalls));
await page3.close();

// ---------- Test D: taken-name check in auto mode ----------
// Same stubs as Test C. Switch to "I don't have a DAO address", type a
// community name, and tap Create. A taken derived name refuses before
// signing; a free one proceeds to the factory call with the derived name.
const page4 = await browser.newPage();
page4.on('pageerror', (e) => console.log('PAGE4 ERROR:', String(e).slice(0, 300)));
await page4.evaluateOnNewDocument(() => {
  localStorage.removeItem('ownground-pending-community');
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('rpc.testnet')) {
      let body = {};
      try { body = JSON.parse(opts && opts.body ? opts.body : '{}'); } catch (_) { /* ignore */ }
      if (body.method === 'query' && body.params && body.params.request_type === 'view_account') {
        if (window.__ogAccountTaken) {
          return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', result: { amount: '10000000000000000000000000' } }), { headers: { 'Content-Type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', error: { message: "account doesn't exist" } }), { headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', error: { message: 'stub: no such method' } }), { headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch(url, opts);
  };
});
await page4.goto(`${BASE}/create.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));
await page4.evaluate(() => {
  window.__ogAccountTaken = true;
  window.__ogWalletCalls = [];
  window.walletCall = async (contractId, method, args, deposit, gas) => {
    window.__ogWalletCalls.push({ contractId, method, deposit, gas });
    return {};
  };
  walletAccountId = 'clearsite587.testnet';
  document.getElementById('cName').value = 'Taken Club';
  document.getElementById('cName').dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('cMembers').value = 'clearsite587.testnet\npeter-vehicles.testnet';
  document.getElementById('cMembers').dispatchEvent(new Event('input', { bubbles: true }));
});
await page4.click('#daoOptAuto');
await new Promise((r) => setTimeout(r, 300));
await page4.click('#createBtn');
await new Promise((r) => setTimeout(r, 3000));
const autoTaken = await page4.evaluate(() => ({
  status: document.getElementById('pageStatus') ? document.getElementById('pageStatus').textContent : '',
  walletCalls: window.__ogWalletCalls || [],
  mode: daoMode(),
}));
check('Auto mode is active for the taken-name check', autoTaken.mode === 'auto', autoTaken.mode);
check('Auto mode refuses a taken derived name before signing', autoTaken.status.indexOf('That name is taken') >= 0, autoTaken.status.slice(0, 80));
check('Auto mode taken name never opens the wallet', autoTaken.walletCalls.length === 0, JSON.stringify(autoTaken.walletCalls));

await page4.evaluate(() => {
  window.__ogAccountTaken = false;
  window.__ogWalletCalls = [];
});
await page4.click('#createBtn');
await new Promise((r) => setTimeout(r, 3000));
const autoFree = await page4.evaluate(() => ({
  status: document.getElementById('pageStatus') ? document.getElementById('pageStatus').textContent : '',
  walletCalls: window.__ogWalletCalls || [],
  pending: JSON.parse(localStorage.getItem('ownground-pending-community') || 'null'),
}));
check('Auto mode free name proceeds to the factory call', autoFree.walletCalls.length === 1 && autoFree.walletCalls[0].contractId === 'sputnikv2.testnet' && autoFree.walletCalls[0].method === 'create', JSON.stringify(autoFree.walletCalls));
check('Auto mode saves the derived DAO name for the resume', autoFree.pending && autoFree.pending.daoName === 'taken-club' && autoFree.pending.daoId === 'taken-club.sputnikv2.testnet', JSON.stringify(autoFree.pending));
await page4.close();

await browser.close();
server.kill();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
