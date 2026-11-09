// Create the fresh OwnGround-only testnet accounts via the NEAR testnet
// helper faucet. No PAC, FairShare, Genesis, VeilProof or any other
// project's wallets, keys, or funds are involved: the helper funds each
// new account with 10 testnet NEAR.
//
//   node scripts/create-accounts-v4.mjs
//
// Keys are written ONLY to .testnet-accounts-v4.json (chmod 600, gitignored
// by omission from the GitHub snapshot) and to ~/.near-credentials/testnet
// (near-cli layout, which scripts/demo.mjs reads). NEVER print or commit
// those files. The deployer (ownground4.testnet) is topped up from the
// four funder accounts by scripts/fund-and-deploy.mjs, because the demo
// members are subaccounts of the deployer and need ~16 NEAR between
// them, and the 730 KB contract code stakes ~7.3 NEAR on deploy —
// v2's two funders left the deployer at its storage floor mid-flow,
// so v3 consolidates from four funders up front.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.near.org';
const HELPER = 'https://helper.testnet.near.org/account';
const OUT = new URL('../.testnet-accounts-v4.json', import.meta.url);
const KEY_DIR = path.join(os.homedir(), '.near-credentials', 'testnet');

const ACCOUNTS = [
  { role: 'contract', accountId: 'ownground4.testnet' },
  { role: 'funder', accountId: 'ownground4-funder.testnet' },
  { role: 'funder2', accountId: 'ownground4-funder2.testnet' },
  { role: 'funder3', accountId: 'ownground4-funder3.testnet' },
  { role: 'funder4', accountId: 'ownground4-funder4.testnet' },
  { role: 'dao', accountId: 'lagos-energy4.testnet' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcView(accountId) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'ownground-check',
      method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }),
  });
  return res.json();
}

// Persist one account's keypair to disk BEFORE any network call that
// depends on it, so a crash can never lose a key for a live account.
function saveProgress(out) {
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  fs.mkdirSync(KEY_DIR, { recursive: true });
  for (const entry of Object.values(out)) {
    fs.writeFileSync(
      path.join(KEY_DIR, `${entry.accountId}.json`),
      JSON.stringify({ account_id: entry.accountId, public_key: entry.publicKey, private_key: entry.privateKey }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
}

async function waitVerified(accountId, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const check = await rpcView(accountId);
    if (check.result) return check.result;
    await sleep(5000);
  }
  return null;
}

const out = {};
try {
  Object.assign(out, JSON.parse(fs.readFileSync(OUT, 'utf8')));
} catch {
  // fresh file
}
for (const { role, accountId } of ACCOUNTS) {
  if (out[role]?.accountId === accountId) {
    const check = await rpcView(accountId);
    if (check.result) {
      console.log(`SKIP ${accountId}: already created and key saved`);
      continue;
    }
  }
  const existing = await rpcView(accountId);
  if (existing.result) {
    throw new Error(
      `${accountId} already exists onchain (balance ${existing.result.amount}); pick a fresh name — its key is not recoverable from here`,
    );
  }
  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey().toString();
  out[role] = { accountId, publicKey, privateKey: keyPair.toString() };
  saveProgress(out);
  console.log(`creating ${accountId} with ${publicKey} ...`);
  let lastText = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(HELPER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
    });
    lastText = await res.text();
    console.log(`helper HTTP ${res.status} (attempt ${attempt}): ${lastText.slice(0, 200)}`);
    if (res.ok) break;
    await sleep(5000);
  }
  const verified = await waitVerified(accountId);
  if (!verified) {
    throw new Error(`account ${accountId} not verified onchain after 90s (helper said: ${lastText.slice(0, 200)}). Key is saved in .testnet-accounts-v4.json — retry verification before reusing the name.`);
  }
  console.log(`VERIFIED ${accountId}: balance ${verified.amount} yoctoNEAR`);
  await sleep(1000);
}

saveProgress(out);
console.log('wrote .testnet-accounts-v4.json (chmod 600) and ~/.near-credentials/testnet/*.json');
