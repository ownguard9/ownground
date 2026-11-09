// OwnGround demo run: Lagos Energy Cooperative.
// RAN LIVE on testnet 2026-11-09: contract ownground.testnet, DAO
// lagos-energy.testnet, members alice/bob/carol/dave.ownground.testnet,
// seller seller.ownground.testnet. Run output is saved to
// demo-log-live.txt. V2 (remediation re-demo) runs the same 17 steps
// against ownground2.testnet / lagos-energy2.testnet with
// OWNGROUND_PARENT=ownground2.testnet; expected numbers are the v2
// figures in the header below (payouts 0.39 each — see step 14).
//
//   1. npm install near-api-js@5.1.1   (in ~/workspace/commonhold)
//   2. Create the demo accounts on testnet and fund them:
//      alice.ownground.testnet (6.5 NEAR), bob/carol/dave.ownground.testnet
//      (3 NEAR each), seller.ownground.testnet (0.2 NEAR), plus the
//      Sputnik DAO lagos-energy.testnet with the four as council,
//      threshold 2 (absolute Weight threshold, not the factory default
//      Ratio 1/2, which would need 3 of 4 approvals).
//      Keys must be in ~/.near-credentials/testnet (near-cli layout).
//      Member names are subaccounts of ownground.testnet because the
//      top-level alice.testnet etc. are taken by other people.
//   3. OWNGROUND_CONTRACT=ownground.testnet OWNGROUND_DAO=lagos-energy.testnet \
//      DEMO_SELLER=seller.ownground.testnet node scripts/demo.mjs
//
// The DAO is NOT a sputnikv2.testnet factory subaccount: a factory DAO is
// keyless, but this script signs add_proposal as the DAO itself, so the DAO
// was deployed directly (live Sputnik v2 wasm, read off-chain from
// genesis.sputnikv2.testnet) to lagos-energy.testnet, whose key we hold —
// the same approach FairShare used for fairshare-dao.testnet.
//
// The script verifies every expected number and aborts on the first
// mismatch. Expected final numbers (DESIGN.md fix 11 and 15, as
// revised when onchain deposits stopped earning work points):
//   D = 2.6 NEAR; alice 0.39, bob 0.39, carol 0.39, dave 0.39;
//   retention 0.65, maintenance 0.39; final treasury 1.04 NEAR exactly.
// The dispute proof runs before the distribution and is upheld, so
// bob's 2 work points are removed and the 0.1 NEAR bond enters the
// treasury as revenue (total_revenue 3.1, D 2.6). Alice's 3 NEAR
// onchain deposit earns no work points (a deposit proves money moved,
// not that the asset earned it), so no verified work stands at
// distribution and the activity slice falls back to ownership: the
// whole 1.56 NEAR member pool splits by ownership, 0.39 each.
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
// for v1, ownground2.testnet for v2 (OWNGROUND_PARENT). The demo's
// expected numbers are the same on either parent.
const PARENT = process.env.OWNGROUND_PARENT || 'ownground.testnet';
const MEMBERS = ["alice", "bob", "carol", "dave"].map((r) => `${r}.${PARENT}`);
const OPS = `ops.${PARENT}`;
// Community id: override with OWNGROUND_COMMUNITY to re-run the demo
// against a contract that already holds a community (v2 attempt 2).
const COMMUNITY = process.env.OWNGROUND_COMMUNITY || "lagos-energy-cooperative";
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
const receipts = [];
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

// --- Step 0: setup -------------------------------------------------------
step(0, "Setup check");
for (const m of MEMBERS) {
  const b = await balanceOf(m);
  assertTrue(b >= 26n * N / 10n, `${m} holds at least 2.6 NEAR (has ${fmt(b)})`);
}
note("DAO is " + DAO + ", seller is " + SELLER + ", contract is " + CONTRACT);

// --- Step 1: create the community ---------------------------------------
step(1, "Create the community (founding policies set here)");
await callAs(ALICE, "create_community", {
  id: COMMUNITY,
  name: "Lagos Energy Cooperative",
  description: "Neighbours owning a generator together",
  dao_id: DAO,
  members: MEMBERS,
  distribution_policy: { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 1000 },
  spending_policy: {
    max_single_expense: (1n * N).toString(),
    min_treasury_reserve: (1n * N).toString(),
    allowed_categories: ["maintenance", "operations"],
  },
  activity_policy: { capital_per_near: 1, work_per_revenue_record: 1, work_per_revenue_near: 1 },
  dispute_window_ns: 300000000000, // 5 minutes for the demo (default 7 days)
  timelock_ns: 120000000000,       // 2 minutes for the demo (default 3 days)
}, (N / 10n).toString());
const community = await view("get_community", { community_id: COMMUNITY });
assertTrue(community.members.length === 4, "4 members fixed at creation");
assertEq(community.policy.members_bp, 6000, "founding members share 60%");
assertEq(community.spending_policy.max_single_expense, N, "founding spending cap 1 NEAR");

