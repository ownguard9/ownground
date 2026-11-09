// Activity-split verification for the FINAL OwnGround model (DESIGN.md
// "Strengthened economics and security" + "Four safeguards"). Run:
// node check-maths-activity.mjs
// All amounts in yoctoNEAR as BigInt. Exits non-zero on any failure.
//
// Final model:
// * capital_points = capital_per_near x floor(cumulative / 1 NEAR);
//   sub-1-NEAR cumulative earns 0. Capital never affects the activity slice.
// * work_points (verified revenue only) = work_per_revenue_record +
//   work_per_revenue_near x floor(amount / 1 NEAR). The activity slice
//   splits by the current epoch's work points only.
// * Epochs: after each distribution the current work points reset to 0.
const N = 10n ** 24n;
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS ${name} ${detail ?? ''}`);
  else { failures++; console.log(`FAIL ${name} ${detail ?? ''}`); }
}

// Capital points from the CUMULATIVE total (no minimum: sub-1-NEAR = 0).
function capitalPoints(totalContributed, capitalPerNear = 1n) {
  return (totalContributed / N) * capitalPerNear;
}

// Work points for one verified revenue entry.
function workPoints(amount, record = 1n, perNear = 1n) {
  return record + perNear * (amount / N);
}

// Full split with the activity slice. Returns exact-sum components.
function splitActivity(D, policy, allocs, points) {
  const { membersBp, treasuryBp, maintenanceBp, activityBp } = policy;
  const M = (D * BigInt(membersBp)) / 10000n;
  const T = (D * BigInt(treasuryBp)) / 10000n;
  const Mt = (D * BigInt(maintenanceBp)) / 10000n;
  const R = D - M - T - Mt;
  let A = (M * BigInt(activityBp)) / 10000n;
  let O = M - A;
  const totalPoints = points.reduce((s, [, p]) => s + p, 0n);
  if (totalPoints === 0n) { O = M; A = 0n; }
  const payouts = new Map();
  const activityPayouts = new Map();
  const ownershipPayouts = new Map();
  let actSum = 0n;
  for (const [acct, pts] of points) {
    if (pts === 0n || A === 0n) continue;
    const pay = (A * pts) / totalPoints;
    actSum += pay;
    payouts.set(acct, (payouts.get(acct) || 0n) + pay);
    activityPayouts.set(acct, pay);
  }
  const rmA = A - actSum;
  let ownSum = 0n;
  for (const [acct, bp] of allocs) {
    const pay = (O * BigInt(bp)) / 10000n;
    ownSum += pay;
    payouts.set(acct, (payouts.get(acct) || 0n) + pay);
    ownershipPayouts.set(acct, pay);
  }
  const rmO = O - ownSum;
  const memberTotal = actSum + ownSum;
  const retention = T + R + rmA + rmO;
  return { M, T, Mt, R, A, O, payouts, activityPayouts, ownershipPayouts, memberTotal, retention, maintenance: Mt,
    total: memberTotal + retention + Mt };
}
const POLICY = { membersBp: 6000, treasuryBp: 2500, maintenanceBp: 1500, activityBp: 1000 };
const ALLOCS = [["alice", 2500], ["bob", 2500], ["carol", 2500], ["dave", 2500]];

// --- capital points: splitting earns nothing extra; sub-1-NEAR earns 0 ---
{
  check('capital split 2.5 once = 2 pts', capitalPoints(25n * N / 10n) === 2n);
  check('capital split 0.5 five times = 2 pts', capitalPoints(5n * (N / 2n)) === 2n);
  check('capital single 0.5 = 0 pts (no minimum)', capitalPoints(N / 2n) === 0n);
  check('capital zero contributed = 0 pts', capitalPoints(0n) === 0n);
  check('capital 7 NEAR = 7 pts', capitalPoints(7n * N) === 7n);
  check('capital weight 2: 2.5 NEAR = 4 pts', capitalPoints(25n * N / 10n, 2n) === 4n);
}

// --- work points formula ---
{
  check('work 3 NEAR = 1 + 3 = 4', workPoints(3n * N) === 4n);
  check('work 1 NEAR = 1 + 1 = 2', workPoints(N) === 2n);
  check('work 0.5 NEAR = 1 + 0 = 1', workPoints(N / 2n) === 1n);
  check('work 10 NEAR = 1 + 10 = 11', workPoints(10n * N) === 11n);
  check('work weights 3+2: 3 NEAR = 9', workPoints(3n * N, 3n, 2n) === 9n);
  check('work weight 0 disables record points', workPoints(3n * N, 0n, 1n) === 3n);
}

// --- demo distribution with the activity slice (final numbers) ---
// The dispute proof runs BEFORE the distribution and is upheld, so
// bob's 2 work points are removed and the 0.1 NEAR bond enters the
// treasury as revenue. total_revenue is 3.1 NEAR, expenses 0.5 NEAR,
// so D = 2.6 NEAR. Work points at distribution: alice 4, bob 0.
{
  const points = [["alice", 4n]];
  const D = 26n * N / 10n; // 2.6 NEAR
  const s = splitActivity(D, POLICY, ALLOCS, points);
  check('demo exact sum', s.total === D, `total=${s.total} D=${D}`);
  check('demo member total 1.56 exact', s.memberTotal === 156n * N / 100n, `${s.memberTotal}`);
  check('demo alice 0.507', s.payouts.get("alice") === 507n * N / 1000n, `${s.payouts.get("alice")}`);
  check('demo bob 0.351', s.payouts.get("bob") === 351n * N / 1000n, `${s.payouts.get("bob")}`);
  check('demo others 0.351', ["carol", "dave"].every((m) => s.payouts.get(m) === 351n * N / 1000n));
  check('demo alice ownership 0.351', s.ownershipPayouts.get("alice") === 351n * N / 1000n);
  check('demo alice activity 0.156', s.activityPayouts.get("alice") === 156n * N / 1000n);
  check('demo bob activity 0 (points removed by dispute)', (s.activityPayouts.get("bob") || 0n) === 0n);
  check('demo alice gets more than bob', s.payouts.get("alice") > s.payouts.get("bob"));
  check('demo retention 0.65 exact', s.retention === 65n * N / 100n, `${s.retention}`);
  check('demo maintenance 0.39', s.maintenance === 39n * N / 100n);
  check('demo activity pool 0.156', s.A === 156n * N / 1000n);
  check('demo ownership pool 1.404', s.O === 1404n * N / 1000n);
}

// --- dispute flow: treasury equation with the forfeited bond ---
// Contributions 10, acquire 10, onchain revenue 3, expense 0.5, the
// upheld dispute adds the 0.1 NEAR bond as revenue, distribution 2.6.
{
  const contributions = 10n * N;
  const acquisitions = 10n * N;
  const revenue = 3n * N + N / 10n; // 3 NEAR onchain + 0.1 bond
  const expenses = 5n * N / 10n;
  const payouts = 156n * N / 100n; // member pool only; retention 0.65
  // + maintenance 0.39 stay in the treasury as reserves
  const treasury = contributions + revenue - acquisitions - expenses - payouts;
  check('dispute treasury final 1.04 NEAR', treasury === 104n * N / 100n, `${treasury}`);
  check('dispute D = revenue - expenses = 2.6', revenue - expenses === 26n * N / 10n);
  // Before the dispute, bob held 2 work points (1 NEAR attested entry);
  // after the upheld dispute they are 0 and the activity pool goes to
  // alice alone. The pre-dispute split (D 2.5, bob 2 pts) is the
  // "verified activity earns points" proof, checked mid-flow.
  const before = splitActivity(25n * N / 10n, POLICY, ALLOCS, [["alice", 4n], ["bob", 2n]]);
  check('dispute pre-dispute bob 0.3875', before.payouts.get("bob") === 3875n * N / 10000n);
  check('dispute pre-dispute alice 0.4375', before.payouts.get("alice") === 4375n * N / 10000n);
}

// --- epoch reset: second distribution uses only new points ---
{
  // After the first distribution the current points reset to 0. Alice
  // records 1 NEAR more (2 fresh points); bob records nothing.
  const points = [["alice", 2n]];
  const D = N; // 1 NEAR of new revenue
  const s = splitActivity(D, POLICY, ALLOCS, points);
  check('epoch2 exact sum', s.total === D);
  check('epoch2 alice 0.195', s.payouts.get("alice") === 195n * N / 1000n, `${s.payouts.get("alice")}`);
  check('epoch2 others 0.135', ["bob", "carol", "dave"].every((m) => s.payouts.get(m) === 135n * N / 1000n));
  check('epoch2 alice activity 0.06', s.activityPayouts.get("alice") === 6n * N / 100n);
  check('epoch2 bob activity 0 (points reset)', (s.activityPayouts.get("bob") || 0n) === 0n);
}

// --- circular farming: cycling 3 NEAR recovers less than 3 NEAR ---
{
  // Alice deposits 3 NEAR, holds all 4 work points, owns 25%.
  const points = [["alice", 4n]];
  const D = 3n * N;
  const s = splitActivity(D, POLICY, ALLOCS, points);
  check('farming exact sum', s.total === D);
  check('farming alice recovers 0.585 < 3', s.payouts.get("alice") === 585n * N / 1000n && s.payouts.get("alice") < 3n * N, `${s.payouts.get("alice")}`);
  check('farming others 0.405 each', ["bob", "carol", "dave"].every((m) => s.payouts.get(m) === 405n * N / 1000n));
}

// --- zero-points fallback: whole pool by ownership ---
{
  const points = [["alice", 0n], ["bob", 0n], ["carol", 0n], ["dave", 0n]];
  const D = 25n * N / 10n;
  const s = splitActivity(D, POLICY, ALLOCS, points);
  check('zero-points exact sum', s.total === D);
  check('zero-points A is 0', s.A === 0n);
  check('zero-points O is M', s.O === s.M);
  check('zero-points each 0.375', ["alice", "bob", "carol", "dave"].every((m) => s.payouts.get(m) === 375n * N / 1000n));
}

// --- activity_bp 0 behaves exactly as the pre-activity distribution ---
{
  const p0 = { ...POLICY, activityBp: 0 };
  const points = [["alice", 4n], ["bob", 2n]];
  const D = 25n * N / 10n;
  const s = splitActivity(D, p0, ALLOCS, points);
  check('activity 0 exact sum', s.total === D);
  check('activity 0 each 0.375', ["alice", "bob", "carol", "dave"].every((m) => s.payouts.get(m) === 375n * N / 1000n));
  check('activity 0 member total 1.5', s.memberTotal === 15n * N / 10n);
}

// --- activity_bp 10000: whole member pool by work points ---
{
  const p100 = { ...POLICY, activityBp: 10000 };
  const points = [["alice", 4n], ["bob", 2n]];
  const D = 25n * N / 10n;
  const s = splitActivity(D, p100, ALLOCS, points);
  check('activity 10000 exact sum', s.total === D);
  check('activity 10000 alice 1.0', s.payouts.get("alice") === N, `${s.payouts.get("alice")}`);
  check('activity 10000 bob 0.5', s.payouts.get("bob") === N / 2n);
  check('activity 10000 others 0', ["carol", "dave"].every((m) => (s.payouts.get(m) || 0n) === 0n));
}

// --- nasty case: tiny D with activity ---
{
  const points = [["alice", 4n], ["bob", 2n]];
  const s = splitActivity(7n, POLICY, [["alice", 5000], ["bob", 5000]], points);
  check('tiny D exact sum', s.total === 7n, `total=${s.total}`);
  check('tiny D member total 4', s.memberTotal === 4n);
  check('tiny D retention 2 maintenance 1', s.retention === 2n && s.maintenance === 1n);
  const s1 = splitActivity(1n, POLICY, [["alice", 10000]], [["alice", 1n]]);
  check('D 1 yocto exact sum', s1.total === 1n);
  check('D 1 yocto all retention', s1.memberTotal === 0n && s1.retention === 1n && s1.maintenance === 0n);
}

// --- spending policy checks (mechanism A) ---
{
  // Demo: treasury 3, locked 0, cap 1, reserve 1, categories maintenance/operations.
  const treasury = 3n * N, locked = 0n, cap = N, reserve = N;
  const allowed = ["maintenance", "operations"];
  const ok = (amount, cat) =>
    amount <= treasury - locked &&
    (cap === 0n || amount <= cap) &&
    (treasury - locked - amount >= reserve) &&
    allowed.includes(cat);
  check('A expense 0.5 operations allowed', ok(5n * N / 10n, "operations"));
  check('A expense 2 over cap rejected', !ok(2n * N, "operations"));
  check('A expense wrong category rejected', !ok(5n * N / 10n, "marketing"));
  check('A expense below reserve rejected', !ok(25n * N / 10n, "operations"));
  check('A expense 1 at cap allowed', ok(N, "maintenance"));
  check('A cap 0 means uncapped', (() => {
    const cap0 = 0n;
    const amount = 15n * N / 10n; // 1.5 NEAR: over a 1 NEAR cap, but cap 0 means no cap
    return amount <= treasury - locked && (cap0 === 0n || amount <= cap0) &&
      (treasury - locked - amount >= reserve);
  })());
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
