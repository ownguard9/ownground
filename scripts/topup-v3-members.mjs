// Top up the v3 demo members back to their funded levels after the
// v3 demo attempt 1 drained them (alice 6.5, bob/carol/dave 3.0 each),
// paid from the v3 deployer (ownground3.testnet). Reads live balances
// and sends exactly the shortfall. Writes topup-log-v3.json (tx hashes,
// NO keys). Run: node scripts/topup-v3-members.mjs
import fs from 'node:fs';
import { connect, keyStores, KeyPair, utils } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts-v3.json', import.meta.url);
const OUT = new URL('../topup-log-v3.json', import.meta.url);
const TARGETS = { alice: '6.5', bob: '3', carol: '3', dave: '3' };

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', accounts.contract.accountId, KeyPair.fromString(accounts.contract.privateKey));
const near = await connect({
  networkId: 'testnet', nodeUrl: 'https://rpc.testnet.near.org',
  walletUrl: 'https://testnet.mynearwallet.com/', helperUrl: 'https://helper.testnet.near.org', keyStore,
});
const payer = await near.account(accounts.contract.accountId);
const log = [];
for (const [role, target] of Object.entries(TARGETS)) {
  const id = accounts[role].accountId;
  const acc = await near.account(id);
  const bal = BigInt((await acc.getAccountBalance()).total);
  const want = BigInt(utils.format.parseNearAmount(target));
  if (bal >= want) { console.log(`${id}: ${bal} already >= ${want}, skip`); continue; }
  const diff = want - bal;
  console.log(`topping up ${id} by ${diff} yoctoNEAR ...`);
  const out = await payer.sendMoney(id, diff);
  console.log(`  tx: ${out.transaction.hash}`);
  log.push({ to: id, amount_yocto: diff.toString(), tx: out.transaction.hash });
}
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
console.log('top-ups done, wrote topup-log-v3.json');