// --- Step 2: create the campaign ----------------------------------------
step(2, "Create the generator campaign, target 10 NEAR");
const deadline = Date.now() * 1000000 + 86400000000000; // 24 hours from now, ns
await callAs(ALICE, "create_campaign", {
  community_id: COMMUNITY,
  asset_name: "Generator",
  category: "energy",
  target: (10n * N).toString(),
  deadline,
}, (5n * N / 100n).toString());
const commAfterCampaign = await view("get_community", { community_id: COMMUNITY });
CAMPAIGN_ID = commAfterCampaign.campaign_ids[0];
note(`campaign id is ${CAMPAIGN_ID}`);
const campaign = await view("get_campaign", { campaign_id: CAMPAIGN_ID });
assertEq(campaign.target, 10n * N, "campaign target 10 NEAR");

// --- Step 3: four contributions ------------------------------------------
step(3, "Four members contribute 2.5 NEAR each");
for (const m of MEMBERS) {
  await callAs(m, "contribute", { campaign_id: CAMPAIGN_ID }, ((25n * N / 10n) + (N / 100n)).toString());
  note(`${m} contributed 2.5 NEAR`);
}
const funded = await view("get_campaign", { campaign_id: CAMPAIGN_ID });
assertEq(funded.raised, 10n * N, "raised 10 NEAR");
assertTrue(funded.status === "Funded", "campaign Funded");

// --- Step 4: DAO acquires the generator ----------------------------------
step(4, "DAO acquires the generator, 10 NEAR to the seller");
const sellerBefore = await balanceOf(SELLER);
const acq = await daoCall("Acquire the generator for 10 NEAR", "acquire_asset", {
  campaign_id: CAMPAIGN_ID,
  seller: SELLER,
  allocation: [[ALICE, 2500], [BOB, 2500], [CAROL, 2500], [DAVE, 2500]],
}, (N / 100n).toString(), [ALICE, BOB]);
assertTrue(acq.status === "Approved", `acquisition proposal ${acq.status}`);
const sellerAfter = await balanceOf(SELLER);
assertEq(sellerAfter - sellerBefore, 10n * N, "seller received 10 NEAR");
const commAfterAcquire = await view("get_community", { community_id: COMMUNITY });
ASSET_ID = commAfterAcquire.asset_ids[0];
note(`asset id is ${ASSET_ID}`);
const asset = await view("get_asset", { asset_id: ASSET_ID });
assertEq(asset.value, 10n * N, "asset value 10 NEAR");
assertTrue(asset.seller === SELLER, "asset seller recorded");

// --- Step 5: onchain revenue ---------------------------------------------
step(5, "Alice records 3 NEAR onchain revenue");
await callAs(ALICE, "record_revenue", {
  asset_id: ASSET_ID, amount: (3n * N).toString(), source: "Generator rental", reference: "invoice-001",
}, ((3n * N) + (N / 100n)).toString());
const rev1 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev1[0].status === "Onchain", "entry 0 Onchain (deposit confirmed)");
assertEq(rev1[0].points_awarded, 0, "alice work points 0 (onchain deposit earns no points)");

// --- Step 6: reported revenue (proof 3) ----------------------------------
step(6, "Bob records 1 NEAR reported revenue (proof: unverified earns no points)");
await callAs(BOB, "record_revenue", {
  asset_id: ASSET_ID, amount: N.toString(), source: "Generator rental", reference: "invoice-002",
}, (N / 100n).toString());
const rev2 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev2[1].status === "Pending", "entry 1 Reported, not independently verified");
assertEq(rev2[1].points_awarded, 0, "PROOF 3: unverified revenue earns no points");

