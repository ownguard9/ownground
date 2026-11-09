# OwnGround agent skill

Use OwnGround the way an agent would: create a community, pool NEAR, buy a
productive asset through DAO governance, earn revenue from it, and share the
earnings under a policy the DAO approved. Everything below is NEAR **testnet
only**. There is no mainnet version.

## Live deployment

- Site: https://ownground.vercel.app/
- Contract: `ownground4.testnet`
- Demo DAO: `lagos-energy4.testnet`
- Repo: https://github.com/ownguard9/ownground
- Full detail: README.md and DESIGN.md in the repo. The runnable demo is
  `scripts/demo-v4.mjs`; the live-state checker is `scripts/verify-v4.mjs`.
  WASM SHA-256 `d050536ee83abdb274684015661cdfde76892e565cc0f489e4b5a6735aa66364`,
  deploy tx `7Epg29vQgHZXTDc35GfLwNGLoUzgAZaSZFm9mK6xZSJD`. The v3
  contract `ownground3.testnet` is superseded but stays deployed.

## The five phases

1. **Pool.** A community of 3-20 members funds a campaign to a target.
   The DAO is verified onchain at creation: it must be a genuine
   Sputnik DAO whose council equals the members and whose threshold is
   the strict majority `floor(n/2)+1`.
2. **Buy.** The DAO (Sputnik v2) approves the acquisition; the contract pays
   the seller and records the ownership allocation.
3. **Earn.** Members record revenue. Onchain revenue moves real NEAR in.
   Reported revenue is a claim: it earns work points only once another
   member attests it with a bond that scales with the claimed amount
   (`0.1 NEAR + amount/10`), and at most 10 work points per entry. The
   label is "member-attested claim", never implied proof the revenue
   happened.
4. **Spend.** The DAO pays expenses from the treasury, inside the spending
   policy (per-expense cap, treasury reserve floor, allowed categories).
5. **Share.** Anyone can trigger the distribution. It pays the members by
   ownership plus work points, keeps the treasury and maintenance shares,
   then resets the epoch's work points to zero. A dispute that passes
   its resolution deadline can be auto-resolved by anyone as UPHOLD,
   so it never blocks a distribution forever; a failed member payout
   becomes a claimable liability for the exact original amount.

## Who holds the money

The DAO decides, the contract enforces. Neither moves money alone. Every
discretionary spend needs the DAO as the caller: `acquire_asset`,
`pay_expense`, `propose_policy_change` and `resolve_dispute` all reject a
non-DAO caller. The contract holds the funds and enforces the locked
campaign funds, the spending policy, and the distribution maths. A
distribution already paid is never re-run. A guard blocks a distribution
while an entry is disputed and still inside its dispute window; after
the window passes, anyone may auto-resolve it as UPHOLD
(`resolve_dispute_expired`, no deposit), so a dispute can never block a
distribution forever. The guard is live in the v4 contract
(`ownground4.testnet`).

## Method reference

Amounts are yoctoNEAR strings. `N` below is 1 NEAR = 10^24 yoctoNEAR.

### Change methods

