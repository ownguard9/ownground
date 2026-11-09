//! Registry module: communities, their policies, and policy amendments.
//!
//! Membership is fixed at creation (no roles, no join/leave, no
//! close_community in v1). The community's Sputnik DAO is verified at
//! creation by a cross-contract get_policy call (see governance.rs):
//! the council must equal the member set and the threshold must be
//! floor(n/2)+1, so a plain account can never stand in as a DAO.
//!
//! Policies are set at creation as founding parameters. Later changes go
//! only through the two-step amendment flow (propose, wait the timelock,
//! execute); there are no direct set_*_policy calls in v1.
//!
//! Activity points are split in two:
//! * `capital_points` (per member, on the community): from cumulative
//!   contributions, capital_per_near x floor(total / 1 NEAR). A sub-1-NEAR
//!   cumulative total earns 0. Capital is recorded and shown but never
//!   affects the activity slice; it is rewarded through ownership.
//! * `work_points` (per member, per asset, current epoch + lifetime):
//!   from verified revenue only. The activity slice is split by the
//!   current epoch's work points only.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::AccountId;

/// 1 NEAR in yoctoNEAR.
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Smallest allowed community size (v4, finding 4): a community needs
/// at least 3 members. Fewer members cannot reach a strict-majority
/// threshold, and a two-member community has no eligible dispute
/// challenger (the challenger must differ from both recorder and
/// attestor). This is Isaiah's DAO-size principle: one person alone
/// is not a DAO.
pub const MIN_MEMBERS: usize = 3;
/// Largest allowed community size (gas bound on the distribution push).
pub const MAX_MEMBERS: usize = 20;

/// Largest work points one revenue entry can award (v4, finding 3):
/// amount-proportional points are capped per entry so a large
/// reported claim cannot mint an unbounded activity share.
pub const MAX_POINTS_PER_ENTRY: u64 = 10;

/// Largest allowed activity weight (capital_per_near,
/// work_per_revenue_record, work_per_revenue_near). A weight above
/// this is a misconfiguration, not a policy: it would let one entry
/// mint unbounded work points.
pub const MAX_ACTIVITY_WEIGHT: u64 = 1_000_000;
/// Largest allowed number of spending categories.
pub const MAX_SPENDING_CATEGORIES: usize = 20;
/// Largest allowed spending category, in characters.
pub const MAX_CATEGORY_LEN: usize = 64;
/// Smallest allowed dispute window / timelock: 60 seconds, in
/// nanoseconds. Zero (or anything shorter) would let a dispute or an
/// amendment resolve before anyone can see it.
pub const MIN_TIME_WINDOW_NS: u64 = 60 * 1_000_000_000;
/// Largest allowed dispute window / timelock: 365 days, in nanoseconds.
pub const MAX_TIME_WINDOW_NS: u64 = 365 * 24 * 60 * 60 * 1_000_000_000;

/// Field-size limits (v4, finding 7): stored strings are capped so a
/// fixed storage deposit always covers the bytes a record can add.
/// Lengths are character counts.
pub const MAX_NAME_LEN: usize = 64;
pub const MAX_DESCRIPTION_LEN: usize = 256;
pub const MAX_SOURCE_LEN: usize = 64;
pub const MAX_REFERENCE_LEN: usize = 128;

/// Record-count limits (v4, finding 7): growing histories are capped
/// per community / per asset so views and scans stay bounded.
pub const MAX_CAMPAIGNS_PER_COMMUNITY: usize = 50;
pub const MAX_ASSETS_PER_COMMUNITY: usize = 50;
pub const MAX_REVENUE_PER_ASSET: usize = 200;
pub const MAX_EXPENSES_PER_ASSET: usize = 200;
pub const MAX_DISTRIBUTIONS_PER_ASSET: usize = 200;
pub const MAX_AMENDMENTS_PER_COMMUNITY: usize = 100;

/// Longest allowed community id, in characters (v4, finding 1).
pub const MAX_COMMUNITY_ID_LEN: usize = 64;

