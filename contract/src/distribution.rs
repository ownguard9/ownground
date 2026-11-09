//! Distribution module: the programmable revenue split.
//!
//! Two counters, each used in exactly one place:
//! * `distributed_payouts` (on the community) — cumulative NEAR actually
//!   transferred to members. Treasury equation only.
//! * `distributed_total` (on the asset) — cumulative D consumed by executed
//!   distributions. D formula only:
//!   D = max(0, revenue_onchain + bond_forfeits - expenses - distributed_total)
//!
//! The split is integer division with floors. Every remainder goes to
//! treasury retention, so the split sums exactly to the distributed amount:
//!   sum(member payouts) + retention (incl. remainders) + maintenance = D

use crate::assets::Asset;
use crate::registry::DistributionPolicy;
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::AccountId;

/// Result of one distribution split. Ownership and activity payouts are
/// kept separate so any member can see exactly what came from their
/// ownership share and what came from verified work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Split {
    /// (member, payout) in yoctoNEAR, ownership + activity combined.
    pub payouts: Vec<(AccountId, u128)>,
    /// (member, payout) from the ownership pool.
    pub ownership_payouts: Vec<(AccountId, u128)>,
    /// (member, payout) from the activity pool (work points only).
    pub activity_payouts: Vec<(AccountId, u128)>,
    /// Sum of member payouts.
    pub member_total: u128,
    /// Treasury retention, including both remainders.
    pub retention: u128,
    /// Maintenance allocation.
    pub maintenance: u128,
    /// The activity pool A = floor(M x activity_bp / 10000).
    pub activity_pool: u128,
    /// The ownership pool O = M - A (or M when nobody holds work points).
    pub ownership_pool: u128,
    /// Total work points the activity slice was split by.
    pub total_work_points: u64,
}

/// Split D across the policy, the asset's ownership allocation, and the
/// current epoch's work points. `allocations` must sum to exactly 10000
/// basis points (checked at acquisition; re-checked here defensively).
/// `activity` is (member, current-epoch work points); capital points are
/// never passed here — they do not affect the activity slice.
/// The exact-sum invariant still holds:
///   sum(member payouts) + retention (incl. all remainders) + maintenance = D
pub fn split_distribution(
    d: u128,
    policy: &DistributionPolicy,
    allocations: &[(AccountId, u16)],
    activity: &[(AccountId, u64)],
) -> Split {
    assert_eq!(
        policy.members_bp as u32 + policy.treasury_bp as u32 + policy.maintenance_bp as u32,
        10_000,
        "policy shares must sum to exactly 10000 basis points"
    );
    assert!(policy.activity_bp <= 10_000, "activity_bp must be between 0 and 10000");
    let alloc_sum: u32 = allocations.iter().map(|(_, bp)| *bp as u32).sum();
    assert_eq!(alloc_sum, 10_000, "allocation basis points must sum to exactly 10000");

    let member_pool = d
        .checked_mul(policy.members_bp as u128)
        .expect("member pool overflow")
        / 10_000;
    let treasury_share = d
        .checked_mul(policy.treasury_bp as u128)
        .expect("treasury share overflow")
        / 10_000;
    let maintenance = d
        .checked_mul(policy.maintenance_bp as u128)
        .expect("maintenance overflow")
        / 10_000;
    // Remainder of the three floors: 0, 1 or 2 yocto.
    let remainder = d - member_pool - treasury_share - maintenance;

    // Activity slice: A = floor(M x activity_bp / 10000); if nobody holds
    // work points, the whole member pool goes by ownership.
    let total_points: u64 = activity.iter().map(|(_, p)| *p).sum();
    let mut activity_pool = member_pool
        .checked_mul(policy.activity_bp as u128)
        .expect("activity pool overflow")
        / 10_000;
    let mut ownership_pool = member_pool - activity_pool;
    if total_points == 0 {
        ownership_pool = member_pool;
        activity_pool = 0;
    }

    // Accumulate payouts per account (BTreeMap keeps the order deterministic),
    // keeping the ownership and activity parts separate.
    let mut by_account: std::collections::BTreeMap<AccountId, u128> = std::collections::BTreeMap::new();
    let mut by_ownership: std::collections::BTreeMap<AccountId, u128> = std::collections::BTreeMap::new();
    let mut by_activity: std::collections::BTreeMap<AccountId, u128> = std::collections::BTreeMap::new();
    let mut activity_sum: u128 = 0;
    if activity_pool > 0 {
        for (account, points) in activity {
            if *points == 0 {
                continue;
            }
            let payout = activity_pool
                .checked_mul(*points as u128)
                .expect("activity payout overflow")
                / total_points as u128;
            activity_sum = activity_sum.checked_add(payout).expect("activity sum overflow");
            *by_account.entry(account.clone()).or_insert(0) += payout;
            *by_activity.entry(account.clone()).or_insert(0) += payout;
        }
    }
    let activity_remainder = activity_pool - activity_sum;
    let mut ownership_sum: u128 = 0;
    for (account, bp) in allocations {
        let payout = ownership_pool
            .checked_mul(*bp as u128)
            .expect("payout overflow")
            / 10_000;
        ownership_sum = ownership_sum.checked_add(payout).expect("ownership sum overflow");
        *by_account.entry(account.clone()).or_insert(0) += payout;
        *by_ownership.entry(account.clone()).or_insert(0) += payout;
    }
    let ownership_remainder = ownership_pool - ownership_sum;
    let member_total = activity_sum + ownership_sum;
    let retention = treasury_share
        .checked_add(remainder)
        .and_then(|r| r.checked_add(activity_remainder))
        .and_then(|r| r.checked_add(ownership_remainder))
        .expect("retention overflow");

    debug_assert_eq!(
        member_total + retention + maintenance,
        d,
        "distribution split must sum exactly to D"
    );
    Split {
        payouts: by_account.into_iter().collect(),
        ownership_payouts: by_ownership.into_iter().collect(),
        activity_payouts: by_activity.into_iter().collect(),
        member_total,
        retention,
        maintenance,
        activity_pool,
        ownership_pool,
        total_work_points: total_points,
    }
}

