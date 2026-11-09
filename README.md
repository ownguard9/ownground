# OwnGround

**Own Together. Build Together. Grow Together.**

OwnGround is a community-owned productive asset platform on NEAR testnet.
A community pools NEAR, acquires a productive asset through DAO governance,
earns revenue from that asset, and distributes the earnings under an
approved policy. One Rust contract, one static site, no backend, no
mainnet parts.

> Status: deployed to NEAR testnet and the live demo passed twice on the
> v2 contract (2026-11-09): contract `ownground2.testnet`, DAO
> `lagos-energy2.testnet`, all 17 demo steps green, `verify.mjs` 89/89
> PASS (29 live state checks + 60 receipt checks). Not submitted yet.
> The GitHub identity is ownguard9 and the repo is live at
> github.com/ownguard9/ownguard. Everything below runs on NEAR testnet only.
> The v1 contract `ownground.testnet` is superseded: it stays deployed
> as-is but is no longer the live deployment, because the remediation
> changed the state layout and there is no migrate method.

## Live deployment (NEAR testnet)

Deployed 2026-11-09; the demo below ran live against these accounts
twice (`scripts/demo.mjs`, logs `demo-log-v2.txt` and
`demo-log-v2-attempt3.txt`; verifier log `verify-live-v2.txt`, 89/89
PASS). The first v2 run used community `lagos-energy-cooperative-2`
(campaign `-c1`, asset `-a1`); the second, fully receipt-verified run
used community `lagos-energy-cooperative-3` (campaign `-c2`, asset
`-a2`). Both passed all 17 steps with identical final numbers.

| What | Account / id |
|---|---|
| Contract | `ownground2.testnet` |
| DAO (Sputnik v2, council = the four members, threshold 2) | `lagos-energy2.testnet` |
| Community | `lagos-energy-cooperative-3` |
| Campaign | `lagos-energy-cooperative-3-c2` |
| Asset (generator) | `lagos-energy-cooperative-3-a2` |
| Members | `alice.ownground2.testnet`, `bob.ownground2.testnet`, `carol.ownground2.testnet`, `dave.ownground2.testnet` |
| Seller | `seller.ownground2.testnet` |
| Operations recipient | `ops.ownground2.testnet` |

The v1 deployment (`ownground.testnet`, DAO `lagos-energy.testnet`,
community `lagos-energy-cooperative`) is superseded and is not
redeployed: the remediation changed the contract state layout and
there is no migrate method, so v2 is a fresh contract. Its demo
passed 17 steps with the old numbers (alice 0.507, others 0.351);
those numbers no longer apply — see the demo section below.

## How it works

1. **Create a community.** A Sputnik DAO governs the community. Membership
   is fixed at creation and cannot change later. The founding distribution,
   spending and activity policies are set at creation.
2. **Fund a campaign.** Members contribute NEAR toward an asset target
   (for example 10 NEAR for a generator). Contributions are locked while
   the campaign is open or funded.
3. **Acquire the asset.** The DAO votes, then `acquire_asset` transfers
   the target to the seller in the same call. The treasury must hold at
   least the target. If the transfer fails, a private callback reverts
   the state change (campaign back to Funded, no asset recorded), so
   the DAO can retry instead of the ledger counting a payment that
   never landed. The same callback pattern guards expenses, refunds
   and campaign cancellation.
4. **Earn revenue.** Revenue is recorded per asset. Onchain revenue
   (the amount is deposited with the call) is verified at once as money
   moved — it is labelled "Deposit confirmed" and earns **no** work
   points: a deposit proves money moved, not that the asset earned it.
   Reported revenue is a claim: it moves no money, earns no points,
   and is labelled "Reported — not independently verified" until a
   different member attests it with a 0.1 NEAR bond. Only attested
   (Verified) entries earn work points.
5. **Spend within policy.** Every expense is checked against the
   community spending policy (cap, minimum reserve, allowed categories)
   before any transfer, even a DAO-approved one. Acquisitions are not
   capped.
6. **Distribute.** `execute_distribution` pays members from the asset's
   realised revenue. The member pool splits 90% by ownership and 10% by
   verified work points (the activity slice); if no verified work
   stands at distribution time, the whole member pool splits by
   ownership instead. Payouts, retention and maintenance sum to the
   distributed amount exactly, in yoctoNEAR.
7. **Change policy safely.** Policies change only through a two-step
   amendment: the DAO proposes, the timelock passes, anyone executes.
   The old policy stays in force until execution.

