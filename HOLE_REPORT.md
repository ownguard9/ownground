# OwnGround — design hole report (2026-11-09, build STOPPED before writing the contract)

Read `DESIGN.md` v1 and checked the maths against the design's own invariants,
with concrete numbers. Four holes and eight gaps. What is NOT broken: the
distribution rounding and remainder rules (checked below, including nasty
cases), the funding cap, the acquire gating as stated, the DAO-only
predecessor checks, and the revenue status split in principle. The problems
are in the acquisition transfer, the treasury equation, the distribution
accounting, and the campaign-funds lock. Do not build the contract on the
v1 numbers; pick fixes first.

## Verified sound: distribution rounding

All money in yoctoNEAR, u128. Policy shares sum to 10000.

- M = floor(D x m/10000), T = floor(D x t/10000), Mt = floor(D x n/10000).
  Each floor loses < 1 yocto, so R = D - M - T - Mt is in {0, 1, 2}, as the
  design says.
- Member i gets floor(M x a_i/10000), allocations sum to 10000. Rm = M -
  sum(payouts) is in [0, n-1] for n members (n <= 20 in v1).
- Final: sum(payouts) + (T + R + Rm) + Mt = D exactly. Checked.
- Demo numbers are clean: D = 2.5 NEAR, 60/25/15 -> M = 1.5, T = 0.625,
  Mt = 0.375, R = 0; four equal members (2500 bp each) get 0.375 each,
  Rm = 0. Total 2.5 exactly.
- Nasty cases hold: D = 7 yocto, 6000/2500/1500 -> M = 4, T = 1, Mt = 1,
  R = 1 to treasury; four equal members get 1 each, Rm = 0; total 7.
  D = 1 yocto -> M = T = Mt = 0, R = 1 to treasury, members get 0.
  Three members 3333/3333/3334, M = 10 -> payouts 3 + 3 + 3 = 9, Rm = 1
  to treasury. Exact in every case.
- Overflow: D x 10000 cannot overflow u128 at any realistic balance
  (whole NEAR supply ~1.2e33 yocto x 1e4 = 1.2e37 < 3.4e38), and the
  design requires checked arithmetic, so an overflow would panic safely
  rather than wrap.

## Hole 1 — acquire_asset has no seller: the acquisition money has nowhere to go

