# OwnGround — design (v2, testnet, NEAR Hackathon Social Money)

Name: **OwnGround** (picked by Isaiah 2026-11-09; the working title was
Commonhold, which he rejected: "I don't like common hold"). The tagline
stays "Own Together. Build Together. Grow Together."
Lead: TBD — Isaac presumed (he led Orbit and Turns, both stopped); confirm
before submission. Deadline: submit before 14 Nov 2026 23:59 UTC.
Separation: own GitHub, own website, own wallet (Isaiah provides them after
the build finishes). Testnet only.
Replaces Orbit and Turns (both stopped after their design checks found
holes). This spec is the "Commons 2.0" proposal Isaiah pasted 2026-11-09,
renamed and scoped.

## Fixes applied (v2, 2026-11-09)

The design check found four holes and eight gaps (full analysis in
`HOLE_REPORT.md`). Isaiah's instruction: fix them and continue building.
Every fix below follows the hole report's proposed fix, except Hole 3,
where the proposed fix is extended with an availability cap (see why).

### Hole 1 — acquire_asset had no seller (fixed)
`acquire_asset` now takes `seller: AccountId` and transfers the target to
the seller in the same call, counted as acquisition spend. The DAO proposal
that approves the acquisition names the seller, so the transfer is governed.
The demo uses a demo seller account and the demo log shows the transfer.

### Hole 2 — treasury equation omitted refunds (fixed)
Treasury = (contributions + revenue deposits) - (acquisitions + expenses +
distribution payouts + refunds). A `refunds` counter is tracked onchain.
Cancel is allowed only from open/funded status, never from acquired or
cancelled; the one-shot refund is enforced by the status transition in the
same call.

### Hole 3 — already_distributed undefined, no period, one-shot failed (fixed, extended)
Two counters, each used in exactly one place:
- `distributed_payouts`: cumulative NEAR actually transferred to members.
  Used ONLY in the treasury equation (spent side).
- `distributed_total`: cumulative D consumed by executed distributions.
  Used ONLY in the D formula: D = max(0, revenue_onchain - expenses -
  distributed_total), per asset.
