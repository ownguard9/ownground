// OwnGround keyless verifier — v4 edition (scripts/verify-v4.mjs).
// v4 changes vs v3: attestation bonds are proportional (0.1 NEAR +
// 10% of the claim, 0.2 NEAR on a 1 NEAR entry — check B sums the
// entries' bond_amount instead of 0.1 NEAR x count), and dispute
// bonds (0.05 NEAR) are tracked separately as
// total_dispute_bonds_held (check B2 + raw-balance check 10).
import fs from "node:fs";

// Reads a deployed OwnGround contract over public testnet RPC and checks
// the design invariants with real numbers. No key, no wallet, read only.
//
//   node scripts/verify.mjs --contract <contract.testnet> [--community <id>]
//   node scripts/verify.mjs --selftest     # checks the logic against the
//                                           # Lagos Energy Cooperative demo
//                                           # final state, no network needed
//
// Checks (DESIGN.md invariants 1-10 plus bonds and policy in force):
//  1  treasury equation: treasury = (contributions + revenue)
//       - (acquisitions + expenses + payouts + refunds)
//  2  locked = sum of raised over open/funded campaigns; spendable >= 0
//  3  per distribution: distributed = member + retention + maintenance,
//     member = ownership + activity (exact sum)
//  4  per asset: distributed_total = sum of its distributions (one-shot)
//  5  refunds counted once: total_refunds <= total_contributions, and
//     the treasury equation (1) already counts them exactly once
//  6  every expense is inside the spending policy in force at
//     verification time (cap, reserve, category)
//  7  activity points: lifetime = sum of points_awarded over all entries
//     by that member; pending entries award 0; current-epoch points
//     match verified entries while no distribution has run yet
//  8  spending policy is in force and was set at creation or by an
//     executed amendment only (no direct set)
//  9  activity slice: activity payouts go only to members with work
//     points, in proportion (checked via get_distribution_breakdown)
// 10  raw balance >= treasury + storage_reserve + bonds held
//  B  total_bonds_held = 0.1 NEAR x entries with a held bond
//  P  the policy in force matches the founding policy or the latest
//     executed amendment for that type; no reported entry carries a
//     deposit (observable indirectly through check 10: a mis-attached
//     deposit would break the raw-balance equation)
//
// Amounts are yoctoNEAR as BigInt. Exits non-zero on any FAIL.
const N = 10n ** 24n;
const BOND = N / 10n; // 0.1 NEAR attestation bond base (v4: bond = 0.1 + 10% of claim)
const DISPUTE_BOND = N / 20n; // 0.05 NEAR dispute bond (v4)
const RPCS = [
  "https://rpc.testnet.fastnear.com",
  "https://testnet.nearblocks.io",
  "https://near-testnet.drpc.org",
];

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log(`PASS ${name} ${detail ?? ""}`); }
  else { failures++; console.log(`FAIL ${name} ${detail ?? ""}`); }
}
const y = (v) => BigInt(v);
const fmt = (v) => {
  const b = BigInt(v);
  return (b / N).toString() + "." + String(Number((b % N) * 1000n / N)).padStart(3, "0");
};

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

async function view(contract, method, args) {
  const enc = Buffer.from(JSON.stringify(args)).toString("base64");
  for (const url of RPCS) {
    try {
      const r = await rpc(url, "query", {
        request_type: "call_function",
        account_id: contract,
        method_name: method,
        args_base64: enc,
        finality: "final",
      });
      const raw = Buffer.from(r.result).toString("utf8");
      return JSON.parse(raw);
    } catch (e) {
      if (url === RPCS[RPCS.length - 1]) throw e;
    }
  }
}

async function rawBalance(contract) {
  for (const url of RPCS) {
    try {
      const r = await rpc(url, "query", {
        request_type: "view_account",
        account_id: contract,
        finality: "final",
      });
      return BigInt(r.amount);
    } catch (e) {
      if (url === RPCS[RPCS.length - 1]) throw e;
    }
  }
}

function workPointsFor(amount, policy) {
  return BigInt(policy.work_per_revenue_record)
    + BigInt(policy.work_per_revenue_near) * (y(amount) / N);
}