/// Distributable earnings for one asset before the availability cap.
pub fn distributable(asset: &Asset) -> u128 {
    // Forfeited attestation bonds (DESIGN fix 9) are real money already
    // held by the contract: they count as revenue for D, exactly as the
    // community-level total_revenue (and the treasury view) count them.
    asset
        .revenue_onchain()
        .checked_add(asset.bond_forfeits)
        .expect("revenue sum overflow")
        .saturating_sub(asset.expenses_total())
        .saturating_sub(asset.distributed_total)
}

/// A distribution record: the amount actually distributed (D_effective)
/// and the exact split, with ownership and activity payouts stored
/// separately. Stored per asset under a globally unique id; a second
/// execution with no new revenue computes D = 0 and is rejected, which
/// is the one-shot guard. `unpaid` lists members whose transfer failed
/// (reconciled by the payout callback); their amounts are credited back
/// to the undistributed pool so a later distribution can include them.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct DistributionRecord {
    pub id: u64,
    pub asset_id: String,
    pub distributed: u128,
    pub ownership_payouts: Vec<(AccountId, u128)>,
    pub activity_payouts: Vec<(AccountId, u128)>,
    pub member_total: u128,
    pub retention: u128,
    pub maintenance: u128,
    pub activity_pool: u128,
    pub ownership_pool: u128,
    pub total_work_points: u64,
    /// The current-epoch work points the activity slice was split by.
    pub work_points_snapshot: Vec<(AccountId, u64)>,
    pub unpaid: Vec<AccountId>,
    pub executed_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::DistributionPolicy;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn policy() -> DistributionPolicy {
        DistributionPolicy::new(6000, 2500, 1500)
    }

    #[test]
    fn demo_split_is_exact() {
        let d = 2_500_000_000_000_000_000_000_000u128; // 2.5 NEAR
        let allocs = vec![
            (acc("a.testnet"), 2500),
            (acc("b.testnet"), 2500),
            (acc("c.testnet"), 2500),
            (acc("d.testnet"), 2500),
        ];
        let s = split_distribution(d, &policy(), &allocs, &[]);
        assert_eq!(s.member_total, 1_500_000_000_000_000_000_000_000u128);
        assert_eq!(s.retention, 625_000_000_000_000_000_000_000u128);
        assert_eq!(s.maintenance, 375_000_000_000_000_000_000_000u128);
        assert_eq!(s.member_total + s.retention + s.maintenance, d);
        assert!(s.payouts.iter().all(|(_, p)| *p == 375_000_000_000_000_000_000_000u128));
    }

    #[test]
    fn nasty_splits_are_exact() {
        // D = 7 yocto
        let s = split_distribution(
            7,
            &policy(),
            &[(acc("a.testnet"), 2500), (acc("b.testnet"), 2500), (acc("c.testnet"), 2500), (acc("d.testnet"), 2500)],
            &[],
        );
        assert_eq!(s.member_total + s.retention + s.maintenance, 7);
        assert_eq!(s.member_total, 4);
        // D = 1 yocto: everything to retention, members get 0
        let s = split_distribution(1, &policy(), &[(acc("a.testnet"), 10_000)], &[]);
        assert_eq!(s.member_total, 0);
        assert_eq!(s.retention, 1);
        assert_eq!(s.maintenance, 0);
        // Uneven allocations 3333/3333/3334, member pool 10
        let s = split_distribution(
            10,
            &DistributionPolicy::new(10_000, 0, 0),
            &[(acc("a.testnet"), 3333), (acc("b.testnet"), 3333), (acc("c.testnet"), 3334)],
            &[],
        );
        assert_eq!(s.payouts.iter().map(|(_, p)| *p).sum::<u128>(), 9);
        assert_eq!(s.retention, 1);
        assert_eq!(s.member_total + s.retention + s.maintenance, 10);
    }

    #[test]
    fn distributable_subtracts_expenses_and_prior_distributions() {
        let mut asset = crate::assets::Asset {
            id: "a1".to_string(),
            community_id: "c".to_string(),
            name: "Generator".to_string(),
            description: "".to_string(),
            category: "energy".to_string(),
            value: 10,
            seller: acc("seller.testnet"),
            allocations: vec![(acc("a.testnet"), 10_000)],
            status: crate::assets::AssetStatus::Active,
            created_at: 0,
            epoch: 0,
            work: vec![],
            distributed_total: 0,
            bond_forfeits: 0,
            revenue: vec![],
            expenses: vec![],
        };
        asset.revenue.push(crate::revenue::RevenueEntry {
            amount: 3,
            source: "rent".to_string(),
            reference: "inv-1".to_string(),
            status: crate::revenue::RevenueStatus::Onchain,
            recorded_at: 0,
            recorded_by: acc("a.testnet"),
            attestor: None,
            verified_at: None,
            points_awarded: 4,
            bond_attestor: None,
            bond_status: None,
        });
        asset.expenses.push(crate::revenue::ExpenseEntry {
            amount: 1,
            recipient: acc("a.testnet"),
            description: "fuel".to_string(),
            category: "operations".to_string(),
            recorded_at: 0,
        });
        assert_eq!(distributable(&asset), 2);
        asset.distributed_total = 2;
        assert_eq!(distributable(&asset), 0);
        // Reported (pending or verified) revenue never enters D: it
        // moves no money, so only onchain deposits count.
        asset.revenue.push(crate::revenue::RevenueEntry {
            amount: 100,
            source: "cash".to_string(),
            reference: "inv-2".to_string(),
            status: crate::revenue::RevenueStatus::Pending,
            recorded_at: 0,
            recorded_by: acc("a.testnet"),
            attestor: None,
            verified_at: None,
            points_awarded: 0,
            bond_attestor: None,
            bond_status: None,
        });
        assert_eq!(distributable(&asset), 0);
        asset.revenue.push(crate::revenue::RevenueEntry {
            amount: 50,
            source: "cash".to_string(),
            reference: "inv-3".to_string(),
            status: crate::revenue::RevenueStatus::Verified,
            recorded_at: 0,
            recorded_by: acc("a.testnet"),
            attestor: Some(acc("b.testnet")),
            verified_at: Some(0),
            points_awarded: 2,
            bond_attestor: Some(acc("b.testnet")),
            bond_status: Some(crate::revenue::BondStatus::Held),
        });
        assert_eq!(distributable(&asset), 0);
    }

    #[test]
    fn distributable_includes_forfeited_bond() {
        // DESIGN fix 9: a forfeited attestation bond is distributable
        // like any other revenue. Demo scale in tenths of a NEAR: 3.0
        // onchain + 0.1 bond - 0.5 expense = D 2.6, not 2.5.
        let mut asset = crate::assets::Asset {
            id: "a1".to_string(),
            community_id: "c".to_string(),
            name: "Generator".to_string(),
            description: String::new(),
            category: "energy".to_string(),
            value: 10,
            seller: acc("seller.testnet"),
            allocations: vec![(acc("a.testnet"), 10_000)],
            status: crate::assets::AssetStatus::Active,
            created_at: 0,
            epoch: 0,
            work: vec![],
            distributed_total: 0,
            bond_forfeits: 0,
            revenue: vec![],
            expenses: vec![],
        };
        asset.revenue.push(crate::revenue::RevenueEntry {
            amount: 30,
            source: "rent".to_string(),
            reference: "inv-1".to_string(),
            status: crate::revenue::RevenueStatus::Onchain,
            recorded_at: 0,
            recorded_by: acc("a.testnet"),
            attestor: None,
            verified_at: None,
            points_awarded: 4,
            bond_attestor: None,
            bond_status: None,
        });
        asset.expenses.push(crate::revenue::ExpenseEntry {
            amount: 5,
            recipient: acc("a.testnet"),
            description: "fuel".to_string(),
            category: "operations".to_string(),
            recorded_at: 0,
        });
        assert_eq!(distributable(&asset), 25);
        asset.bond_forfeits = 1;
        assert_eq!(distributable(&asset), 26);
    }

    #[test]
    fn activity_slice_demo_numbers_exact() {
        // Demo, final model: D = 2.5 NEAR, 60/25/15, activity 10% of the
        // member pool. Work points only: alice 4 (3 NEAR onchain revenue:
        // 1 record + 3 per NEAR), bob 2 (1 NEAR attested entry: 1 + 1),
        // carol and dave 0. Capital points (2 each) do not affect the
        // slice. Activity pool 0.15 NEAR, ownership pool 1.35 NEAR.
        let d = 2_500_000_000_000_000_000_000_000u128;
        let allocs = vec![
            (acc("alice.testnet"), 2500),
            (acc("bob.testnet"), 2500),
            (acc("carol.testnet"), 2500),
            (acc("dave.testnet"), 2500),
        ];
        let activity = vec![
            (acc("alice.testnet"), 4),
            (acc("bob.testnet"), 2),
        ];
        let s = split_distribution(d, &policy(), &allocs, &activity);
        assert_eq!(s.member_total + s.retention + s.maintenance, d);
        let get = |a: &str| s.payouts.iter().find(|(x, _)| x.as_str() == a).unwrap().1;
        assert_eq!(get("alice.testnet"), 437_500_000_000_000_000_000_000u128);
        assert_eq!(get("bob.testnet"), 387_500_000_000_000_000_000_000u128);
        assert_eq!(get("carol.testnet"), 337_500_000_000_000_000_000_000u128);
        assert_eq!(get("dave.testnet"), 337_500_000_000_000_000_000_000u128);
        // Ownership and activity parts are stored separately.
        let get_o = |a: &str| s.ownership_payouts.iter().find(|(x, _)| x.as_str() == a).unwrap().1;
        let get_a = |a: &str| s.activity_payouts.iter().find(|(x, _)| x.as_str() == a).map(|(_, p)| *p).unwrap_or(0);
        assert!(s.ownership_payouts.iter().all(|(_, p)| *p == 337_500_000_000_000_000_000_000u128));
        assert_eq!(get_o("alice.testnet"), 337_500_000_000_000_000_000_000u128);
        assert_eq!(get_a("alice.testnet"), 100_000_000_000_000_000_000_000u128);
        assert_eq!(get_a("bob.testnet"), 50_000_000_000_000_000_000_000u128);
        assert_eq!(get_a("carol.testnet"), 0);
        assert_eq!(s.activity_pool, 150_000_000_000_000_000_000_000u128);
        assert_eq!(s.ownership_pool, 1_350_000_000_000_000_000_000_000u128);
        assert_eq!(s.total_work_points, 6);
        // No remainders: the split is exact to the yocto.
        assert_eq!(s.member_total, 1_500_000_000_000_000_000_000_000u128);
        assert_eq!(s.retention, 625_000_000_000_000_000_000_000u128);
        assert_eq!(s.maintenance, 375_000_000_000_000_000_000_000u128);
    }

    #[test]
    fn zero_points_fallback_is_pure_ownership() {
        let d = 2_500_000_000_000_000_000_000_000u128;
        let allocs = vec![
            (acc("alice.testnet"), 2500),
            (acc("bob.testnet"), 2500),
            (acc("carol.testnet"), 2500),
            (acc("dave.testnet"), 2500),
        ];
        let activity = vec![
            (acc("alice.testnet"), 0),
            (acc("bob.testnet"), 0),
            (acc("carol.testnet"), 0),
            (acc("dave.testnet"), 0),
        ];
        let s = split_distribution(d, &policy(), &allocs, &activity);
        assert_eq!(s.member_total + s.retention + s.maintenance, d);
        assert!(s.payouts.iter().all(|(_, p)| *p == 375_000_000_000_000_000_000_000u128));
    }

    #[test]
    fn activity_bp_zero_matches_pre_activity() {
        let d = 2_500_000_000_000_000_000_000_000u128;
        let allocs = vec![
            (acc("alice.testnet"), 2500),
            (acc("bob.testnet"), 2500),
            (acc("carol.testnet"), 2500),
            (acc("dave.testnet"), 2500),
        ];
        let activity = vec![
            (acc("alice.testnet"), 4),
            (acc("bob.testnet"), 2),
        ];
        let zero = DistributionPolicy::new_with_activity(6000, 2500, 1500, 0);
        let s = split_distribution(d, &zero, &allocs, &activity);
        assert_eq!(s.member_total + s.retention + s.maintenance, d);
        assert!(s.payouts.iter().all(|(_, p)| *p == 375_000_000_000_000_000_000_000u128));
        assert_eq!(s.member_total, 1_500_000_000_000_000_000_000_000u128);
    }

    #[test]
    fn activity_bp_full_is_all_by_activity() {
        let d = 2_500_000_000_000_000_000_000_000u128;
        let allocs = vec![
            (acc("alice.testnet"), 2500),
            (acc("bob.testnet"), 2500),
            (acc("carol.testnet"), 2500),
            (acc("dave.testnet"), 2500),
        ];
        let activity = vec![
            (acc("alice.testnet"), 4),
            (acc("bob.testnet"), 2),
        ];
        let full = DistributionPolicy::new_with_activity(6000, 2500, 1500, 10_000);
        let s = split_distribution(d, &full, &allocs, &activity);
        assert_eq!(s.member_total + s.retention + s.maintenance, d);
        let get = |a: &str| s.payouts.iter().find(|(x, _)| x.as_str() == a).unwrap().1;
        // All of M by work points: alice 4/6, bob 2/6, others 0.
        assert_eq!(get("alice.testnet"), 1_000_000_000_000_000_000_000_000u128);
        assert_eq!(get("bob.testnet"), 500_000_000_000_000_000_000_000u128);
        assert_eq!(get("carol.testnet"), 0);
        assert_eq!(s.member_total, 1_500_000_000_000_000_000_000_000u128);
    }
}
