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
// v4: create_community is ASYNC — the community only appears once the
// on_dao_verified callback lands. Poll until it exists (or fails).
let community = null;
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  try {
    const c = await view("get_community", { community_id: COMMUNITY });
    if (c && c.id === COMMUNITY) { community = c; break; }
  } catch (e) { /* not created yet */ }
  const pending = await view("is_community_pending", { community_id: COMMUNITY }).catch(() => null);
  note(`waiting for DAO verification… pending=${pending}`);
  if (pending === false && !community) {
    throw new Error("community verification failed: pending record removed, community never created (DAO policy mismatch?)");
  }
}
if (!community) throw new Error("timed out waiting for community creation after DAO verification");
note("community created after DAO verification");
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
}, (N / 100n).toString(), [ALICE, BOB, CAROL]);
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
step(7, "Alice attests bob's entry with a 0.2 NEAR bond (proof: verified activity earns points)");
await callAs(ALICE, "attest_revenue", { asset_id: ASSET_ID, entry_id: 1 }, ((2n * N / 10n) + (N / 100n)).toString());
const rev3 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev3[1].status === "Verified", "entry 1 Verified by attestation");
assertEq(rev3[1].points_awarded, 2, "PROOF 4: bob work points 2 (1 + 1 per NEAR)");
const t3 = await view("get_treasury", { community_id: COMMUNITY });
assertEq(t3.total_bonds_held, 2n * N / 10n, "bond held 0.2 NEAR (0.1 + 10% of 1 NEAR)");

// --- Step 8: over-cap expense fails onchain (proof 2) --------------------
step(8, "DAO tries a 2 NEAR expense (proof: excessive expense fails onchain with the reason)");
const bad = await daoCall("Pay 2 NEAR for operations", "pay_expense", {
  asset_id: ASSET_ID, amount: (2n * N).toString(), recipient: OPS,
  description: "Oversized service bill", category: "operations",
}, (N / 100n).toString(), [ALICE, BOB, CAROL], "fail:expense exceeds max_single_expense");
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
}, (N / 100n).toString(), [ALICE, BOB, CAROL]);
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
}, (N / 100n).toString(), [ALICE, BOB, CAROL]);
const pol1 = await view("get_policies", { community_id: COMMUNITY });
assertTrue(pol1.amendments.length === 1 && pol1.amendments[0].status === "Pending", "amendment 0 pending");
assertEq(pol1.spending.max_single_expense, N, "old policy still in force while the amendment is pending");
const amendmentDeadline = Number(BigInt(pol1.amendments[0].deadline) / 1000000n);

// --- Step 11: dispute flow (proof 7, part 1) ----------------------------
step(11, "Carol disputes bob's attested entry with a 0.05 NEAR dispute bond (points suspended)");
await callAs(CAROL, "dispute_revenue", { asset_id: ASSET_ID, entry_id: 1 }, ((5n * N / 100n) + (N / 100n)).toString());
const rev4 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev4[1].status === "Disputed", "entry 1 Disputed, points suspended");
const act1 = await view("get_activity", { asset_id: ASSET_ID });
const bobNow = act1.work_points.find(([a]) => a === BOB);
assertEq(bobNow ? bobNow[1].current : 0, 0, "bob current work points 0 while disputed");

// --- Step 12: DAO upholds the dispute (proof 7, part 2) -----------------
step(12, "DAO upholds the dispute: entry rejected, points removed, bond to treasury");
await daoCall("Uphold the dispute on entry 1", "resolve_dispute", {
  asset_id: ASSET_ID, entry_id: 1, uphold: true,
}, (N / 100n).toString(), [ALICE, BOB, CAROL]);
const rev5 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev5[1].status === "Rejected", "PROOF 7: entry 1 Rejected");
assertTrue(rev5[1].bond_status === "Forfeited", "bond forfeited");
const t6 = await view("get_treasury", { community_id: COMMUNITY });
assertEq(t6.total_revenue, 32n * N / 10n, "total revenue 3.2 NEAR (3 onchain + 0.2 forfeited bond)");
assertEq(t6.total_dispute_bonds_held, 0, "no dispute bonds held after the resolution (carol's 0.05 returned)");
assertEq(t6.total_bonds_held, 0, "no bonds held after the forfeit");