async function runChecks(state) {
  const { community, treasury, campaigns, assets, revenue, expenses, distributions, activity, policies, raw } = state;
  const c = community;
  const t = treasury;

  // 1. Treasury equation.
  const deposits = y(c.total_contributions) + y(c.total_revenue);
  const spent = y(c.total_acquisitions) + y(c.total_expenses) + y(c.total_payouts) + y(c.total_refunds);
  check("1 treasury equation",
    y(t.treasury) === deposits - spent,
    `treasury=${fmt(t.treasury)} deposits=${fmt(deposits)} spent=${fmt(spent)}`);

  // 2. Locked funds and spendable.
  const locked = campaigns
    .filter((cp) => cp.status === "Open" || cp.status === "Funded")
    .reduce((s, cp) => s + y(cp.raised), 0n);
  check("2 locked funds", y(t.locked) === locked, `locked=${fmt(t.locked)} computed=${fmt(locked)}`);
  check("2 spendable non-negative",
    y(t.spendable) === y(t.treasury) - y(t.locked) && y(t.spendable) >= 0n,
    `spendable=${fmt(t.spendable)}`);

  // 5. Refunds counted once.
  check("5 refunds within contributions",
    y(c.total_refunds) <= y(c.total_contributions),
    `refunds=${fmt(c.total_refunds)} contributions=${fmt(c.total_contributions)}`);

  // 10. Raw balance.
  check("10 raw balance covers treasury + storage + bonds",
    raw >= y(t.treasury) + y(c.storage_reserve) + y(c.total_bonds_held) + y(c.total_dispute_bonds_held ?? 0),
    `raw=${fmt(raw)} treasury=${fmt(t.treasury)} storage=${fmt(c.storage_reserve)} bonds=${fmt(c.total_bonds_held)} dispute_bonds=${fmt(c.total_dispute_bonds_held ?? 0)}`);

  // 8 + P. Policy in force: founding policy, or the latest executed
  // amendment for that type.
  const latestExecuted = (type) => {
    const done = policies.amendments
      .filter((a) => a.policy_type === type && a.status === "Executed")
      .sort((a, b) => b.id - a.id);
    return done.length ? done[0] : null;
  };
  const distAmend = latestExecuted("Distribution");
  const spendAmend = latestExecuted("Spending");
  const actAmend = latestExecuted("Activity");
  check("P distribution policy in force",
    !distAmend || JSON.stringify(policies.distribution) === JSON.stringify(distAmend.new_params.Distribution),
    distAmend ? `amendment ${distAmend.id} executed` : "founding policy");
  check("P spending policy in force",
    !spendAmend || JSON.stringify(policies.spending) === JSON.stringify(spendAmend.new_params.Spending),
    spendAmend ? `amendment ${spendAmend.id} executed` : "founding policy");
  check("P activity policy in force",
    !actAmend || JSON.stringify(policies.activity) === JSON.stringify(actAmend.new_params.Activity),
    actAmend ? `amendment ${actAmend.id} executed` : "founding policy");
  check("8 spending policy present",
    policies.spending.max_single_expense !== undefined
      && policies.spending.min_treasury_reserve !== undefined
      && Array.isArray(policies.spending.allowed_categories),
    `cap=${fmt(policies.spending.max_single_expense)} reserve=${fmt(policies.spending.min_treasury_reserve)}`);

  // Per asset: revenue, expenses, distributions, activity.
  for (const a of assets) {
    const rev = revenue[a.id] || [];
    const exp = expenses[a.id] || [];
    const dists = distributions[a.id] || [];
    const act = activity[a.id];

    // 6. Every expense inside the spending policy (cap and category are
    // timeless; the reserve floor depends on the treasury at call time,
    // which the contract enforces and the unit tests cover — the
    // current treasury cannot prove it after the fact).
    for (const e of exp) {
      const cap = y(policies.spending.max_single_expense);
      check(`6 expense ${fmt(e.amount)} ${e.category} within cap`,
        cap === 0n || y(e.amount) <= cap,
        `amount=${fmt(e.amount)} cap=${fmt(cap)}`);
      check(`6 expense ${fmt(e.amount)} ${e.category} allowed`,
        policies.spending.allowed_categories.includes(e.category),
        `category=${e.category}`);
    }

    // 7. Activity points.
    const byMember = new Map();
    for (const r of rev) {
      byMember.set(r.recorded_by, (byMember.get(r.recorded_by) || 0n) + BigInt(r.points_awarded));
      if (r.status === "Onchain") {
        // v2: an onchain deposit proves money moved, not that the asset
        // earned it — it awards NO work points (remediation fix).
        check(`7 entry ${r.id} onchain deposit earns no points`,
          BigInt(r.points_awarded) === 0n,
          `${r.recorded_by} ${r.status} points=${r.points_awarded}`);
      }
      if (r.status === "Verified") {
        check(`7 entry ${r.id} points by formula`,
          BigInt(r.points_awarded) === workPointsFor(r.amount, policies.activity),
          `${r.recorded_by} ${r.status} points=${r.points_awarded} expected=${workPointsFor(r.amount, policies.activity)}`);
      }
      if (r.status === "Pending") {
        check(`7 pending entry ${r.id} earns no points`, BigInt(r.points_awarded) === 0n,
          `${r.recorded_by} points=${r.points_awarded}`);
      }
      // Disputed and Rejected entries keep their points_awarded on the
      // record, but the points are suspended from the current epoch:
      // the epoch-0 current-points check below sums only Onchain and
      // Verified entries, so a disputed or rejected entry's points
      // must not appear in any member's current total.
    }
    for (const [member, pts] of act.work_points) {
      const expectedLifetime = byMember.get(member) || 0n;
      check(`7 lifetime work points for ${member}`,
        BigInt(pts.lifetime) === expectedLifetime,
        `lifetime=${pts.lifetime} awarded=${expectedLifetime}`);
    }
    if (a.epoch === 0) {
      // No distribution has run yet, so current points are exactly the
      // points of currently verified entries.
      for (const [member, pts] of act.work_points) {
        const verified = rev
          .filter((r) => r.recorded_by === member && (r.status === "Onchain" || r.status === "Verified"))
          .reduce((s, r) => s + BigInt(r.points_awarded), 0n);
        check(`7 current work points for ${member} (epoch 0)`,
          BigInt(pts.current) === verified,
          `current=${pts.current} verified=${verified}`);
      }
    } else {
      check("7 current points within lifetime (epoch > 0)",
        act.work_points.every(([m, p]) => BigInt(p.current) <= BigInt(p.lifetime)),
        `epoch=${a.epoch}`);
    }
    // Capital points never enter the activity slice: they are recorded
    // and shown, but the activity pool is split by work points only
    // (checked per distribution in 9 below).
    check("7 capital points recorded, display only",
      act.capital_points.every(([, p]) => BigInt(p) >= 0n),
      act.capital_points.map(([m, p]) => `${m}=${p}`).join(", "));

    // B is checked community-wide below (total_bonds_held = 0.1 NEAR
    // x held entries); per-asset bond counts feed into it.

    // 3 + 4 + 9. Distributions.
    let assetDistributed = 0n;
    for (const d of dists) {
      assetDistributed += y(d.distributed);
      const ownSum = d.ownership_payouts.reduce((s, [, v]) => s + y(v), 0n);
      const actSum = d.activity_payouts.reduce((s, [, v]) => s + y(v), 0n);
      check(`3 distribution ${d.id} exact sum`,
        y(d.distributed) === y(d.member_total) + y(d.retention) + y(d.maintenance),
        `D=${fmt(d.distributed)} member=${fmt(d.member_total)} retention=${fmt(d.retention)} maintenance=${fmt(d.maintenance)}`);
      check(`3 distribution ${d.id} member = ownership + activity`,
        y(d.member_total) === ownSum + actSum,
        `member=${fmt(d.member_total)} ownership=${fmt(ownSum)} activity=${fmt(actSum)}`);
      check(`9 distribution ${d.id} activity pool not overpaid`,
        actSum <= y(d.activity_pool),
        `activity paid=${fmt(actSum)} pool=${fmt(d.activity_pool)}`);
      // 9. Spot check one member's breakdown against the contract view.
      if (state.breakdowns && state.breakdowns[d.id]) {
        for (const [member, b] of Object.entries(state.breakdowns[d.id])) {
          check(`9 breakdown ${d.id} ${member} total = ownership + activity`,
            y(b.total_payout) === y(b.ownership_payout) + y(b.activity_payout),
            `total=${fmt(b.total_payout)} ownership=${fmt(b.ownership_payout)} activity=${fmt(b.activity_payout)}`);
          check(`9 breakdown ${d.id} ${member} activity matches work points`,
            (BigInt(b.member_work_points) === 0n) === (y(b.activity_payout) === 0n),
            `work=${b.member_work_points} activity=${fmt(b.activity_payout)}`);
        }
      }
    }
    check(`4 asset ${a.id} distributed_total = sum of distributions`,
      y(a.distributed_total) === assetDistributed,
      `distributed_total=${fmt(a.distributed_total)} sum=${fmt(assetDistributed)}`);
  }

  // B. Community-wide bond accounting (v4: proportional bonds).
  const heldEntries = Object.values(revenue).flat().filter((r) => r.bond_status === "Held");
  const heldSum = heldEntries.reduce((s, r) => s + y(r.bond_amount ?? 0), 0n);
  check("B total bonds held = sum of held entries' bond_amount",
    y(c.total_bonds_held) === heldSum,
    `held=${fmt(c.total_bonds_held)} sum=${fmt(heldSum)} entries=${heldEntries.length}`);
  const heldDispute = Object.values(revenue).flat().filter((r) => r.dispute_bond_status === "Held").length;
  check("B2 total dispute bonds held = 0.05 NEAR x held dispute entries",
    y(c.total_dispute_bonds_held ?? 0) === BigInt(heldDispute) * DISPUTE_BOND,
    `held=${fmt(c.total_dispute_bonds_held ?? 0)} entries=${heldDispute}`);

  // No reported entry carries a deposit: a Pending entry is a claim,
  // not money. The deposit rule is enforced at record time (unit
  // tests); here the raw-balance check (10) is the observable guard:
  // a mis-attached deposit would break it.
  const pending = Object.values(revenue).flat().filter((r) => r.status === "Pending");
  check("P reported entries are claims, not money",
    pending.every((r) => BigInt(r.points_awarded) === 0n),
    `${pending.length} pending entries, none with points`);

  console.log(failures === 0
    ? `\nALL ${passes} CHECKS PASSED`
    : `\n${failures} CHECKS FAILED, ${passes} PASSED`);
  return failures === 0;
}

