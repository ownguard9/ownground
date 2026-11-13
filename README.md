# OwnGround

**Own Together. Build Together. Grow Together.**

Live site: https://ownground.vercel.app/

OwnGround is a community-owned productive asset platform on NEAR testnet.
A community pools NEAR, acquires a productive asset through DAO governance,
earns revenue from that asset, and distributes the earnings under an
approved policy. One Rust contract, one static site, no backend, no
mainnet parts.

Built by the same person as [Agent's Ladder](https://github.com/ownguard9/ladder) — Isaac leads both projects.

> Status: deployed to NEAR testnet and the live demo passed on the
> v4 contract (2026-11-09): contract `ownground4.testnet`, DAO
> `lagos-energy4.testnet`, all 19 demo steps green, `verify-v4.mjs`
> 108/108 PASS (32 live state checks + 76 receipt checks).
> SUBMITTED 2026-11-09 to the NEAR hackathon (Social Money track,
> requestId eaf765d1-81d6-499d-99ca-ff50729648da, verified in the
> public submissions list). The submitted demo points at the v3
> contract; v4 is the live deployment below. The GitHub identity is
> ownguard9 and the repo is live at github.com/ownguard9/ownground.
> Everything below runs on NEAR testnet only. A deep security audit
> (2026-11-09) found high and medium issues in v3; v4 fixes them
> (see "What v4 changed"). The v3 contract `ownground3.testnet`
> is superseded: it stays deployed as-is but is no longer the live
> deployment. The v2 contract `ownground2.testnet` and v1
> `ownground.testnet` are likewise superseded.

## Live deployment (NEAR testnet)

Deployed 2026-11-09; the demo below ran live against these accounts
once, passing all 19 steps. The run used community
`lagos-energy-cooperative-6` (campaign `-c0`, asset `-a0`). The
v3 contract holds three communities (`lagos-energy-cooperative-4`,
`-5`, `fleet-cooperative`); the site lists only the v4 run now.
Deployment evidence: WASM SHA-256
`d050536ee83abdb274684015661cdfde76892e565cc0f489e4b5a6735aa66364`
(408,774 bytes, `cargo near build non-reproducible-wasm`), deploy
transaction `7Epg29vQgHZXTDc35GfLwNGLoUzgAZaSZFm9mK6xZSJD`, init
transaction `7Xku37GMRNLbuEzF3xHLU1tBH1pnXZRrBjNhjXyLJuGU`.
Reproduce the build from the repo commit with
`cargo near build non-reproducible-wasm` in `contract/` (cargo
1.99.1, cargo-near 0.22.0) and compare the SHA-256.

| What | Account / id |
|---|---|
| Contract | `ownground4.testnet` |
| DAO (Sputnik v2, council = the four members, threshold 3 = strict majority) | `lagos-energy4.testnet` |
| Community | `lagos-energy-cooperative-6` |
| Campaign | `lagos-energy-cooperative-6-c0` |
| Asset (generator) | `lagos-energy-cooperative-6-a0` |
| Members | `alice.ownground4.testnet`, `bob.ownground4.testnet`, `carol.ownground4.testnet`, `dave.ownground4.testnet` |
| Seller | `seller.ownground4.testnet` |
| Operations recipient | `ops.ownground4.testnet` |

## What v4 changed (deep audit remediation, 2026-11-09)

A deep technical and security audit of v3 found seven issues. v4
fixes all of them; the v4 demo and the integration tests prove each
one (see Tests).

1. **Stored XSS through community IDs.** The contract now enforces a
   strict ID allowlist onchain (lowercase letters, digits, hyphens,
   1-64 chars, start/end alphanumeric). The site removed every inline
   event handler and attaches listeners with `addEventListener` using
   dataset attributes; `escapeHtml` now escapes apostrophes too; every
   `innerHTML` interpolation was audited. Regression tests use
   malicious IDs and campaign IDs.
2. **DAO authentication.** `create_community` now verifies the DAO
   onchain: it calls the DAO's `get_policy()` and only creates the
   community in the callback if the account is a genuine Sputnik DAO
   whose council equals the community members and whose threshold is
   the strict majority. An ordinary account (EOA) and a council/member
   mismatch are rejected. Any genuine Sputnik DAO qualifies (factory
   or direct-deployed); no specific factory is required.
3. **DAO threshold.** The threshold is derived from council size:
   strict majority `floor(n/2)+1` (3 of 4, 3 of 5, 2 of 3, 11 of 20).
   A community must have at least 3 members (Isaiah's DAO-size
   principle) and at most 20. The creation preview shows the exact
   threshold.
4. **Reported-revenue rewards.** Work points per reported entry are
   capped at 10, and the attestation bond scales with the claimed
   amount: `0.1 NEAR + amount/10` (a 1 NEAR claim needs a 0.2 NEAR
   bond). A 100 NEAR claim needs a 10.1 NEAR bond and still earns at
   most 10 points. Attested entries are labelled "member-attested
   claim", not implied proof the revenue happened.
5. **Dispute deadlock.** A dispute must resolve by
   `disputed_at + dispute_window_ns`. After that deadline anyone may
   call `resolve_dispute_expired`, which auto-resolves as UPHOLD
   (the disclosed default: entry Rejected, attestor bond forfeited,
   disputer bond returned), so a dispute can never block a
   distribution forever. Disputing attaches a 0.05 NEAR bond
   (returned if the dispute is upheld, forfeited if rejected).
6. **Failed payouts.** A failed member payout becomes a per-recipient
   claimable liability for the exact original amount (including
   activity points). The original recipient claims it with
   `claim_failed_payout`; distribution totals are never recomputed
   under a new epoch.
7. **Storage.** Field sizes are capped (name 64, description 256,
   asset name 64, source 64, reference 128, expense description 256)
   and record counts are capped (50 campaigns/assets per community,
   200 revenue/expenses/distributions per asset, 100 amendments).
   The contract measures actual storage written and requires the
   attached deposit to cover it; `acquire_asset`,
   `execute_distribution` and `propose_policy_change` deposits are
   minimums, not exact amounts. `list_communities` is paginated.

## How it works

1. **Create a community.** A Sputnik DAO governs the community. The
   contract verifies the DAO onchain before creating the community:
   it must be a genuine Sputnik DAO whose council equals the members
   and whose threshold is the strict majority `floor(n/2)+1`. A
   community has at least 3 and at most 20 members. Membership
   is fixed at creation and cannot change later. The founding distribution,
   spending and activity policies are set at creation. Community ids
   are restricted onchain to lowercase letters, digits and hyphens
   (1-64 chars).
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
   and is labelled "member-attested claim" (never implied proof the
   revenue happened) until a different member attests it with a bond
   that scales with the claimed amount (`0.1 NEAR + amount/10`). Only
   attested (Verified) entries earn work points, capped at 10 points
   per entry. Disputing an entry attaches a 0.05 NEAR bond.
5. **Spend within policy.** Every expense is checked against the
   community spending policy (cap, minimum reserve, allowed categories)
   before any transfer, even a DAO-approved one. Acquisitions are not
   capped.
6. **Distribute.** `execute_distribution` pays members from the asset's
   realised revenue. The member pool splits 90% by ownership and 10% by
   verified work points (the activity slice); if no verified work
   stands at distribution time, the whole member pool splits by
   ownership instead. Payouts, retention and maintenance sum to the
   distributed amount exactly, in yoctoNEAR. A distribution is blocked
   while any entry is Disputed and inside its resolution deadline; after
   the deadline anyone may auto-resolve it as UPHOLD
   (`resolve_dispute_expired`), so a dispute never blocks a payout
   forever. If a member payout transfer fails, the exact amount becomes
   a claimable liability for that recipient (`claim_failed_payout`); it
   is never recomputed under a new epoch.
7. **Change policy safely.** Policies change only through a two-step
   amendment: the DAO proposes, the timelock passes, anyone executes.
   The old policy stays in force until execution.

## The demo (Lagos Energy Cooperative)

The full demo is `scripts/demo-v4.mjs` (19 steps; run live on testnet
2026-11-09, all steps passed on the v4 contract — log
`demo-log-v4.txt`). Four members
contribute 2.5 NEAR each to a 10 NEAR
generator target. The DAO acquires the generator from a demo seller.
Alice records 3 NEAR onchain revenue. Bob records 1 NEAR reported revenue,
attested by Alice with a 0.2 NEAR bond (0.1 + 1/10 of the claim). A 2 NEAR
expense is rejected onchain. A 0.5 NEAR
expense succeeds. Carol disputes bob's entry (0.06 NEAR dispute deposit)
and the DAO upholds it, so
the entry is rejected, bob's 2 work points are removed, and the 0.2 NEAR
bond enters the treasury as revenue. The DAO proposes raising the spending
cap from 1 to 2 NEAR, waits the timelock, and executes it. Then dave
records 1 NEAR reported revenue, attested by carol (0.2 NEAR bond), and nobody disputes
it — so dave holds the only work points at distribution. The demo waits
out the dispute window, carol's bond is released in full, and then the
distribution runs.

Final numbers, verified in `check-maths-activity.mjs` and by the live
verifier. Note the change from the v3 demo: the forfeited attestation
bond is now 0.2 NEAR (the v4 proportional bond for a 1 NEAR claim),
so total revenue is 3.2 NEAR and D is 2.7 NEAR. Dave's attested,
undisputed entry survives to distribution, so he takes the whole
0.162 NEAR activity pool on top of his 0.3645 NEAR ownership share —
0.5265 NEAR against 0.3645 for the other three. Alice's 3 NEAR onchain
deposit still earns no work points, and the dispute upheld still removes
bob's 2 attested points. D is 2.7 NEAR (3.0 revenue + 0.2
forfeited bond − 0.5 expense).