## The demo (Lagos Energy Cooperative)

The full demo is `scripts/demo.mjs` (17 steps; run live on testnet
2026-11-09, all steps passed twice on the v2 contract — logs
`demo-log-v2.txt` and `demo-log-v2-attempt3.txt`). Four members
contribute 2.5 NEAR each to a 10 NEAR
generator target. The DAO acquires the generator from a demo seller.
Alice records 3 NEAR onchain revenue. Bob records 1 NEAR reported revenue,
attested by Alice. A 2 NEAR expense is rejected onchain. A 0.5 NEAR
expense succeeds. Carol disputes bob's entry and the DAO upholds it, so
the entry is rejected, bob's 2 work points are removed, and the 0.1 NEAR
bond enters the treasury as revenue. The DAO proposes raising the spending
cap from 1 to 2 NEAR, waits the timelock, and executes it. Then the
distribution runs.

Final numbers, verified in `check-maths-activity.mjs` and by the live
verifier. Note the change from the v1 demo: Alice's 3 NEAR onchain
deposit now earns no work points, and the dispute upheld removes bob's
2 attested points, so no verified work stands at distribution — the
activity pool is 0 and the whole 1.56 NEAR member pool splits by
ownership, 0.39 NEAR each. D stays 2.6 NEAR (3.0 revenue + 0.1
forfeited bond − 0.5 expense).

| | NEAR |
|---|---|
| D (distributed) | 2.6 |
| Member pool | 1.56 |
| Activity pool | 0 (no verified work stands) |
| Ownership pool | 1.56 |
| Alice | 0.39 (ownership only) |
| Bob | 0.39 (ownership only, points removed) |
| Carol | 0.39 |
| Dave | 0.39 |
| Retained in the treasury | 0.65 |
| Maintenance | 0.39 |
| Final treasury | 1.04 (retention 0.65 + maintenance 0.39 remain as reserves) |

The demo proves eight things: a valid expense succeeds; an excessive
expense fails onchain with the spending-policy reason; unverified revenue
earns no points; verified activity earns points (bob holds 2 work
points after attestation, before the dispute); with no verified work
standing at distribution, the activity slice falls back to ownership
and all four equal owners get 0.39 NEAR; total payouts equal D exactly;
the dispute flow; the policy amendment flow. The transfer receipts
prove the money moved: the seller's balance rises exactly 10 NEAR
across the deciding acquire vote, the operations recipient exactly
0.5 NEAR, and each member exactly 0.39 NEAR across the distribution
(the signing member's balance also shows that tx's gas and its 0.01
NEAR storage deposit — see `verify.mjs --receipts`).

## Judge steps (do X, see Y)

All of these are checkable against the deployed contract
(`ownground2.testnet`, community `lagos-energy-cooperative-3`); they are
also covered by the unit tests and the maths scripts.

| Do | See |
|---|---|
| Create a community with 60/25/15 and a 10% activity share | `get_community` returns the founding policies; membership is fixed |
| Contribute 2.5 NEAR four times to a 10 NEAR campaign | `get_campaign` shows raised 10 NEAR, status Funded |
| DAO acquire with a seller account | The seller gains exactly 10 NEAR; the asset exists with that seller |
| Record 3 NEAR onchain revenue as alice | Entry status Onchain ("Deposit confirmed"); alice has 0 work points — an onchain deposit earns none |
| Record 1 NEAR reported revenue as bob | Entry status Pending, labelled "Reported — not independently verified", 0 points |
| Attest bob's entry as alice (0.1 NEAR bond) | Entry Verified; bob has 2 work points; 0.1 NEAR bond held |
| Try a 2 NEAR expense | Rejected onchain with `expense exceeds max_single_expense`; treasury unchanged |
| Pay a 0.5 NEAR operations expense | Recorded; treasury falls by 0.5 NEAR |
| Dispute bob's entry as carol, DAO upholds | Entry Rejected; bob's points 0; total revenue 3.1 NEAR (bond included) |
| Propose a spending cap change, wait the timelock, execute | Cap changes from 1 to 2 NEAR; the old cap stayed in force until execution |
| Execute the distribution | Alice 0.39, bob 0.39, carol 0.39, dave 0.39 NEAR; activity pool 0; payouts + retention + maintenance = 2.6 exactly |
| Open the community page on the site | A "Member deposits and payouts" chart shows each member's deposits and payouts as bars on one scale, read live from the contract; treasury cards carry a one-line source for every figure |
| Open the live communities list, type 'lagos' in the search box | Only Lagos Energy Cooperative shows; typing a name that matches nothing says so |
| Open Create community from the header | The form is on its own page, not below the list |
| Run `node scripts/verify.mjs --contract ownground2.testnet --community lagos-energy-cooperative-3` | All checks PASS with numbers (29/29 live state checks) |
| Run `node scripts/verify.mjs --contract ownground2.testnet --community lagos-energy-cooperative-3 --receipts demo-receipts-lagos-energy-cooperative-3.json` | All checks PASS with numbers (89/89 live: 29 state + 60 receipt checks, including exact balance deltas proving the seller, the expense recipient and all four members were paid) |
| Run `node site/classify.test.cjs` | 22 checks PASS; no failure message is ever a bare "transaction failed" |

