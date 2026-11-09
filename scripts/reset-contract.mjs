// Reset the OwnGround contract account to a clean state.
//
// The first live demo run created the community and one campaign before the
// demo script hit a contract/script id mismatch, and the contract has no
// state-wipe method (new() is init-guarded). So: delete ownground.testnet
// (balance goes to the funder), recreate it fresh via the testnet helper
// faucet, redeploy the fixed wasm, call new(), and verify empty state.
//
// Subaccounts (alice/bob/carol/dave/seller.ownground.testnet) and the DAO
// (lagos-energy.testnet) are independent accounts and are NOT touched:
// they keep their keys and balances, and the demo reuses them as-is.
// If the delete is refused (e.g. the runtime blocks deleting an account
// with subaccounts), this script stops with a clear error and changes
// nothing else.
//
//   node scripts/reset-contract.mjs
// Writes reset-log.json (tx hashes + verified state; NO keys).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, keyStores, KeyPair } from 'near-api-js';

const RPC = 'https://rpc.testnet.fastnear.com';
const HELPER = 'https://helper.testnet.near.org/account';
const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const KEY_FILE = path.join(os.homedir(), '.near-credentials', 'testnet', 'ownground.testnet.json');
const WASM = new URL('../contract/target/wasm32-unknown-unknown/release/ownground.wasm', import.meta.url);
const OUT = new URL('../reset-log.json', import.meta.url);
const CONTRACT_ID = 'ownground.testnet';
const BENEFICIARY = 'ownground-funder.testnet';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcView(accountId) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'ownground-reset',
      method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }),
  });
  return res.json();
}

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
if (!accounts.contract || !accounts.funder) throw new Error('contract/funder missing in .testnet-accounts.json');

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', CONTRACT_ID, KeyPair.fromString(accounts.contract.privateKey));
const near = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org', keyStore,
});

// 1. Delete the contract account; its balance goes to the funder.
const acc = await near.account(CONTRACT_ID);
console.log(`deleting ${CONTRACT_ID} (beneficiary ${BENEFICIARY}) ...`);
let deleteTx;
try {
  const out = await acc.deleteAccount(BENEFICIARY);
  deleteTx = out.transaction.hash;
  console.log('delete tx:', deleteTx);
} catch (e) {
  console.error('DELETE FAILED — stopping, nothing else changed.');
  console.error(e.message);
  process.exit(2);
}

// 2. Verify it is gone.
let gone = false;
for (let i = 0; i < 12; i++) {
  const check = await rpcView(CONTRACT_ID);
  if (check.error) { gone = true; break; }
  await sleep(5000);
}
if (!gone) throw new Error(`${CONTRACT_ID} still exists onchain after delete tx ${deleteTx}`);
console.log(`${CONTRACT_ID} confirmed gone onchain`);

// 3. Fresh keypair, saved BEFORE any network call that depends on it.
const fresh = KeyPair.fromRandom('ed25519');
accounts.contract = {
  role: 'contract', accountId: CONTRACT_ID,
  publicKey: fresh.getPublicKey().toString(), privateKey: fresh.toString(),
};
fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2) + '\n', { mode: 0o600 });
fs.writeFileSync(KEY_FILE, JSON.stringify({
  account_id: CONTRACT_ID,
  public_key: fresh.getPublicKey().toString(), private_key: fresh.toString(),
}, null, 2) + '\n', { mode: 0o600 });
console.log('fresh keypair saved; public key:', fresh.getPublicKey().toString());

// 4. Recreate via the helper faucet (10 NEAR), retry x3, verify onchain.
let lastText = '';
for (let attempt = 1; attempt <= 3; attempt++) {
  const res = await fetch(HELPER, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: CONTRACT_ID, newAccountPublicKey: fresh.getPublicKey().toString() }),
  });
  lastText = await res.text();
  console.log(`helper HTTP ${res.status} (attempt ${attempt}): ${lastText.slice(0, 200)}`);
  if (res.ok) break;
  await sleep(5000);
}
let verified = null;
for (let i = 0; i < 18; i++) {
  const check = await rpcView(CONTRACT_ID);
  if (check.result) { verified = check.result; break; }
  await sleep(5000);
}
if (!verified) throw new Error(`recreated ${CONTRACT_ID} not verified onchain (helper said: ${lastText.slice(0, 200)}). Key is saved — retry verification before reusing the name.`);
console.log(`${CONTRACT_ID} recreated, balance ${verified.amount} yoctoNEAR`);

// 5. Deploy the fixed wasm, init, verify empty state.
const keyStore2 = new keyStores.InMemoryKeyStore();
await keyStore2.setKey('testnet', CONTRACT_ID, fresh);
const near2 = await connect({
  networkId: 'testnet', nodeUrl: RPC,
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org', keyStore: keyStore2,
});
const acc2 = await near2.account(CONTRACT_ID);
const wasm = fs.readFileSync(WASM);
console.log(`deploying ${wasm.length} bytes ...`);
const deployOut = await acc2.deployContract(wasm);
console.log('deploy tx:', deployOut.transaction.hash);
const initOut = await acc2.functionCall({
  contractId: CONTRACT_ID, methodName: 'new', args: {}, gas: BigInt('30000000000000'),
});
console.log('init tx:', initOut.transaction.hash);
const stats = await acc2.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_stats', args: {} });
console.log('get_stats after reset:', JSON.stringify(stats));
const communities = await acc2.viewFunction({ contractId: CONTRACT_ID, methodName: 'list_communities', args: {} });
console.log('list_communities after reset:', JSON.stringify(communities));

fs.writeFileSync(OUT, JSON.stringify({
  contract: CONTRACT_ID, delete_tx: deleteTx,
  deploy_tx: deployOut.transaction.hash, init_tx: initOut.transaction.hash,
  get_stats: stats, list_communities: communities,
}, null, 2) + '\n');
console.log('reset complete; log written to reset-log.json');