// --- Step 7: attestation (proof 4) ---------------------------------------
step(7, "Alice attests bob's entry with a 0.1 NEAR bond (proof: verified activity earns points)");
await callAs(ALICE, "attest_revenue", { asset_id: ASSET_ID, entry_id: 1 }, ((N / 10n) + (N / 100n)).toString());
const rev3 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev3[1].status === "Verified", "entry 1 Verified by attestation");
assertEq(rev3[1].points_awarded, 2, "PROOF 4: bob work points 2 (1 + 1 per NEAR)");
const t3 = await view("get_treasury", { community_id: COMMUNITY });
assertEq(t3.total_bonds_held, N / 10n, "bond held 0.1 NEAR");

// --- Step 8: over-cap expense fails onchain (proof 2) --------------------
step(8, "DAO tries a 2 NEAR expense (proof: excessive expense fails onchain with the reason)");
const bad = await daoCall("Pay 2 NEAR for operations", "pay_expense", {
  asset_id: ASSET_ID, amount: (2n * N).toString(), recipient: OPS,
  description: "Oversized service bill", category: "operations",
}, (N / 100n).toString(), [ALICE, BOB], "fail:expense exceeds max_single_expense");
// The DAO proposal executes, but the contract call inside it must fail
// with the spending-policy panic. The treasury must be unchanged.
const t4 = await view("get_treasury", { community_id: COMMUNITY });
assertEq(t4.total_expenses, 0, "PROOF 2: no expense recorded after the over-cap attempt");
assertTrue(t4.treasury === (3n * N).toString(), "treasury still 3 NEAR after the failed expense");
assertTrue(
  bad.panics.some((p) => p.includes("expense exceeds max_single_expense")),
  `PROOF 2: the contract panic names the rule (receipts showed: ${bad.panics.join(" | ") || "none"})`,
);

// --- Step 9: valid expense succeeds (proof 1) ---------------------------
step(9, "DAO pays a 0.5 NEAR operations expense (proof: valid expense succeeds)");
await daoCall("Pay 0.5 NEAR for operations", "pay_expense", {
  asset_id: ASSET_ID, amount: (5n * N / 10n).toString(), recipient: OPS,
  description: "Generator service", category: "operations",
}, (N / 100n).toString(), [ALICE, BOB]);
const t5 = await view("get_treasury", { community_id: COMMUNITY });
assertEq(t5.total_expenses, 5n * N / 10n, "PROOF 1: expense 0.5 NEAR recorded");
assertEq(t5.treasury, 25n * N / 10n, "treasury 2.5 NEAR after the expense");

// --- Step 10: propose the spending-policy amendment (proof 8, part 1) ----
step(10, "DAO proposes raising the spending cap from 1 to 2 NEAR (amendment timelock starts)");
await daoCall("Propose spending cap 1 to 2 NEAR", "propose_policy_change", {
  community_id: COMMUNITY,
  policy_type: "Spending",
  new_params: { Spending: {
    max_single_expense: (2n * N).toString(),
    min_treasury_reserve: (1n * N).toString(),
    allowed_categories: ["maintenance", "operations"],
  } },
}, (N / 100n).toString(), [ALICE, BOB]);
const pol1 = await view("get_policies", { community_id: COMMUNITY });
assertTrue(pol1.amendments.length === 1 && pol1.amendments[0].status === "Pending", "amendment 0 pending");
assertEq(pol1.spending.max_single_expense, N, "old policy still in force while the amendment is pending");
const amendmentDeadline = Number(BigInt(pol1.amendments[0].deadline) / 1000000n);

// --- Step 11: dispute flow (proof 7, part 1) ----------------------------
step(11, "Carol disputes bob's attested entry (points suspended)");
await callAs(CAROL, "dispute_revenue", { asset_id: ASSET_ID, entry_id: 1 }, (N / 100n).toString());
const rev4 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev4[1].status === "Disputed", "entry 1 Disputed, points suspended");
const act1 = await view("get_activity", { asset_id: ASSET_ID });
const bobNow = act1.work_points.find(([a]) => a === BOB);
assertEq(bobNow ? bobNow[1].current : 0, 0, "bob current work points 0 while disputed");

// --- Step 12: DAO upholds the dispute (proof 7, part 2) -----------------
step(12, "DAO upholds the dispute: entry rejected, points removed, bond to treasury");
await daoCall("Uphold the dispute on entry 1", "resolve_dispute", {
  asset_id: ASSET_ID, entry_id: 1, uphold: true,
}, (N / 100n).toString(), [ALICE, BOB]);
const rev5 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev5[1].status === "Rejected", "PROOF 7: entry 1 Rejected");
assertTrue(rev5[1].bond_status === "Forfeited", "bond forfeited");
const t6 = await view("get_treasury", { community_id: COMMUNITY });
assertEq(t6.total_revenue, 31n * N / 10n, "total revenue 3.1 NEAR (3 onchain + 0.1 bond)");
assertEq(t6.total_bonds_held, 0, "no bonds held after the forfeit");