`execute_distribution` takes an `asset_id` (per-asset execution; the policy
stays community-level, the allocation used is that asset's). An immediate
second call computes D = 0 and is rejected by the D > 0 requirement — that
rejection IS the one-shot guard. All "period" language is dropped.
Extension beyond the proposed fix: D is capped by available funds,
D_effective = min(D_asset, treasury - locked). The proposed fix's proof
sketch claimed D <= treasury - locked, but that fails when one asset has
net-negative earnings while another is profitable (concrete case below in
Re-verification). The cap keeps the treasury non-negative in every case;
the undistributed remainder stays available for a later distribution, and
the distribution record stores D_effective, so the exact-sum invariant
still holds on the amount actually distributed.
Second extension (found while building, 2026-11-09): D_effective is also
capped by the community's undistributed net earnings,
community_net - total_distributed, where community_net = total_revenue -
total_expenses (saturating) and total_distributed is the cumulative
D_effective across all assets. Without it, an expense charged to one
asset does not reduce another asset's D, so repeated distributions could
pay members more than 60% of true net earnings (concrete case in
Re-verification, Case E). With it, total member payouts never exceed the
policy share of community net earnings.

### Hole 4 — campaign funds not actually locked (fixed)
Track `locked = sum of raised over open/funded campaigns` per community.
- `pay_expense` requires amount <= treasury - locked.
- `acquire_asset` requires treasury >= target, in addition to raised ==
  target (defence in depth; with the lock guard it should always pass).
- Distributions use the D_effective cap (see Hole 3), so no extra lock
  check is needed there.

### Gap 1 — record_revenue amount vs attached deposit (fixed)
`onchain`: attached deposit must equal amount + 0.01 NEAR storage, and
amount > 0. `reported`: attached deposit must equal exactly 0.01 NEAR
storage, and amount > 0. The contract checks both; a mismatch rejects.

### Gap 2 — distribution scoping (fixed)
Per-asset distribution (see Hole 3 fix). `execute_distribution(asset_id)`.

### Gap 3 — close_community and membership (fixed)
Fixed membership set at creation; no roles; no join/leave; `close_community`
is omitted from v1 entirely (it is not in the Methods list and not in the
DAO-only list).

### Gap 4 — zero-amount and status guards (fixed)
Require target > 0 at campaign creation, contribution > 0, expense > 0,
onchain revenue amount > 0, reported revenue amount > 0. `contribute` only
when the campaign status is open. `record_revenue` only for an existing
asset. `pay_expense` only for an existing asset.

### Gap 5 — who may record revenue (fixed)
`reported` revenue may be recorded only by a community member. `onchain`
revenue may be recorded by anyone, since it is real money in.

### Gap 6 — create_community trusts dao_id (fixed by disclosure)
The contract cannot verify the DAO exists without a cross-contract call.
Accepted for v1 (the demo creates the DAO first); stated in the README
Limits section.

### Gap 7 — storage deposits (fixed, specified)
Every call that creates a new stored record attaches a 0.01 NEAR storage
deposit, except `create_community` (0.1 NEAR, covers the community record
and the fixed member list) and `create_campaign` (0.05 NEAR). The value
transferred is separate from the storage deposit:
- `contribute`: attached = contribution + 0.01. Contribution = attached -
  0.01.
- `record_revenue` onchain: attached = amount + 0.01.
- `record_revenue` reported: attached = 0.01.
- `pay_expense`, `acquire_asset`, `set_distribution_policy`,
  `execute_distribution`, `cancel_campaign`: attached = 0.01 (the DAO or
  caller attaches it).
Storage deposits are tracked in a `storage_reserve` counter and are never
counted in the treasury. The demo script attaches the documented amounts.

### Gap 8 — verify script scope (fixed)
The script checks tracked counters only for the treasury equation, and
additionally checks raw balance >= treasury + storage_reserve (a lower
bound: the excess is the deployer's initial account funding, reported as
informational). It does not require raw balance to equal the counters.

## What it is

Communities pool money, acquire a productive asset (a generator, a vehicle,
farm equipment), earn revenue from it, and distribute or reinvest the
earnings under rules nobody can quietly change. Not a savings circle, not a
crowdfunding page, not a generic DAO treasury: the whole
acquisition-to-revenue-to-distribution flow runs onchain.

Why a chain (the README must say this): pooled funds, ownership, and payouts
are enforced by the contract and the community's DAO votes. A spreadsheet or
an admin can be edited; a OwnGround community cannot be.

## Priority (Isaiah's instruction)

The complete acquisition-to-revenue-to-distribution flow comes first. All
other features are cut or minimal until that flow works end to end on
testnet and is verified by the keyless script.

## The flow (the demo, and the product)

1. A user connects a NEAR testnet wallet.
2. The user creates Lagos Energy Cooperative (a community with its own
   Sputnik DAO, members, and treasury).
3. Members contribute to an asset acquisition campaign (target: a commercial
   generator, 10 NEAR).
4. The community reaches its funding target.
5. A proposal is submitted to acquire the generator.
6. Members vote on the proposal (Sputnik DAO, strict majority of council).
7. The required approval threshold is reached.
8. The treasury executes the approved transaction: the contract acquires and
   registers the generator, transferring 10 NEAR to the seller.
9. The generator is registered in the asset registry with its ownership
   allocation.
10. Revenue is recorded against the asset (real NEAR deposited into the
    contract = verified onchain income).
11. Operating expenses are recorded (paid from the treasury, DAO-approved).
12. The community approves a revenue distribution policy (DAO vote).
13. The distribution engine calculates member entitlements.
14. Members receive actual testnet payouts.
15. The transaction history is independently verifiable on the NEAR explorer.

## Entities and state (one contract, many communities)

- Community: id (slug), name, description, DAO account (Sputnik DAO),
  members (fixed Vec<AccountId> set at creation, no roles), treasury
  counters (deposits, acquisitions, expenses, payouts, refunds,
  storage_reserve, distributed_payouts, total_distributed), distribution
  policy, status.
- Funding campaign: id, community, asset name/category, target (yoctoNEAR),
  raised, contributors (account -> amount), status
  (open / funded / acquired / cancelled), deadline.
- Asset: id, community, name, description, category, acquisition value,
  acquisition date, seller, ownership allocation (account -> basis points),
  status (active / retired), revenue history, maintenance history,
  distributed_total (cumulative D consumed by this asset's distributions).
- Revenue entry: asset, amount, date, source/description, reference,
  verification status: `onchain` (real NEAR deposited with the record) or
  `reported` (no deposit; an offchain payment recorded as a ledger entry,
  labelled as such on the site and never presented as verified income).
- Expense entry: asset, amount, date, description, recipient, proposal id.
- Distribution: id, asset, policy snapshot, distributable amount
  (D_effective, the amount actually distributed), per-member payouts,
  treasury retention, maintenance allocation, status (executed once, never
  twice).

## Money maths (all in yoctoNEAR, u128, no floating point)

### Funding
- A contribution is rejected if it would push `raised` above `target`.
  So `raised <= target` always, and `raised = sum(contributions)` exactly.
- Acquire requires `raised == target` AND `treasury >= target`. The
  campaign funds stay locked in the contract until acquisition (or refund
  on cancellation).
- Cancellation (DAO-approved, only from open/funded status) refunds
  contributors: one-shot push of each contributor's amount. A campaign can
  be refunded at most once.

### Treasury (per community)
- `treasury = (contributions + revenue deposits) - (acquisitions +
  expenses + distribution payouts + refunds)`. Track all six counters
  onchain; the verify script checks the equation.
- `locked = sum of raised over open/funded campaigns` per community.
- No spend is ever allowed beyond available funds: `pay_expense` requires
  amount <= treasury - locked; `acquire_asset` requires treasury >=
  target; distributions pay at most D_effective <= treasury - locked.
- Identity (holds by the campaign accounting, see Re-verification):
  treasury - locked = revenue_onchain - expenses - distributed_payouts.

### Distribution
- Policy: three basis-point shares — members / treasury retention /
  maintenance — that must sum to exactly 10000 at registration. Enforced.
  Default demo policy: 6000 / 2500 / 1500 (60% / 25% / 15%).
- Per asset: D_asset = max(0, revenue_onchain(asset) - expenses(asset) -
  distributed_total(asset)). D_effective = min(D_asset, treasury - locked,
  community_net - total_distributed), where community_net =
  total_revenue - total_expenses (saturating at 0) and total_distributed
  is the cumulative D_effective across all assets of the community. The
  distribution record stores D_effective.
- Split (integer division, floor each term):
  - member pool M = D_effective x members_bp / 10000
  - treasury retention T = D_effective x treasury_bp / 10000
  - maintenance Mt = D_effective x maintenance_bp / 10000
  - remainder R = D_effective - M - T - Mt (0, 1 or 2 yocto). R goes to
    treasury retention. So M + T + Mt + R = D_effective exactly.
- Member split: each member i gets floor(M x allocation_i / 10000), where
  allocation_i is their ownership basis points on the asset and the
  allocations sum to exactly 10000 (enforced at acquisition). Remainder
  Rm = M - sum(member payouts) goes to treasury retention as well.
  Final invariant: sum(member payouts) + treasury retention (including
  both remainders) + maintenance = D_effective exactly.
- One-shot: `execute_distribution(asset_id)` requires D_effective > 0,
  increments distributed_total by D_effective, increments
  distributed_payouts by sum(member payouts), and pays every member in
  the same call (real NEAR transfers). A second call computes
  D_asset = 0 (distributed_total already consumed it) and is rejected.
  Member cap: 20 members per community for v1 (gas bound on the push).
- Ownership allocation is set at acquisition and approved by the DAO vote
  that approves the acquisition. It is NOT assumed to equal contributions:
  the acquisition call carries the allocation explicitly, and the contract
  rejects it unless the basis points sum to exactly 10000.

### Invariants (the verify script checks these live, no wallet needed)
1. Treasury conservation: (contributions + revenue deposits) -
   (acquisitions + expenses + distribution payouts + refunds) = treasury
   balance, per community.
2. Funding: raised = sum(contributions), raised <= target, acquire only at
   raised == target and treasury >= target.
3. Distribution exactness: payouts + retention + maintenance =
   D_effective exactly, a second execute_distribution for the same
   asset with no new revenue computes D = 0 and is rejected, and total
   member payouts never exceed the policy share of community net
   earnings (total_distributed <= total_revenue - total_expenses).
4. No spend beyond available funds: pay_expense checks treasury - locked;
   acquire checks treasury >= target; distributions pay at most
   D_effective <= treasury - locked.
5. No double refund (a cancelled campaign refunds at most once; cancel
   only from open/funded).
6. Ownership allocations sum to exactly 10000 per asset.
7. Revenue status honesty: a `reported` entry never carries an onchain
   deposit (attached == 0.01 storage only), an `onchain` entry always
   carries attached == amount + 0.01, and the site labels reported entries
   as reported, not verified.
8. Spending policy: no expense ever violates the spending policy, and no
   expense ever takes the unlocked treasury below the reserve.
9. Activity: the activity slice sums exactly under the same remainder
   rule, and activity points only increase on a contribution or a revenue
   record.
10. Raw balance check: contract raw balance >= treasury + storage_reserve
    (the excess is the deployer's initial account funding).

## Re-verification of the fixed maths (concrete numbers)

All cases use the demo numbers unless stated. 1 NEAR = 1e24 yocto.

### Case A — demo flow, end to end
Contributions 4 x 2.5 = 10. Treasury 10, locked 10. Acquire (seller gets
10): treasury = 10 + 0 - 10 - 0 - 0 - 0 = 0, locked 0, actual balance 0.
Revenue 3 onchain: treasury 3. Expense 0.5 (DAO-approved, 0.5 <= 3 - 0):
treasury 2.5. Distribution: D_asset = max(0, 3 - 0.5 - 0) = 2.5;
D_effective = min(2.5, 2.5 - 0) = 2.5. M = 1.5, T = 0.625, Mt = 0.375,
R = 0; four equal members get 0.375 each, Rm = 0. Payouts 1.5.
Treasury = 10 + 3 - 10 - 0.5 - 1.5 - 0 = 1.0. Actual balance: in 13,
out 12, balance 1.0. Invariant 1 holds. Identity: treasury - locked =
1.0 - 0 = 1.0; revenue - expenses - payouts = 3 - 0.5 - 1.5 = 1.0. Holds.

### Case B — Hole 3 repeated distribution (the bug that was fixed)
Same as A through the first distribution: distributed_total = 2.5,
distributed_payouts = 1.5. Second call, no new revenue: D_asset =
max(0, 3 - 0.5 - 2.5) = 0 -> rejected. Members stay at 1.5 total, exactly
60% of 2.5 net earnings. Under the v1 (broken) formula the second call
would have paid another 0.6. New revenue 1 NEAR later: D_asset = max(0,
4 - 0.5 - 2.5) = 1.0; members get 0.6 more (total 2.1 = 60% of 3.5 net).
Correct.

### Case C — Hole 4 locked funds (the bug that was fixed)
Raised 10, treasury 10, locked 10. Expense 6: requires 6 <= 10 - 10 = 0
-> rejected. Expense 0 is rejected by the zero-amount guard. Acquire:
raised == target and treasury 10 >= 10 -> proceeds, seller gets 10.
After: treasury 0, locked 0.

### Case D — Hole 2 refund
Contributions 10, treasury 10, locked 10. DAO cancels: refunds 10,
treasury = 10 - 10 = 0, locked 0, actual balance 0. Second cancel:
status is cancelled, not open/funded -> rejected. A later spend of any
positive amount is rejected (amount <= 0 fails).

### Case E — multi-asset negative net (why the D_effective cap exists)
Two assets, both acquired at 10. Asset 1 revenue 10 onchain, asset 2
expense 5. Treasury = 20 + 10 - 20 - 5 - 0 - 0 = 5, locked 0.
D for asset 1 = max(0, 10 - 0 - 0) = 10, which exceeds the 5 available
(the hole report's proof sketch missed this). With the availability cap:
D_effective = min(10, 5, community_net - total_distributed = 5 - 0) = 5;
members get 3, retention 1.25, maintenance 0.75. Treasury after = 5 - 3
= 2, still non-negative. distributed_total(asset 1) = 5 and
total_distributed = 5.
Second call, no new revenue: D_asset = max(0, 10 - 0 - 5) = 5, but
community_net - total_distributed = 5 - 5 = 0, so D_effective = 0 and the
call is rejected. Without the community-net cap the second call would
have paid another 1.2, taking members to 4.2 = 84% of the 5 net earnings
instead of the policy's 60%. With it, members stay at 3 = 60% of 5 net,
exactly the policy. If asset 1 later earns 5 more revenue, community_net
becomes 10, total_distributed is 5, D_asset is 10, and D_effective =
min(10, available, 5) = 5, so members get 3 more (total 6 = 60% of 10
net). Correct in every step.

### Case F — distribution rounding (nasty cases, from the hole report)
D = 7 yocto, 6000/2500/1500 -> M = 4, T = 1, Mt = 1, R = 1 to treasury;
four equal members get 1 each, Rm = 0; total 7. D = 1 yocto -> M = T =
Mt = 0, R = 1 to treasury, members get 0. Three members 3333/3333/3334,
M = 10 -> payouts 3 + 3 + 3 = 9, Rm = 1 to treasury. Exact in every case.
Overflow: D x 10000 cannot overflow u128 at any realistic balance
(whole NEAR supply ~1.2e33 yocto x 1e4 = 1.2e37 < 3.4e38), and checked
arithmetic panics safely rather than wrapping.

## Governance (Sputnik DAO, the FairShare pattern)

- Each community gets its own Sputnik DAO (factory sputnikv2.testnet).
  Council = the community's members. Strict majority to pass.
- Treasury spending happens ONLY through DAO-approved calls. The contract
  checks `predecessor == community.dao_id` for: `acquire_asset`,
  `pay_expense`, `set_distribution_policy`, `cancel_campaign`. A frontend
  check never authorises a spend.
- The site reads proposals from the DAO (`get_proposals`) and shows their
  status; proposing and voting happen through the DAO as in FairShare.

## Contract (Rust, near-sdk, one contract with internal modules)

The spec's seven modules become Rust modules inside one contract crate
(one address, one verify target, simpler to deploy):
`registry` (communities + membership), `treasury` (balances + counters),
`funding` (campaigns + contributions + refunds), `assets` (registry +
ownership), `governance` (DAO predecessor checks), `revenue` (entries +
expenses), `distribution` (policies + payouts). NEP-297 events
(`standard: "ownground"`) on every state change. (The event standard
string is a code identifier; it stays "ownground" regardless of the
final brand name.)

Methods (attached deposits per Gap 7):
- `create_community(id, name, description, dao_id, members)` — creator;
  attaches 0.1 NEAR storage.
- `create_campaign(community_id, asset_name, category, target, deadline)` —
  community member; attaches 0.05 NEAR storage.
- `contribute(campaign_id)` — attaches contribution + 0.01 NEAR storage;
  rejected past target and unless status is open; contribution > 0.
- `acquire_asset(campaign_id, seller, allocation: Vec<(AccountId, bp)>)` —
  DAO only; attaches 0.01 NEAR; requires raised == target, treasury >=
  target, allocation sums to 10000; transfers target to seller, registers
  the asset.
- `record_revenue(asset_id, amount, source, reference, status)` — onchain:
  attached == amount + 0.01, amount > 0, anyone may call; reported:
  attached == 0.01, amount > 0, community member only.
- `pay_expense(asset_id, amount, recipient, description)` — DAO only;
  attaches 0.01 NEAR; requires amount > 0 and amount <= treasury - locked.
- `set_distribution_policy(community_id, members_bp, treasury_bp,
  maintenance_bp)` — DAO only; attaches 0.01 NEAR; shares must sum to
  10000.
- `execute_distribution(asset_id)` — anyone; attaches 0.01 NEAR; requires
  D_effective > 0; one-shot via the D = 0 guard.
- `cancel_campaign(campaign_id)` — DAO only; attaches 0.01 NEAR; only from
  open/funded; one-shot push refunds.
- Views: `get_community`, `get_campaign`, `get_asset`, `get_treasury`,
  `get_revenue`, `get_expenses`, `get_distribution`, `get_stats`.
- Safety: state is updated before any external transfer (no reentrancy
  window); all arithmetic is checked u128; storage deposits are documented
  per method; no method trusts the frontend.

## Tests

- Unit tests for: funding cap (contribution past target rejected), acquire
  gating (below target rejected, allocation not summing to 10000 rejected,
  seller receives the target, treasury >= target check), treasury
  conservation (including refunds), distribution rounding (including the
  remainder rules and the exact-sum invariant), one-shot distribution
  (second call rejected), double refund prevention, DAO-only enforcement
  (non-DAO caller rejected), revenue status labelling (attached-deposit
  checks, reported restricted to members), locked-funds guard (expense
  rejected while funds are locked).
- Integration test in a sandbox against the real Sputnik DAO v2 build:
  the full 15-step demo flow. (If near-workspaces cannot be downloaded in
  this sandbox, the fallback is unit tests plus a cargo-near local-chain
  demo, as Herald does.)
- Publish the test count in the README. CI on every push (fmt, clippy,
  tests).

## Verify script (keyless)

`npm run verify` / `scripts/verify.mjs`: reads the live testnet contract,
checks invariants 1-10 against onchain state, prints PASS/FAIL per check
with the numbers. No wallet, no signing.

## Site

Static site, plain HTML/JS + the FastNEAR wallet bundle (testnet only),
same pattern as FairShare. Pages: landing (problem, solution, the flow,
"Own Together. Build Together. Grow Together."), communities, community
dashboard (treasury, campaigns, assets, governance, revenue, distributions),
asset page. The community dashboard is organised around the flow, with the
current step visible. Visible copy avoids hyphens/dashes. No mainnet parts.
Charts are simple and honest: acquisition value, treasury balance, and
realised revenue are shown as separate figures, never combined into one
misleading total. The brand name appears in exactly one place:
`site/config.js` exports `BRAND_NAME` ("OwnGround"); all pages read it
from there and no brand string is hardcoded in page copy.

## Demo script

`scripts/demo.mjs`: the 15-step Lagos Energy Cooperative flow with demo
accounts (labelled as demo accounts in the README and on the site): create
the DAO, create the community, 4 members contribute 2.5 NEAR each (each
attaching 2.51 NEAR) to reach the 10 NEAR generator target, propose + vote
+ execute the acquisition with a contribution-proportional ownership
allocation (an explicit DAO-approved choice, not an assumption) and a demo
seller account receiving the 10 NEAR, record 3 NEAR onchain revenue
(attaching 3.01 NEAR), pay a 0.5 NEAR DAO-approved expense, approve the
60/25/15 policy, execute the distribution and pay the members. Every
transaction is real and linked in the log.

## README (do X, see Y)

Judge steps with an expected result for each, plus: why a chain is needed,
the trust-model paragraph, a Limits section (demo accounts only; testnet
only; deployer key held during the hackathon; no audit; no Trezu — Trezu is
production mainnet-only and has no live testnet payout path; physical
revenue claims rest on the recorded entry's status, onchain or reported;
the contract cannot verify a DAO exists without a cross-contract call),
the test count, and the verify command. No fake transaction hashes, balances,
or success messages anywhere. The README title carries the brand name.

## Build order (Nov 9-13; submit Nov 14)

1. Nov 9: contract + unit tests.
2. Nov 10: deploy testnet, integration test, verify script.
3. Nov 11: site + demo script (the 15-step flow).
4. Nov 12: video + X post.
5. Nov 13: README polish, submission prep (needs lead's email + payout
   NEAR address + repo from the handover).
6. Nov 14: submit. Track Social Money, size 1.

## Non-goals for v1

No Trezu. No asset leasing or sales. No reputation score (participation is
visible from onchain history; no arbitrary score). No second asset type.
No fee. No mainnet parts.

## Beating the top three (added 2026-11-09, on Isaiah's instruction)

Take the strongest mechanism from each rival without copying their product.
Two mechanisms, both contract-enforced, both added to v1.

### A. From Petty Cash: enforceable spending policies

Petty Cash's strength is spending rules the contract enforces, not just
governance norms. OwnGround already requires a DAO vote for every spend;
this adds onchain rules that bind even a DAO-approved spend.

Per community, a `SpendingPolicy` (set by `set_spending_policy`, DAO only):

- `max_single_expense`: the largest single expense allowed (yoctoNEAR).
  0 means no cap. Demo policy: 1 NEAR.
- `min_treasury_reserve`: the treasury floor. An expense is rejected if it
  would take the unlocked treasury (treasury - locked) below this.
  Demo policy: 1 NEAR.
- `allowed_categories`: the expense categories the community permits
  (for example "maintenance", "operations"). An expense whose category is
  not listed is rejected. Demo policy: ["maintenance", "operations"].

Enforcement (in `pay_expense`, before any transfer):

- amount <= max_single_expense (when the cap is set).
- (treasury - locked) - amount >= min_treasury_reserve.
- category is in allowed_categories.
- The locked-funds guard from the Hole 4 fix still applies first.

The acquisition is NOT capped by max_single_expense (a generator costs
more than one expense); it is governed by the campaign target and the DAO
vote. The reserve check applies to the unlocked pool only, so it does not
block an acquisition funded by locked campaign money.

New invariant 8: no expense ever violates the spending policy, and no
expense ever takes the unlocked treasury below the reserve.

Tests: over-cap expense rejected; below-reserve expense rejected;
disallowed-category expense rejected; an expense inside all three rules
executes; only the DAO can set the policy; a policy with a 0 cap means
uncapped.

Demo change: the demo script sets the spending policy (1 NEAR cap, 1 NEAR
reserve, maintenance + operations) before recording the 0.5 NEAR expense,
so the demo proves the policy allows a good expense. The demo log also
shows one rejected over-cap expense attempt (a 2 NEAR expense that the
contract refuses) to prove the policy bites.

### B. From Herald: contributor and activity-based incentives

Herald's strength is trust earned from activity, and payouts that reward
it. OwnGround's distribution is by ownership allocation; this adds an
activity slice on top of it without disturbing the ownership model.

Activity points (per member, per community, counted by the contract —
only actions the contract itself sees):

- Contribution points are derived from the member's CUMULATIVE contributed
  total: points = max(1, floor(total_contributed / 1 NEAR)) once the member
  has contributed anything, else 0. (FIX applied 2026-11-09 while building:
  the section first said "each contribution earns floor(amount / 1 NEAR)
  points, minimum 1 per contribution", but that rule rewards splitting —
  five 0.5 NEAR contributions earn 5 points against 2 for one 2.5 NEAR
  contribution — which contradicts the same paragraph's "splitting earns no
  extra points". The cumulative rule is the one that satisfies the stated
  property: the same total always earns the same points however it is split.)
- Each revenue record earns 1 point (onchain or reported), for the member
  who recorded it. A non-member who records onchain revenue earns no point.
- Points only ever increase, and only on those two actions.

Distribution policy gains one parameter, `activity_bp` (0-10000, default
1000 = 10%): the share of the member pool M that is distributed by
activity points instead of ownership allocation.

- Activity pool A = floor(M x activity_bp / 10000). Ownership pool
  O = M - A. (When activity_bp is 0, A is 0 and the whole pool goes by
  ownership, exactly as before.)
- Activity split: member i gets floor(A x points_i / total_points). If
  total_points is 0, A is added to O instead (the whole pool goes by
  ownership).
- Ownership split: as before, floor(O x allocation_i / 10000).
- Remainders from both splits go to treasury retention, exactly as the
  existing remainder rule. The exact-sum invariant still holds:
  sum(member payouts) + treasury retention (including all remainders) +
  maintenance = D exactly.

`set_distribution_policy` (DAO only) now sets four parameters:
members_bp, treasury_bp, maintenance_bp (which must sum to 10000) and
activity_bp (0-10000). The ownership allocation itself is untouched —
activity rewards activity, it does not rewrite ownership.

New invariant 9: the activity slice sums exactly under the same remainder
rule, and activity points only increase on a contribution or a revenue
record.

Note on invariant numbering: the v2 list already had an invariant 8 (raw
balance check). The spending policy is invariant 8, activity is invariant
9, and the raw balance check is renumbered to invariant 10. The verify
script checks 1-10.

Tests: contribution points (whole NEAR, minimum 1, no gain from splitting);
revenue-record points; activity slice split with exact sum; zero-points
fallback (whole pool by ownership); default 10% activity slice; a policy
with activity_bp 0 behaves exactly as the pre-activity distribution.

Demo change: the demo's 4 members contribute 2.5 NEAR each (2 points
each); the member who records the 3 NEAR revenue earns 1 more point (3
total). The distribution shows the activity slice: the revenue recorder
gets a slightly larger share than the other three, and the log shows the
exact split.

### What this does not add

No trust-gated payout routes (Herald's three routes) and no period-based
spending cap — both are future work. The two mechanisms above are the
minimal faithful versions that fit v1 and the existing, verified maths.

## Strengthened economics and security (added 2026-11-09, on Isaiah's instruction)

OwnGround protects community capital, rewards genuine contributions,
preserves ownership rights, and distributes wealth transparently. The six
areas below strengthen the two mechanisms from "Beating the top three".
All of it is enforced by the contract, never by the frontend alone.

### 1. Activity verification

Capital and work are different things and are tracked separately.

Per member, per community, two counters:

- `capital_points`: from contributions. Computed from the member's
  CUMULATIVE contributions, not per event: on each contribution,
  `capital_points = capital_per_near x floor(total_contributed / 1 NEAR)`.
  Splitting one contribution into many small ones earns nothing extra,
  because the points depend on the cumulative total, not on the number of
  contributions. A sub-1-NEAR cumulative total earns 0 points.
- `work_points`: from verified work only. Earned only when a revenue entry
  is VERIFIED (see below). Never from an unverified entry, never from an
  arbitrary submission.

The activity slice of a distribution is split by `work_points` only.
`capital_points` are recorded and shown separately (transparency) but do
not affect the activity slice. Capital is rewarded through the ownership
share; work is rewarded through the activity slice. Neither rewrites the
other.

Verification process for revenue and work points:

- `record_revenue` with an attached deposit (attached == amount, amount
  > 0) creates an `onchain` entry: the deposit itself is the verification
  (real money in). Work points are awarded when the entry is recorded.
- `record_revenue` with 0 attached creates a `reported` entry with status
  `pending`: it earns NO points and is labelled "Reported — not
  independently verified" everywhere it appears.
- A different member (never the recorder, and a community member) calls
  `attest_revenue(asset_id, entry_id)`. On attestation the entry becomes
  `verified` and the recorder earns work points. Attestation is one-shot:
  the entry's status moves pending -> verified and a second attestation is
  rejected. The attestor earns no points (verification is a duty, not a
  reward, so there is no attestation-farming incentive).
- Duplicate revenue submissions are rejected: a revenue entry is
  identified by (asset_id, reference), and recording a second entry with
  the same reference is rejected. The demo uses distinct references.

Activity policy (configurable, DAO-approved):

- `set_activity_policy` (DAO only) sets: `capital_per_near` (default 1),
  `work_per_revenue_record` (default 1), `work_per_revenue_near`
  (default 1). Work points for a verified revenue entry =
  `work_per_revenue_record + work_per_revenue_near x floor(amount /
  1 NEAR)`. Changing the policy requires its own DAO proposal; a single
  member cannot change it, and an expense proposal cannot change it.
- All weights are u64. A weight of 0 disables that source of points.

Anti-farming summary: points depend on cumulative totals and verified
entries, not on event counts; self-attestation and duplicate references
are rejected; attestation earns nothing; weights change only by DAO vote.

### 2. Distribution engine

- Default: 90% ownership-based, 10% activity-based (`activity_bp`
  default 1000). All four policy parameters (members_bp, treasury_bp,
  maintenance_bp, activity_bp) are configurable through DAO governance
  (`set_distribution_policy`, DAO only). members+treasury+maintenance
  must sum to 10000; activity_bp is 0-10000.
- All calculations in yoctoNEAR (u128, checked arithmetic). No floating
  point anywhere.
- Exactness: sum(member payouts) + treasury retention (including every
  remainder) + maintenance = D exactly, always. The activity slice uses
  the same floor-and-remainder rule as the ownership split: each member's
  payout is a pure function of (M, allocation, points) and does not depend
  on iteration order; every remainder goes to treasury retention. The
  remainder rule is therefore deterministic.
- Double distributions: prevented by the two-counter design
  (`distributed_total` in the D formula, `distributed_payouts` in the
  treasury equation) plus the D > 0 guard — a second execution in the
  same state computes D = 0 and is rejected. There are no claims to
  duplicate: payouts are pushed in one call, one-shot.
- Payout failures: `execute_distribution` pays via promises with a
  callback (`on_payouts_complete`) that reconciles the results. If a
  member's transfer fails, that amount is credited back to the
  undistributed pool and the member is listed as unpaid in the
  distribution record (so the funds are never lost and a later
  distribution can include them). A failed payout never changes the
  distribution's recorded totals.
- Ownership entitlements never change when activity rewards are awarded:
  the ownership allocation map is set once at acquisition (DAO-approved)
  and is immutable in v1. Activity points and the activity slice never
  write to it.

### 3. Treasury protection

- The spending policy (max single expense, minimum treasury reserve,
  allowed categories) is enforced inside the contract in `pay_expense`,
  before any transfer. It is not a frontend check.
- DAO approval does NOT bypass the restrictions: the guards run on every
  `pay_expense` call regardless of caller. The DAO is the only caller,
  but the policy binds the DAO too. To spend beyond the policy, the
  community must first pass a separate governance proposal changing the
  policy (`set_spending_policy`, DAO only), and only then propose the
  expense. A single proposal cannot do both (the contract enforces the
  policy in force at the time of the spend; the process rule is stated in
  the README).
- Only the DAO can change the policy (`set_spending_policy` rejects any
  other caller). A policy change is a separate proposal from any expense.
- Rejected spending attempts: a failed transaction cannot write to
  onchain state (the transaction is rolled back), so the contract does
  not store a log of its own rejections. Instead, every guard has a
  distinct panic message naming the rule violated (for example
  "expense exceeds max_single_expense", "expense would breach
  min_treasury_reserve", "expense category not allowed"). The site
  displays the failure reason from the transaction outcome, the demo log
  records rejected attempts with their reasons, and the README lists the
  guard messages. The verify script checks the policy is in force.

### 4. Economic transparency

- The distribution record stores ownership payouts and activity payouts
  per member SEPARATELY, and the site shows them as two separate lines.
- A member can inspect how their payout was calculated: the view
  `get_distribution_breakdown(distribution_id, account)` returns the
  inputs (D, M, activity pool, ownership pool, the member's allocation,
  the member's work points, total work points) and the computed amounts,
  so any member can recompute their payout. The site shows the formula
  next to the numbers.
- The community dashboard shows four separate figures: verified revenue
  (onchain deposits only), expenses, retained reserves (treasury
  retention + maintenance buckets), and distributable revenue
  (undistributed). They are never combined into one misleading total.
- Manually recorded revenue is never presented as independently verified
  income: `reported` entries are labelled "Reported — not independently
  verified" on the site and in the README; only `onchain` entries are
  labelled "Verified onchain". The verify script checks that no reported
  entry carries a deposit.

### 5. Security testing (required unit tests)

- Unauthorized withdrawal: a non-DAO caller cannot call `pay_expense`,
  `acquire_asset`, `set_distribution_policy`, `set_spending_policy`,
  `set_activity_policy`, or `cancel_campaign`.
- Expense exceeding the maximum limit is rejected with the max-expense
  reason.
- Reserve-floor violation is rejected with the reserve reason.
- Disallowed-category expense is rejected with the category reason.
- Duplicate revenue submission (same asset + reference) is rejected.
- Activity-point manipulation: splitting a contribution earns no extra
  capital points; self-attestation is rejected; double attestation is
  rejected; an unverified (pending) revenue entry earns no work points;
  attestation earns the attestor no points.
- Rounding and distribution conservation: the exact-sum invariant holds
  including nasty cases (D = 7 yocto, D = 1 yocto, uneven allocations,
  uneven points, zero total work points).
- Malicious or unauthorized policy changes: a non-DAO caller cannot
  change any policy; a DAO expense proposal cannot bypass the spending
  policy in force.
- Double distribution: a second `execute_distribution` with no new
  revenue is rejected (D = 0).

### 6. Demonstration (the demo must visibly prove each of these)

The demo script's log shows, with transaction links:

- A valid expense succeeds (0.5 NEAR, within the 1 NEAR cap, above the
  1 NEAR reserve, category maintenance).
- An excessive expense fails onchain (a 2 NEAR expense, rejected by the
  contract with the max-expense reason).
- An unverified revenue entry earns no points (a `reported` entry is
  recorded and the recorder's work points stay 0).
- A verified activity earns points (the 3 NEAR `onchain` revenue record
  earns work points; a `reported` entry earns points only after a
  different member attests it).
- Two members with equal ownership receive different total distributions
  because of verified activity (the revenue recorder's total exceeds the
  others' by exactly the activity slice).
- Total payouts equal the approved distribution amount exactly (the log
  shows the sum of member payouts + retention + maintenance = D, to the
  yocto).

## Four safeguards (added 2026-11-09, on Isaiah's instruction)

Isaiah approved both architectural decisions: verified work points are the
only source of activity rewards, and treasury spending restrictions are
enforceable even against DAO-approved spending proposals. The four
safeguards below make that defensible. All of it is enforced by the
contract and proven by automated tests, not just by the demonstration.

### Safeguard 1 — Prevent collusion between revenue submitters and verifiers

Every revenue entry records its evidence: recorder, attestor (once
attested), evidence reference, amount, status. The reference is part of
the entry's identity (asset_id, reference), so a duplicate submission
with the same reference is rejected.

- Attestation is one-shot and by a different member only. The entry's
  status moves pending -> verified; a second attestation is rejected, and
  self-attestation is rejected. The attestor earns no points and no
  reward for verifying.
- Attestation bond: `attest_revenue` requires a 0.1 NEAR bond attached.
  The bond is held by the contract per entry. It is a deposit, not a
  reward, and it is what makes rubber-stamping costly.
- Disputes: any member except the recorder and the attestor can call
  `dispute_revenue(entry_id)` within the dispute window (contract
  parameter, default 7 days, demo: minutes). The entry becomes
  `disputed` and its work points are suspended — excluded from the
  activity slice while disputed.
- Resolution is by DAO vote: a proposal calls
  `resolve_dispute(entry_id, uphold: bool)` (DAO only). If the dispute
  is upheld (verification overturned): the entry becomes `rejected`, the
  recorder's work points from that entry are removed (from the current
  epoch; if already consumed in a distribution, deducted from the
  member's current-epoch points, floored at 0 — the paid distribution is
  never re-run), and the attestor's bond goes to the community treasury.
  If the dispute is rejected (verification stands): the entry returns to
  `verified` and the bond is returned to the attestor.
- Bond release: if the dispute window passes with no dispute, the
  attestor calls `release_attestation_bond(entry_id)` and gets the bond
  back.
- Work points are awarded exactly once: points are tied to the entry id,
  the entry records `points_awarded`, and awarding happens once — at
  verification (attested reported entry) or at record time (onchain
  entry). A second award attempt is rejected by the status check.

### Safeguard 2 — Prevent circular revenue farming

Depositing and withdrawing the same capital must not generate unlimited
verified work points. Only qualifying economic activity earns rewards.
Qualifying activity in OwnGround is verified revenue generation only
(an onchain deposit, or an attested reported entry). No points are
awarded for proposals, votes, claims, or any other submission.

Three layers of defence:

- Economics: revenue is shared pro-rata by ownership, so a member who
  deposits revenue recovers only their ownership share plus their
  activity share of it — always less than the deposit (unless they own
  everything and do all the work, in which case there is nobody to farm
  from). Cycling the same capital loses money every round. This is
  stated in the README and tested: a member who deposits 3 NEAR and
  cycles it recovers less than 3 NEAR.
- Epochs: each asset has an `epoch` counter, incremented by every
  `execute_distribution` for that asset. Work points are tracked per
  epoch (current) plus a lifetime total for display. The activity slice
  for a distribution uses only the current epoch's work points; after
  the distribution the current-epoch points reset to 0. Points therefore
  reward recent activity and cannot accumulate without bound from one
  entry — each new epoch needs new verified activity.
- Entry caps: a single revenue entry earns at most its defined points
  (record points + near points), and duplicate references are rejected,
  so one deposit cannot be re-recorded to earn points again.

### Safeguard 3 — Safe policy amendment mechanism

Initial policies (spending, distribution, activity) are set at community
creation as the founding parameters. Any later change goes through a
two-step amendment flow; there are no direct `set_*_policy` calls in v1.

- Step 1 — propose: a DAO proposal calls
  `propose_policy_change(policy_type, new_params)` (DAO only). This
  records a pending amendment with a voting deadline (the timelock:
  contract parameter, default 3 days, demo: minutes) and emits a
  `policy_amendment_proposed` event. The DAO's own vote is the approval.
- Step 2 — execute: after the deadline, anyone calls
  `execute_policy_change(amendment_id)`. It applies the new parameters,
  stores the amendment as executed, and emits a `policy_amendment_executed`
  event recording the old and new parameters. Executing before the
  deadline is rejected.
- No permanent deadlocks: an amendment expires if not executed within 30
  days after its deadline (after which it can be re-proposed); a pending
  amendment can be cancelled by a DAO proposal
  (`cancel_policy_change`, DAO only) and superseded by a newer one; and
  if governance itself cannot reach a majority, the existing policy
  simply stays in force — the product keeps working under the old rules,
  so a governance deadlock never bricks the community.
- The site shows the policy history (proposed, executed, cancelled,
  expired) from the stored amendment records.

### Safeguard 4 — Distinguish contract rejections from other failures

The site classifies every transaction failure into exactly one of four
categories, with distinct wording, and never shows a bare "transaction
failed":

- Contract policy rejection: the transaction receipt shows a failure
  carrying the contract's panic message (for example "expense exceeds
  max_single_expense"). The site displays the specific rule: "Rejected
  by the community's spending policy: the expense exceeds the 1 NEAR
  maximum." No money moved.
- Network failure (RPC unreachable or timed out): "Network error — the
  transaction may not have been sent. Check your connection and try
  again. No money moved."
- Gas failure (out of gas): "Ran out of gas — the transaction did not
  execute. No money moved. Try again."
- Wallet failure (user declined in the wallet, or wallet not connected):
  "You declined the transaction in your wallet — nothing was sent."
- The classifier is a pure function in the site's code (input: the
  failure stage and message; output: the category and display text) and
  is unit-tested with one case per category. The demo log records the
  category for the failed expense attempt. The site never shows success
  before the chain confirms it.

### Ensures (restated as contract rules)

- Work points are awarded exactly once (tied to the entry id; see
  Safeguard 1).
- Attestors receive no reward for verification (0 points; the bond is a
  deposit, returned on success, forfeited to the treasury only if a
  dispute overturns the verification).
- Ownership percentages never change because of activity rewards (the
  allocation map is immutable after acquisition in v1; activity points
  and the activity slice never write to it).
- Distribution calculations use yoctoNEAR (u128, checked arithmetic).
- All payout allocations conserve the exact approved amount (the
  exact-sum invariant, including the activity slice and the epoch reset).
- The frontend reads actual contract state rather than hardcoded demo
  values: every figure on the site comes from a contract view
  (get_community, get_treasury, get_distribution,
  get_distribution_breakdown, get_activity, get_policies); there are no
  hardcoded balances, payouts, or transaction hashes in the site code,
  and the site shows loading and empty states while reading.

### Automated tests (required, proving the protections)

In addition to the tests in the earlier sections, the contract must have
unit tests for each safeguard, and the site must have unit tests for the
failure classifier:

- Collusion: duplicate attestation rejected; self-attestation rejected;
  attestation by a non-member rejected; dispute by the recorder or the
  attestor rejected; dispute after the window rejected; dispute upheld
  removes the recorder's points and sends the bond to the treasury;
  dispute rejected returns the bond; bond release after the window
  returns the bond; work points awarded exactly once per entry.
- Circular farming: depositing, receiving a distribution, and
  re-depositing the same capital recovers less than the deposit; work
  points from one entry are capped; the epoch reset means points from a
  past epoch do not affect the next distribution; duplicate references
  rejected.
- Policy amendment: execute before the deadline rejected; execute after
  the deadline applies the new parameters and records the event;
  amendment expiry after 30 days; cancel by DAO; a non-DAO caller cannot
  propose, execute, or cancel an amendment; the old policy stays in
  force while an amendment is pending.
- Failure classifier (site unit tests): one case per category, plus a
  case where the contract panic message maps to the specific policy rule.
- The six original demonstration scenarios stay intact; the demo adds
  two more proofs: a dispute flow (a reported entry is attested, then
  disputed by another member, the DAO overturns it, the points are
  removed and the bond goes to the treasury) and a policy amendment flow
  (propose a change to the spending cap, wait the demo timelock, execute,
  and the recorded event is shown).

### Fixes recorded while implementing the strengthened sections

The appended sections were checked against the storage and treasury
accounting before building. These points did not verify as written; each
fix below is what the contract actually implements, and why.

1. Onchain revenue attaches amount + 0.01 NEAR storage, not exactly
   amount. The section says "attached == amount", but every record pays
   0.01 NEAR of storage into `storage_reserve`, and the verify script
   checks raw balance >= treasury + storage_reserve + bonds held. An
   exact-amount deposit would leave the reserve 0.01 NEAR short on every
   record. The verification is the amount deposit itself; the 0.01 NEAR
   is storage on top, as in the earlier gap fix.
2. Reported revenue attaches 0.01 NEAR storage, not 0, for the same
   reason: a record with no deposit would grow state without paying for
   it and break the reserve check.
3. Evidence references are required (non-empty). The (asset_id,
   reference) identity needs a non-empty reference; an empty reference
   is rejected, so two unreferenced entries cannot collide and a
   duplicate check always has something to compare.
4. Disputes apply only to Verified (attested) entries. Onchain entries
   are verified by the deposit itself and have no attestor or bond to
   forfeit; pending entries have nothing to overturn. A dispute on an
   onchain or pending entry is rejected.
5. A rejected dispute restores the suspended points. Suspension is
   temporary: "verification stands" means the entry is verified again,
   so the points deducted at dispute time are added back to the
   recorder's current-epoch work points.
6. Supersede mechanics: proposing a new amendment for a policy type
   marks any pending amendment of that type Superseded. The section
   says a pending amendment "can be superseded by a newer one" without
   giving the mechanics; this is the rule implemented.
7. Capital points: a sub-1-NEAR cumulative total earns 0 points. This
   supersedes the "Beating the top three" minimum-1 rule (five 0.5 NEAR
   contributions earn 2 points from a 2.5 NEAR cumulative total, and a
   single 0.5 NEAR contribution earns 0). The strengthened section states
   the 0 rule explicitly and it is the later, more deliberate spec.
8. attest, dispute, release, and resolve each attach 0.01 NEAR storage
   (they are state-changing calls). attest additionally attaches the
   0.1 NEAR bond.
9. A forfeited bond enters the treasury as revenue (total_revenue +=
   bond). The bond is real money already held by the contract; counting
   it as revenue keeps the treasury equation exact and makes the
   forfeited bond distributable like any other revenue.
10. Payout and bond callbacks read the promise result in the callback;
    the reconciliation logic is extracted into internal functions that
    the unit tests call directly, because the mock blockchain in unit
    tests carries no promise results.
11. The demo distribution numbers under the final model: the 3 NEAR
    onchain revenue earns alice 4 work points (1 record + 3 per NEAR);
    the 1 NEAR reported entry earns bob 2 work points (1 + 1) only after
    alice attests it. Total work points 6 before the dispute proof.
    The dispute proof then removes bob's points and the upheld bond
    enters revenue, so the final distribution uses D = 2.6 NEAR
    (total_revenue 3.1 minus expenses 0.5), member pool 1.56 NEAR,
    activity pool 0.156 NEAR, ownership pool 1.404 NEAR. Alice
    0.507 NEAR, bob 0.351 NEAR, carol 0.351 NEAR, dave 0.351 NEAR.
    Final treasury 1.04 NEAR exactly (retention 0.65 + maintenance 0.39
    remain as reserves; only the 1.56 NEAR member pool leaves). (The earlier recorded numbers —
    D 2.5, alice 0.4375, bob 0.3875, others 0.3375, treasury 1.0 —
    were the pre-dispute split and are kept in the maths script as the
    mid-flow "verified activity earns points" check.)
12. Known limitation, out of scope for these sections: acquire_asset,
    cancel_campaign, and pay_expense use bare transfers with no
    callback, so a failed seller, refund, or expense transfer is not
    reconciled by the contract (the ledger counts it as spent while the
    money stays in the contract). Only execute_distribution payouts and
    bond returns carry callbacks. See the README Limits section.
13. The safeguards test list says "a non-DAO caller cannot propose,
    execute, or cancel an amendment", but the amendment flow says
    "after the deadline, anyone calls execute_policy_change". The flow
    wins: execution is permissionless by design (the anti-deadlock
    rule — if only the DAO could execute and the DAO deadlocks, the
    amendment could never execute). Propose and cancel are DAO-only;
    execute is anyone, after the deadline.
14. The site called a `refund` method the contract did not have (a
    member refunding their own contribution from an open campaign).
    Added: `refund(campaign_id)` refunds one member's own contribution
    in full from an OPEN campaign only, counts it once in
    total_refunds (contributions stay cumulative, exactly like
    cancel_campaign), and recomputes the member's capital points from
    their remaining cumulative total. Funded or acquired campaigns are
    refunded only by DAO cancellation.
15. The dispute demo proof changes the final demo numbers. The
    safeguards section requires the demo dispute to be upheld (bond to
    treasury, points removed), and fix 9 makes the forfeited bond
    revenue, so D grows from 2.5 to 2.6 NEAR and bob's work points
    drop from 2 to 0 before the distribution. The final numbers are
    recomputed in this section (fix 11) and in check-maths-activity.mjs:
    D 2.6, alice 0.507, bob 0.351, carol 0.351, dave 0.351, retention
    0.65, maintenance 0.39, final treasury 1.04 NEAR (the retained shares
    stay as reserves). The pre-dispute
    split (alice 0.4375, bob 0.3875) is still the mid-flow proof that
    verified activity earns points. The demo order is fixed: dispute
    and DAO resolution happen before execute_distribution.
16. ABI generation needs JsonSchema on the contract's public types.
    `cargo near abi` failed with 16 missing JsonSchema impls. A plain
    `derive(schemars::JsonSchema)` breaks normal builds because
    `U128: JsonSchema` only exists when near-sdk's abi feature is on,
    and `cfg(feature = "near-sdk/abi")` never fires for a non-optional
    dependency. Fix: `#[derive(near_sdk::NearSchema)]` plus
    `#[abi(json)]` on all 20 public types (16 reported plus nested
    WorkPointsView, BondStatus, AmendmentView, AmendmentStatus). The
    macro gates the derive off on wasm32, so the wasm build, the unit
    tests and the ABI generation all pass. ABI: 33 methods, schema
    0.4.0.
