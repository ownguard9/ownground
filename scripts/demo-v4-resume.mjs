// OwnGround v4 demo run: Lagos Energy Cooperative, community
// lagos-energy-cooperative-6, on contract ownground4.testnet / DAO
// lagos-energy4.testnet (threshold 3 of 4, strict majority — v4
// REQUIRES it; the v3 DAO's threshold 2 is rejected by v4).
// Same 19-step flow as the v3 demo, with the v4 numbers and rules:
//   * create_community is ASYNC (DAO verification callback): this
//     script polls get_community / is_community_pending after step 1
//     until the community appears.
//   * Attestation bond is proportional: 0.1 NEAR + 10% of the claim
//     (0.2 NEAR on a 1 NEAR entry), attached 0.21 NEAR with storage.
//   * Dispute bond is 0.05 NEAR, attached 0.06 NEAR with storage.
//   * DAO proposals need 3 approvals (alice, bob, carol vote).
//   * Dispute window 5 min / timelock 2 min for the demo (live
//     defaults are 7 days / 3 days).
//
//   OWNGROUND_CONTRACT=ownground4.testnet OWNGROUND_DAO=lagos-energy4.testnet \
//     DEMO_SELLER=seller.ownground4.testnet OWNGROUND_PARENT=ownground4.testnet \
//     OWNGROUND_COMMUNITY=lagos-energy-cooperative-6 node scripts/demo-v4.mjs
//
// Expected final numbers (v4, reconciled in contract/tests/demo.rs):
//   D = 2.7 NEAR; alice 0.3645, bob 0.3645, carol 0.3645, dave 0.5265;
//   retention 0.675, maintenance 0.405; final treasury 1.08 NEAR exactly.
// The dispute proof runs before the distribution and is upheld, so
// bob's 2 work points are removed and the 0.2 NEAR bond enters the
// treasury as revenue (total_revenue 3.2, D 2.7). Alice's 3 NEAR
// onchain deposit earns no work points. After the dispute resolves,
// dave records 1 NEAR reported revenue, carol attests it (0.2 NEAR
// bond), and nobody disputes it — so dave holds the only 2 work
// points at distribution and takes the whole 0.162 NEAR activity pool
// on top of his 0.3645 NEAR ownership share: 0.5265 NEAR against
// 0.3645 for the other three. The distribution waits out the
// 5-minute dispute window after dave's attestation (the timing guard
// blocks any earlier payout), then carol's bond is released in full
// before the payout.
//
// Demo accounts are test accounts only. Nothing here is mainnet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const N = 10n ** 24n;
const fmt = (v) => {
  const b = BigInt(v);
  return (b / N).toString() + "." + String(Number((b % N) * 1000n / N)).padStart(3, "0");
};
const CONTRACT = process.env.OWNGROUND_CONTRACT;
const DAO = process.env.OWNGROUND_DAO;
const SELLER = process.env.DEMO_SELLER;
// Member subaccounts live under one parent account: ownground.testnet
// for v1, ownground2.testnet for v2, ownground3.testnet for v3
// (OWNGROUND_PARENT). The demo's expected numbers are the v3 figures
// in the header above.
const PARENT = process.env.OWNGROUND_PARENT || 'ownground.testnet';
const MEMBERS = ["alice", "bob", "carol", "dave"].map((r) => `${r}.${PARENT}`);
const OPS = `ops.${PARENT}`;
// Community id: override with OWNGROUND_COMMUNITY to re-run the demo
// against a contract that already holds a community (v2 attempt 2).
const COMMUNITY = process.env.OWNGROUND_COMMUNITY || "lagos-energy-cooperative-6";
// The contract generates campaign and asset ids (e.g. lagos-energy-cooperative-c0,
// lagos-energy-cooperative-a0) and acquire_asset takes an ownership allocation.
// Both ids are read back from get_community after the calls that create them.
let CAMPAIGN_ID = "";
let ASSET_ID = "";
const GAS = "100000000000000"; // 100 TGas

let nearApi;
try {
  nearApi = await import("near-api-js");
} catch {
  console.error("near-api-js is not installed. Run: npm install near-api-js");
  process.exit(2);
}
const { connect, keyStores, utils } = nearApi;

if (!CONTRACT || !DAO || !SELLER) {
  console.error("Set OWNGROUND_CONTRACT, OWNGROUND_DAO and DEMO_SELLER first.");
  process.exit(2);
}

const keyStore = new keyStores.UnencryptedFileSystemKeyStore(
  // Root is ~/.near-credentials: near-api-js 5.x appends the network id,
  // so keys live at ~/.near-credentials/testnet/<account>.json (near-cli
  // layout). Pointing this at the testnet dir itself would make it look
  // under testnet/testnet/ and find nothing.
  path.join(os.homedir(), '.near-credentials'),
);
const near = await connect({
  networkId: "testnet",
  nodeUrl: "https://rpc.testnet.fastnear.com",
  walletUrl: "https://testnet.mynearwallet.com",
  helperUrl: "https://helper.testnet.near.org",
  explorerUrl: "https://testnet.nearblocks.io",
  keyStore,
});