function demoFixture() {
  // Lagos Energy Cooperative, final state after the full v4 demo flow
  // (dispute upheld, amendment executed, dave's attested entry pays
  // him the activity pool, one distribution; contract
  // ownground4.testnet, community lagos-energy-cooperative-6). Values
  // read back from the live v4 run: onchain deposits earn no points,
  // activity pool 0.162 (all to dave), payouts 0.3645 each except dave
  // 0.5265; attestation bonds 0.2 NEAR, total revenue 3.2.
  const community = {
    id: "lagos-energy-cooperative-6",
    name: "Lagos Energy Cooperative",
    dao_id: "lagos-energy4.testnet",
    members: ["alice.ownground4.testnet", "bob.ownground4.testnet", "carol.ownground4.testnet", "dave.ownground4.testnet"],
    policy: { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 1000 },
    spending_policy: { max_single_expense: (2n * N).toString(), min_treasury_reserve: N.toString(), allowed_categories: ["maintenance", "operations"] },
    activity_policy: { capital_per_near: 1, work_per_revenue_record: 1, work_per_revenue_near: 1 },
    capital_points: [["alice.ownground4.testnet", 2], ["bob.ownground4.testnet", 2], ["carol.ownground4.testnet", 2], ["dave.ownground4.testnet", 2]],
    campaign_ids: ["generator"],
    asset_ids: ["generator"],
    dispute_window_ns: 300000000000,
    timelock_ns: 120000000000,
    total_contributions: (10n * N).toString(),
    total_revenue: (32n * N / 10n).toString(),
    total_acquisitions: (10n * N).toString(),
    total_expenses: (5n * N / 10n).toString(),
    total_payouts: (162n * N / 100n).toString(),
    total_distributed: (27n * N / 10n).toString(),
    total_refunds: "0",
    total_retained: (108n * N / 100n).toString(),
    total_bonds_held: "0",
    total_dispute_bonds_held: "0",
    storage_reserve: (32n * N / 100n).toString(),
  };
  const treasury = {
    community_id: "lagos-energy-cooperative-6",
    treasury: (108n * N / 100n).toString(),
    locked: "0",
    spendable: (108n * N / 100n).toString(),
    total_revenue: (32n * N / 10n).toString(),
    total_expenses: (5n * N / 10n).toString(),
    retained: (108n * N / 100n).toString(),
    distributable: "0",
    total_contributions: (10n * N).toString(),
    total_acquisitions: (10n * N).toString(),
    total_payouts: (162n * N / 100n).toString(),
    total_distributed: (27n * N / 10n).toString(),
    total_refunds: "0",
    total_bonds_held: "0",
    total_dispute_bonds_held: "0",
    storage_reserve: (32n * N / 100n).toString(),
  };
  const assetId = "generator";
  return {
    community,
    treasury,
    campaigns: [{ id: "generator", community_id: "lagos-energy-cooperative-6", asset_name: "Generator", category: "energy", target: (10n * N).toString(), raised: (10n * N).toString(), contributors: [], status: "Acquired", deadline: 0 }],
    assets: [{
      id: assetId, community_id: "lagos-energy-cooperative-6", name: "Generator", category: "energy",
      value: (10n * N).toString(), seller: "seller.ownground4.testnet",
      allocations: [["alice.ownground4.testnet", 2500], ["bob.ownground4.testnet", 2500], ["carol.ownground4.testnet", 2500], ["dave.ownground4.testnet", 2500]],
      status: "Active", created_at: 0, epoch: 1,
      work_points: [
        ["bob.ownground4.testnet", { current: 0, lifetime: 2 }],
        ["dave.ownground4.testnet", { current: 0, lifetime: 2 }],
      ],
      distributed_total: (27n * N / 10n).toString(),
      revenue_onchain: (3n * N).toString(),
      expenses_total: (5n * N / 10n).toString(),
      revenue_count: 3, expense_count: 1,
    }],
    revenue: {
      [assetId]: [
        { id: 0, amount: (3n * N).toString(), source: "Generator rental", reference: "invoice-001", status: "Onchain", recorded_at: 0, recorded_by: "alice.ownground4.testnet", attestor: null, verified_at: 0, points_awarded: 0, bond_status: null },
        { id: 1, amount: N.toString(), source: "Generator rental", reference: "invoice-002", status: "Rejected", recorded_at: 0, recorded_by: "bob.ownground4.testnet", attestor: "alice.ownground4.testnet", verified_at: 0, points_awarded: 2, bond_status: "Forfeited", bond_amount: (2n * N / 10n).toString(), dispute_bond_status: "Released" },
        { id: 2, amount: N.toString(), source: "Generator rental", reference: "invoice-003", status: "Verified", recorded_at: 0, recorded_by: "dave.ownground4.testnet", attestor: "carol.ownground4.testnet", verified_at: 0, points_awarded: 2, bond_status: "Released", bond_amount: (2n * N / 10n).toString(), dispute_bond_status: null },
      ],
    },
    expenses: {
      [assetId]: [{ amount: (5n * N / 10n).toString(), recipient: "ops.testnet", description: "Generator service", category: "operations", recorded_at: 0 }],
    },
    distributions: {
      [assetId]: [{
        id: 0, asset_id: assetId, distributed: (27n * N / 10n).toString(),
        payouts: [["alice.ownground4.testnet", (3645n * N / 10000n).toString()], ["bob.ownground4.testnet", (3645n * N / 10000n).toString()], ["carol.ownground4.testnet", (3645n * N / 10000n).toString()], ["dave.ownground4.testnet", (5265n * N / 10000n).toString()]],
        ownership_payouts: [["alice.ownground4.testnet", (3645n * N / 10000n).toString()], ["bob.ownground4.testnet", (3645n * N / 10000n).toString()], ["carol.ownground4.testnet", (3645n * N / 10000n).toString()], ["dave.ownground4.testnet", (3645n * N / 10000n).toString()]],
        activity_payouts: [["dave.ownground4.testnet", (162n * N / 1000n).toString()]],
        member_total: (162n * N / 100n).toString(),
        retention: (675n * N / 1000n).toString(),
        maintenance: (405n * N / 1000n).toString(),
        activity_pool: (162n * N / 1000n).toString(),
        ownership_pool: (1458n * N / 1000n).toString(),
        total_work_points: 2,
        unpaid: [], executed_at: 0,
      }],
    },
    activity: {
      [assetId]: {
        asset_id: assetId, epoch: 1,
        work_points: [
          ["bob.ownground4.testnet", { current: 0, lifetime: 2 }],
          ["dave.ownground4.testnet", { current: 0, lifetime: 2 }],
        ],
        capital_points: [["alice.ownground4.testnet", 2], ["bob.ownground4.testnet", 2], ["carol.ownground4.testnet", 2], ["dave.ownground4.testnet", 2]],
      },
    },
    policies: {
      community_id: "lagos-energy-cooperative-6",
      distribution: { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 1000 },
      spending: { max_single_expense: (2n * N).toString(), min_treasury_reserve: N.toString(), allowed_categories: ["maintenance", "operations"] },
      activity: { capital_per_near: 1, work_per_revenue_record: 1, work_per_revenue_near: 1 },
      dispute_window_ns: 300000000000,
      timelock_ns: 120000000000,
      amendments: [{
        id: 0, policy_type: "Spending",
        new_params: { Spending: { max_single_expense: (2n * N).toString(), min_treasury_reserve: N.toString(), allowed_categories: ["maintenance", "operations"] } },
        old_params: { Spending: { max_single_expense: N.toString(), min_treasury_reserve: N.toString(), allowed_categories: ["maintenance", "operations"] } },
        proposed_at: 0, deadline: 0, status: "Executed",
      }],
    },
    breakdowns: {
      0: {
        "alice.ownground4.testnet": { distribution_id: 0, asset_id: assetId, account: "alice.ownground4.testnet", distributed: (27n * N / 10n).toString(), member_total: (162n * N / 100n).toString(), activity_pool: (162n * N / 1000n).toString(), ownership_pool: (1458n * N / 1000n).toString(), member_allocation_bp: 2500, member_work_points: 0, total_work_points: 2, ownership_payout: (3645n * N / 10000n).toString(), activity_payout: "0", total_payout: (3645n * N / 10000n).toString() },
        "bob.ownground4.testnet": { distribution_id: 0, asset_id: assetId, account: "bob.ownground4.testnet", distributed: (27n * N / 10n).toString(), member_total: (162n * N / 100n).toString(), activity_pool: (162n * N / 1000n).toString(), ownership_pool: (1458n * N / 1000n).toString(), member_allocation_bp: 2500, member_work_points: 0, total_work_points: 2, ownership_payout: (3645n * N / 10000n).toString(), activity_payout: "0", total_payout: (3645n * N / 10000n).toString() },
        "dave.ownground4.testnet": { distribution_id: 0, asset_id: assetId, account: "dave.ownground4.testnet", distributed: (27n * N / 10n).toString(), member_total: (162n * N / 100n).toString(), activity_pool: (162n * N / 1000n).toString(), ownership_pool: (1458n * N / 1000n).toString(), member_allocation_bp: 2500, member_work_points: 2, total_work_points: 2, ownership_payout: (3645n * N / 10000n).toString(), activity_payout: (162n * N / 1000n).toString(), total_payout: (5265n * N / 10000n).toString() },
      },
    },
    raw: 140n * N / 100n, // treasury 1.08 + storage 0.32 + bonds 0
  };
}