## Why a chain is needed

The money, the rules and the proof live in the same place. Contributions
are locked by the contract, not by a promise. An expense outside the
spending policy is rejected by the contract itself, even when the DAO
voted for it. A distribution is computed from onchain counters and the
payouts sum to the distributed amount exactly, in yoctoNEAR, so any
member can re-add the numbers. Reported revenue is visibly labelled as
unverified until a different member stakes a bond on it. None of that
holds if the ledger is a spreadsheet on one person's laptop: the
treasurer could edit the numbers, approve their own expense, or pay
themselves twice. The chain is the treasurer that cannot be edited.

## Trust model

OwnGround trusts the NEAR chain and the contract, and trusts nothing
else. It does not trust the site (the site reads contract state and
shows it; every number on the dashboard comes from a view call). It
does not trust the DAO to be honest about revenue: onchain revenue is
verified by the deposit itself, reported revenue is only a claim until
a different member attests it with a bond, and any member can dispute
a verified entry inside the window. It does not trust members to be
honest about work: activity rewards come from verified revenue only,
split by the current epoch's work points, and cycling capital through
the system loses money (a member who deposits 3 NEAR recovers at most
0.45 NEAR of it — their ownership share of the member pool, since an
onchain deposit earns no work points). It does not trust the deployer after deployment:
policies change only through the DAO amendment flow, and the contract
has no owner backdoor. What it cannot verify is the physical world:
whether a generator really exists, or whether a reported invoice is
real. Those claims rest on the recorded entry's status (onchain or
reported) and on the people who attested them, not on the contract.

## Who holds the money, and who can spend it

The contract holds the pooled funds; the DAO authorises spending.
Neither can move money alone. Every spend needs the DAO as the
caller, and the contract enforces its own checks on top of the DAO's
vote — locked campaign funds, the spending policy, and the
distribution maths. A passed DAO proposal cannot spend locked funds,
pay an over-cap expense, or pay a member twice, because the contract
checks again when the DAO calls it. Routing the funds through the
DAO treasury instead would weaken those guarantees: a passed
proposal could spend locked funds, and the contract could not enforce
its guards from outside.

| Action | Who can call it | What the contract checks |
|---|---|---|
| Contribute | any member | campaign Open; attached deposit is the contribution + 0.01 NEAR storage |
| Acquire the asset | DAO only | campaign Funded; treasury holds at least the target; allocation sums to exactly 10000 bp |
| Pay an expense | DAO only | inside the spending policy (cap, reserve, category); spendable funds cover it |
| Refund my contribution | the contributor | campaign Open; each contribution refunded once, never twice |
| Cancel a campaign | DAO only | campaign Open or Funded; every contributor gets a refund claim, each claimable once |
| Record revenue | any member | onchain: attached deposit is the amount + 0.01 NEAR storage; reported: attached deposit is 0.01 NEAR only, no money moves |
| Attest revenue | a different member | 0.1 NEAR bond + 0.01 NEAR storage; entry Pending |
| Dispute revenue | any member | entry Verified; inside the dispute window; not the recorder or the attestor |
| Resolve a dispute | DAO only | entry Disputed; uphold marks it Rejected and forfeits the bond to the treasury; reject marks it Verified, returns the bond, and restores work points only if the entry's epoch is still current |
| Propose a policy change | DAO only | type and params match; deadline is now + timelock; supersedes a pending proposal of the same type |
| Execute a policy change | anyone | after the deadline, within 30 days after it |
| Execute a distribution | anyone | the caller chooses nothing — amounts are computed from onchain counters; one distribution per epoch, so it cannot run twice |

