// One-off: top up peter-vehicles.testnet from felix-vehicles.testnet
// so peter can cover the 10 NEAR factory deposit plus gas.
import fs from 'node:fs';
import { connect, keyStores, KeyPair } from 'near-api-js';

const accounts = JSON.parse(fs.readFileSync('/home/hatch/workspace/commonhold/.testnet-vehicle-accounts.json', 'utf8'));
const from = accounts.felix;
const to = accounts.peter.accountId;

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', from.accountId, KeyPair.fromString(from.privateKey));
const near = await connect({
  networkId: 'testnet',
  nodeUrl: 'https://rpc.testnet.near.org',
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org',
  keyStore,
});
const account = await near.account(from.accountId);
const out = await account.sendMoney(to, 2000000000000000000000000n);
console.log('transfer tx:', out.transaction.hash);
const peter = await near.account(to);
console.log('peter balance:', (await peter.getAccountBalance()).total);