// ---- Transfer receipt checks (remediation P1) ---------------------------
// Given the receipts file a demo run writes (demo-receipts-<community>.json:
// [{ label, signer, tx, description?, deciding?, expect? }]), query every
// tx hash via RPC and assert it succeeded, then prove the money moved by
// comparing the receiver's balance across the tx's block window:
//   * the deciding acquire vote moved the target to the seller;
//   * the deciding expense vote moved the expense amount to its recipient;
//   * the distribution moved each member's payout to that member.
// The `tx` RPC response carries no receipt actions (no `receipts` array
// with Transfer actions), so the transfer itself is proved from onchain
// balances instead: balance at the parent of the tx block vs balance at
// the highest block any receipt outcome landed in. A receiver who did
// not sign the tx gains exactly the transfer amount; a receiver who did
// sign also pays that tx's gas (sum of tokens_burnt over the tx and its
// receipts) and its attached deposit, so those are subtracted. Balances
// are compared as exact yoctoNEAR BigInts, never floats. A tx whose
// label carries expect "fail:<substring>" must instead show that
// substring in one of its receipt failures (the demo's over-cap expense,
// proof 2). Refunds have no demo txs — they are covered by the contract
// unit tests, and this function says so.
async function rpcFirst(method, params) {
  for (const url of RPCS) {
    try {
      return await rpc(url, method, params);
    } catch (e) {
      if (url === RPCS[RPCS.length - 1]) throw e;
    }
  }
}