If a transfer fails, the contract reverts the state change instead of
counting money that never moved: a failed acquisition puts the
campaign back to Funded with no asset recorded, a failed expense is
not counted, and a failed refund restores the contribution, so the
operation can be retried. This is covered by the unit tests, and it
was proven live in the first v2 demo run, where the expense transfer
failed because the recipient account did not exist yet and the
expense stayed uncounted.

Trezu is a mainnet-only treasury product with no live testnet payout
path — its UI can read a testnet Sputnik DAO read-only in guest mode,
but its production backend errors on testnet balances — so no testnet
submission can pay through Trezu live. OwnGround therefore holds
funds in its own contract on testnet, under the split-custody rule
above.

## Spending policy guard messages

Every `pay_expense` rejection names the rule violated:

- `expense exceeds max_single_expense`
- `expense would breach min_treasury_reserve`
- `expense category not allowed`
- `expense exceeds spendable funds`

## Policy amendment process

1. The DAO proposes a change (`propose_policy_change`, DAO only).
   A new proposal for a policy type supersedes a pending one of that type.
2. The timelock runs (default 3 days; minutes in the demo). The old
   policy stays in force.
3. Anyone executes it after the deadline (`execute_policy_change`).
   Amendments expire 30 days after the deadline. The DAO can cancel a
   pending amendment. If governance deadlocks, the old policy stays in
   force and the community keeps working.

## Cycling loses money

Work points come from verified revenue only, and a distribution pays a
member their ownership share plus their activity share of the member
pool. A member who deposits 3 NEAR as onchain revenue recovers 0.45
NEAR — only their 25% ownership share of the member pool, because an
onchain deposit earns no work points (the other three members get
0.45 NEAR each too). Splitting contributions earns nothing extra
(capital points come from the cumulative total), duplicate revenue
references are rejected, and each distribution resets the current
epoch's work points to zero. There is no loop that pays back more than
was put in.

## Tests

- **115 Rust unit tests, all passing** (`cargo test --lib` in
  `contract/`; plain `cargo test` does not run in this VM — the
  near-workspaces build script downloader ignores the proxy, so run
  with `NEAR_SANDBOX_BIN_PATH=$HOME/.near/near-sandbox-2.14.0/near-sandbox
  cargo test --lib`):
  funding cap, acquire gating (seller transfer, treasury >= target),
  treasury conservation (including refunds), distribution rounding and
  the exact-sum invariant, one-shot distribution, double refund
  prevention, DAO-only enforcement, revenue status labelling, the
  locked-funds guard, spending policy (over-cap, reserve floor, category,
  DAO-bound, zero cap, acquisitions uncapped), capital points (splitting,
  sub-1-NEAR = 0, custom weights), work points (formula, non-member earns
  none, reported earns nothing until attested, self/double/non-member
  attestation rejected, bond required, duplicate/empty reference
  rejected), disputes (recorder/attestor/non-member/pending/onchain/
  after-window rejected; uphold removes points + bond to treasury;
  reject restores points + returns bond; resolve requires DAO), bond
  release (window, attestor-only, failed transfer reverts to Held),
  policy amendments (propose/cancel DAO-only, execute before deadline
  rejected, execute after deadline applies, expiry after 30 days,
  supersede, old policy stays in force, anyone can execute), circular
  farming (recovers less than deposit; epoch reset), failed-payout
  reconciliation (unpaid listed, totals unchanged, amount distributable
  again), payout callback no-op with no promise results, refunds (open
  campaign, funded rejected, non-contributor rejected, double refund
  rejected), **transfer callbacks (remediation P0: a failed acquire,
  expense, cancel or refund transfer reverts the state change so the
  operation is retryable; claim-based refunds for cancelled
  campaigns)**, **policy validation (remediation P0: every policy is
  validated at creation and on amendment — shares must sum to 10000,
  activity_bp ≤ 10000, no empty/duplicate/>64-char/>20 expense
  categories, activity weights ≤ 1,000,000, timelock and dispute
  window between 60s and 365 days)**, **epoch-safe disputes
  (remediation P1: suspend/restore touch points only in the entry's
  own epoch; dispute → distribution → new activity → resolution,
  both upheld and rejected)**.
- **Maths scripts, all passing**: `node check-maths.mjs` (34 checks) and
  `node check-maths-activity.mjs` (capital points, work-points formula,
  demo split, dispute flow, epoch reset, circular farming, zero-points
  fallback, activity_bp 0 and 10000, tiny D, spending policy).