| Method | Who | Attach | Notes |
|---|---|---|---|
| `create_community(id, name, description, dao_id, members, distribution_policy, spending_policy, activity_policy, dispute_window_ns?, timelock_ns?)` | anyone | 0.1 NEAR | Members are fixed at creation; **at least 3 and at most 20 members**. Community ids are restricted onchain to lowercase letters, digits and hyphens (1-64 chars, start/end alphanumeric). The DAO is **verified onchain**: the contract calls the DAO's `get_policy()` and only creates the community in the callback if it is a genuine Sputnik DAO whose council equals the members and whose threshold is the strict majority `floor(n/2)+1`. An ordinary account or a council/threshold mismatch is rejected and the pending record is cleared; poll `get_community` / `is_community_pending(id)`. Policies are validated here: shares sum to 10000, `activity_bp` at most 10000, timelock and dispute window 60 s to 365 d, expense categories capped, no empty, duplicate, over-64-char or over-20 categories, activity weights at most 1,000,000. Defaults: dispute window 7 days, timelock 3 days. |
| `create_campaign(community_id, asset_name, category, target, deadline)` | member | 0.05 NEAR | Returns the campaign id. |
| `contribute(campaign_id)` | member | the contribution | The attached amount IS the contribution. |
| `acquire_asset(campaign_id, seller, allocation)` | DAO only | 0.01 NEAR minimum | Campaign must be Funded with `raised == target` and the treasury must hold the target. `allocation` is `[[account, basis_points], ...]` and must sum to 10000 across the members. If the seller transfer fails, the callback reverts the acquisition so the DAO can retry. The deposit is a minimum: the contract measures actual storage written and requires the attached amount to cover it. |
| `cancel_campaign(campaign_id)` | DAO only | 0.01 NEAR | Open or Funded only. Moves no money: each contributor then claims their refund once via `claim_refund`. |
| `claim_refund(campaign_id)` | contributor | 0.01 NEAR | Cancelled campaigns only, once per contributor. If the refund transfer fails, the claim stays open. |
| `record_revenue(asset_id, amount, source, reference)` | member | see note | `reference` is required and must be unique per asset. Attach `amount + 0.01 NEAR` for onchain revenue (the money moves in); attach `0.01 NEAR` only for reported revenue (a claim, no money moves). Field limits: source at most 64 chars, reference at most 128 chars. |
| `attest_revenue(asset_id, entry_id)` | member, not the recorder | bond + 0.01 NEAR | The bond scales with the claimed amount: `0.1 NEAR + amount/10` (a 1 NEAR claim needs a 0.2 NEAR bond; a 100 NEAR claim needs 10.1 NEAR). Pending entries only. The entry becomes Verified, the recorder earns work points exactly once, **capped at 10 points per entry**, and the bond is held until the dispute window passes or the dispute is resolved. The attestor earns no points: verification is a duty, not a reward. |
| `dispute_revenue(asset_id, entry_id)` | member, not recorder or attestor | 0.05 NEAR bond + 0.01 NEAR | Verified entries only, inside the dispute window (from attestation). The entry becomes Disputed and its points are suspended from the recorder's current-epoch points. The dispute bond is returned if the dispute is upheld, forfeited to the treasury if rejected. |
| `resolve_dispute(asset_id, entry_id, uphold)` | DAO only | 0.01 NEAR | Uphold: entry Rejected, bond forfeited to the treasury, points stay removed. Reject: entry Verified again, bond returned, points restored only if the entry's epoch is still current. |
| `resolve_dispute_expired(asset_id, entry_id)` | anyone | 0 NEAR | After the resolution deadline (`disputed_at + dispute_window_ns`): auto-resolves as UPHOLD (entry Rejected, attestor bond forfeited, disputer bond returned). No deposit. |
| `claim_dispute_bond(asset_id, entry_id)` | disputer | 0.01 NEAR | Retry the dispute-bond return after resolution. |
| `release_attestation_bond(asset_id, entry_id)` | attestor | 0.01 NEAR | Entry Verified, bond Held, dispute window passed. |
| `pay_expense(asset_id, amount, recipient, description, category)` | DAO only | 0.01 NEAR | Amount must be at most the spendable funds, inside the per-expense cap, above the reserve floor, and in an allowed category. If the transfer fails, the callback reverts the expense. Description at most 256 chars. |
| `propose_policy_change(community_id, policy_type, new_params)` | DAO only | 0.01 NEAR minimum | Returns the amendment id. New params are validated at proposal time. A new proposal for the same type supersedes a pending one. Deadline is now + timelock; the old policy stays in force until execution. The deposit is a minimum: the contract measures actual storage written. |
| `execute_policy_change(community_id, amendment_id)` | anyone | 0.01 NEAR | After the deadline, before the 30-day expiry. |
| `cancel_policy_change(community_id, amendment_id)` | DAO only | 0.01 NEAR | Cancels a pending amendment. |
| `execute_distribution(asset_id)` | anyone | 0.01 NEAR minimum | Pays the distribution and resets the epoch. Requires something distributable. One-shot per epoch: the caller chooses nothing, the maths is fixed. The deposit is a minimum: the contract measures actual storage written (a 20-member distribution with long ids needs more than 0.01 NEAR). Blocked while an entry is Disputed and inside its resolution deadline; use `resolve_dispute_expired` after the deadline. |
| `claim_failed_payout(distribution_id)` | original recipient | 0.01 NEAR | Pays the exact original amount of a failed member payout. The entitlement is never recomputed under a new epoch. |

### View methods