/// Validate a community id against the strict allowlist (v4,
/// finding 1): lowercase letters, digits and hyphens only, 1-64
/// characters, starting and ending with a letter or digit. This is
/// the slug the creation form produces, and it closes the stored-XSS
/// hole: a crafted id can no longer break out of a JavaScript string
/// on the site.
pub fn validate_community_id(id: &str) {
    assert!(!id.is_empty(), "community id must not be empty");
    assert!(
        id.chars().count() <= MAX_COMMUNITY_ID_LEN,
        "community id must be at most 64 characters"
    );
    assert!(
        id.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "community id must contain only lowercase letters, digits and hyphens"
    );
    let first = id.chars().next().unwrap();
    let last = id.chars().last().unwrap();
    assert!(
        first.is_ascii_lowercase() || first.is_ascii_digit(),
        "community id must start with a letter or digit"
    );
    assert!(
        last.is_ascii_lowercase() || last.is_ascii_digit(),
        "community id must end with a letter or digit"
    );
}

/// Validate one stored text field against its character cap (v4,
/// finding 7). Panics naming the field and its limit.
pub fn validate_field_len(value: &str, max: usize, field: &str) {
    assert!(
        value.chars().count() <= max,
        "{} must be at most {} characters",
        field,
        max
    );
}

/// Validate a distribution policy's shares. This is the ONE shared
/// validation path for deserialized input: serde deserialization
/// bypasses constructors, so a direct contract call must be checked
/// here, never by trusting `DistributionPolicy::new_with_activity`
/// to have run.
pub fn validate_distribution_policy(
    members_bp: u16,
    treasury_bp: u16,
    maintenance_bp: u16,
    activity_bp: u16,
) {
    assert_eq!(
        members_bp as u32 + treasury_bp as u32 + maintenance_bp as u32,
        10_000,
        "policy shares must sum to exactly 10000 basis points"
    );
    assert!(activity_bp <= 10_000, "activity_bp must be between 0 and 10000");
}

/// Validate a spending policy: the category list must be non-empty,
/// every category a non-empty string of at most 64 characters, no
/// duplicates, at most 20 categories. (The amounts —
/// max_single_expense, min_treasury_reserve — carry no bound: 0 means
/// "no cap" / "no floor" by design.)
pub fn validate_spending_policy(policy: &SpendingPolicy) {
    assert!(!policy.allowed_categories.is_empty(), "spending policy must allow at least one category");
    assert!(
        policy.allowed_categories.len() <= MAX_SPENDING_CATEGORIES,
        "spending policy allows at most 20 categories"
    );
    let mut seen: Vec<&str> = Vec::new();
    for category in &policy.allowed_categories {
        let trimmed = category.trim();
        assert!(!trimmed.is_empty(), "spending category must not be empty");
        assert!(
            trimmed.chars().count() <= MAX_CATEGORY_LEN,
            "spending category must be at most 64 characters"
        );
        assert!(!seen.contains(&trimmed), "duplicate spending category");
        seen.push(trimmed);
    }
}

/// Validate an activity policy: every weight is at most 1,000,000.
/// A weight of 0 disables that source of points.
pub fn validate_activity_policy(policy: &ActivityPolicy) {
    assert!(
        policy.capital_per_near <= MAX_ACTIVITY_WEIGHT,
        "capital_per_near must be at most 1000000"
    );
    assert!(
        policy.work_per_revenue_record <= MAX_ACTIVITY_WEIGHT,
        "work_per_revenue_record must be at most 1000000"
    );
    assert!(
        policy.work_per_revenue_near <= MAX_ACTIVITY_WEIGHT,
        "work_per_revenue_near must be at most 1000000"
    );
}

/// Validate a dispute window / timelock: at least 60 seconds (0 is
/// rejected — a zero window would close disputes and amendments
/// before anyone can see them) and at most 365 days.
pub fn validate_time_window(value_ns: u64, name: &str) {
    assert!(
        value_ns >= MIN_TIME_WINDOW_NS && value_ns <= MAX_TIME_WINDOW_NS,
        "{} must be between 60 seconds and 365 days",
        name
    );
}

/// A distribution policy: three basis-point shares that must sum to
/// exactly 10000, plus the activity slice. Set at creation; changed only
/// by a policy amendment.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct DistributionPolicy {
    pub members_bp: u16,
    pub treasury_bp: u16,
    pub maintenance_bp: u16,
    /// Share of the member pool distributed by work points instead of
    /// ownership allocation (0-10000). Default 1000 = 10%.
    pub activity_bp: u16,
}

impl DistributionPolicy {
    pub fn new(members_bp: u16, treasury_bp: u16, maintenance_bp: u16) -> Self {
        Self::new_with_activity(members_bp, treasury_bp, maintenance_bp, 1000)
    }

