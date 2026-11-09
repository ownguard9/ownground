# OwnGround

**Own Together. Build Together. Grow Together.**

OwnGround is a community-owned productive asset platform on NEAR testnet.
A community pools NEAR, acquires a productive asset through DAO governance,
earns revenue from that asset, and distributes the earnings under an
approved policy. One Rust contract, one static site, no backend, no
mainnet parts.

> Status: deployed to NEAR testnet and the live demo passed (2026-11-09):
> contract `ownground.testnet`, DAO `lagos-energy.testnet`, all 17 demo
> steps green, `verify.mjs` 30/30 PASS. Not submitted yet. The GitHub
> identity is ownguard9 and the repo is live at
> github.com/ownguard9/ownguard. Everything below runs on NEAR testnet only.

## Live deployment (NEAR testnet)

Deployed 2026-11-09; the demo below ran live against these accounts
(`scripts/demo.mjs`, log `demo-log-live.txt`; verifier log
`verify-live.txt`, 30/30 PASS).

| What | Account / id |
|---|---|
| Contract | `ownground.testnet` |
| DAO (Sputnik v2, council = the four members, threshold 2) | `lagos-energy.testnet` |
| Community | `lagos-energy-cooperative` |
| Campaign | `lagos-energy-cooperative-c0` |
| Asset (generator) | `lagos-energy-cooperative-a0` |
| Members | `alice.ownground.testnet`, `bob.ownground.testnet`, `carol.ownground.testnet`, `dave.ownground.testnet` |
| Seller | `seller.ownground.testnet` |
| Operations recipient | `ops.ownground.testnet` |

## How it works

1. **Create a community.** A Sputnik DAO governs the community. Membership
   is fixed at creation and cannot change later. The founding distribution,
   spending and activity policies are set at creation.
2. **Fund a campaign.** Members contribute NEAR toward an asset target
   (for example 10 NEAR for a generator). Contributions are locked while
   the campaign is open or funded.
3. **Acquire the asset.** The DAO votes, then `acquire_asset` transfers
   the target to the seller in the same call. The treasury must hold at
   least the target.
4. **Earn revenue.** Revenue is recorded per asset. Onchain revenue
   (the amount is deposited with the call) is verified at once. Reported
   revenue is a claim: it moves no money, earns no points, and is labelled
   "Reported — not independently verified" until a different member attests
   it with a 0.1 NEAR bond.
5. **Spend within policy.** Every expense is checked against the
   community spending policy (cap, minimum reserve, allowed categories)
   before any transfer, even a DAO-approved one. Acquisitions are not
   capped.
6. **Distribute.** `execute_distribution` pays members from the asset's
   realised revenue. The member pool splits 90% by ownership and 10% by
   verified work points (the activity slice). Payouts, retention and
   maintenance sum to the distributed amount exactly, in yoctoNEAR.
7. **Change policy safely.** Policies change only through a two-step
   amendment: the DAO proposes, the timelock passes, anyone executes.
   The old policy stays in force until execution.

## The demo (Lagos Energy Cooperative)

The full demo is `scripts/demo.mjs` (17 steps; run live on testnet
2026-11-09, all steps passed — log `demo-log-live.txt`). Four members
contribute 2.5 NEAR each to a 10 NEAR
generator target. The DAO acquires the generator from a demo seller.
Alice records 3 NEAR onchain revenue. Bob records 1 NEAR reported revenue,
attested by Alice. A 2 NEAR expense is rejected onchain. A 0.5 NEAR
expense succeeds. Carol disputes bob's entry and the DAO upholds it, so
the entry is rejected, bob's 2 work points are removed, and the 0.1 NEAR
bond enters the treasury as revenue. The DAO proposes raising the spending
cap from 1 to 2 NEAR, waits the timelock, and executes it. Then the
distribution runs.

Final numbers, verified in `check-maths-activity.mjs`:

| | NEAR |
|---|---|
| D (distributed) | 2.6 |
| Alice | 0.507 (ownership 0.351 + activity 0.156) |
| Bob | 0.351 |
| Carol | 0.351 |
| Dave | 0.351 |
| Retained in the treasury | 0.65 |
| Maintenance | 0.39 |
| Final treasury | 1.04 (retention 0.65 + maintenance 0.39 remain as reserves) |

The demo proves eight things: a valid expense succeeds; an excessive
expense fails onchain with the spending-policy reason; unverified revenue
earns no points; verified activity earns points; two equal-ownership
members get different totals; total payouts equal D exactly; the dispute
flow; the policy amendment flow.

## Judge steps (do X, see Y)

All of these are checkable against the deployed contract
(`ownground.testnet`, community `lagos-energy-cooperative`); they are
also covered by the unit tests and the maths scripts.

