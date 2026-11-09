# OwnGround

**Own Together. Build Together. Grow Together.**

Live site: https://ownground.vercel.app/

OwnGround is a community-owned productive asset platform on NEAR testnet.
A community pools NEAR, acquires a productive asset through DAO governance,
earns revenue from that asset, and distributes the earnings under an
approved policy. One Rust contract, one static site, no backend, no
mainnet parts.

> Status: deployed to NEAR testnet and the live demo passed on the
> v3 contract (2026-11-09): contract `ownground3.testnet`, DAO
> `lagos-energy3.testnet`, all 19 demo steps green, `verify.mjs` 97/97
> PASS (31 live state checks + 66 receipt checks). Not submitted yet.
> The GitHub identity is ownguard9 and the repo is live at
> github.com/ownguard9/ownground. Everything below runs on NEAR testnet only.
> The v2 contract `ownground2.testnet` is superseded: it stays deployed
> as-is but is no longer the live deployment, because v3 adds the
> distribution-timing guard and there is no migrate method. The v1
> contract `ownground.testnet` is likewise superseded.

## Live deployment (NEAR testnet)

Deployed 2026-11-09; the demo below ran live against these accounts
once, passing all 19 steps. The run used community
`lagos-energy-cooperative-5` (campaign `-c1`, asset `-a1`). An
earlier partial v3 attempt (`lagos-energy-cooperative-4`, acquired
but stopped at step 8 when the deployed wasm trapped every panic as
a bare `unreachable`) also sits on the contract; the site lists only
the receipt-verified run. The v2 contract holds three communities
(`lagos-energy-cooperative`, `-2`, `-3`); the site lists only the
v3 run now.

| What | Account / id |
|---|---|
| Contract | `ownground3.testnet` |
| DAO (Sputnik v2, council = the four members, threshold 2) | `lagos-energy3.testnet` |
| Community | `lagos-energy-cooperative-5` |
| Campaign | `lagos-energy-cooperative-5-c1` |
| Asset (generator) | `lagos-energy-cooperative-5-a1` |
| Members | `alice.ownground3.testnet`, `bob.ownground3.testnet`, `carol.ownground3.testnet`, `dave.ownground3.testnet` |
| Seller | `seller.ownground3.testnet` |
| Operations recipient | `ops.ownground3.testnet` |

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

The full demo is `scripts/demo.mjs` (19 steps; run live on testnet
2026-11-09, all steps passed on the v3 contract — log
`demo-log-v3.txt`). Four members
contribute 2.5 NEAR each to a 10 NEAR
generator target. The DAO acquires the generator from a demo seller.
Alice records 3 NEAR onchain revenue. Bob records 1 NEAR reported revenue,
attested by Alice. A 2 NEAR expense is rejected onchain. A 0.5 NEAR
expense succeeds. Carol disputes bob's entry and the DAO upholds it, so
the entry is rejected, bob's 2 work points are removed, and the 0.1 NEAR
bond enters the treasury as revenue. The DAO proposes raising the spending
cap from 1 to 2 NEAR, waits the timelock, and executes it. Then dave
records 1 NEAR reported revenue, attested by carol, and nobody disputes
it — so dave holds the only work points at distribution. The demo waits
out the dispute window, carol's bond is released in full, and then the
distribution runs.

Final numbers, verified in `check-maths-activity.mjs` and by the live
verifier. Note the change from the v2 demo: dave's attested, undisputed
entry survives to distribution, so he takes the whole 0.156 NEAR
activity pool on top of his 0.351 NEAR ownership share — 0.507 NEAR
against 0.351 for the other three. Alice's 3 NEAR onchain deposit
still earns no work points, and the dispute upheld still removes bob's
2 attested points. D stays 2.6 NEAR (3.0 revenue + 0.1
forfeited bond − 0.5 expense).

| | NEAR |
|---|---|
| D (distributed) | 2.6 |
| Member pool | 1.56 |
| Activity pool | 0.156 (all to dave) |
| Ownership pool | 1.404 |
| Alice | 0.351 (ownership only) |
| Bob | 0.351 (ownership only, points removed) |
| Carol | 0.351 |
| Dave | 0.507 (0.351 ownership + 0.156 activity) |
| Retained in the treasury | 0.65 |
| Maintenance | 0.39 |
| Final treasury | 1.04 (retention 0.65 + maintenance 0.39 remain as reserves) |