const log = [];
function step(n, text) {
  console.log(`\n== Step ${n}: ${text}`);
  log.push(`Step ${n}: ${text}`);
}
function note(text) {
  console.log(`   ${text}`);
  log.push(`   ${text}`);
}
function assertEq(actual, expected, label) {
  const a = BigInt(actual);
  const e = BigInt(expected);
  if (a !== e) {
    console.error(`MISMATCH ${label}: got ${fmt(a)} NEAR, expected ${fmt(e)} NEAR`);
    process.exit(1);
  }
  console.log(`   ok ${label}: ${fmt(a)} NEAR`);
}
function assertTrue(cond, label) {
  if (!cond) { console.error(`MISMATCH ${label}`); process.exit(1); }
  console.log(`   ok ${label}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Receipts record: every transaction the demo sends, so scripts/verify.mjs
// --receipts can check each tx hash onchain afterwards (tx status +
// Transfer receipts proving the money moved). Written incrementally, so
// a partial run still leaves its receipts behind.
const RECEIPTS_FILE = new URL(`../demo-receipts-${COMMUNITY}.json`, import.meta.url);
const receipts = JSON.parse(fs.readFileSync(RECEIPTS_FILE, "utf8"));
function recordTx(label, signer, txHash, extra = {}) {
  if (!txHash) return;
  receipts.push({ label, signer, tx: txHash, ...extra });
  fs.writeFileSync(RECEIPTS_FILE, JSON.stringify(receipts, null, 2) + "\n");
}

async function account(id) {
  return near.account(id);
}
async function view(method, args) {
  const acc = await account(CONTRACT);
  const raw = await acc.viewFunction({ contractId: CONTRACT, methodName: method, args });
  return raw;
}
async function callAs(id, method, args, depositYocto, gas = GAS) {
  const acc = await account(id);
  const outcome = await acc.functionCall({
    contractId: CONTRACT,
    methodName: method,
    args,
    gas: BigInt(gas),
    attachedDeposit: BigInt(depositYocto),
  });
  recordTx(method, id, outcome?.transaction?.hash);
  // Settle pause: a view issued immediately after a write can read
  // pre-transaction state (the node lags finality by ~a block), so give
  // the write a moment to become visible before the next view.
  await sleep(1500);
  return outcome;
}
async function balanceOf(id) {
  const acc = await account(id);
  const s = await acc.getAccountBalance();
  return BigInt(s.total);
}
// A DAO proposal that calls one OwnGround method, voted through by two
// council members. Returns the proposal id and the final proposal state.
// `expect` describes the deciding vote's expected receipt outcome:
// "success", or "fail:<substring>" when the execution must panic with
// that reason (step 8's over-cap expense). Recorded in the receipts file.
async function daoCall(description, method, args, depositYocto, voters, expect = "success") {
  const dao = await account(DAO);
  // Sputnik v2 add_proposal takes { proposal: ProposalInput }; the action
  // gas/deposit are stringly-typed (U64/U128), as in the FairShare scripts.
  const proposalArgs = {
    proposal: {
      description,
      kind: {
        FunctionCall: {
          receiver_id: CONTRACT,
          actions: [{
            method_name: method,
            args: Buffer.from(JSON.stringify(args)).toString('base64'),
            deposit: depositYocto.toString(),
            gas: GAS.toString(),
          }],
        },
      },
    },
  };
  // Read the next proposal id BEFORE creating it: get_last_proposal_id
  // returns the id the next proposal will get, and reading it after the
  // add_proposal can return the stale pre-write count (same finality lag
  // as the views), which once made the demo vote on the previous, already
  // approved proposal. This is the FairShare pattern.
  const daoAcc = await account(DAO);
  const proposalId = Number(await daoAcc.viewFunction({ contractId: DAO, methodName: 'get_last_proposal_id', args: {} }));
  const addOutcome = await dao.functionCall({
    contractId: DAO,
    methodName: "add_proposal",
    args: proposalArgs,
    gas: BigInt(GAS),
    attachedDeposit: utils.format.parseNearAmount("1"),
  });
  recordTx("add_proposal", DAO, addOutcome?.transaction?.hash, { description });
  note(`DAO proposal ${proposalId}: ${description}`);
  // A vote that reaches threshold executes the proposal in the same
  // receipt chain, so if the contract call inside it panics (step 8's
  // over-cap expense), near-api-js throws on the vote itself. Catch it:
  // the vote landed, the proposal is decided, and the panic text is in
  // the error message — record it instead of crashing the demo.
  let lastOutcome = null;
  let voteError = null;
  for (let vi = 0; vi < voters.length; vi++) {
    const voter = voters[vi];
    const deciding = vi === voters.length - 1;
    const v = await account(voter);
    try {
      // 150 TGas: the deciding vote must cover the DAO's own cost PLUS the
      // 100 TGas the action forwards to the contract (FairShare votes use
      // 150 TGas for this reason).
      lastOutcome = await v.functionCall({
        contractId: DAO,
        methodName: 'act_proposal',
        args: { id: proposalId, action: 'VoteApprove' },
        gas: 150000000000000n,
        attachedDeposit: 0n,
      });
      recordTx(`dao:${method}`, voter, lastOutcome?.transaction?.hash,
        { description, deciding, expect: deciding ? expect : "success" });
      note(`${voter} voted Approve on proposal ${proposalId}`);
    } catch (e) {
      // Only swallow the error when the vote LANDED but the proposal
      // execution it triggered failed (the message carries the contract
      // ExecutionError). Any other failure — e.g. the voter cannot even
      // afford the vote's prepaid gas — means the vote never landed, so
      // re-throw at once instead of polling a proposal that stays open.
      if (!String(e.message || e).includes("ExecutionError")) throw e;
      voteError = e;
      // near-api-js attaches the outcome to the thrown error, so the
      // failed vote's tx hash is still recoverable for the receipts file.
      recordTx(`dao:${method}`, voter, e?.transaction_outcome?.id,
        { description, deciding, expect: deciding ? expect : "success" });
      note(`${voter} voted Approve on proposal ${proposalId} (execution failed: ${String(e.message).slice(0, 140)})`);
      break;
    }
  }
  // Poll until the proposal leaves InProgress.
  for (let i = 0; i < 30; i++) {
    const prop = await daoAcc.viewFunction({ contractId: DAO, methodName: "get_proposal", args: { id: proposalId } });
    if (prop.status !== "InProgress") {
      const panics = lastOutcome ? receiptPanics(lastOutcome) : [];
      if (voteError) {
        const m = String(voteError.message || voteError);
        if (!panics.includes(m)) panics.push(m);
      }
      return { proposalId, status: prop.status, panics };
    }
    await sleep(2000);
  }
  throw new Error(`DAO proposal ${proposalId} never left InProgress`);
}
// Scan a transaction outcome's receipts for a contract panic message.
function receiptPanics(outcome) {
  const found = [];
  const walk = (o) => {
    const s = o.status;
    if (s && typeof s === "object" && s.Failure) {
      const err = s.Failure.ActionError?.kind?.FunctionCallError?.ExecutionError
        || s.Failure.ActionError?.kind?.FunctionCallError?.MethodResolveError
        || JSON.stringify(s.Failure);
      found.push(String(err));
    }
    for (const r of o.receipts_outcome || []) walk(r.outcome);
  };
  walk(outcome);
  return found;
}

const [ALICE, BOB, CAROL, DAVE] = MEMBERS;


// Resume state: read the campaign / asset ids and dave's attestation time.
const comm0 = await view("get_community", { community_id: COMMUNITY });
CAMPAIGN_ID = comm0.campaign_ids[0];
ASSET_ID = comm0.asset_ids[0];
note(`resuming on campaign ${CAMPAIGN_ID}, asset ${ASSET_ID}`);
const rev0 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev0[2].status === "Verified", "entry 2 still Verified (resume precondition)");
assertEq(rev0[2].points_awarded, 2, "dave work points 2 (resume precondition)");
const pol0 = await view("get_policies", { community_id: COMMUNITY });
assertTrue(pol0.amendments.length === 1 && pol0.amendments[0].status === "Pending", "amendment 0 still pending (resume precondition)");
const amendmentDeadline = Number(BigInt(pol0.amendments[0].deadline) / 1000000n);
const daveVerifiedAt = Number(BigInt(rev0[2].verified_at) / 1000000n); // ms

// --- Step 14: execute the amendment (proof 8, part 2) --------------------
step(14, "Execute the spending-policy amendment after the timelock");
const waitMs = amendmentDeadline - Date.now() + 5000;
if (waitMs > 0) { note(`waiting ${Math.round(waitMs / 1000)}s for the timelock`); await sleep(waitMs); }
await callAs(ALICE, "execute_policy_change", { community_id: COMMUNITY, amendment_id: 0 }, (N / 100n).toString());
const pol2 = await view("get_policies", { community_id: COMMUNITY });
assertEq(pol2.spending.max_single_expense, 2n * N, "PROOF 8: spending cap now 2 NEAR");
assertTrue(pol2.amendments[0].status === "Executed", "amendment 0 Executed");

// --- Step 15: wait out the dispute window, release the bond ---------------
step(15, "Wait out the dispute window, then carol's 0.2 NEAR bond is released in full");
const windowWaitMs = daveVerifiedAt + 300000 - Date.now() + 5000;
if (windowWaitMs > 0) { note(`waiting ${Math.round(windowWaitMs / 1000)}s for the dispute window`); await sleep(windowWaitMs); }
await callAs(CAROL, "release_attestation_bond", { asset_id: ASSET_ID, entry_id: 2 }, (N / 100n).toString());
const rev7 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev7[2].bond_status === "Released", "carol's 0.2 NEAR bond released after the window passed undisputed");
const t8 = await view("get_treasury", { community_id: COMMUNITY });
assertEq(t8.total_bonds_held, 0, "no bonds held after the release");

// --- Step 16: distribution (proofs 5 and 6) ------------------------------
step(16, "Execute the distribution");
await callAs(ALICE, "execute_distribution", { asset_id: ASSET_ID }, (N / 100n).toString());
const dists = await view("get_distributions", { asset_id: ASSET_ID });
const d = dists[0];
assertEq(d.distributed, 27n * N / 10n, "D = 2.7 NEAR");
assertEq(d.member_total, 162n * N / 100n, "member pool 1.62 NEAR");
assertEq(d.retention, 675n * N / 1000n, "retention 0.675 NEAR");
assertEq(d.maintenance, 405n * N / 1000n, "maintenance 0.405 NEAR");
assertEq(d.activity_pool, 162n * N / 1000n, "activity pool 0.162 NEAR (all to dave)");
assertEq(d.ownership_pool, 1458n * N / 1000n, "ownership pool 1.458 NEAR");
const payout = (acct) => BigInt(d.payouts.find(([a]) => a === acct)?.[1] ?? 0);
assertEq(payout(ALICE), 3645n * N / 10000n, "alice 0.3645 NEAR (ownership only)");
assertEq(payout(BOB), 3645n * N / 10000n, "bob 0.3645 NEAR (ownership only, points removed)");
assertEq(payout(CAROL), 3645n * N / 10000n, "carol 0.3645 NEAR (ownership only)");
assertEq(payout(DAVE), 5265n * N / 10000n, "PROOF 5: dave 0.5265 NEAR — 0.3645 ownership + the whole 0.162 activity pool");
const actPay = (acct) => BigInt(d.activity_payouts.find(([a]) => a === acct)?.[1] ?? 0);
assertEq(actPay(DAVE), 162n * N / 1000n, "PROOF 5: dave's activity payout is the whole activity pool");
assertEq(actPay(ALICE) + actPay(BOB) + actPay(CAROL), 0, "no activity payout to anyone without work points");
assertEq(
  payout(ALICE) + payout(BOB) + payout(CAROL) + payout(DAVE) + BigInt(d.retention) + BigInt(d.maintenance),
  BigInt(d.distributed),
  "PROOF 6: total payouts equal D exactly",
);
assertTrue(d.unpaid.length === 0, "no unpaid members");

// --- Step 17: final state -------------------------------------------------
step(17, "Final state");
const tf = await view("get_treasury", { community_id: COMMUNITY });
assertEq(tf.treasury, 108n * N / 100n, "final treasury 1.08 NEAR (retention 0.675 + maintenance 0.405 remain as reserves)");
assertEq(tf.distributable, 0, "nothing left distributable");
assertEq(tf.total_bonds_held, 0, "no bonds held at the end");
const actF = await view("get_activity", { asset_id: ASSET_ID });
assertTrue(actF.work_points.every(([, p]) => p.current === 0), "epoch reset: current work points 0");
assertTrue(actF.epoch === 1, "epoch advanced to 1");

console.log("\nDEMO COMPLETE (resumed at step 14 after the first process was lost mid-wait; steps 0-13 verified live on this same community). All nine proofs verified:");
console.log("  1. Valid expense succeeds (0.5 NEAR operations).");
console.log("  2. Excessive expense fails onchain with the spending-policy reason.");
console.log("  3. Unverified revenue earns no points (bob 0 before attestation).");
console.log("  4. Verified activity earns points (bob 2 after attestation).");
console.log("  5. The activity slice pays the worker: dave 0.5265 NEAR against 0.3645 for the others — his attested, undisputed entry earned the whole 0.162 NEAR activity pool.");
console.log("  6. Total payouts equal D exactly (2.7 NEAR).");
console.log("  7. Dispute flow: disputed, DAO upholds, entry rejected, points removed, bond to treasury.");
console.log("  8. Policy amendment flow: proposed, timelock waited, executed, cap 1 to 2 NEAR.");
console.log("  9. An undisputed attestation's bond is returned in full after the dispute window (carol's 0.2 NEAR).");
console.log("\nDemo log (resume part):\n" + log.join("\n"));
console.log(`\nReceipts file: ${RECEIPTS_FILE.pathname} (${receipts.length} transactions recorded)`);