| Do | See |
|---|---|
| Create a community with 60/25/15 and a 10% activity share | `get_community` returns the founding policies; membership is fixed |
| Contribute 2.5 NEAR four times to a 10 NEAR campaign | `get_campaign` shows raised 10 NEAR, status Funded |
| DAO acquire with a seller account | The seller gains exactly 10 NEAR; the asset exists with that seller |
| Record 3 NEAR onchain revenue as alice | Entry status Onchain; alice has 4 work points |
| Record 1 NEAR reported revenue as bob | Entry status Pending, labelled "Reported — not independently verified", 0 points |
| Attest bob's entry as alice (0.1 NEAR bond) | Entry Verified; bob has 2 work points; 0.1 NEAR bond held |
| Try a 2 NEAR expense | Rejected onchain with `expense exceeds max_single_expense`; treasury unchanged |
| Pay a 0.5 NEAR operations expense | Recorded; treasury falls by 0.5 NEAR |
| Dispute bob's entry as carol, DAO upholds | Entry Rejected; bob's points 0; total revenue 3.1 NEAR (bond included) |
| Propose a spending cap change, wait the timelock, execute | Cap changes from 1 to 2 NEAR; the old cap stayed in force until execution |
| Execute the distribution | Alice 0.507, bob 0.351, carol 0.351, dave 0.351 NEAR; payouts + retention + maintenance = 2.6 exactly |
| Run `node scripts/verify.mjs --contract ownground.testnet --community lagos-energy-cooperative` | All checks PASS with numbers (30/30 live) |
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
0.585 NEAR of it). It does not trust the deployer after deployment:
policies change only through the DAO amendment flow, and the contract
has no owner backdoor. What it cannot verify is the physical world:
whether a generator really exists, or whether a reported invoice is
real. Those claims rest on the recorded entry's status (onchain or
reported) and on the people who attested them, not on the contract.

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
pool. A member who deposits 3 NEAR as revenue and holds every work
point recovers 0.585 NEAR. Splitting contributions earns nothing extra
(capital points come from the cumulative total), duplicate revenue
references are rejected, and each distribution resets the current
epoch's work points to zero. There is no loop that pays back more than
was put in.

## Tests

- **85 Rust unit tests, all passing** (`cargo test` in `contract/`):
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
  rejected).
- **Maths scripts, all passing**: `node check-maths.mjs` (34 checks) and
  `node check-maths-activity.mjs` (capital points, work-points formula,
  demo split, dispute flow, epoch reset, circular farming, zero-points
  fallback, activity_bp 0 and 10000, tiny D, spending policy).
- **Failure classifier, 22 checks passing**: `node site/classify.test.cjs`.
- **Verifier logic, 26 checks passing**: `node scripts/verify.mjs --selftest`
  (live run needs a deployed contract: `--contract <id> --community <id>`).
- **Wasm build: SUCCEEDED.** `cargo build --target wasm32-unknown-unknown
  --release` produces `target/wasm32-unknown-unknown/release/ownground.wasm`
  (694,791 bytes). `cargo near build` needs a TTY and fails without one.
  ABI generated with `cargo near abi` (`target/near/ownground_abi.json`,
  33 methods). Public types carry `NearSchema` + `#[abi(json)]` so the
  ABI generates; the derive is inert on wasm32.
- **Integration test: written and compiles, cannot run in this VM.**
  `contract/tests/demo.rs` runs the full demo flow on a near-workspaces
  sandbox (DAO played by a plain account). The sandbox binary was
  downloaded from S3 (the Rust downloader ignores the proxy; curl works)
  and lives at `~/.near/near-sandbox-2.14.0/near-sandbox` — set
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
- **Acquire, cancel and expense transfers have no callback.** Only
  distribution payouts and bond returns are reconciled on failure. If a
  seller, refund or expense transfer fails, the ledger counts it as
  spent while the money stays in the contract. This is a known
  limitation, recorded in DESIGN.md fix 12.
- **Ownership allocation is immutable in v1.** Allocations are fixed at
  acquisition from cumulative contributions; there is no transfer or
  reallocation of ownership shares.
- **The site reads contract state; it holds no funds and signs nothing
  itself.** The wallet signs every transaction, and the site never shows
  success before the chain confirms it.

## Files

- `DESIGN.md` — the full design, invariants 1–10, the four holes and
  eight gaps with their fixes, the strengthened economics and the four
  safeguards, and the demo flow.
- `HOLE_REPORT.md` — the original hole and gap report.
- `contract/` — one Rust contract (near-sdk), seven internal modules,
  85 unit tests.
- `site/` — static site: landing, communities list, community dashboard,
  asset page, failure classifier with tests. Testnet only.
- `scripts/verify.mjs` — keyless verifier (invariants 1–10, bonds,
  policy in force). `--selftest` runs without a network.
- `scripts/demo.mjs` — the full 17-step demo run. Written, not run live.
- `check-maths.mjs`, `check-maths-activity.mjs` — the money maths,
  checked with concrete numbers.
