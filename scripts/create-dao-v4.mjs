// Create the OwnGround demo Sputnik DAO at lagos-energy4.testnet.
// Why not the Sputnik factory: a factory-created DAO (<name>.sputnikv2.testnet)
// is keyless — the factory leaves no access key on it — but scripts/demo.mjs
// signs add_proposal as the DAO itself, so the DAO needs a key we hold.
// So, exactly like FairShare's fairshare-dao.testnet, this deploys the live
// Sputnik DAO v2 wasm directly: the bytes are read on-chain via view_code
// from genesis.sputnikv2.testnet, then deployed to lagos-energy4.testnet and
// initialised with new().
//
// The policy is NOT the factory default. The default vote policy is
// Ratio(1,2), which with 4 council members needs 3 approvals
// (threshold weight = 1*4/2 + 1 = 3, per WeightOrRatio::to_weight), and the
// v4 demo votes with 3 members. So the policy sets an absolute Weight
// threshold of 3: default_vote_policy = {weight_kind: RoleWeight,
// quorum: 0, threshold: "3"} (WeightOrRatio is serde untagged, so the
// Weight variant serialises as the bare U128 string "3").
// Uses ONLY the fresh OwnGround accounts in .testnet-accounts-v4.json.
// Run: node scripts/create-dao.mjs
// Writes dao-log-v4.json (tx hashes + verified policy; NO keys).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, keyStores, KeyPair } from 'near-api-js';

const ACCOUNTS_FILE = new URL('../.testnet-accounts-v4.json', import.meta.url);
const OUT = new URL('../dao-log-v4.json', import.meta.url);

const DAO_ID = 'lagos-energy4.testnet';
// A DAO holding the factory's current default DAO code (hash checked below).
const WASM_SOURCE_DAO = 'genesis.sputnikv2.testnet';

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
const dao = accounts.dao;
if (!dao || dao.accountId !== DAO_ID) {
  throw new Error('dao account missing in .testnet-accounts-v4.json');
}
const members = ['alice', 'bob', 'carol', 'dave'].map((r) => accounts[r].accountId);
if (members.some((m) => !m)) throw new Error('demo member accounts missing');

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', dao.accountId, KeyPair.fromString(dao.privateKey));

const near = await connect({
  networkId: 'testnet',
  nodeUrl: 'https://rpc.testnet.near.org',
  walletUrl: 'https://testnet.mynearwallet.com/',
  helperUrl: 'https://helper.testnet.near.org',
  keyStore,
});

// 1. Read the Sputnik DAO v2 wasm straight off the chain.
const provider = near.connection.provider;
const code = await provider.query({
  request_type: 'view_code',
  account_id: WASM_SOURCE_DAO,
  finality: 'final',
});
const wasm = Buffer.from(code.code_base64, 'base64');
const wasmSha256 = createHash('sha256').update(wasm).digest('hex');
console.log(`DAO wasm from ${WASM_SOURCE_DAO}: ${wasm.length} bytes, code hash ${code.hash}, sha256 ${wasmSha256}`);
if (wasm.length < 100_000) throw new Error('DAO wasm implausibly small — refusing to deploy');
if (!wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
  throw new Error('downloaded bytes are not a wasm module');
}

const account = await near.account(DAO_ID);

// 2. Deploy the DAO wasm to lagos-energy4.testnet.
console.log(`deploying ${wasm.length} bytes to ${DAO_ID} ...`);
const deployOutcome = await account.deployContract(wasm);
console.log('deploy tx:', deployOutcome.transaction.hash);

// 3. Initialise: custom policy, council = the 4 demo members, threshold 3.
const policy = {
  roles: [
    { name: 'all', kind: 'Everyone', permissions: ['*:AddProposal'], vote_policy: {} },
    {
      name: 'council',
      kind: { Group: members },
      permissions: ['*:*'],
      vote_policy: {},
    },
  ],
  default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: '3' },
  proposal_bond: '1000000000000000000000000',
  proposal_period: '604800000000000',
  bounty_bond: '1000000000000000000000000',
  bounty_forgiveness_period: '86400000000000',
};
const initArgs = {
  config: {
    name: 'lagos-energy4',
    purpose: 'Lagos Energy Cooperative — neighbours owning a generator together',
    metadata: '',
  },
  policy,
};
console.log(`calling new() with council ${members.join(', ')} ...`);
const initOutcome = await account.functionCall({
  contractId: DAO_ID,
  methodName: 'new',
  args: initArgs,
  gas: 100_000_000_000_000n,
  attachedDeposit: 0n,
});
console.log('init tx:', initOutcome.transaction.hash);

// 4. Verify live: get_policy must show a council role whose group is
// exactly the 4 demo members, with the Weight-3 threshold in force.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function viewPoll(methodName, args, pred, label, timeoutMs = 90000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await account.viewFunction({ contractId: DAO_ID, methodName, args });
    if (pred(last)) return last;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${label}; last view: ${JSON.stringify(last)}`);
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
if (dvp?.threshold !== '3' && dvp?.threshold !== 3) {
  throw new Error(`vote threshold mismatch: got ${JSON.stringify(dvp)}, expected Weight 3`);
}
const config = await account.viewFunction({ contractId: DAO_ID, methodName: 'get_config', args: {} });
console.log('get_config:', JSON.stringify(config));
if (config.name !== 'lagos-energy4') throw new Error('DAO config name mismatch');
const daoBalance = await account.getAccountBalance();

const log = {
  network: 'testnet',
  dao_id: DAO_ID,
  dao_name: 'lagos-energy4',
  wasm_source_dao: WASM_SOURCE_DAO,
  wasm_bytes: wasm.length,
  wasm_code_hash: code.hash,
  wasm_sha256: wasmSha256,
  deploy_tx: deployOutcome.transaction.hash,
  init_tx: initOutcome.transaction.hash,
  council: sortedGroup,
  vote_threshold: 'Weight 3 (3 of 4 council approvals pass a proposal)',
  config,
  dao_balance_yocto: daoBalance.total,
  created_at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(log, null, 2) + '\n');
console.log('DAO OK:', DAO_ID);
console.log('wrote dao-log-v4.json');