    pub fn new_with_activity(
        members_bp: u16,
        treasury_bp: u16,
        maintenance_bp: u16,
        activity_bp: u16,
    ) -> Self {
        validate_distribution_policy(members_bp, treasury_bp, maintenance_bp, activity_bp);
        Self { members_bp, treasury_bp, maintenance_bp, activity_bp }
    }
}

/// An enforceable spending policy (from Petty Cash). Binds even a
/// DAO-approved spend. Set at creation; changed only by a policy
/// amendment.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct SpendingPolicy {
    /// Largest single expense allowed in yoctoNEAR. 0 means no cap.
    pub max_single_expense: U128,
    /// Treasury floor: an expense is rejected if it would take the
    /// unlocked treasury (treasury - locked) below this.
    pub min_treasury_reserve: U128,
    /// Expense categories the community permits.
    pub allowed_categories: Vec<String>,
}

/// Weights for activity points. Set at creation; changed only by a
/// policy amendment. A weight of 0 disables that source of points.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct ActivityPolicy {
    /// Capital points per whole NEAR of cumulative contributions.
    pub capital_per_near: u64,
    /// Work points per verified revenue entry.
    pub work_per_revenue_record: u64,
    /// Work points per whole NEAR of a verified revenue entry.
    pub work_per_revenue_near: u64,
}

impl Default for ActivityPolicy {
    fn default() -> Self {
        Self { capital_per_near: 1, work_per_revenue_record: 1, work_per_revenue_near: 1 }
    }
}

impl ActivityPolicy {
    /// Work points for one verified revenue entry of `amount` yoctoNEAR:
    /// record points + per-NEAR points on the whole-NEAR part, capped
    /// at MAX_POINTS_PER_ENTRY (v4, finding 3). A large reported claim
    /// can no longer mint an unbounded activity share at a fixed bond.
    pub fn work_points_for(&self, amount: u128) -> u64 {
        let whole = (amount / ONE_NEAR).min(u64::MAX as u128) as u64;
        self.work_per_revenue_record
            .saturating_add(self.work_per_revenue_near.saturating_mul(whole))
            .min(MAX_POINTS_PER_ENTRY)
    }
}

/// Capital points from a member's cumulative contributed total:
/// capital_per_near x floor(total / 1 NEAR). A sub-1-NEAR cumulative
/// total earns 0. Splitting one contribution into many small ones earns
/// nothing extra, because the points depend on the cumulative total.
pub fn capital_points_for(total_contributed: u128, capital_per_near: u64) -> u64 {
    let whole = (total_contributed / ONE_NEAR).min(u64::MAX as u128) as u64;
    whole.saturating_mul(capital_per_near)
}

/// Which policy an amendment changes.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub enum PolicyType {
    Distribution,
    Spending,
    Activity,
}

/// New parameters for an amendment, by policy type.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub enum PolicyParams {
    Distribution { members_bp: u16, treasury_bp: u16, maintenance_bp: u16, activity_bp: u16 },
    Spending { max_single_expense: U128, min_treasury_reserve: U128, allowed_categories: Vec<String> },
    Activity { capital_per_near: u64, work_per_revenue_record: u64, work_per_revenue_near: u64 },
}

/// Status of a policy amendment.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub enum AmendmentStatus {
    Pending,
    Executed,
    Cancelled,
    Superseded,
    Expired,
}

/// A pending or past policy amendment. The old policy stays in force
/// until an amendment is executed; a deadlock never bricks the community.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PolicyAmendment {
    pub id: u64,
    pub policy_type: PolicyType,
    pub new_params: PolicyParams,
    pub old_params: PolicyParams,
    /// Block timestamp (ns) when the amendment was proposed.
    pub proposed_at: u64,
    /// Block timestamp (ns) after which the amendment may execute.
    pub deadline: u64,
    pub status: AmendmentStatus,
}

