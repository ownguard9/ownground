// PROOF: create a Sputnik DAO through the public factory
// (sputnikv2.testnet) instead of deploying the wasm directly.
// This is the call the OwnGround site will make from the browser.
//
//   node scripts/create-dao-factory-test.mjs
//
// Signer: peter-vehicles.testnet (a throwaway demo member, 10 NEAR).
// Test DAO: vehicle-coop-factory-test.sputnikv2.testnet — a FRESH name,
// never the live vehicle-coop.testnet (direct-deploy DAO).
// Council = the 4 vehicle members, absolute Weight threshold 2.
// Deposit: 10 NEAR (README --amount 10). The live factory's floor is
// 5.39679 NEAR (ERR_NOT_ENOUGH_DEPOSIT:5396790000000000000000000 — the
// live factory predates the current source's 0.01 NEAR floor and its
// minimum covers the ~470KB DAO code storage); 10 NEAR clears it with
// headroom and leaves the new DAO ~4.6 NEAR of working balance. The
// deposit becomes the new DAO's balance, it is not a fee.
// Gas: 150 TGas (README example).
// Writes dao-factory-test-log.json (tx hash + verified policy; NO keys).
import fs from 'node:fs';
import { connect, keyStores, KeyPair } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-vehicle-accounts.json', import.meta.url);
const OUT = new URL('../dao-factory-test-log.json', import.meta.url);

const FACTORY_ID = 'sputnikv2.testnet';
const DAO_NAME = 'vehicle-coop-factory-test';
const DAO_ID = `${DAO_NAME}.${FACTORY_ID}`;
const DEPOSIT_YOCTO = 10000000000000000000000000n; // 10 NEAR
const GAS = 150000000000000n; // 150 TGas

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const signer = accounts.peter;
if (!signer) throw new Error('peter account missing in .testnet-vehicle-accounts.json');
const members = ['peter', 'felix', 'grace', 'daniel'].map((r) => accounts[r].accountId);
if (members.some((m) => !m)) throw new Error('vehicle member accounts missing');

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', signer.accountId, KeyPair.fromString(signer.privateKey));

const near = await connect({
  networkId: 'testnet',
  nodeUrl: 'https://rpc.testnet.near.org',
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org',
  keyStore,
});

// The DAO's `new` args, exactly as scripts/create-dao-v3.mjs builds them.
const daoInitArgs = {
  config: {
    name: DAO_NAME,
    purpose: 'Factory test DAO for the Vehicle Cooperative',
    metadata: '',
  },
  policy: {
    roles: [
      { name: 'all', kind: 'Everyone', permissions: ['*:AddProposal'], vote_policy: {} },
      {
        name: 'council',
        kind: { Group: members },
        permissions: ['*:*'],
        vote_policy: {},
      },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: '2' },
    proposal_bond: '1000000000000000000000000',
    proposal_period: '604800000000000',
    bounty_bond: '1000000000000000000000000',
    bounty_forgiveness_period: '86400000000000',
  },
};
const argsBase64 = Buffer.from(JSON.stringify(daoInitArgs)).toString('base64');
console.log('DAO init args base64 (first 120 chars):', argsBase64.slice(0, 120));
console.log('DAO init args decode check:', JSON.parse(Buffer.from(argsBase64, 'base64').toString('utf8')).config.name);

const account = await near.account(signer.accountId);
console.log(`calling ${FACTORY_ID}.create(${DAO_NAME}) with 10 NEAR deposit, 150 TGas ...`);
const outcome = await account.functionCall({
  contractId: FACTORY_ID,
  methodName: 'create',
  args: { name: DAO_NAME, args: argsBase64 },
  gas: GAS,
  attachedDeposit: DEPOSIT_YOCTO,
});
console.log('create tx:', outcome.transaction.hash);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function viewPoll(methodName, args, pred, label, timeoutMs = 120000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await account.viewFunction({ contractId: DAO_ID, methodName, args });
      if (pred(last)) return last;
    } catch (e) {
      last = String(e && e.message ? e.message : e);
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last)}`);
}
const policyOut = await viewPoll('get_policy', {}, (v) => Array.isArray(v?.roles), 'get_policy');
console.log('get_policy:', JSON.stringify(policyOut).slice(0, 800));
const council = policyOut.roles.find((r) => r.name === 'council');
if (!council) throw new Error('no council role in DAO policy');
const group = council.kind?.Group;
if (!Array.isArray(group)) throw new Error('council role is not a Group');
const sortedGroup = [...group].sort();
const sortedMembers = [...members].sort();
if (JSON.stringify(sortedGroup) !== JSON.stringify(sortedMembers)) {
  throw new Error(`council group mismatch: got ${JSON.stringify(sortedGroup)}, expected ${JSON.stringify(sortedMembers)}`);
}
const dvp = policyOut.default_vote_policy;
if (dvp?.threshold !== '2' && dvp?.threshold !== 2) {
  throw new Error(`vote threshold mismatch: got ${JSON.stringify(dvp)}, expected Weight 2`);
}
const config = await account.viewFunction({ contractId: DAO_ID, methodName: 'get_config', args: {} });
console.log('get_config:', JSON.stringify(config));
if (config.name !== DAO_NAME) throw new Error('DAO config name mismatch');
const daoAccount = await near.account(DAO_ID);
const daoBalance = await daoAccount.getAccountBalance();
console.log('DAO balance (total yocto):', daoBalance.total);

const log = {
  network: 'testnet',
  factory_id: FACTORY_ID,
  dao_id: DAO_ID,
  dao_name: DAO_NAME,
  signer: signer.accountId,
  deposit_yocto: DEPOSIT_YOCTO.toString(),
  deposit_near: '10',
  gas: GAS.toString(),
  create_tx: outcome.transaction.hash,
  council: sortedGroup,
  vote_threshold: 'Weight 2 (2 of 4 council approvals pass a proposal)',
  config,
  dao_balance_yocto: daoBalance.total,
  created_at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
console.log('FACTORY DAO OK:', DAO_ID);
console.log('wrote dao-factory-test-log.json');
