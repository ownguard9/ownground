// Top up the OwnGround deployer from the two funder accounts, deploy the
// OwnGround wasm to ownground.testnet, initialise it with new(), and verify.
// Uses ONLY the fresh OwnGround accounts in .testnet-accounts.json.
// Run: node scripts/fund-and-deploy.mjs
// Writes deploy-log.json (tx hashes + verified state; NO keys).
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts.json', import.meta.url);
const WASM = new URL('../contract/target/wasm32-unknown-unknown/release/ownground.wasm', import.meta.url);
const OUT = new URL('../deploy-log.json', import.meta.url);
const CONTRACT_ID = 'ownground.testnet';

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
for (const role of ['contract', 'funder', 'funder2']) {
  if (!accounts[role]) throw new Error(`${role} account missing in .testnet-accounts.json`);
}

const keyStore = new keyStores.InMemoryKeyStore();
for (const role of ['contract', 'funder', 'funder2']) {
  const a = accounts[role];
  await keyStore.setKey('testnet', a.accountId, KeyPair.fromString(a.privateKey));
}

const near = await connect({
  networkId: 'testnet',
  nodeUrl: 'https://rpc.testnet.near.org',
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org',
  keyStore,
});

async function balanceOf(id) {
  const acc = await near.account(id);
  const s = await acc.getAccountBalance();
  return s.total;
}

const N = utils.format.parseNearAmount('1');
console.log('balances before funding:');
for (const role of ['contract', 'funder', 'funder2']) {
  console.log(`  ${accounts[role].accountId}: ${balanceOf ? await balanceOf(accounts[role].accountId) : '?'} yoctoNEAR`);
}

// 1. Consolidate: 9.5 NEAR from each funder to the deployer.
const topUps = [];
for (const role of ['funder', 'funder2']) {
  const acc = await near.account(accounts[role].accountId);
  const amount = utils.format.parseNearAmount('9.5');
  console.log(`transferring 9.5 NEAR ${accounts[role].accountId} -> ${CONTRACT_ID} ...`);
  const outcome = await acc.sendMoney(CONTRACT_ID, BigInt(amount));
  console.log(`  tx: ${outcome.transaction.hash}`);
  topUps.push({ from: accounts[role].accountId, to: CONTRACT_ID, amount_near: '9.5', tx: outcome.transaction.hash });
}
console.log(`deployer balance after top-up: ${await balanceOf(CONTRACT_ID)} yoctoNEAR`);

// 2. Deploy the wasm.
const wasm = fs.readFileSync(WASM);
console.log(`deploying ${wasm.length} bytes to ${CONTRACT_ID} ...`);
const deployer = await near.account(CONTRACT_ID);
const deployOutcome = await deployer.deployContract(wasm);
console.log(`deploy tx: ${deployOutcome.transaction.hash}`);
console.log(`deployer balance after deploy: ${await balanceOf(CONTRACT_ID)} yoctoNEAR`);

// 3. Initialise with new().
console.log('calling new() ...');
const initOutcome = await deployer.functionCall({
  contractId: CONTRACT_ID,
  methodName: 'new',
  args: {},
  gas: 100_000_000_000_000n,
  attachedDeposit: 0n,
});
console.log(`init tx: ${initOutcome.transaction.hash}`);

// 4. Verify: no communities yet, stats readable.
const communities = await deployer.viewFunction({ contractId: CONTRACT_ID, methodName: 'list_communities', args: {} });
console.log('list_communities:', JSON.stringify(communities));
if (!Array.isArray(communities) || communities.length !== 0) throw new Error('expected zero communities after init');
const stats = await deployer.viewFunction({ contractId: CONTRACT_ID, methodName: 'get_stats', args: {} });
console.log('get_stats:', JSON.stringify(stats));

const log = {
  network: 'testnet',
  contract_id: CONTRACT_ID,
  wasm_bytes: wasm.length,
  top_ups: topUps,
  deploy_tx: deployOutcome.transaction.hash,
  init_tx: initOutcome.transaction.hash,
  deployer_balance_yocto: await balanceOf(CONTRACT_ID),
  stats,
  created_at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
console.log('DEPLOY OK:', CONTRACT_ID);
console.log('wrote deploy-log.json');