/// A community: a fixed member set, its Sputnik DAO, and all money
/// counters. Amounts are yoctoNEAR (u128). The treasury balance is
/// derived from the counters, never stored separately:
///
/// treasury = (total_contributions + total_revenue)
///          - (total_acquisitions + total_expenses + total_payouts
///             + total_refunds)
///
/// The contract's raw balance is treasury + storage_reserve +
/// total_bonds_held + total_dispute_bonds_held: storage deposits and
/// bonds are held separately from the treasury and never counted in
/// it. A failed member payout is also still in the raw balance but
/// NOT in the treasury: it was counted in total_payouts at
/// distribution time, so it stays out of the spendable treasury until
/// its recipient claims it (see distribution::ClaimablePayout).
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct Community {
    pub id: String,
    pub name: String,
    pub description: String,
    pub dao_id: AccountId,
    /// Fixed at creation. No roles, no join/leave in v1.
    pub members: Vec<AccountId>,
    /// Founding distribution policy; changed only by amendment.
    pub policy: DistributionPolicy,
    /// Founding spending policy; changed only by amendment.
    pub spending_policy: SpendingPolicy,
    /// Founding activity policy; changed only by amendment.
    pub activity_policy: ActivityPolicy,
    /// Capital points per member (cumulative contributions). Recorded and
    /// shown; they never affect the activity slice.
    pub capital_points: Vec<(AccountId, u64)>,
    pub campaign_ids: Vec<String>,
    pub asset_ids: Vec<String>,
    /// Pending and past policy amendments, in proposal order.
    pub amendments: Vec<PolicyAmendment>,
    /// Dispute window for attested revenue, in nanoseconds.
    pub dispute_window_ns: u64,
    /// Timelock for policy amendments, in nanoseconds.
    pub timelock_ns: u64,
    pub total_contributions: u128,
    /// Onchain revenue deposits only, plus forfeited attestation bonds.
    /// Reported revenue moves no money.
    pub total_revenue: u128,
    pub total_acquisitions: u128,
    pub total_expenses: u128,
    /// Cumulative NEAR actually transferred to members (treasury
    /// equation only; see the distribution module for the D formula).
    pub total_payouts: u128,
    /// Cumulative D_effective consumed by all distributions of this
    /// community's assets (D formula only; caps total distributions at
    /// community net earnings).
    pub total_distributed: u128,
    pub total_refunds: u128,
    /// Cumulative retention + maintenance kept by the treasury from
    /// distributions (the retained reserves figure on the dashboard).
    pub total_retained: u128,
    /// Attestation bonds currently held by the contract (not treasury).
    pub total_bonds_held: u128,
    /// Dispute bonds currently held by the contract (not treasury):
    /// 0.05 NEAR per open dispute, returned if the dispute is upheld
    /// and forfeited to the treasury as revenue if it is rejected.
    pub total_dispute_bonds_held: u128,
    /// Cumulative storage deposits received; never counted in the treasury.
    pub storage_reserve: u128,
}