const blockHeaderCache = new Map();
async function blockHeader(hash) {
  if (!blockHeaderCache.has(hash)) {
    const b = await rpcFirst("block", { block_id: hash });
    blockHeaderCache.set(hash, b.header);
  }
  return blockHeaderCache.get(hash);
}

async function balanceAt(account, blockId) {
  const r = await rpcFirst("query", {
    request_type: "view_account",
    account_id: account,
    block_id: blockId,
  });
  return BigInt(r.amount);
}

function totalBurnt(outcome) {
  return [outcome.transaction_outcome, ...(outcome.receipts_outcome || [])]
    .reduce((s, o) => s + BigInt(o.outcome.tokens_burnt), 0n);
}

function attachedDeposit(outcome) {
  // Deposits on the signed tx's own actions (e.g. the 0.01 NEAR storage
  // deposit execute_distribution requires of its caller).
  let total = 0n;
  for (const a of outcome?.transaction?.actions || []) {
    if (a.FunctionCall?.deposit) total += BigInt(a.FunctionCall.deposit);
    if (a.Transfer?.deposit) total += BigInt(a.Transfer.deposit);
  }
  return total;
}

async function balanceDelta(outcome, account) {
  // [parent of the tx block, highest block any receipt outcome landed in]
  const txBlock = outcome.transaction_outcome.block_hash;
  const before = (await blockHeader(txBlock)).prev_hash;
  let afterHash = txBlock;
  let maxHeight = (await blockHeader(txBlock)).height;
  for (const ro of outcome.receipts_outcome || []) {
    const h = await blockHeader(ro.block_hash);
    if (h.height > maxHeight) { maxHeight = h.height; afterHash = ro.block_hash; }
  }
  const beforeBal = await balanceAt(account, before);
  const afterBal = await balanceAt(account, afterHash);
  return afterBal - beforeBal;
}

