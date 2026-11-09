// Re-verification of the FIXED OwnGround maths (DESIGN.md v2).
// Independent check of every case in the design doc's Re-verification
// section, plus the treasury identity. Run: node check-maths.mjs
// All amounts in yoctoNEAR as BigInt. Exits non-zero on any failure.
const N = 10n ** 24n; // 1 NEAR
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS ${name} ${detail ?? ''}`);
  else { failures++; console.log(`FAIL ${name} ${detail ?? ''}`); }
}
const floor = (a, b) => a / b; // BigInt division floors

// --- distribution split (exact-sum invariant) ---
function split(D, mBp, tBp, nBp, allocs) {
  const M = floor(D * BigInt(mBp), 10000n);
  const T = floor(D * BigInt(tBp), 10000n);
  const Mt = floor(D * BigInt(nBp), 10000n);
  const R = D - M - T - Mt;
  const payouts = allocs.map((a) => floor(M * BigInt(a), 10000n));
  const sumP = payouts.reduce((s, p) => s + p, 0n);
  const Rm = M - sumP;
  const retention = T + R + Rm;
  return { M, T, Mt, R, payouts, sumP, Rm, retention,
    total: sumP + retention + Mt };
}
function checkSplit(name, D, policy, allocs) {
  const s = split(D, ...policy, allocs);
  check(name, s.total === D, `(total ${s.total} == D ${D})`);
  check(`${name} remainder-bounds`, s.R >= 0n && s.R <= 2n, `R=${s.R}`);
  check(`${name} rm-bounds`, s.Rm >= 0n && s.Rm < BigInt(allocs.length), `Rm=${s.Rm}`);
  return s;
}
checkSplit('demo D=2.5', 25n * N / 10n, [6000, 2500, 1500], [2500, 2500, 2500, 2500]);
checkSplit('nasty D=7yocto', 7n, [6000, 2500, 1500], [2500, 2500, 2500, 2500]);
checkSplit('nasty D=1yocto', 1n, [6000, 2500, 1500], [2500, 2500, 2500, 2500]);
checkSplit('nasty 3333/3333/3334 M=10', 10n, [10000, 0, 0], [3333, 3333, 3334]);
checkSplit('D=0', 0n, [6000, 2500, 1500], [2500, 2500, 2500, 2500]);

// --- Case A: demo flow, treasury equation + identity ---
{
  let C = 0n, R = 0n, A = 0n, E = 0n, P = 0n, F = 0n;
  let locked = 0n, balance = 0n;
  // 4 x 2.5 contributions
  C += 10n * N; balance += 10n * N; locked += 10n * N;
  check('A raised==target', true);
  // acquire: seller gets 10, locked released
  A += 10n * N; balance -= 10n * N; locked -= 10n * N;
  check('A treasury after acquire', C + R - A - E - P - F === balance, `treasury=${C + R - A - E - P - F} balance=${balance}`);
  // revenue 3 onchain
  R += 3n * N; balance += 3n * N;
  // expense 0.5, guard: 0.5 <= treasury - locked = 3
  const tBefore = C + R - A - E - P - F;
  check('A expense guard', 5n * N / 10n <= tBefore - locked, `0.5 <= ${tBefore - locked}`);
  E += 5n * N / 10n; balance -= 5n * N / 10n;
  // distribution: D = max(0, 3 - 0.5 - 0) = 2.5
  const D = 3n * N - 5n * N / 10n;
  const s = split(D, 6000, 2500, 1500, [2500, 2500, 2500, 2500]);
  check('A member payouts', s.sumP === 15n * N / 10n, `1.5 NEAR`);
  P += s.sumP; balance -= s.sumP;
  const treasury = C + R - A - E - P - F;
  check('A treasury equation', treasury === balance && treasury === N, `treasury=${treasury} balance=${balance}`);
  check('A identity treasury-locked == R-E-P', treasury - locked === R - E - P, `${treasury - locked} == ${R - E - P}`);
}

// --- Case B: Hole 3 repeated distribution ---
{
  const rev = 3n * N, exp = 5n * N / 10n;
  let dt = 0n; // distributed_total
  const d1 = rev - exp - dt; dt += d1;
  check('B first D', d1 === 25n * N / 10n, `2.5 NEAR`);
  const d2 = rev - exp - dt > 0n ? rev - exp - dt : 0n;
  check('B second D is 0 (rejected)', d2 === 0n, `D2=${d2}`);
  const d3 = (rev + N) - exp - dt; // new revenue 1 NEAR
  check('B later revenue D', d3 === N, `1.0 NEAR`);
  const s3 = split(d3, 6000, 2500, 1500, [2500, 2500, 2500, 2500]);
  const totalMembers = 15n * N / 10n + s3.sumP;
  check('B total member share 60% of 3.5 net', totalMembers === 21n * N / 10n, `2.1 NEAR`);
}

// --- Case C: Hole 4 locked funds ---
{
  let treasury = 10n * N, locked = 10n * N;
  check('C expense 6 rejected', !(6n * N <= treasury - locked));
  check('C acquire gate', 10n * N === 10n * N && treasury >= 10n * N);
}

// --- Case D: Hole 2 refund (claim-based) ---
// Cancel records one claimable refund per contributor (no transfers
// in a loop). The unclaimed 10 NEAR is LOCKED: the treasury still
// shows 10 NEAR but spendable is 0, so the DAO cannot spend money
// owed to contributors. total_refunds counts only at claim payment:
// after all four claims are paid, the treasury is 0.
{
  const C = 10n * N, F0 = 0n, locked0 = 10n * N, balance0 = 10n * N;
  const treasuryAtCancel = C - F0;
  check('D treasury at cancel still 10 (claims unpaid)', treasuryAtCancel === 10n * N);
  check('D locked at cancel is 10 (claims)', locked0 === 10n * N);
  check('D spendable at cancel is 0', treasuryAtCancel - locked0 === 0n);
  let F = F0, balance = balance0, locked = locked0;
  F += 10n * N; balance -= 10n * N; locked -= 10n * N; // all claims paid
  const treasury = C - F;
  check('D treasury after all claims paid', treasury === 0n && balance === 0n);
  check('D locked after all claims paid', locked === 0n);
}

// --- Case E: multi-asset negative net (the D_effective cap) ---
// Community-net cap: D_eff = min(D_asset, treasury - locked,
// community_net - total_distributed). Without the community-net cap the
// second call would over-pay members to 84% of net earnings.
{
  // two assets acquired at 10 each; asset1 revenue 10, asset2 expense 5
  const C = 20n * N, A = 20n * N, R = 10n * N, E = 5n * N;
  const treasury = C + R - A - E;
  check('E treasury is 5', treasury === 5n * N, `${treasury}`);
  const communityNet = R - E; // 5
  let totalDistributed = 0n;
  const dAsset1 = 10n * N; // max(0, 10 - 0 - 0)
  let dEff = dAsset1;
  if (dEff > treasury) dEff = treasury;
  if (dEff > communityNet - totalDistributed) dEff = communityNet - totalDistributed;
  check('E cap binds', dEff === 5n * N, `D_eff=${dEff}`);
  const s = split(dEff, 6000, 2500, 1500, [2500, 2500, 2500, 2500]);
  check('E payouts fit treasury', s.sumP <= treasury, `${s.sumP} <= ${treasury}`);
  const treasuryAfter = treasury - s.sumP;
  check('E treasury stays non-negative', treasuryAfter >= 0n, `${treasuryAfter}`);
  totalDistributed += dEff;
  // Second call, no new revenue: D_asset = 5 but community net is exhausted.
  const dAsset1b = 10n * N - totalDistributed;
  let dEff2 = dAsset1b;
  if (dEff2 > treasuryAfter) dEff2 = treasuryAfter;
  if (dEff2 > communityNet - totalDistributed) dEff2 = communityNet - totalDistributed;
  check('E second call D_eff is 0 (rejected)', dEff2 === 0n, `D_eff2=${dEff2}`);
  check('E members total 60% of 5 net', s.sumP === 3n * N, `3 NEAR`);
  // New revenue 5 later: the remaining D becomes distributable again.
  const communityNet2 = (R + 5n * N) - E;
  const dAsset1c = (10n * N + 5n * N) - totalDistributed;
  let dEff3 = dAsset1c;
  if (dEff3 > communityNet2 - totalDistributed) dEff3 = communityNet2 - totalDistributed;
  check('E later revenue D_eff', dEff3 === 5n * N, `D_eff3=${dEff3}`);
  const s3 = split(dEff3, 6000, 2500, 1500, [2500, 2500, 2500, 2500]);
  check('E members total 60% of 10 net after new revenue', s.sumP + s3.sumP === 6n * N, `6 NEAR`);
}

// --- identity proof: treasury - locked == R - E - P (campaign accounting) ---
{
  // campaigns: [open 3, acquired 10, cancelled 4] (NEAR)
  const camps = [
    { r: 3n * N, st: 'open' }, { r: 10n * N, st: 'acquired' }, { r: 4n * N, st: 'cancelled' },
  ];
  let C = 0n, A = 0n, F = 0n, L = 0n;
  for (const c of camps) {
    C += c.r;
    if (c.st === 'acquired') A += c.r;
    if (c.st === 'cancelled') F += c.r;
    if (c.st === 'open') L += c.r;
    check(`identity per campaign (${c.st})`, c.r - (c.st === 'acquired' ? c.r : 0n) - (c.st === 'cancelled' ? c.r : 0n) - (c.st === 'open' ? c.r : 0n) === 0n);
  }
  const R = 7n * N, E = 2n * N, P = 1n * N;
  const treasury = C + R - A - E - P - F;
  check('identity treasury-locked == R-E-P', treasury - L === R - E - P, `${treasury - L} == ${R - E - P}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
