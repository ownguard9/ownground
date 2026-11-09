// Create the OwnGround demo subaccounts under ownground4.testnet and fund
// them for the 17-step demo. Uses ONLY the fresh OwnGround accounts.
// Run: node scripts/create-subaccounts-v4.mjs
// Keys are appended to .testnet-accounts-v4.json (chmod 600) and to
// ~/.near-credentials/testnet (near-cli layout). NEVER print or commit them.
//
// Funding (demo needs + gas): alice 6.5 NEAR (she also pays the 3 NEAR
// onchain revenue deposit, the 0.2 attestation bond and the create calls),
// bob/carol/dave 3 NEAR each, seller 0.2 NEAR (receives 10 NEAR at acquire).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts-v4.json', import.meta.url);
const KEY_DIR = path.join(os.homedir(), '.near-credentials', 'testnet');
const PARENT_ID = 'ownground4.testnet';

const SUBACCOUNTS = [
  { role: 'alice', accountId: 'alice.ownground4.testnet', near: '6.5' },
  { role: 'bob', accountId: 'bob.ownground4.testnet', near: '3' },
  { role: 'carol', accountId: 'carol.ownground4.testnet', near: '3' },
  { role: 'dave', accountId: 'dave.ownground4.testnet', near: '3' },
  { role: 'seller', accountId: 'seller.ownground4.testnet', near: '0.2' },
  // Ops must EXIST onchain: pay_expense transfers to it, and a transfer
  // to a nonexistent account fails (v3 demo attempt 1 proved it — the new
  // callback then correctly reverted the expense). 0.05 NEAR is enough.
  { role: 'ops', accountId: 'ops.ownground4.testnet', near: '0.05' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcView(accountId) {
  const res = await fetch('https://rpc.testnet.near.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'ownground-sub',
      method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }),
  });
  return res.json();
}

function saveProgress(out) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
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

const out = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
if (!out.contract || out.contract.accountId !== PARENT_ID) throw new Error('contract account missing');

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', PARENT_ID, KeyPair.fromString(out.contract.privateKey));
const near = await connect({
  networkId: 'testnet',
  nodeUrl: 'https://rpc.testnet.near.org',
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org',
  keyStore,
});
const parent = await near.account(PARENT_ID);

for (const { role, accountId, near: amountNear } of SUBACCOUNTS) {
  if (out[role]?.accountId === accountId) {
    const check = await rpcView(accountId);
    if (check.result) {
      console.log(`SKIP ${accountId}: already created and key saved (balance ${check.result.amount})`);
      continue;
    }
  }
  const existing = await rpcView(accountId);
  if (existing.result) {
    throw new Error(`${accountId} already exists onchain; pick a fresh name — its key is not recoverable from here`);
  }
  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey().toString();
  out[role] = { accountId, publicKey, privateKey: keyPair.toString() };
  saveProgress(out);
  console.log(`creating ${accountId} with ${amountNear} NEAR ...`);
  const outcome = await parent.createAccount(accountId, keyPair.getPublicKey(), BigInt(utils.format.parseNearAmount(amountNear)));
  console.log(`  tx: ${outcome.transaction.hash}`);
  const verified = await waitVerified(accountId);
  if (!verified) throw new Error(`${accountId} not verified onchain after 90s. Key is saved — retry verification before reusing the name.`);
  console.log(`VERIFIED ${accountId}: balance ${verified.amount} yoctoNEAR`);
  await sleep(1000);
}

saveProgress(out);
console.log('subaccounts done');