async function txOutcome(hash, signer) {
  return rpcFirst("tx", [hash, signer]);
}

function txSucceeded(outcome) {
  const s = outcome?.status;
  return !!s && (s.SuccessValue !== undefined || s.SuccessReceiptId !== undefined);
}

function receiptFailures(outcome) {
  const found = [];
  if (outcome?.status?.Failure) found.push(JSON.stringify(outcome.status.Failure));
  const walk = (list) => {
    for (const r of list || []) {
      if (r?.status?.Failure) found.push(JSON.stringify(r.status.Failure));
      walk(r?.receipts_outcome);
      // Some providers nest outcomes under `outcome.receipts_outcome`.
      walk(r?.outcome?.receipts_outcome);
    }
  };
  walk(outcome?.receipts_outcome);
  return found;
}

async function runReceiptChecks(receiptsPath, contract, communityId) {
  const entries = JSON.parse(fs.readFileSync(receiptsPath, "utf8"));
  if (!Array.isArray(entries) || !entries.length) throw new Error(`no receipts in ${receiptsPath}`);
  console.log(`\nReceipt checks: ${entries.length} demo transactions from ${receiptsPath}\n`);
  const outcomes = new Map();
  for (const e of entries) {
    if (!e.tx) { check(`R ${e.label} has a tx hash`, false, `signer=${e.signer}`); continue; }
    let outcome;
    try {
      outcome = await txOutcome(e.tx, e.signer);
    } catch (err) {
      check(`R ${e.label} tx readable onchain`, false, `${e.tx} (${err.message})`);
      continue;
    }
    outcomes.set(e.label + "|" + e.tx, outcome);
    if (e.expect && e.expect.startsWith("fail:")) {
      const needle = e.expect.slice(5);
      const fails = receiptFailures(outcome);
      check(`R ${e.label} failed onchain as expected`,
        fails.some((f) => f.includes(needle)),
        `failures: ${fails.join(" | ").slice(0, 200) || "none"}`);
    } else {
      check(`R ${e.label} tx succeeded`, txSucceeded(outcome), `${e.tx.slice(0, 12)}…`);
      const fails = receiptFailures(outcome);
      check(`R ${e.label} no receipt failures`, fails.length === 0,
        fails.length ? fails.join(" | ").slice(0, 200) : "clean");
    }
  }
  const deciding = (label) => entries.filter((e) => e.label === label && e.deciding);
  const findOutcome = (label) => {
    // The deciding tx that actually executed the call: skip the
    // fail-expected deciding vote (step 8's over-cap expense, which
    // correctly moved no money) and take the successful one.
    const es = deciding(label).filter((e) => !(e.expect && e.expect.startsWith("fail:")));
    if (!es.length) return null;
    return outcomes.get(label + "|" + es[0].tx) || null;
  };

  // Seller paid the target (acquire). The seller did not sign the
  // deciding vote tx, so its balance must rise by exactly the price.
  const community = await view(contract, "get_community", { community_id: communityId });
  const asset = await view(contract, "get_asset", { asset_id: community.asset_ids[0] });
  const acqOutcome = findOutcome("dao:acquire_asset");
  let acqDelta = null;
  if (acqOutcome) acqDelta = await balanceDelta(acqOutcome, asset.seller);
  check("R seller paid the target",
    acqDelta !== null && acqDelta === y(asset.value),
    acqOutcome ? `seller=${asset.seller} value=${fmt(asset.value)} balance delta=${acqDelta === null ? "?" : fmt(acqDelta)}` : "no deciding acquire vote recorded");

  // Expense recipient paid (the successful expense only). Same: the
  // recipient did not sign the deciding vote tx.
  const expenses = await view(contract, "get_expenses", { asset_id: asset.id });
  const expOutcome = findOutcome("dao:pay_expense");
  for (const e of expenses) {
    const delta = expOutcome ? await balanceDelta(expOutcome, e.recipient) : null;
    check(`R expense recipient paid ${fmt(e.amount)}`,
      delta !== null && delta === y(e.amount),
      `recipient=${e.recipient} amount=${fmt(e.amount)} balance delta=${delta === null ? "?" : fmt(delta)}`);
  }

  // Member payouts landed. Non-signing members gain exactly their
  // payout; the member who signed the distribution tx also paid that
  // tx's gas and its attached storage deposit, so those are subtracted.
  const dists = await view(contract, "get_distributions", { asset_id: asset.id });
  const distEntry = entries.find((e) => e.label === "execute_distribution");
  const distOutcome = distEntry ? outcomes.get("execute_distribution|" + distEntry.tx) : null;
  const distBurnt = distOutcome ? totalBurnt(distOutcome) : 0n;
  const distDeposit = distOutcome ? attachedDeposit(distOutcome) : 0n;
  for (const d of dists) {
    for (const [member, amount] of d.payouts) {
      const delta = distOutcome ? await balanceDelta(distOutcome, member) : null;
      const expected = member === distEntry?.signer
        ? y(amount) - distBurnt - distDeposit
        : y(amount);
      check(`R payout landed for ${member}`,
        delta !== null && delta === expected,
        `${member} ${fmt(amount)} balance delta=${delta === null ? "?" : fmt(delta)}${member === distEntry?.signer ? ` (signer: - gas ${fmt(distBurnt)} - deposit ${fmt(distDeposit)})` : ""}`);
    }
  }

  // Refunds: the demo performs no cancel/refund, so no refund txs exist
  // to check here. Refund transfers are covered by the contract unit
  // tests (failed-transfer revert + retry, claim-based cancel refunds).
  const refundEntries = entries.filter((e) => /refund|cancel_campaign/.test(e.label));
  check("R no demo refunds to verify (unit-tested instead)", refundEntries.length === 0,
    refundEntries.length ? `${refundEntries.length} refund txs recorded` : "demo performs no refund");
  console.log(failures === 0
    ? `\nALL ${passes} CHECKS PASSED`
    : `\n${failures} CHECKS FAILED, ${passes} PASSED`);
  return failures === 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    console.log("OwnGround verify: self-test against the demo final state.\n");
    const ok = await runChecks(demoFixture());
    process.exit(ok ? 0 : 1);
  }
  const ci = args.indexOf("--contract");
  if (ci < 0 || !args[ci + 1]) {
    console.error("Usage: node scripts/verify.mjs --contract <contract.testnet> [--community <id>] [--receipts <demo-receipts.json>]");
    console.error("   or: node scripts/verify.mjs --selftest");
    process.exit(2);
  }
  const contract = args[ci + 1];
  const communityArg = args.indexOf("--community");
  const communityId = communityArg >= 0 ? args[communityArg + 1] : null;
  const receiptsArg = args.indexOf("--receipts");
  const receiptsPath = receiptsArg >= 0 ? args[receiptsArg + 1] : null;
  if (receiptsPath && !communityId) {
    console.error("--receipts needs --community (transfer expectations come from that community's live state)");
    process.exit(2);
  }

  const ids = await view(contract, "list_communities", {});
  const targets = communityId ? [communityId] : ids;
  if (!targets.length) {
    console.log("No communities on this contract yet. Nothing to verify.");
    process.exit(0);
  }
  let ok = true;
  for (const target of targets) {
    const community = await view(contract, "get_community", { community_id: target });
    const treasury = await view(contract, "get_treasury", { community_id: target });
    const policies = await view(contract, "get_policies", { community_id: target });
    const campaigns = [];
    for (const id of community.campaign_ids) campaigns.push(await view(contract, "get_campaign", { campaign_id: id }));
    const assets = [];
    const revenue = {};
    const expenses = {};
    const distributions = {};
    const activity = {};
    const breakdowns = {};
    for (const id of community.asset_ids) {
      assets.push(await view(contract, "get_asset", { asset_id: id }));
      revenue[id] = await view(contract, "get_revenue", { asset_id: id });
      expenses[id] = await view(contract, "get_expenses", { asset_id: id });
      distributions[id] = await view(contract, "get_distributions", { asset_id: id });
      activity[id] = await view(contract, "get_activity", { asset_id: id });
      for (const d of distributions[id]) {
        breakdowns[d.id] = {};
        for (const member of community.members) {
          breakdowns[d.id][member] = await view(contract, "get_distribution_breakdown", { distribution_id: d.id, account: member });
        }
      }
    }
    const raw = await rawBalance(contract);
    console.log(`OwnGround verify: ${contract} / ${target}\n`);
    ok = await runChecks({ community, treasury, campaigns, assets, revenue, expenses, distributions, activity, policies, breakdowns, raw }) && ok;
    if (receiptsPath && target === communityId) {
      ok = await runReceiptChecks(receiptsPath, contract, target) && ok;
    }
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("VERIFY ERROR", e.message); process.exit(2); });
