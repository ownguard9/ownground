# OwnGround agent skill

Use OwnGround the way an agent would: create a community, pool NEAR, buy a
productive asset through DAO governance, earn revenue from it, and share the
earnings under a policy the DAO approved. Everything below is NEAR **testnet
only**. There is no mainnet version.

## Live deployment

- Site: https://ownground.vercel.app/
- Contract: `ownground3.testnet`
- Demo DAO: `lagos-energy3.testnet`
- Repo: https://github.com/ownguard9/ownground
- Full detail: README.md and DESIGN.md in the repo. The runnable demo is
  `scripts/demo.mjs`; the live-state checker is `scripts/verify.mjs`.

## The five phases

1. **Pool.** A community of 3-5 members funds a campaign to a target.
2. **Buy.** The DAO (Sputnik v2) approves the acquisition; the contract pays
   the seller and records the ownership allocation.
3. **Earn.** Members record revenue. Onchain revenue moves real NEAR in.
   Reported revenue is a claim: it earns work points only once another
   member attests it with a 0.1 NEAR bond.
4. **Spend.** The DAO pays expenses from the treasury, inside the spending
   policy (per-expense cap, treasury reserve floor, allowed categories).
5. **Share.** Anyone can trigger the distribution. It pays the members by
   ownership plus work points, keeps the treasury and maintenance shares,
   then resets the epoch's work points to zero.

## Who holds the money

The DAO decides, the contract enforces. Neither moves money alone. Every
discretionary spend needs the DAO as the caller: `acquire_asset`,
`pay_expense`, `propose_policy_change` and `resolve_dispute` all reject a
non-DAO caller. The contract holds the funds and enforces the locked
campaign funds, the spending policy, and the distribution maths. A
distribution already paid is never re-run. A guard blocks a distribution
while an entry is disputed or still inside its dispute window; it is live
in the v3 contract (`ownground3.testnet`).)

## Method reference

Amounts are yoctoNEAR strings. `N` below is 1 NEAR = 10^24 yoctoNEAR.

### Change methods

| Method | Who | Attach | Notes |
|---|---|---|---|
| `create_community(id, name, description, dao_id, members, distribution_policy, spending_policy, activity_policy, dispute_window_ns?, timelock_ns?)` | anyone | 0.1 NEAR | Members are fixed at creation. Policies are validated here: shares sum to 10000, `activity_bp` at most 10000, timelock and dispute window 60 s to 365 d, expense categories capped, no empty, duplicate, over-64-char or over-20 categories, activity weights at most 1,000,000. Defaults: dispute window 7 days, timelock 3 days. |
| `create_campaign(community_id, asset_name, category, target, deadline)` | member | 0.05 NEAR | Returns the campaign id. |
| `contribute(campaign_id)` | member | the contribution | The attached amount IS the contribution. |
| `acquire_asset(campaign_id, seller, allocation)` | DAO only | 0.01 NEAR | Campaign must be Funded with `raised == target` and the treasury must hold the target. `allocation` is `[[account, basis_points], ...]` and must sum to 10000 across the members. If the seller transfer fails, the callback reverts the acquisition so the DAO can retry. |
| `cancel_campaign(campaign_id)` | DAO only | 0.01 NEAR | Open or Funded only. Moves no money: each contributor then claims their refund once via `claim_refund`. |
| `claim_refund(campaign_id)` | contributor | 0.01 NEAR | Cancelled campaigns only, once per contributor. If the refund transfer fails, the claim stays open. |
| `record_revenue(asset_id, amount, source, reference)` | member | see note | `reference` is required and must be unique per asset. Attach `amount + 0.01 NEAR` for onchain revenue (the money moves in); attach `0.01 NEAR` only for reported revenue (a claim, no money moves). |
| `attest_revenue(asset_id, entry_id)` | member, not the recorder | 0.1 NEAR bond + 0.01 NEAR | Pending entries only. The entry becomes Verified, the recorder earns work points exactly once, and the bond is held until the dispute window passes or the dispute is resolved. The attestor earns no points: verification is a duty, not a reward. |
| `dispute_revenue(asset_id, entry_id)` | member, not recorder or attestor | 0.01 NEAR | Verified entries only, inside the dispute window (from attestation). The entry becomes Disputed and its points are suspended from the recorder's current-epoch points. |
| `resolve_dispute(asset_id, entry_id, uphold)` | DAO only | 0.01 NEAR | Uphold: entry Rejected, bond forfeited to the treasury, points stay removed. Reject: entry Verified again, bond returned, points restored only if the entry's epoch is still current. |
| `release_attestation_bond(asset_id, entry_id)` | attestor | 0.01 NEAR | Entry Verified, bond Held, dispute window passed. |
| `pay_expense(asset_id, amount, recipient, description, category)` | DAO only | 0.01 NEAR | Amount must be at most the spendable funds, inside the per-expense cap, above the reserve floor, and in an allowed category. If the transfer fails, the callback reverts the expense. |
| `propose_policy_change(community_id, policy_type, new_params)` | DAO only | 0.01 NEAR | Returns the amendment id. New params are validated at proposal time. A new proposal for the same type supersedes a pending one. Deadline is now + timelock; the old policy stays in force until execution. |
| `execute_policy_change(community_id, amendment_id)` | anyone | 0.01 NEAR | After the deadline, before the 30-day expiry. |
| `cancel_policy_change(community_id, amendment_id)` | DAO only | 0.01 NEAR | Cancels a pending amendment. |
| `execute_distribution(asset_id)` | anyone | 0.01 NEAR | Pays the distribution and resets the epoch. Requires something distributable. One-shot per epoch: the caller chooses nothing, the maths is fixed. |