The demo proves nine things: a valid expense succeeds; an excessive
expense fails onchain with the spending-policy reason; unverified revenue
earns no points; verified activity earns points (bob holds 2 work
points after attestation, before the dispute); the activity slice pays
the worker — dave gets 0.507 NEAR against 0.351 for the others, his
attested, undisputed entry earning the whole 0.156 NEAR activity pool;
total payouts equal D exactly;
the dispute flow; the policy amendment flow; and an undisputed
attestation's bond is returned in full after the dispute window
(carol's 0.1 NEAR). The transfer receipts
prove the money moved: the seller's balance rises exactly 10 NEAR
across the deciding acquire vote, the operations recipient exactly
0.5 NEAR, and each member exactly their payout across the distribution
(the signing member's balance also shows that tx's gas and its 0.01
NEAR storage deposit — see `verify.mjs --receipts`).

## Judge steps (do X, see Y)

All of these are checkable against the deployed contract
(`ownground3.testnet`, community `lagos-energy-cooperative-5`); they are
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
| Record 1 NEAR reported revenue as dave, attest as carol, dispute nothing | Entry Verified; dave has 2 work points; 0.1 NEAR bond held; after the window the bond is released in full |
| Execute the distribution after the window | Alice 0.351, bob 0.351, carol 0.351, dave 0.507 NEAR; activity pool 0.156, all to dave; payouts + retention + maintenance = 2.6 exactly |
| Open the community page on the site | A "Member deposits and payouts" chart shows each member's deposits and payouts as bars on one scale, read live from the contract; treasury cards carry a one-line source for every figure |
| Open the live communities list, type 'lagos' in the search box | Only Lagos Energy Cooperative shows; typing a name that matches nothing says so |
| Open Create community from the header | The form is on its own page, not below the list |
| Run `node scripts/verify.mjs --contract ownground3.testnet --community lagos-energy-cooperative-5` | All checks PASS with numbers (31/31 live state checks) |
| Run `node scripts/verify.mjs --contract ownground3.testnet --community lagos-energy-cooperative-5 --receipts demo-receipts-lagos-energy-cooperative-5.json` | All checks PASS with numbers (97/97 live: 31 state + 66 receipt checks, including exact balance deltas proving the seller, the expense recipient and all four members were paid) |
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
| Distribution | Anyone | one-shot, payouts sum exactly; blocked while any entry is disputed or still inside its dispute window, so nobody can trigger a payout before a challenge resolves |

Trade-offs: the contract is a single custodian of pooled funds, it is unaudited, and it should only ever hold testnet NEAR. Failed-transfer reconciliation: every transfer the contract initiates carries a private callback — acquire, expense, refund (including claim refunds), distribution payouts and bond returns. If a transfer fails, the callback reverts the state change, so the operation can be retried instead of the ledger counting money that never moved: a failed acquisition puts the campaign back to Funded with no asset recorded, a failed expense is not counted, and a failed refund restores the contribution. Cancel itself moves no money — it only records one claimable refund per contributor — so there is no cancel callback; the money moves when each contributor claims, and a failed claim leaves the claim open for retry. The unit tests cover a failed transfer for every one of these operations, and the first v2 demo run proved it live: the expense transfer failed because the recipient account did not exist yet, and the expense stayed uncounted.

Trezu: Trezu (https://trezu.org) is a Sputnik-DAO-compatible treasury UI, but it is production mainnet-only: we verified its UI reads a testnet Sputnik DAO in read-only guest mode, while its production backend returns errors for testnet balances and there is no live Trezu testnet payout path, so OwnGround does not use it.

## Tests

- **119 Rust unit tests, all passing** (`cargo test --lib` in
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
  window 60s–365d, expense categories capped), epoch-safe
  disputes (suspend/restore touch only the entry's own epoch), and
  the distribution-timing guard (a distribution is blocked while any
  entry is Disputed or still inside its dispute window; allowed once
  the window passes, or with only Pending entries).
- **Maths scripts, all passing**: `node check-maths.mjs` (34 checks) and
  `node check-maths-activity.mjs` (capital points, work-points formula,
  demo split, dispute flow, epoch reset, circular farming, zero-points
  fallback, activity_bp 0 and 10000, tiny D, spending policy).
- **Failure classifier, 22 checks passing**: `node site/classify.test.cjs`.
- **Verifier logic, 29 checks passing**: `node scripts/verify.mjs --selftest`
  (live run needs a deployed contract: `--contract <id> --community <id>`).
  With `--receipts <demo-receipts-<community>.json>` it also checks
  every demo tx hash onchain (66 checks for the v3 demo: each tx
  succeeded, the over-cap expense failed with the expected reason, and
  the seller, the expense recipient and all four members were paid —
  proved by exact balance deltas across each tx's block window).
- **Wasm build: SUCCEEDED.** `cargo near build non-reproducible-wasm`
  produces the wasm (357,565 bytes); ABI generated with
  `cargo near abi` (33 methods). A plain `cargo build --target
  wasm32-unknown-unknown --release` must NOT be used for the
  deployable wasm: it traps every contract panic as a bare
  `unreachable` with no message (found live 2026-11-09 — the first
  v3 demo stopped at step 8 on it), while the cargo-near build
  carries panic text.
- **Integration test: updated to the v3 demo and compiles, but marked
  `#[ignore]` because it cannot run in this VM.**
  `contract/tests/demo.rs` runs the full demo flow on a
  near-workspaces sandbox (new numbers, 60-second timelock and
  dispute window, the allocation argument on `acquire_asset`, dave's
  attested entry and the bond release). Verify it compiles with
  `cargo test --test demo --no-run`. The sandbox node cannot
  start here: it needs the file-descriptor limit raised to
  65535 and this container caps it at 4096, unraisable even as root.
  Run it on a machine where the limit can be raised:
  `NEAR_SANDBOX_BIN_PATH=~/.near/near-sandbox-2.14.0/near-sandbox cargo test --test demo -- --ignored`.

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
  119 unit tests.
- `site/` — static site: landing, communities list, community dashboard,
  asset page, failure classifier with tests. Testnet only.
- `scripts/verify.mjs` — keyless verifier (invariants 1–10, bonds,
  policy in force). `--selftest` runs without a network. `--receipts`
  checks every demo tx hash onchain and proves the transfers by exact
  balance deltas.
- `scripts/demo.mjs` — the full 19-step demo run. Run live on the
  v3 contract, green (log `demo-log-v3.txt`).
- `check-maths.mjs`, `check-maths-activity.mjs` — the money maths,
  checked with concrete numbers.