The design counts the acquisition as a treasury spend ("moves the target
from the campaign into the treasury's acquisition spend") and invariant 1
says deposits - spent = treasury balance. But `acquire_asset(campaign_id,
allocation)` takes no seller or recipient, and the 15-step flow names no
seller. So either:

- (a) the implementation records the spend without transferring anything.
  Then after the demo acquisition the tracked treasury is 0 while the
  contract still holds the 10 NEAR. Invariant 1 is false against the real
  balance: 10 - 10 = 0, but 10 NEAR is still held. Worse, that 10 NEAR can
  never be spent afterwards: every spend checks the treasury counter, which
  says 0. The money is stranded in the contract forever, and a judge
  checking the explorer sees the contract holding 10 NEAR the ledger claims
  was spent on a generator, with no transfer to any seller. The
  "acquisition" is unverifiable.
- (b) the implementation transfers to someone the design never names, which
  means the builder has to invent the recipient.

Either way the design as written cannot produce a verifiable acquisition.

### Proposed fix (required)

Add `seller: AccountId` to `acquire_asset`. The call transfers the target
to the seller in the same call and counts it as acquisition spend. The DAO
proposal that approves the acquisition names the seller, so the transfer is
governed. The demo needs a demo seller account (the account that "sold"
the generator); the demo log shows the transfer. Do NOT take the
alternative of keeping the funds in the contract as the asset's backing and
changing the treasury equation — that breaks the "spent" model and strands
the funds.

## Hole 2 — the treasury equation omits refunds

Invariant 1: treasury = total deposits (contributions + revenue deposits) -
total spent (acquisitions + expenses + distribution payouts). Refunds are
not in the spent list, but `cancel_campaign` pushes refunds out of the
contract.

Concrete case: 4 members contribute 2.5 NEAR each (deposits 10, treasury
10). The DAO cancels the campaign and refunds all 10 NEAR. Actual contract
balance is now 0, but the tracked treasury still says 10, because no spent
counter moved. The next spend of up to 10 NEAR would be approved by the
treasury check and then fail for insufficient balance — or, if the
implementation decrements the counter without checking the real balance,
the counter underflows. The verify script checking only tracked counters
would PASS (10 - 0 = 10) while the ledger disagrees with reality.

### Proposed fix (required)

Treasury = (contributions + revenue deposits) - (acquisitions + expenses +
distribution payouts + refunds). Track a refunds counter onchain; the
verify script checks the corrected equation. Also state explicitly that
cancel is allowed only from open/funded status, never from acquired or
cancelled (the one-shot refund is enforced by the status transition in the
same call).

## Hole 3 — `already_distributed` is undefined and there is no period, so the one-shot distribution fails

The design defines D = max(0, revenue_onchain - expenses -
already_distributed) and says a distribution "cannot run twice for the same
period". Two problems:

- `already_distributed` is never defined. The natural reading is "member
  payouts so far" (the transfers the contract made). But the retention and
  maintenance shares are also consumed by a distribution — they must not
  re-enter the distributable pool.
- There is no period anywhere in the design: no period field, no period
  length, no tick. A distribution record is one-shot, but nothing stops a
  second `execute_distribution` call creating a second record and paying
  again.

Concrete case (demo numbers, wrong reading): revenue 3 NEAR, expense 0.5
NEAR, policy 60/25/15, four equal members. First distribution: D = 3 - 0.5
- 0 = 2.5. Members get 1.5, retention 0.625, maintenance 0.375. Second
call, same period, no new revenue: D = 3 - 0.5 - 1.5 = 1.0 > 0, so it
executes. Members get another 0.6 (total 2.1 = 84% of the 2.5 net
earnings, not 60%). Third call: D = 0.4, members get 0.24 (total 2.34 =
93.6%). It converges to members receiving 100% of net earnings. The
60/25/15 policy is violated by repeated execution, and invariant 3 ("a
distribution executes at most once") is false in practice.

### Proposed fix (required)

Define TWO counters and use each in exactly one place:

- `distributed_payouts`: cumulative NEAR actually transferred to members.
  Used ONLY in the treasury equation (spent side).
- `distributed_total`: cumulative D consumed by executed distributions.
  Used ONLY in the D formula: D = max(0, revenue_onchain - expenses -
  distributed_total). `execute_distribution` increments it by D.

Then an immediate second call computes D = 0 and is rejected by the
existing D > 0 requirement — that rejection IS the one-shot guard, so drop
the undefined "period" language (or define distribution epochs explicitly;
the D > 0 guard alone is sufficient). Also scope distributions per asset
(see Gap 2): `execute_distribution` takes an asset_id, D is computed from
that asset's revenue, expenses and distributed_total, and the allocation
used is that asset's. The policy stays community-level; the execution is
per asset.

## Hole 4 — campaign funds are not actually locked

The design says "The campaign funds stay locked in the contract until
acquisition (or refund on cancellation)." But the treasury is a single pool
and the only spend check stated is `amount <= treasury`. Campaign funds sit
in that pool, so a DAO-approved expense can spend them.

Concrete case: 4 members contribute 2.5 NEAR each (raised 10, treasury
10). The DAO approves a 6 NEAR expense: 6 <= 10 passes. Treasury is now 4.
The DAO approves the acquisition: raised == target (10 == 10) passes the
design's stated gate. `acquire_asset` then tries to move 10 NEAR from a
treasury holding 4 — the transfer fails for insufficient balance, or the
counter underflows. The acquisition is bricked, the 6 NEAR expense is gone,
and the campaign can never complete. The design's acquire gate checks the
campaign counter but never checks that the money is still there.

### Proposed fix (required, minimal and consistent with the design's equation)

Track `locked = sum of raised over open/funded campaigns` per community,
and enforce spendable funds on every spend:

- `pay_expense` requires amount <= treasury - locked.
- `acquire_asset` requires treasury >= target, in addition to raised ==
  target (defense in depth; with the lock guard the check should always
  pass, but it must be stated).
- Distributions need no extra lock check: the unlocked treasury always
  covers D. Proof sketch: treasury - locked = revenue - expenses -
  payouts (the contribution, acquisition and refund terms cancel exactly:
  contributions - locked - acquisitions - refunds = 0, because acquire
  requires raised == target and refunds return exactly the raised amount),
  and D <= treasury - locked because member payouts are a fraction of D.
  An explicit check on the payout total is harmless defense and may be
  added.

Alternative (not recommended for v1): segregate campaign funds into a
separate escrow so they never enter the treasury. That is cleaner in the
abstract but changes the design's stated treasury equation; the lock
counter keeps the equation as written.

## Gaps (not holes, but the design must specify them before building)

- **Gap 1 — record_revenue amount vs attached deposit.** The signature is
  `record_revenue(asset_id, amount, source, reference)`, "attaches NEAR
  for onchain, or 0 for reported". The contract must check attached ==
  amount for onchain (and amount > 0), and attached == 0 for reported.
  Without the check, the recorded amount and the actual deposit can
  diverge and invariant 1 breaks against the real balance.
- **Gap 2 — distribution scoping.** `execute_distribution(community_id)`
  is community-level, but ownership allocations are per asset. With two
  assets the allocation is undefined. Fix: per-asset distribution (see
  Hole 3 fix).
- **Gap 3 — close_community and membership.** `close_community` is listed
  in the DAO-only methods but not in the Methods list; membership roles
  are never defined; there is no join/leave. Recommendation for v1: fixed
  membership set at creation, drop roles, omit `close_community` from v1
  (or define it minimally before building).
- **Gap 4 — zero-amount and status guards.** Require target > 0 at
  campaign creation, contribution > 0, expense > 0, onchain revenue
  amount > 0. `contribute` only when the campaign status is open.
- **Gap 5 — who may record revenue.** Restrict `reported` revenue to
  community members (otherwise anyone can pollute the ledger); `onchain`
  revenue may be recorded by anyone, since it is real money in.
- **Gap 6 — create_community trusts dao_id.** The contract cannot verify
  the DAO exists without a cross-contract call. Acceptable for v1 (the
  demo creates the DAO first), but state it in the README limits.
- **Gap 7 — storage deposits.** The design says storage deposits are
  "documented per method" but never says whether an attached deposit on
  `contribute` / `record_revenue` is purely the contribution/revenue or
  includes storage, nor how first-contributor storage is funded. Specify
  before the demo script is written.
- **Gap 8 — verify script scope.** The script checks tracked counters. If
  it also cross-checks the contract's raw balance, it must account for
  the storage reserve (and, pre-fix, stranded funds). State which one it
  checks.

## Environment readiness (checked 2026-11-09)

- Toolchain ready: cargo 1.99.1, rustc 1.99.1, cargo-near 0.22.0.
  `~/.cargo/bin` is not on PATH by default; export it.
- `near-workspaces` is NOT in the local crate cache (Turns found the same);
  the sandbox crates.io download has failed before on SSL/proxy. If it
  fails, the fallback is unit tests + a `cargo-near` local-chain demo, as
  Herald does.
- Nothing was deployed, pushed, or submitted. No OwnGround wallet or
  GitHub identity exists yet (handover due after the build finishes), and
  no other project's wallet or identity was used. No secrets in any file.