### View methods

`get_community`, `get_campaign`, `get_asset`, `get_treasury`,
`get_revenue`, `get_expenses`, `get_distributions`, `get_distribution`,
`get_distribution_breakdown`, `get_activity`, `get_policies`, `get_stats`,
`list_communities`. All read-only, no deposit.

## The money rules

- Distribution split (basis points, must sum to 10000): members 6000,
  treasury 2500, maintenance 1500, activity 1000. The activity slice is
  10% of the member pool, shared by current-epoch work points.
- Work points: capital 1 per whole NEAR contributed; work 1 per revenue
  record + 1 per whole NEAR of attested reported revenue. Onchain deposits
  earn no work points; points come only from attested reported revenue.
- A disputed entry's points are suspended while the dispute is open. If
  the dispute is upheld, the points are gone and the 0.1 NEAR bond is
  forfeited. If it is rejected, the points return only if the entry's
  epoch is still current.
- Payouts sum exactly; the conservation invariant holds in yoctoNEAR.
  Ownership payouts follow the acquisition allocation; activity payouts
  follow work points; with zero work points the activity pool falls back
  to ownership shares.

## Worked example (the live v3 demo)

Four members contribute 2.5 NEAR each (10 NEAR target). The DAO acquires
a generator for 10 NEAR. Alice records 3 NEAR onchain revenue. Bob
records 1 NEAR reported revenue; Alice attests it (0.1 NEAR bond). Carol
disputes it; the DAO upholds, so the entry is rejected, the bond is
forfeited, and Bob's 2 points are removed. A 2 NEAR expense is rejected
(over the 1 NEAR cap); a 0.5 NEAR expense succeeds. The DAO raises the cap
to 2 NEAR through the timelock. Dave records 1 NEAR reported revenue;
Carol attests it (0.1 NEAR bond), so Dave holds the only 2 work points.
The demo waits out the dispute window, then Carol's bond is released.
Distribution: distributable 2.6 NEAR, member pool 1.56, activity pool
0.156 (all to Dave), ownership pool 1.404 (0.351 each). Payouts: Alice
0.351, Bob 0.351, Carol 0.351, Dave 0.507. Retention 0.65, maintenance
0.39, final treasury 1.04 NEAR. The receipts are
`demo-receipts-lagos-energy-cooperative-5.json` in the repo; run
`scripts/verify.mjs --receipts <that file>` to check them.

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
  claims once.
- Do not invent a token number, balance, or payout. Read it from a view
  call or from `scripts/verify.mjs` first.
- Membership is fixed at creation. There is no join or add-member method
  in this version, and no leave flow.

## Limits

- Demo accounts only. The demo members, seller and DAO are test
  accounts. No real people have used OwnGround.
- Testnet only. No mainnet parts, no fee logic.
- `create_community` trusts the DAO account id it is given; check the DAO
  exists and the council is who you expect before funding a campaign.
- The site hides superseded demo runs (`lagos-energy-cooperative` and
  `lagos-energy-cooperative-2`); they remain onchain as history and their
  community pages still load.
