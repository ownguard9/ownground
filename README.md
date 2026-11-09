# OwnGround

**Own Together. Build Together. Grow Together.**

Live site: https://ownground.vercel.app/

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
> github.com/ownguard9/ownground. Everything below runs on NEAR testnet only.
> The v1 contract `ownground.testnet` is superseded: it stays deployed
> as-is but is no longer the live deployment, because the remediation
> changed the state layout and there is no migrate method.

## Live deployment (NEAR testnet)

Deployed 2026-11-09; the demo below ran live against these accounts
twice, both runs passing all 17 steps with identical final numbers.
The first v2 run used community `lagos-energy-cooperative-2`
(campaign `-c1`, asset `-a1`); the second, fully receipt-verified run
used community `lagos-energy-cooperative-3` (campaign `-c2`, asset
`-a2`). An earlier partial attempt (`lagos-energy-cooperative`,
acquired but never distributed) also sits on the contract; the site
lists only the receipt-verified run.

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

OwnGround splits custody on purpose: the contract holds the funds, and the community's Sputnik DAO authorises every discretionary spend.

Why the contract holds them: the locked-funds guard, the spending policy and the exact-sum distribution can only be enforced by the contract that knows its own balance. If a DAO treasury held the pool, a passed proposal could spend campaign money that members had locked, and nothing could stop it.

| Action | Who can call it | What the contract still checks |
|---|---|---|
| Acquire asset | DAO | campaign funded, treasury >= target |
| Pay expense | DAO | cap, reserve floor, allowed category |
| Cancel campaign | DAO | campaign is Open or Funded; refunds every contributor exactly once |
| Resolve dispute | DAO | entry is Disputed; uphold: entry Rejected, attestation bond forfeited to treasury, recorder's points stay removed; reject: entry Verified, bond returned to attestor, points restored only if the entry's epoch is still current |
| Propose policy change | DAO | policy type and params match; records a pending amendment with deadline now + timelock; a new proposal for the same type supersedes a pending one; old policy stays in force until executed |
| Execute policy change | Anyone, after the timelock | deadline passed, not expired |
| Refund | Contributor | open campaign, once only |
| Bond release | Attestor | window passed |
| Distribution | Anyone | one-shot, payouts sum exactly |

Trade-offs: the contract is a single custodian of pooled funds, it is unaudited, and it should only ever hold testnet NEAR. Failed-transfer reconciliation: every transfer the contract initiates carries a private callback — acquire, expense, refund (including claim refunds), distribution payouts and bond returns. If a transfer fails, the callback reverts the state change, so the operation can be retried instead of the ledger counting money that never moved: a failed acquisition puts the campaign back to Funded with no asset recorded, a failed expense is not counted, and a failed refund restores the contribution. Cancel itself moves no money — it only records one claimable refund per contributor — so there is no cancel callback; the money moves when each contributor claims, and a failed claim leaves the claim open for retry. The unit tests cover a failed transfer for every one of these operations, and the first v2 demo run proved it live: the expense transfer failed because the recipient account did not exist yet, and the expense stayed uncounted.

Trezu: Trezu (https://trezu.org) is a Sputnik-DAO-compatible treasury UI, but it is production mainnet-only: we verified its UI reads a testnet Sputnik DAO in read-only guest mode, while its production backend returns errors for testnet balances and there is no live Trezu testnet payout path, so OwnGround does not use it.

## Tests

- **115 Rust unit tests, all passing** (`cargo test --lib` in
  `contract/`; plain `cargo test` does not run in this VM — the
  near-workspaces build script downloader ignores the proxy, so run
  with `NEAR_SANDBOX_BIN_PATH=$HOME/.near/near-sandbox-2.14.0/near-sandbox
  cargo test --lib`):
  funding, acquisition, treasury conservation, distribution maths and
  the exact-sum invariant, DAO-only enforcement, revenue and
  attestation, disputes and bonds, policy amendments, circular
  farming, and the remediation fixes: transfer callbacks (a failed
  acquire, expense or refund reverts so it can be retried;
  cancelled-campaign refunds are claim-based, and a failed claim
  leaves the claim open), policy validation
  (shares sum to 10000, activity_bp ≤ 10000, timelock and dispute
  window 60s–365d, expense categories capped), and epoch-safe
  disputes (suspend/restore touch only the entry's own epoch).
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
  --release` produces the wasm (725,095 bytes); ABI generated with
  `cargo near abi` (33 methods). `cargo near build` needs a TTY and
  fails without one.
- **Integration test: written and compiles, but stale and cannot run in
  this VM.** `contract/tests/demo.rs` runs the full demo flow on a
  near-workspaces sandbox, but it still asserts the v1 numbers, uses a
  1-nanosecond timelock the new policy validation rejects, and calls
  `acquire_asset` without the allocation argument — it needs updating
  to the v2 demo before it can pass anywhere. The sandbox node cannot
  start here either: it needs the file-descriptor limit raised to
  65535 and this container caps it at 4096, unraisable even as root.
  Run it on a machine where the limit can be raised:
  `NEAR_SANDBOX_BIN_PATH=~/.near/near-sandbox-2.14.0/near-sandbox cargo test --test demo`.

## Limits

- **Testnet only.** No mainnet parts, no fee logic, no Trezu (see Who
  holds the money above).
- **Demo accounts only.** The demo members, seller and DAO are test
  accounts. No real people have used OwnGround.
- **Deployer key held during the hackathon.** The deployer account is
  held by the builder until handover; there is no owner backdoor in the
  contract, but the deployment itself is not yet decentralised.
- **No audit.** The contract has unit tests and maths checks, not an
  independent audit. Do not put real money in it.
- **The contract cannot verify a DAO exists without a cross-contract
  call.** `create_community` takes a DAO account id on trust; a
  mistyped or non-DAO account would only fail later, when a DAO-only
  call is attempted.
- **Ownership allocation is immutable.** Allocations are fixed at
  acquisition from cumulative contributions; there is no transfer or
  reallocation of ownership shares.

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