// --- Step 13: the visible reward (v3) -------------------------------------
// After the dispute resolves, dave records 1 NEAR reported revenue and
// carol attests it with a 0.2 NEAR bond. Nobody disputes it, so dave's
// 2 work points stand at distribution — the activity pool will pay
// him, visibly, on top of his ownership share.
step(13, "Dave records 1 NEAR reported revenue, carol attests it (the visible reward)");
await callAs(DAVE, "record_revenue", {
  asset_id: ASSET_ID, amount: N.toString(), source: "Generator rental", reference: "invoice-003",
}, (N / 100n).toString());
await callAs(CAROL, "attest_revenue", { asset_id: ASSET_ID, entry_id: 2 }, ((2n * N / 10n) + (N / 100n)).toString());
const rev6 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev6[2].status === "Verified", "entry 2 Verified by attestation");
assertEq(rev6[2].points_awarded, 2, "dave work points 2 (1 + 1 per NEAR)");
assertTrue(rev6[2].recorded_by === DAVE, "entry 2 recorded by dave");
assertTrue(rev6[2].attestor === CAROL, "entry 2 attested by carol (a different member)");
const t7 = await view("get_treasury", { community_id: COMMUNITY });
assertEq(t7.total_bonds_held, 2n * N / 10n, "carol's bond held 0.2 NEAR");
const daveVerifiedAt = Number(BigInt(rev6[2].verified_at) / 1000000n); // ms

// --- Step 14: execute the amendment (proof 8, part 2) --------------------
step(14, "Execute the spending-policy amendment after the timelock");
const waitMs = amendmentDeadline - Date.now() + 5000;
if (waitMs > 0) { note(`waiting ${Math.round(waitMs / 1000)}s for the timelock`); await sleep(waitMs); }
await callAs(ALICE, "execute_policy_change", { community_id: COMMUNITY, amendment_id: 0 }, (N / 100n).toString());
const pol2 = await view("get_policies", { community_id: COMMUNITY });
assertEq(pol2.spending.max_single_expense, 2n * N, "PROOF 8: spending cap now 2 NEAR");
assertTrue(pol2.amendments[0].status === "Executed", "amendment 0 Executed");

// --- Step 15: wait out the dispute window, release the bond ---------------
// The v3 distribution-timing guard blocks any payout while dave's
// entry is Verified but still inside its 5-minute dispute window, so
// the demo waits the window out — then carol's bond is released in
// full (an undisputed attestation costs the attestor nothing).
step(15, "Wait out the dispute window, then carol's bond is released in full");
const windowWaitMs = daveVerifiedAt + 300000 - Date.now() + 5000;
if (windowWaitMs > 0) { note(`waiting ${Math.round(windowWaitMs / 1000)}s for the dispute window`); await sleep(windowWaitMs); }
await callAs(CAROL, "release_attestation_bond", { asset_id: ASSET_ID, entry_id: 2 }, (N / 100n).toString());
const rev7 = await view("get_revenue", { asset_id: ASSET_ID });
assertTrue(rev7[2].bond_status === "Released", "carol's bond released after the window passed undisputed");
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

console.log("\nDEMO COMPLETE. All nine proofs verified:");
console.log("  1. Valid expense succeeds (0.5 NEAR operations).");
console.log("  2. Excessive expense fails onchain with the spending-policy reason.");
console.log("  3. Unverified revenue earns no points (bob 0 before attestation).");
console.log("  4. Verified activity earns points (bob 2 after attestation).");
console.log("  5. The activity slice pays the worker: dave 0.5265 NEAR against 0.3645 for the others — his attested, undisputed entry earned the whole 0.162 NEAR activity pool.");
console.log("  6. Total payouts equal D exactly (2.7 NEAR).");
console.log("  7. Dispute flow: disputed, DAO upholds, entry rejected, points removed, bond to treasury.");
console.log("  8. Policy amendment flow: proposed, timelock waited, executed, cap 1 to 2 NEAR.");
console.log("  9. An undisputed attestation's bond is returned in full after the dispute window (carol's 0.2 NEAR).");
console.log("\nDemo log:\n" + log.join("\n"));
console.log(`\nReceipts file: ${RECEIPTS_FILE.pathname} (${receipts.length} transactions recorded)`);