| | NEAR |
|---|---|
| D (distributed) | 2.7 |
| Member pool | 1.62 |
| Activity pool | 0.162 (all to dave) |
| Ownership pool | 1.458 |
| Alice | 0.3645 (ownership only) |
| Bob | 0.3645 (ownership only, points removed) |
| Carol | 0.3645 |
| Dave | 0.5265 (0.3645 ownership + 0.162 activity) |
| Retained in the treasury | 0.675 |
| Maintenance | 0.405 |
| Final treasury | 1.08 (retention 0.675 + maintenance 0.405 remain as reserves) |

The demo proves nine things: a valid expense succeeds; an excessive
expense fails onchain with the spending-policy reason; unverified revenue
earns no points; verified activity earns points (bob holds 2 work
points after attestation, before the dispute); the activity slice pays
the worker — dave gets 0.5265 NEAR against 0.3645 for the others, his
attested, undisputed entry earning the whole 0.162 NEAR activity pool;
total payouts equal D exactly;
the dispute flow; the policy amendment flow; and an undisputed
attestation's bond is returned in full after the dispute window
(carol's 0.2 NEAR). The transfer receipts
prove the money moved: the seller's balance rises exactly 10 NEAR
across the deciding acquire vote, the operations recipient exactly
0.5 NEAR, and each member exactly their payout across the distribution
(the signing member's balance also shows that tx's gas and its 0.01
NEAR storage deposit — see `verify.mjs --receipts`).

## Judge steps (do X, see Y)

All of these are checkable against the deployed contract
(`ownground4.testnet`, community `lagos-energy-cooperative-6`); they are
also covered by the unit tests and the maths scripts.

| Do | See |
|---|---|
| Create a community with 60/25/15 and a 10% activity share | `get_community` returns the founding policies; membership is fixed; the DAO was verified onchain (council = members, threshold 3 of 4) |
| Try to create a community with a plain account as DAO | Rejected: the DAO fails onchain verification, no pending record remains |
| Try to create a community with 2 members | Rejected: "at least 3 members" |
| Contribute 2.5 NEAR four times to a 10 NEAR campaign | `get_campaign` shows raised 10 NEAR, status Funded |
| DAO acquire with a seller account | The seller gains exactly 10 NEAR; the asset exists with that seller |
| Record 3 NEAR onchain revenue as alice | Entry status Onchain ("Deposit confirmed"); alice has 0 work points — an onchain deposit earns none |
| Record 1 NEAR reported revenue as bob | Entry status Pending, labelled "member-attested claim", 0 points |
| Attest bob's entry as alice (0.2 NEAR bond = 0.1 + 1/10) | Entry Verified; bob has 2 work points; 0.2 NEAR bond held |
| Try a 2 NEAR expense | Rejected onchain with `expense exceeds max_single_expense`; treasury unchanged |
| Pay a 0.5 NEAR operations expense | Recorded; treasury falls by 0.5 NEAR |
| Dispute bob's entry as carol (0.06 NEAR), DAO upholds | Entry Rejected; bob's points 0; total revenue 3.2 NEAR (bond included) |
| Propose a spending cap change, wait the timelock, execute | Cap changes from 1 to 2 NEAR; the old cap stayed in force until execution |
| Record 1 NEAR reported revenue as dave, attest as carol, dispute nothing | Entry Verified; dave has 2 work points; 0.2 NEAR bond held; after the window the bond is released in full |
| Execute the distribution after the window | Alice 0.3645, bob 0.3645, carol 0.3645, dave 0.5265 NEAR; activity pool 0.162, all to dave; payouts + retention + maintenance = 2.7 exactly |
| Open the community page on the site | A "Member deposits and payouts" chart shows each member's deposits and payouts as bars on one scale, read live from the contract; treasury cards carry a one-line source for every figure |
| Open the live communities list, type 'lagos' in the search box | Only Lagos Energy Cooperative shows; typing a name that matches nothing says so |
| Open Create community from the header | The form is on its own page, not below the list |
| Run `node scripts/verify-v4.mjs --contract ownground4.testnet --community lagos-energy-cooperative-6` | All checks PASS with numbers (32/32 live state checks) |
| Run `node scripts/verify-v4.mjs --contract ownground4.testnet --community lagos-energy-cooperative-6 --receipts demo-receipts-lagos-energy-cooperative-6.json` | All checks PASS with numbers (108/108 live: 32 state + 76 receipt checks, including exact balance deltas proving the seller, the expense recipient and all four members were paid) |
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
does not trust a caller-supplied DAO id: the contract verifies the
account is a genuine Sputnik DAO whose council equals the members and
whose threshold is the strict majority before the community exists. It
does not trust the DAO to be honest about revenue: onchain revenue is
verified by the deposit itself, reported revenue is only a claim until
a different member attests it with a bond that scales with the claimed
amount, work points per entry are capped at 10, and any member can
dispute a verified entry inside the window. It does not trust members
to be honest about work: activity rewards come from verified revenue
only, split by the current epoch's work points, and cycling capital
through the system loses money (a member who deposits 3 NEAR recovers at most
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
| Resolve expired dispute | Anyone, after the deadline | deadline (`disputed_at + dispute_window_ns`) passed; auto-resolves as UPHOLD (entry Rejected, attestor bond forfeited, disputer bond returned), so a dispute can never block a distribution forever |
| Claim failed payout | Original recipient | the exact stored amount from the failed distribution is paid; never recomputed |
| Claim dispute bond | Disputer | after resolution; returns the bond if the dispute was upheld, forfeits it to the treasury if rejected |
| Propose policy change | DAO | policy type and params match; records a pending amendment with deadline now + timelock; a new proposal for the same type supersedes a pending one; old policy stays in force until executed |
| Execute policy change | Anyone, after the timelock | deadline passed, not expired |
| Refund | Contributor | open campaign, once only |
| Bond release | Attestor | window passed |
| Distribution | Anyone | one-shot, payouts sum exactly; blocked while any entry is disputed and still inside its dispute window, so nobody can trigger a payout before a challenge resolves; after the deadline anyone may auto-resolve the dispute as UPHOLD; a failed member payout becomes a claimable liability for the exact original amount |

Trade-offs: the contract is a single custodian of pooled funds, it is unaudited, and it should only ever hold testnet NEAR. Failed-transfer reconciliation: every transfer the contract initiates carries a private callback — acquire, expense, refund (including claim refunds), distribution payouts and bond returns. If a transfer fails, the callback reverts the state change, so the operation can be retried instead of the ledger counting money that never moved: a failed acquisition puts the campaign back to Funded with no asset recorded, a failed expense is not counted, and a failed refund restores the contribution. A failed member payout in a distribution is different: the exact amount becomes a per-recipient claimable liability (`claim_failed_payout`), not a recomputed share, so the entitlement survives under the original epoch. Cancel itself moves no money — it only records one claimable refund per contributor — so there is no cancel callback; the money moves when each contributor claims, and a failed claim leaves the claim open for retry. The unit tests cover a failed transfer for every one of these operations, and the first v2 demo run proved it live: the expense transfer failed because the recipient account did not exist yet, and the expense stayed uncounted.

Trezu: Trezu (https://trezu.org) is a Sputnik-DAO-compatible treasury UI, but it is production mainnet-only: we verified its UI reads a testnet Sputnik DAO in read-only guest mode, while its production backend returns errors for testnet balances and there is no live Trezu testnet payout path, so OwnGround does not use it.

## Tests

- **156 Rust unit tests, all passing** (`cargo test --lib` in
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
  the window passes, or with only Pending entries), plus the v4
  audit fixes: strict community-id validation, DAO verification
  (EOA rejection, council mismatch, wrong threshold), the strict
  majority threshold rule, the minimum-3-member rule, the
  per-entry 10-point cap and proportional attestation bond,
  dispute expiry and auto-resolve, claimable failed payouts, and
  storage field/record limits.
- **v4 security integration tests, 9/9 passing**
  (`contract/tests/v4_security.rs`, run with
  `NEAR_SANDBOX_BIN_PATH=$HOME/.near/near-sandbox-2.14.0/near-sandbox
  cargo test --test v4_security -- --test-threads=1`): a real Sputnik
  DAO deployed from the real Sputnik v2 bytecode in a local sandbox —
  happy path, EOA-as-DAO rejected, council/member mismatch rejected,
  wrong threshold rejected, adversarial revenue (100 NEAR claim needs
  the 10.1 NEAR bond, capped at 10 points), dispute auto-resolve
  unblocking a distribution, a failed payout claimable for the exact
  original amount, community-id fuzzing (19 malicious ids), and a
  2-member community rejected. The sandbox binary needs the
  file-descriptor limit at 65535; this container caps it at 4096, so
  the tests run here only with the `LD_PRELOAD` shim in
  `hidden_files/fd-shim/` (test-only, no contract impact).
- **Maths scripts, all passing**: `node check-maths.mjs` (44 checks) and
  `node check-maths-activity.mjs` (60 checks: capital points, work-points formula,
  demo split, dispute flow, epoch reset, circular farming, zero-points
  fallback, activity_bp 0 and 10000, tiny D, spending policy).
- **Failure classifier, 22 checks passing**: `node site/classify.test.cjs`.
- **Verifier logic, 29 checks passing**: `node scripts/verify.mjs --selftest`
  (live run needs a deployed contract: `--contract <id> --community <id>`).
  With `--receipts <demo-receipts-<community>.json>` it also checks
  every demo tx hash onchain (76 checks for the v4 demo: each tx
  succeeded, the over-cap expense failed with the expected reason, and
  the seller, the expense recipient and all four members were paid —
  proved by exact balance deltas across each tx's block window).
- **Wasm build: SUCCEEDED.** `cargo near build non-reproducible-wasm`
  produces the wasm (408,774 bytes, SHA-256
  `d050536ee83abdb274684015661cdfde76892e565cc0f489e4b5a6735aa66364`);
  ABI generated with
  `cargo near abi`. A plain `cargo build --target
  wasm32-unknown-unknown --release` must NOT be used for the
  deployable wasm: it traps every contract panic as a bare
  `unreachable` with no message (found live 2026-11-09 — the first
  v3 demo stopped at step 8 on it), while the cargo-near build
  carries panic text. Rebuild from source with
  `cargo near build non-reproducible-wasm` in `contract/` and compare
  the SHA-256 above.
- **Site verifiers, all passing** (`hidden_files/`): the existing
  headless verifiers (create-DAO, create fixes, community status,
  community return, community proposals, communities order, logo)
  plus the v4 XSS regression verifier (`verify-xss.mjs`, 39/39 with
  malicious community and campaign ids).
- **Integration test: `contract/tests/demo.rs` is marked `#[ignore]`
  and currently has a latent bug** (it never calls the contract's
  `new()` initializer and uses hand-made campaign/asset ids instead
  of the contract-generated ones). The v4 security tests
  (`v4_security.rs`) supersede it and run green. If `demo.rs` is
  ever revived, fix the initializer call and the ids first.

## Limits

- **Testnet only.** No mainnet parts, no fee logic, no Trezu (see Who
  holds the money above).
- **Demo accounts only.** The demo members, seller and DAO are test
  accounts. No real people have used OwnGround.
- **Deployer key held during the hackathon.** The deployer account is
  held by the builder until handover; there is no owner backdoor in the
  contract, but the deployment itself is not yet decentralised.
- **No independent audit of v4.** A deep security audit of v3
  (2026-11-09) found the seven issues v4 fixes; v4 has unit tests,
  maths checks, a live demo and real-DAO integration tests, but no
  independent audit of the v4 build. Do not put real money in it.
- **DAO verification checks policy, not code hash.** v4 verifies a DAO
  by reading its `get_policy()` and checking council and threshold; it
  does not check the code hash, so a malicious contract that mimics the
  Sputnik `get_policy` interface could pass. The DAO is also fixed at
  community creation and cannot be rotated.
- **Ownership allocation is immutable.** Allocations are fixed at
  acquisition from cumulative contributions; there is no transfer or
  reallocation of ownership shares.

## Files

- `DESIGN.md` — the full design, invariants 1–10, the four holes and
  eight gaps with their fixes, the strengthened economics and the four
  safeguards, and the demo flow.
- `HOLE_REPORT.md` — the original hole and gap report.
- `skill.md` — the agent method reference: the five phases, money
  rules, safety rules, and the worked v4 demo, written for an agent
  to follow.
- `contract/` — one Rust contract (near-sdk), seven internal modules,
  156 unit tests, plus the v4 security integration tests
  (`contract/tests/v4_security.rs`, 9 tests with a real Sputnik DAO
  in a local sandbox) and the real Sputnik v2 bytecode
  (`contract/tests/sputnik-v2.wasm`).
- `site/` — static site: landing, communities list, community dashboard,
  asset page, failure classifier with tests. Testnet only. The v4
  site points at `ownground4.testnet`.
- `scripts/verify-v4.mjs` — keyless verifier (invariants 1–10, bonds,
  policy in force). `--selftest` runs without a network. `--receipts`
  checks every demo tx hash onchain and proves the transfers by exact
  balance deltas.
- `scripts/demo-v4.mjs` — the full 19-step demo run. Run live on the
  v4 contract, green (log `demo-log-v4.txt`, receipts
  `demo-receipts-lagos-energy-cooperative-6.json`).
- `check-maths.mjs`, `check-maths-activity.mjs` — the money maths,
  checked with concrete numbers.