- **Failure classifier, 22 checks passing**: `node site/classify.test.cjs`.
- **Verifier logic, 25 checks passing**: `node scripts/verify.mjs --selftest`
  (live run needs a deployed contract: `--contract <id> --community <id>`).
  With `--receipts <demo-receipts-<community>.json>` it also checks
  every demo tx hash onchain (60 checks for the v2 demo: each tx
  succeeded, the over-cap expense failed with the expected reason, and
  the seller, the expense recipient and all four members were paid —
  proved by exact balance deltas across each tx's block window).
- **Wasm build: SUCCEEDED.** `cargo build --target wasm32-unknown-unknown
  --release` produces `target/wasm32-unknown-unknown/release/ownground.wasm`
  (725,095 bytes). `cargo near build` needs a TTY and fails without one.
  ABI generated with `cargo near abi` (`target/near/ownground_abi.json`,
  33 methods). Public types carry `NearSchema` + `#[abi(json)]` so the
  ABI generates; the derive is inert on wasm32.
- **Integration test: written and compiles, but stale and cannot run in
  this VM.** `contract/tests/demo.rs` runs the full demo flow on a
  near-workspaces sandbox (DAO played by a plain account). It still
  asserts the v1 numbers (alice 0.507, activity pool 0.156), uses a
  1-nanosecond timelock the new policy validation rejects, and calls
  `acquire_asset` without the allocation argument the remediation
  added — it needs updating to the v2 demo before it can pass
  anywhere. The sandbox binary was downloaded from S3 (the Rust
  downloader ignores the proxy; curl works) and lives at
  `~/.near/near-sandbox-2.14.0/near-sandbox` — set
  `NEAR_SANDBOX_BIN_PATH` to it when running the test. But the node
  itself cannot start here: it requires raising the file-descriptor
  limit to 65535 and this container caps it at 4096, unraisable even as
  root (`ulimit` and `prlimit` both fail with Operation not permitted).
  Run the test on a machine where the limit can be raised:
  `NEAR_SANDBOX_BIN_PATH=~/.near/near-sandbox-2.14.0/near-sandbox cargo test --test demo`.

## Limits

- **Testnet only.** No mainnet parts, no fee logic, no Trezu. Trezu is
  production mainnet-only and has no live testnet payout path, so it is
  not used here.
- **Demo accounts only.** The demo members, seller and DAO are test
  accounts. No real people have used OwnGround.
- **Deployer key held during the hackathon.** The deployer account is
  held by the builder until handover; there is no owner backdoor in the
  contract, but the deployment itself is not yet decentralised.
- **No audit.** The contract has unit tests and maths checks, not an
  independent audit. Do not put real money in it.
- **Physical revenue claims rest on the recorded entry's status.**
  Onchain revenue is verified by the deposit. Reported revenue is a
  claim until attested, and attestation is a member staking a bond, not
  proof that a generator exists or an invoice is genuine.
- **The contract cannot verify a DAO exists without a cross-contract
  call.** `create_community` takes a DAO account id on trust; a
  mistyped or non-DAO account would only fail later, when a DAO-only
  call is attempted.
- **Ownership allocation is immutable.** Allocations are fixed at
  acquisition from cumulative contributions; there is no transfer or
  reallocation of ownership shares.
- **The sandbox integration test is stale.** `contract/tests/demo.rs`
  still asserts the v1 demo numbers and calls `acquire_asset` without
  the allocation argument; it needs updating to the v2 demo (see
  Tests above). It also cannot run in this VM (file-descriptor limit
  4096, sandbox needs 65535).
- **The site reads contract state; it holds no funds and signs nothing
  itself.** The wallet signs every transaction, and the site never shows
  success before the chain confirms it.

## Files

- `DESIGN.md` — the full design, invariants 1–10, the four holes and
  eight gaps with their fixes, the strengthened economics and the four
  safeguards, and the demo flow.
- `HOLE_REPORT.md` — the original hole and gap report.
- `contract/` — one Rust contract (near-sdk), seven internal modules,
  115 unit tests.
- `site/` — static site: landing, communities list, community dashboard,
  asset page, failure classifier with tests. Testnet only.
- `scripts/verify.mjs` — keyless verifier (invariants 1–10, bonds,
  policy in force). `--selftest` runs without a network. `--receipts`
  checks every demo tx hash onchain and proves the transfers by exact
  balance deltas.
- `scripts/demo.mjs` — the full 17-step demo run. Run live twice on the
  v2 contract, both green (logs `demo-log-v2.txt`,
  `demo-log-v2-attempt3.txt`).
- `check-maths.mjs`, `check-maths-activity.mjs` — the money maths,
  checked with concrete numbers.