// --- Step 13: execute the amendment (proof 8, part 2) --------------------
step(13, "Execute the spending-policy amendment after the timelock");
const waitMs = amendmentDeadline - Date.now() + 5000;
if (waitMs > 0) { note(`waiting ${Math.round(waitMs / 1000)}s for the timelock`); await sleep(waitMs); }
await callAs(ALICE, "execute_policy_change", { community_id: COMMUNITY, amendment_id: 0 }, (N / 100n).toString());
const pol2 = await view("get_policies", { community_id: COMMUNITY });
assertEq(pol2.spending.max_single_expense, 2n * N, "PROOF 8: spending cap now 2 NEAR");
assertTrue(pol2.amendments[0].status === "Executed", "amendment 0 Executed");

// --- Step 14: distribution (proofs 5 and 6) ------------------------------
step(14, "Execute the distribution");
await callAs(ALICE, "execute_distribution", { asset_id: ASSET_ID }, (N / 100n).toString());
const dists = await view("get_distributions", { asset_id: ASSET_ID });
const d = dists[0];
assertEq(d.distributed, 26n * N / 10n, "D = 2.6 NEAR");
assertEq(d.member_total, 156n * N / 100n, "member pool 1.56 NEAR");
assertEq(d.retention, 65n * N / 100n, "retention 0.65 NEAR");
assertEq(d.maintenance, 39n * N / 100n, "maintenance 0.39 NEAR");
assertEq(d.activity_pool, 0, "activity pool 0 NEAR (no verified work stands)");
assertEq(d.ownership_pool, 156n * N / 100n, "ownership pool 1.56 NEAR");
const payout = (acct) => BigInt(d.payouts.find(([a]) => a === acct)?.[1] ?? 0);
assertEq(payout(ALICE), 390n * N / 1000n, "PROOF 5: alice 0.39 NEAR (ownership only, activity slice falls back)");
assertEq(payout(BOB), 390n * N / 1000n, "bob 0.39 NEAR (ownership only, points removed)");
assertEq(payout(CAROL), 390n * N / 1000n, "carol 0.39 NEAR");
assertEq(payout(DAVE), 390n * N / 1000n, "dave 0.39 NEAR");
assertEq(
  payout(ALICE) + payout(BOB) + payout(CAROL) + payout(DAVE) + BigInt(d.retention) + BigInt(d.maintenance),
  BigInt(d.distributed),
  "PROOF 6: total payouts equal D exactly",
);
assertTrue(d.unpaid.length === 0, "no unpaid members");

// --- Step 15: final state -------------------------------------------------
step(15, "Final state");
const tf = await view("get_treasury", { community_id: COMMUNITY });
assertEq(tf.treasury, 104n * N / 100n, "final treasury 1.04 NEAR (retention 0.65 + maintenance 0.39 remain as reserves)");
assertEq(tf.distributable, 0, "nothing left distributable");
const actF = await view("get_activity", { asset_id: ASSET_ID });
assertTrue(actF.work_points.every(([, p]) => p.current === 0), "epoch reset: current work points 0");
assertTrue(actF.epoch === 1, "epoch advanced to 1");

console.log("\nDEMO COMPLETE. All eight proofs verified:");
console.log("  1. Valid expense succeeds (0.5 NEAR operations).");
console.log("  2. Excessive expense fails onchain with the spending-policy reason.");
console.log("  3. Unverified revenue earns no points (bob 0 before attestation).");
console.log("  4. Verified activity earns points (bob 2 after attestation).");
console.log("  5. With no verified work standing at distribution, the activity slice falls back to ownership and all four equal owners get 0.39 NEAR.");
console.log("  6. Total payouts equal D exactly (2.6 NEAR).");
console.log("  7. Dispute flow: disputed, DAO upholds, entry rejected, points removed, bond to treasury.");
console.log("  8. Policy amendment flow: proposed, timelock waited, executed, cap 1 to 2 NEAR.");
console.log("\nDemo log:\n" + log.join("\n"));
console.log(`\nReceipts file: ${RECEIPTS_FILE.pathname} (${receipts.length} transactions recorded)`);