`get_community`, `get_campaign`, `get_asset`, `get_treasury`,
`get_revenue`, `get_expenses`, `get_distributions`, `get_distribution`,
`get_distribution_breakdown`, `get_activity`, `get_policies`, `get_stats`,
`list_communities(from_index?, limit?)`, `is_community_pending(community_id)`,
`get_claimable_payouts(account)`. All read-only, no deposit.

## The money rules

- Distribution split (basis points, must sum to 10000): members 6000,
  treasury 2500, maintenance 1500, activity 1000. The activity slice is
  10% of the member pool, shared by current-epoch work points.
- Work points: capital 1 per whole NEAR contributed; work 1 per revenue
  record + 1 per whole NEAR of attested reported revenue, **capped at 10
  points per entry**. Onchain deposits earn no work points; points come
  only from attested reported revenue.
- Attestation bond scales with the claim: `0.1 NEAR + amount/10`. A 100
  NEAR claim needs a 10.1 NEAR bond and still earns at most 10 points.
- A disputed entry's points are suspended while the dispute is open. If
  the dispute is upheld, the points are gone and the bond is
  forfeited. If it is rejected, the points return only if the entry's
  epoch is still current. A dispute that passes its resolution deadline
  is auto-resolved as UPHOLD by anyone calling
  `resolve_dispute_expired` (no deposit).
- A failed member payout is not recomputed: the exact original amount
  is claimable by the recipient via `claim_failed_payout`.
- Payouts sum exactly; the conservation invariant holds in yoctoNEAR.
  Ownership payouts follow the acquisition allocation; activity payouts
  follow work points; with zero work points the activity pool falls back
  to ownership shares.
- Field limits: community name at most 64 chars, description at most 256,
  asset name at most 64, revenue source at most 64, reference at most 128,
  expense description at most 256. Record limits: 50 campaigns/assets per
  community, 200 revenue/expenses/distributions per asset, 100 amendments
  per community.

## Worked example (the live v4 demo)

Four members contribute 2.5 NEAR each (10 NEAR target). The DAO acquires
a generator for 10 NEAR. Alice records 3 NEAR onchain revenue. Bob
records 1 NEAR reported revenue; Alice attests it (0.2 NEAR bond = 0.1
+ 1/10 of the claim). Carol disputes it (0.06 NEAR); the DAO upholds, so
the entry is rejected, the bond is
forfeited, and Bob's 2 points are removed. A 2 NEAR expense is rejected
(over the 1 NEAR cap); a 0.5 NEAR expense succeeds. The DAO raises the cap
to 2 NEAR through the timelock. Dave records 1 NEAR reported revenue;
Carol attests it (0.2 NEAR bond), so Dave holds the only 2 work points.
The demo waits out the dispute window, then Carol's bond is released.
Distribution: distributable 2.7 NEAR, member pool 1.62, activity pool
0.162 (all to Dave), ownership pool 1.458 (0.3645 each). Payouts: Alice
0.3645, Bob 0.3645, Carol 0.3645, Dave 0.5265. Retention 0.675,
maintenance 0.405, final treasury 1.08 NEAR. The receipts are
`demo-receipts-lagos-energy-cooperative-6.json` in the repo; run
`scripts/verify-v4.mjs --receipts <that file>` to check them.

## Rules for the agent using this skill

- Testnet only. Never mainnet, never real funds.
- Use your own testnet wallet. Never the user's personal wallet, never
  their keys, never a key pasted in chat.
- Before any change call, state the exact method, arguments, attached
  deposit, and the worst case (what is lost if it fails), and get an
  explicit yes for that exact call. Never batch a signature with another
  action.
- A failed transfer is a revert, not a loss: the callbacks on acquire,
  expense, refund and payouts put the state back so the operation can be
  retried. A cancelled campaign never auto-refunds; each contributor
  claims once. A failed member payout in a distribution becomes a
  claimable liability for the exact original amount
  (`claim_failed_payout`).
- Do not invent a token number, balance, or payout. Read it from a view
  call or from `scripts/verify-v4.mjs` first.
- Membership is fixed at creation. There is no join or add-member method
  in this version, and no leave flow.

## Limits

- Demo accounts only. The demo members, seller and DAO are test
  accounts. No real people have used OwnGround.
- Testnet only. No mainnet parts, no fee logic.
- `create_community` verifies the DAO onchain (genuine Sputnik DAO,
  council equals members, threshold is the strict majority). A community
  has at least 3 and at most 20 members.
- The site hides superseded demo runs; they remain onchain as history and
  their community pages still load.