impl Community {
    pub fn new(
        id: String,
        name: String,
        description: String,
        dao_id: AccountId,
        members: Vec<AccountId>,
    ) -> Self {
        // v4, findings 1 + 4 + 7: the id must match the strict
        // allowlist, the name/description must fit their caps, and the
        // member set must be 3..=20 (a smaller community has no
        // eligible dispute challenger and cannot reach a strict
        // majority; a larger one exceeds the distribution gas bound).
        validate_community_id(&id);
        validate_field_len(&name, MAX_NAME_LEN, "community name");
        validate_field_len(&description, MAX_DESCRIPTION_LEN, "community description");
        assert!(
            members.len() >= MIN_MEMBERS,
            "a community needs at least 3 members"
        );
        assert!(members.len() <= MAX_MEMBERS, "at most 20 members per community in v1");
        let mut sorted = members.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), members.len(), "duplicate members");
        Self {
            id,
            name,
            description,
            dao_id,
            members,
            policy: DistributionPolicy::new(6000, 2500, 1500),
            spending_policy: SpendingPolicy {
                max_single_expense: U128(0),
                min_treasury_reserve: U128(0),
                allowed_categories: Vec::new(),
            },
            activity_policy: ActivityPolicy::default(),
            capital_points: Vec::new(),
            campaign_ids: Vec::new(),
            asset_ids: Vec::new(),
            amendments: Vec::new(),
            dispute_window_ns: 7 * 24 * 60 * 60 * 1_000_000_000,
            timelock_ns: 3 * 24 * 60 * 60 * 1_000_000_000,
            total_contributions: 0,
            total_revenue: 0,
            total_acquisitions: 0,
            total_expenses: 0,
            total_payouts: 0,
            total_distributed: 0,
            total_refunds: 0,
            total_retained: 0,
            total_bonds_held: 0,
            total_dispute_bonds_held: 0,
            storage_reserve: 0,
        }
    }

    pub fn is_member(&self, account: &AccountId) -> bool {
        self.members.contains(account)
    }

    /// A member's capital points (0 if they have none).
    pub fn capital_points_of(&self, account: &AccountId) -> u64 {
        self.capital_points
            .iter()
            .find(|(a, _)| a == account)
            .map(|(_, p)| *p)
            .unwrap_or(0)
    }

    /// Recompute a member's capital points from their cumulative
    /// contributed total across all campaigns. Only members hold points.
    pub fn set_capital_points(&mut self, account: &AccountId, total_contributed: u128) {
        if !self.is_member(account) {
            return;
        }
        let points = capital_points_for(total_contributed, self.activity_policy.capital_per_near);
        match self.capital_points.iter_mut().find(|(a, _)| a == account) {
            Some((_, p)) => *p = points,
            None => self.capital_points.push((account.clone(), points)),
        }
    }

    /// Work points for one verified revenue entry of `amount`.
    pub fn work_points_for(&self, amount: u128) -> u64 {
        self.activity_policy.work_points_for(amount)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn community_id_allowlist_accepts_valid_slugs() {
        for id in ["a", "lagos-energy", "a-1-b", "x9", &"a".repeat(64)] {
            validate_community_id(id);
        }
    }

    #[test]
    fn community_id_allowlist_rejects_malicious_ids() {
        // The audit's stored-XSS payloads and every neighbouring shape.
        let bad = [
            "x');alert(document.domain);//",
            "\"><script>alert(1)</script>",
            "lagos energy",
            "Lagos-Energy",
            "lagos_energy",
            "lagos.energy",
            "-lagos",
            "lagos-",
            "-",
            "",
            &"a".repeat(65),
            "lagos'",
            "a/b",
            "a\\b",
            "a;b",
        ];
        for id in bad {
            let result = std::panic::catch_unwind(|| validate_community_id(id));
            assert!(result.is_err(), "id {:?} must be rejected", id);
        }
    }

    #[test]
    fn work_points_cap_at_ten_per_entry() {
        // Default weights (1 + 1 per whole NEAR): 1 NEAR -> 2, 9 NEAR
        // -> 10, 100 NEAR -> 10 (capped, not 101).
        let policy = ActivityPolicy::default();
        assert_eq!(policy.work_points_for(ONE_NEAR), 2);
        assert_eq!(policy.work_points_for(9 * ONE_NEAR), 10);
        assert_eq!(policy.work_points_for(100 * ONE_NEAR), 10);
        assert_eq!(policy.work_points_for(1_000_000 * ONE_NEAR), 10);
        // Custom weights that would mint 9 per entry stay under the
        // cap; weights that would mint 90 are capped at 10.
        let big = ActivityPolicy {
            capital_per_near: 1,
            work_per_revenue_record: 3,
            work_per_revenue_near: 2,
        };
        assert_eq!(big.work_points_for(3 * ONE_NEAR), 9);
        assert_eq!(big.work_points_for(100 * ONE_NEAR), 10);
        // Zero weights stay zero.
        let zero = ActivityPolicy {
            capital_per_near: 0,
            work_per_revenue_record: 0,
            work_per_revenue_near: 0,
        };
        assert_eq!(zero.work_points_for(100 * ONE_NEAR), 0);
    }

    #[test]
    fn field_length_limits_enforced() {
        validate_field_len(&"a".repeat(64), MAX_NAME_LEN, "community name");
        let result = std::panic::catch_unwind(|| {
            validate_field_len(&"a".repeat(65), MAX_NAME_LEN, "community name")
        });
        assert!(result.is_err());
        validate_field_len(&"a".repeat(256), MAX_DESCRIPTION_LEN, "community description");
        let result = std::panic::catch_unwind(|| {
            validate_field_len(&"a".repeat(257), MAX_DESCRIPTION_LEN, "community description")
        });
        assert!(result.is_err());
    }

    #[test]
    fn community_new_rejects_fewer_than_three_members() {
        let one: Vec<AccountId> = vec!["a.testnet".parse().unwrap()];
        let result = std::panic::catch_unwind(|| {
            Community::new(
                "x".to_string(),
                "X".to_string(),
                "".to_string(),
                "dao.testnet".parse().unwrap(),
                one,
            )
        });
        assert!(result.is_err());
        let two: Vec<AccountId> =
            vec!["a.testnet".parse().unwrap(), "b.testnet".parse().unwrap()];
        let result = std::panic::catch_unwind(|| {
            Community::new(
                "x".to_string(),
                "X".to_string(),
                "".to_string(),
                "dao.testnet".parse().unwrap(),
                two,
            )
        });
        assert!(result.is_err());
    }
}
