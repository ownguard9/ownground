//! OwnGround — communities pool NEAR, acquire a productive asset through
//! DAO governance, earn revenue from it, and distribute earnings under an
//! approved policy. The complete acquisition-to-revenue-to-distribution
//! flow runs onchain.
//!
//! Design: ~/workspace/commonhold/DESIGN.md (v2 — four holes and eight
//! gaps found by the design check, all fixed before this contract was
//! written; plus the "Beating the top three", "Strengthened economics
//! and security", and "Four safeguards" sections). Money maths (all
//! yoctoNEAR, u128, checked arithmetic):
//!   * treasury = (contributions + revenue deposits)
//!              - (acquisitions + expenses + distribution payouts + refunds)
//!   * locked = sum of raised over open/funded campaigns, plus unclaimed
//!     refund claims; spends may only draw on treasury - locked.
//!   * total_refunds counts a refund when its payment is initiated
//!     (claim_refund for cancelled campaigns, refund for open ones);
//!     a failed transfer's callback reverts that count.
//!   * D (per asset) = max(0, revenue_onchain + bond_forfeits - expenses
//!     - distributed_total),
//!     capped by available funds: D_effective = min(D, treasury - locked).
//!   * A distribution splits D_effective exactly: member payouts +
//!     retention (incl. remainders) + maintenance = D_effective.
//!   * A second execute_distribution with no new revenue computes D = 0
//!     and is rejected — that rejection IS the one-shot guard.
//!
//! TESTNET ONLY. Never deploy to mainnet.

pub mod assets;
pub mod distribution;
pub mod events;
pub mod funding;
pub mod governance;
pub mod registry;
pub mod revenue;
pub mod treasury;

use assets::{validate_allocations, Asset, AssetStatus};
use distribution::{distributable, split_distribution, DistributionRecord};
use funding::{Campaign, CampaignStatus};
use governance::{caller, require_dao, require_member};
use registry::{
    validate_activity_policy, validate_distribution_policy, validate_spending_policy,
    validate_time_window, ActivityPolicy, AmendmentStatus, Community, DistributionPolicy,
    PolicyAmendment, PolicyParams, PolicyType, SpendingPolicy,
};
use revenue::{BondStatus, ExpenseEntry, RevenueEntry, RevenueStatus};
use treasury::{locked_funds, spendable, treasury_balance};

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, Promise};

/// 1 NEAR in yoctoNEAR.
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Storage deposit for creating a community.
pub const STORAGE_CREATE_COMMUNITY: u128 = ONE_NEAR / 10;
/// Storage deposit for creating a campaign.
pub const STORAGE_CREATE_CAMPAIGN: u128 = ONE_NEAR / 20;
/// Storage deposit attached to every call that creates a stored record.
pub const STORAGE_RECORD: u128 = ONE_NEAR / 100;

/// Max members per community in v1 (gas bound on the distribution push).
pub const MAX_MEMBERS: usize = 20;
/// Attestation bond held per attested revenue entry (0.1 NEAR).
pub const ATTESTATION_BOND: u128 = ONE_NEAR / 10;
/// Default dispute window for attested revenue: 7 days, in nanoseconds.
pub const DEFAULT_DISPUTE_WINDOW_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
/// Default timelock for policy amendments: 3 days, in nanoseconds.
pub const DEFAULT_TIMELOCK_NS: u64 = 3 * 24 * 60 * 60 * 1_000_000_000;
/// An amendment expires if not executed within 30 days after its deadline.
pub const AMENDMENT_EXPIRY_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    community_ids: Vector<String>,
    communities: LookupMap<String, Community>,
    campaigns: LookupMap<String, Campaign>,
    assets: LookupMap<String, Asset>,
    distributions: LookupMap<String, Vec<DistributionRecord>>,
    /// Global distribution id -> asset id (for get_distribution_breakdown).
    distribution_asset: LookupMap<u64, String>,
    campaign_seq: u64,
    asset_seq: u64,
    distribution_seq: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            community_ids: Vector::new(b"i"),
            communities: LookupMap::new(b"c"),
            campaigns: LookupMap::new(b"f"),
            assets: LookupMap::new(b"a"),
            distributions: LookupMap::new(b"d"),
            distribution_asset: LookupMap::new(b"x"),
            campaign_seq: 0,
            asset_seq: 0,
            distribution_seq: 0,
        }
    }

    // -- helpers -----------------------------------------------------------

    fn community(&self, id: &str) -> Community {
        self.communities.get(id).expect("community not found").clone()
    }

    fn save_community(&mut self, c: &Community) {
        self.communities.insert(c.id.clone(), c.clone());
    }

    fn campaign(&self, id: &str) -> Campaign {
        self.campaigns.get(id).expect("campaign not found").clone()
    }

    fn save_campaign(&mut self, c: &Campaign) {
        self.campaigns.insert(c.id.clone(), c.clone());
    }

    fn asset(&self, id: &str) -> Asset {
        self.assets.get(id).expect("asset not found").clone()
    }

    fn save_asset(&mut self, a: &Asset) {
        self.assets.insert(a.id.clone(), a.clone());
    }

    fn community_campaigns(&self, community: &Community) -> Vec<Campaign> {
        community
            .campaign_ids
            .iter()
            .map(|id| self.campaign(id))
            .collect()
    }

    fn require_attached(&self, expected: u128) {
        let attached = env::attached_deposit().as_yoctonear();
        assert_eq!(
            attached, expected,
            "attached deposit must be exactly {} yoctoNEAR, got {}",
            expected, attached
        );
    }

    // -- communities -------------------------------------------------------

    /// Create a community with a fixed member set and its founding
    /// policies. Attaches exactly 0.1 NEAR storage. The DAO id is recorded
    /// as given; the contract cannot verify the DAO exists without a
    /// cross-contract call. Later policy changes go only through the
    /// two-step amendment flow (propose, wait the timelock, execute).
    #[payable]
    pub fn create_community(
        &mut self,
        id: String,
        name: String,
        description: String,
        dao_id: AccountId,
        members: Vec<AccountId>,
        distribution_policy: DistributionPolicy,
        spending_policy: SpendingPolicy,
        activity_policy: ActivityPolicy,
        dispute_window_ns: Option<u64>,
        timelock_ns: Option<u64>,
    ) {
        self.require_attached(STORAGE_CREATE_COMMUNITY);
        assert!(!id.is_empty(), "community id must not be empty");
        assert!(
            self.communities.get(&id).is_none(),
            "community id already exists"
        );
        let mut community = Community::new(id.clone(), name, description, dao_id, members);
        // Validate every founding policy through the ONE shared path
        // (deserialized input bypasses constructors, so the check must
        // run here, not in a constructor). The time bounds run on the
        // effective values, defaults included.
        validate_distribution_policy(
            distribution_policy.members_bp,
            distribution_policy.treasury_bp,
            distribution_policy.maintenance_bp,
            distribution_policy.activity_bp,
        );
        validate_spending_policy(&spending_policy);
        validate_activity_policy(&activity_policy);
        community.policy = distribution_policy;
        community.spending_policy = spending_policy;
        community.activity_policy = activity_policy;
        community.dispute_window_ns = dispute_window_ns.unwrap_or(DEFAULT_DISPUTE_WINDOW_NS);
        community.timelock_ns = timelock_ns.unwrap_or(DEFAULT_TIMELOCK_NS);
        validate_time_window(community.dispute_window_ns, "dispute_window_ns");
        validate_time_window(community.timelock_ns, "timelock_ns");
        community.storage_reserve += STORAGE_CREATE_COMMUNITY;
        self.community_ids.push(id.clone());
        self.save_community(&community);
        events::emit(
            "community_created",
            near_sdk::serde_json::json!({ "community_id": id }),
        );
    }

    // -- campaigns ---------------------------------------------------------

    /// Create a funding campaign. Caller must be a community member.
    /// Attaches exactly 0.05 NEAR storage.
    #[payable]
    pub fn create_campaign(
        &mut self,
        community_id: String,
        asset_name: String,
        category: String,
        target: U128,
        deadline: u64,
    ) -> String {
        self.require_attached(STORAGE_CREATE_CAMPAIGN);
        let mut community = self.community(&community_id);
        require_member(&caller(), &community.members);
        let target: u128 = target.into();
        let id = format!("{}-c{}", community_id, self.campaign_seq);
        self.campaign_seq += 1;
        let campaign = Campaign::new(id.clone(), community_id, asset_name, category, target, deadline);
        community.storage_reserve += STORAGE_CREATE_CAMPAIGN;
        community.campaign_ids.push(id.clone());
        self.save_community(&community);
        self.save_campaign(&campaign);
        events::emit(
            "campaign_created",
            near_sdk::serde_json::json!({ "campaign_id": id, "target": target.to_string() }),
        );
        id
    }

    /// Contribute to a campaign. Attached deposit = contribution + 0.01
    /// NEAR storage. Rejected past the target, when the campaign is not
    /// open, or after its deadline.
    #[payable]
    pub fn contribute(&mut self, campaign_id: String) {
        let attached = env::attached_deposit().as_yoctonear();
        assert!(attached > STORAGE_RECORD, "attached deposit must exceed the 0.01 NEAR storage deposit");
        let amount = attached - STORAGE_RECORD;
        let mut campaign = self.campaign(&campaign_id);
        assert!(
            env::block_timestamp() <= campaign.deadline,
            "campaign deadline has passed"
        );
        let contributor = caller();
        campaign.add_contribution(contributor.clone(), amount);
        campaign.check_funded();
        // Persist the campaign first: the cumulative total below is read
        // back from storage and must include this contribution.
        self.save_campaign(&campaign);
        let mut community = self.community(&campaign.community_id);
        community.total_contributions = community
            .total_contributions
            .checked_add(amount)
            .expect("total contributions overflow");
        // Capital points come from the member's cumulative contributed
        // total across all of the community's campaigns, so splitting one
        // contribution into many small ones earns no extra points.
        // Capital points are recorded and shown; they never affect the
        // activity slice (only verified work points do).
        let campaigns = self.community_campaigns(&community);
        let total_contributed: u128 = campaigns
            .iter()
            .flat_map(|c| c.contributors.iter())
            .filter(|(a, _)| *a == contributor)
            .map(|(_, v)| *v)
            .sum();
        community.set_capital_points(&contributor, total_contributed);
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        events::emit(
            "contributed",
            near_sdk::serde_json::json!({
                "campaign_id": campaign_id,
                "contributor": caller().to_string(),
                "amount": amount.to_string(),
                "raised": campaign.raised.to_string(),
            }),
        );
    }

    /// Acquire the asset a campaign funded. DAO only. Transfers the target
    /// to the seller with a callback and counts it as acquisition spend.
    /// If the transfer fails, the callback reverts the acquisition so the
    /// DAO can retry (see on_acquire_complete). Attaches exactly 0.01
    /// NEAR storage.
    #[payable]
    pub fn acquire_asset(
        &mut self,
        campaign_id: String,
        seller: AccountId,
        allocation: Vec<(AccountId, u16)>,
    ) -> String {
        self.require_attached(STORAGE_RECORD);
        let mut campaign = self.campaign(&campaign_id);
        let mut community = self.community(&campaign.community_id);
        require_dao(&caller(), &community.dao_id);
        assert_eq!(campaign.status, CampaignStatus::Funded, "campaign is not funded");
        assert_eq!(campaign.raised, campaign.target, "campaign has not reached its target");
        assert!(
            treasury_balance(&community) >= campaign.target,
            "treasury does not hold the target"
        );
        assert_ne!(seller, env::current_account_id(), "seller cannot be the contract itself");
        validate_allocations(&allocation, &community.members)
            .unwrap_or_else(|e| env::panic_str(&e));
        let asset_id = format!("{}-a{}", community.id, self.asset_seq);
        self.asset_seq += 1;
        let asset = Asset {
            id: asset_id.clone(),
            community_id: community.id.clone(),
            name: campaign.asset_name.clone(),
            description: String::new(),
            category: campaign.category.clone(),
            value: campaign.target,
            seller: seller.clone(),
            allocations: allocation,
            status: AssetStatus::Active,
            created_at: env::block_timestamp(),
            epoch: 0,
            work: Vec::new(),
            distributed_total: 0,
            bond_forfeits: 0,
            revenue: Vec::new(),
            expenses: Vec::new(),
        };
        // State first, transfer second: no reentrancy window.
        campaign.status = CampaignStatus::Acquired;
        community.asset_ids.push(asset_id.clone());
        community.total_acquisitions = community
            .total_acquisitions
            .checked_add(campaign.target)
            .expect("total acquisitions overflow");
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        self.save_campaign(&campaign);
        self.save_asset(&asset);
        // Transfer with a callback: if the seller transfer fails, the
        // callback reverts the acquisition (campaign back to Funded,
        // asset removed, total_acquisitions decremented) so the DAO can
        // retry. The ledger never counts a failed transfer as spent.
        let _ = Promise::new(seller.clone())
            .transfer(NearToken::from_yoctonear(campaign.target))
            .then(
                Self::ext(env::current_account_id()).on_acquire_complete(
                    campaign_id.clone(),
                    asset_id.clone(),
                    seller.clone(),
                    U128(campaign.target),
                ),
            );
        events::emit(
            "asset_acquired",
            near_sdk::serde_json::json!({
                "asset_id": asset_id,
                "campaign_id": campaign_id,
                "seller": seller.to_string(),
                "value": campaign.target.to_string(),
            }),
        );
        asset_id
    }

    /// Callback for one acquisition transfer. Private: only the contract
    /// itself may call it, as the continuation of the transfer promise.
    /// On success nothing changes; on failure the acquisition is
    /// reverted so the DAO can retry it. A direct call (no promise
    /// results) is a no-op.
    #[private]
    pub fn on_acquire_complete(
        &mut self,
        campaign_id: String,
        asset_id: String,
        seller: AccountId,
        amount: U128,
    ) {
        if env::promise_results_count() == 0 {
            return;
        }
        if env::promise_result_checked(0, 100).is_err() {
            self.revert_failed_acquire(&campaign_id, &asset_id, &seller, amount.0);
        }
    }

    /// Revert a failed acquisition: the campaign goes back to Funded,
    /// the asset record is removed entirely (and dropped from the
    /// community's asset list), and total_acquisitions is decremented.
    /// Removing the asset — rather than marking it Failed — is the
    /// cleanest revert: no dangling record can ever be distributed
    /// from, and the retry creates a fresh asset id. Idempotent: if
    /// the campaign is no longer Acquired (already reverted, or a
    /// retry already succeeded) nothing changes. Extracted so unit
    /// tests can drive it directly (the mock blockchain carries no
    /// promise results).
    fn revert_failed_acquire(
        &mut self,
        campaign_id: &str,
        asset_id: &str,
        seller: &AccountId,
        amount: u128,
    ) {
        let mut campaign = match self.campaigns.get(campaign_id) {
            Some(c) => c.clone(),
            None => return,
        };
        if campaign.status != CampaignStatus::Acquired {
            return;
        }
        if self.assets.get(asset_id).is_none() {
            return;
        }
        campaign.status = CampaignStatus::Funded;
        self.save_campaign(&campaign);
        self.assets.remove(asset_id);
        let mut community = self.community(&campaign.community_id);
        community.asset_ids.retain(|id| id != asset_id);
        community.total_acquisitions = community.total_acquisitions.saturating_sub(amount);
        self.save_community(&community);
        events::emit(
            "acquisition_failed",
            near_sdk::serde_json::json!({
                "campaign_id": campaign_id,
                "asset_id": asset_id,
                "seller": seller.to_string(),
                "amount": amount.to_string(),
            }),
        );
    }

    /// Cancel a campaign and record a claimable refund for every
    /// contributor. DAO only, only from open/funded status. Attaches
    /// 0.01 NEAR storage. NO transfers are pushed here: each
    /// contributor claims their refund individually via claim_refund,
    /// which carries a callback. The claimed amounts are recorded in
    /// the campaign's refund_claims and count as LOCKED funds until
    /// claimed, so the DAO cannot spend money owed to contributors.
    /// total_refunds counts a refund only when its claim payment is
    /// initiated (claim_refund), not here — the money is still in the
    /// contract until claimed.
    #[payable]
    pub fn cancel_campaign(&mut self, campaign_id: String) {
        self.require_attached(STORAGE_RECORD);
        let mut campaign = self.campaign(&campaign_id);
        let mut community = self.community(&campaign.community_id);
        require_dao(&caller(), &community.dao_id);
        assert!(
            campaign.status == CampaignStatus::Open || campaign.status == CampaignStatus::Funded,
            "only an open or funded campaign can be cancelled"
        );
        let refund_total = campaign.raised;
        campaign.status = CampaignStatus::Cancelled;
        // Record one claimable refund per contributor. No transfers:
        // a loop of fire-and-forget transfers could silently fail for
        // one contributor while the ledger counted them all refunded.
        campaign.refund_claims = campaign.contributors.clone();
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        self.save_campaign(&campaign);
        events::emit(
            "campaign_cancelled",
            near_sdk::serde_json::json!({
                "campaign_id": campaign_id,
                "refunded": refund_total.to_string(),
            }),
        );
    }

    /// Claim a refund recorded when a campaign was cancelled (or when
    /// an individual refund's transfer failed after its campaign moved
    /// on). Pays ONE contributor — the caller — with a callback: if the
    /// transfer fails, the callback restores the claim and the
    /// contributor can retry. Attaches exactly 0.01 NEAR storage.
    /// total_refunds counts the refund when this payment is initiated;
    /// the callback reverts that count on failure. Capital points are
    /// NOT recomputed here: a cancelled campaign's contributions stay
    /// cumulative, exactly as cancel_campaign has always treated them.
    #[payable]
    pub fn claim_refund(&mut self, campaign_id: String) {
        self.require_attached(STORAGE_RECORD);
        let mut campaign = self.campaign(&campaign_id);
        let claimant = caller();
        let amount = campaign
            .refund_claims
            .iter()
            .find(|(a, _)| *a == claimant)
            .map(|(_, v)| *v)
            .expect("caller has no claimable refund in this campaign");
        campaign.refund_claims.retain(|(a, _)| *a != claimant);
        self.save_campaign(&campaign);
        let mut community = self.community(&campaign.community_id);
        community.total_refunds = community
            .total_refunds
            .checked_add(amount)
            .expect("total refunds overflow");
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        let _ = Promise::new(claimant.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id()).on_claim_refund_complete(
                    campaign_id.clone(),
                    claimant.clone(),
                    U128(amount),
                ),
            );
        events::emit(
            "refund_claimed",
            near_sdk::serde_json::json!({
                "campaign_id": campaign_id,
                "contributor": claimant.to_string(),
                "amount": amount.to_string(),
            }),
        );
    }

    /// Callback for one claim-refund transfer. Private: only the
    /// contract itself may call it. On failure the claim is restored
    /// (and total_refunds decremented) so the contributor can retry.
    /// A direct call (no promise results) is a no-op.
    #[private]
    pub fn on_claim_refund_complete(
        &mut self,
        campaign_id: String,
        claimant: AccountId,
        amount: U128,
    ) {
        if env::promise_results_count() == 0 {
            return;
        }
        if env::promise_result_checked(0, 100).is_err() {
            self.revert_failed_claim_refund(&campaign_id, &claimant, amount.0);
        }
    }

    /// Restore a failed claim refund: the claim goes back on the
    /// campaign and total_refunds is decremented. Idempotent: if the
    /// claim is already there (already restored) nothing changes.
    /// Extracted so unit tests can drive it directly (the mock
    /// blockchain carries no promise results).
    fn revert_failed_claim_refund(
        &mut self,
        campaign_id: &str,
        claimant: &AccountId,
        amount: u128,
    ) {
        let mut campaign = match self.campaigns.get(campaign_id) {
            Some(c) => c.clone(),
            None => return,
        };
        if campaign.refund_claims.iter().any(|(a, _)| a == claimant) {
            return;
        }
        campaign.refund_claims.push((claimant.clone(), amount));
        self.save_campaign(&campaign);
        let mut community = self.community(&campaign.community_id);
        community.total_refunds = community.total_refunds.saturating_sub(amount);
        self.save_community(&community);
        events::emit(
            "refund_claim_failed",
            near_sdk::serde_json::json!({
                "campaign_id": campaign_id,
                "contributor": claimant.to_string(),
                "amount": amount.to_string(),
            }),
        );
    }

    /// Refund one member's own contribution from an OPEN campaign, in
    /// full. Anyone who contributed may call it while the campaign is
    /// still open; a funded or acquired campaign cannot be refunded this
    /// way (the DAO cancels it instead). Attaches exactly 0.01 NEAR
    /// storage. The member's capital points are recomputed from their
    /// remaining cumulative total. The transfer carries a callback: if
    /// it fails, the contribution is restored (and total_refunds
    /// decremented) so the member can retry.
    #[payable]
    pub fn refund(&mut self, campaign_id: String) {
        self.require_attached(STORAGE_RECORD);
        let mut campaign = self.campaign(&campaign_id);
        assert_eq!(campaign.status, CampaignStatus::Open, "only an open campaign can be refunded");
        let contributor = caller();
        let amount = campaign
            .contributors
            .iter()
            .find(|(a, _)| *a == contributor)
            .map(|(_, v)| *v)
            .expect("caller has no contribution in this campaign");
        campaign.contributors.retain(|(a, _)| *a != contributor);
        campaign.raised = campaign.raised.saturating_sub(amount);
        // Persist the campaign first: the cumulative total below is read
        // back from storage and must exclude the refunded contribution.
        self.save_campaign(&campaign);
        let mut community = self.community(&campaign.community_id);
        // The refund is counted once in total_refunds, when this
        // payment is initiated; the callback decrements it again if
        // the transfer fails. (Cancelled campaigns count differently:
        // only at claim payment, see claim_refund.)
        community.total_refunds = community
            .total_refunds
            .checked_add(amount)
            .expect("total refunds overflow");
        community.storage_reserve += STORAGE_RECORD;
        // Recompute capital points from the remaining cumulative total.
        let campaigns = self.community_campaigns(&community);
        let total_contributed: u128 = campaigns
            .iter()
            .flat_map(|c| c.contributors.iter())
            .filter(|(a, _)| *a == contributor)
            .map(|(_, v)| *v)
            .sum();
        community.set_capital_points(&contributor, total_contributed);
        self.save_community(&community);
        let _ = Promise::new(contributor.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id()).on_refund_complete(
                    campaign_id.clone(),
                    contributor.clone(),
                    U128(amount),
                ),
            );
        events::emit(
            "refunded",
            near_sdk::serde_json::json!({
                "campaign_id": campaign_id,
                "contributor": contributor.to_string(),
                "amount": amount.to_string(),
            }),
        );
    }

    /// Callback for one individual refund transfer. Private: only the
    /// contract itself may call it. On failure the contribution is
    /// restored so the member can retry. A direct call (no promise
    /// results) is a no-op.
    #[private]
    pub fn on_refund_complete(
        &mut self,
        campaign_id: String,
        contributor: AccountId,
        amount: U128,
    ) {
        if env::promise_results_count() == 0 {
            return;
        }
        if env::promise_result_checked(0, 100).is_err() {
            self.revert_failed_refund(&campaign_id, &contributor, amount.0);
        }
    }

    /// Restore a failed individual refund: the contributor entry goes
    /// back, raised is restored, total_refunds is decremented, and
    /// capital points are recomputed from the restored cumulative
    /// total — the exact mirror of refund(). Idempotent: if the
    /// contributor is already listed (already restored) nothing
    /// changes. If the campaign has moved on (funded, acquired, or
    /// cancelled) or refilling it would push raised past the target,
    /// the money is never lost: it is recorded as a claimable refund
    /// instead (locked funds, collectable via claim_refund) and
    /// total_refunds is still decremented, since nothing was paid.
    /// Extracted so unit tests can drive it directly (the mock
    /// blockchain carries no promise results).
    fn revert_failed_refund(
        &mut self,
        campaign_id: &str,
        contributor: &AccountId,
        amount: u128,
    ) {
        let mut campaign = match self.campaigns.get(campaign_id) {
            Some(c) => c.clone(),
            None => return,
        };
        if campaign.contributors.iter().any(|(a, _)| a == contributor) {
            return;
        }
        let mut community = self.community(&campaign.community_id);
        if campaign.status == CampaignStatus::Open
            && campaign
                .raised
                .checked_add(amount)
                .map_or(false, |r| r <= campaign.target)
        {
            campaign.contributors.push((contributor.clone(), amount));
            campaign.raised = campaign
                .raised
                .checked_add(amount)
                .expect("raised overflow");
            self.save_campaign(&campaign);
        } else {
            if campaign.refund_claims.iter().any(|(a, _)| a == contributor) {
                return;
            }
            campaign.refund_claims.push((contributor.clone(), amount));
            self.save_campaign(&campaign);
        }
        community.total_refunds = community.total_refunds.saturating_sub(amount);
        // Recompute capital points from the restored cumulative total
        // (the claim path leaves the contributor list untouched, so
        // the total is unchanged there — the recompute is a no-op).
        let campaigns = self.community_campaigns(&community);
        let total_contributed: u128 = campaigns
            .iter()
            .flat_map(|c| c.contributors.iter())
            .filter(|(a, _)| *a == *contributor)
            .map(|(_, v)| *v)
            .sum();
        community.set_capital_points(contributor, total_contributed);
        self.save_community(&community);
        events::emit(
            "refund_failed",
            near_sdk::serde_json::json!({
                "campaign_id": campaign_id,
                "contributor": contributor.to_string(),
                "amount": amount.to_string(),
            }),
        );
    }

    // -- revenue and expenses ----------------------------------------------

    /// Record revenue for an asset. The status is derived from the
    /// attached deposit, never chosen by the caller:
    /// * Onchain: attached == amount + 0.01 NEAR storage, amount > 0.
    ///   Anyone may call (it is real money in). The entry means
    ///   "deposit confirmed", never "asset-generated": a deposit proves
    ///   money moved, not that the asset earned it, so it earns NO work
    ///   points (points_awarded is always 0). It still counts as
    ///   revenue money: total_revenue and distributable rise by the
    ///   amount.
    /// * Reported: attached == 0.01 NEAR storage, amount > 0. Community
    ///   members only. The entry starts Pending, earns no points, and is
    ///   labelled "Reported — not independently verified" until a
    ///   different member attests it. Work points come ONLY from
    ///   attested reported revenue (attest_revenue).
    /// The evidence reference is required and unique per asset: a second
    /// entry with the same reference is rejected.
    #[payable]
    pub fn record_revenue(
        &mut self,
        asset_id: String,
        amount: U128,
        source: String,
        reference: String,
    ) {
        let amount: u128 = amount.into();
        assert!(amount > 0, "revenue amount must be greater than zero");
        assert!(!reference.trim().is_empty(), "evidence reference is required");
        let attached = env::attached_deposit().as_yoctonear();
        let mut asset = self.asset(&asset_id);
        assert!(
            !asset.revenue.iter().any(|e| e.reference == reference),
            "duplicate revenue reference for this asset"
        );
        let mut community = self.community(&asset.community_id);
        let status = if attached == amount.checked_add(STORAGE_RECORD).expect("attached overflow") {
            RevenueStatus::Onchain
        } else if attached == STORAGE_RECORD {
            require_member(&caller(), &community.members);
            RevenueStatus::Pending
        } else {
            env::panic_str(
                "onchain revenue must attach amount + 0.01 NEAR storage; reported revenue must attach exactly 0.01 NEAR storage",
            );
        };
        let points_awarded = 0;
        if status == RevenueStatus::Onchain {
            community.total_revenue = community
                .total_revenue
                .checked_add(amount)
                .expect("total revenue overflow");
            // A deposit proves money moved, not that the asset earned
            // it: no work points are awarded here, for anyone. Work
            // points come only from attested reported revenue.
        }
        community.storage_reserve += STORAGE_RECORD;
        asset.revenue.push(RevenueEntry {
            amount,
            source,
            reference: reference.clone(),
            status: status.clone(),
            recorded_at: env::block_timestamp(),
            recorded_by: caller(),
            attestor: None,
            verified_at: None,
            points_awarded,
            epoch: asset.epoch,
            bond_attestor: None,
            bond_status: None,
        });
        self.save_community(&community);
        self.save_asset(&asset);
        events::emit(
            "revenue_recorded",
            near_sdk::serde_json::json!({
                "asset_id": asset_id,
                "amount": amount.to_string(),
                "reference": reference,
                "status": format!("{:?}", status),
            }),
        );
    }

    /// Attest a pending reported revenue entry. The attestor must be a
    /// different community member than the recorder. Attaches the 0.1
    /// NEAR bond plus 0.01 NEAR storage. The entry becomes Verified, the
    /// recorder earns work points (exactly once, tied to this entry), and
    /// the bond is held by the contract until the dispute window passes
    /// or a dispute is resolved. The attestor earns no points and no
    /// reward: verification is a duty, not a reward.
    #[payable]
    pub fn attest_revenue(&mut self, asset_id: String, entry_id: u64) {
        let attached = env::attached_deposit().as_yoctonear();
        assert_eq!(
            attached,
            ATTESTATION_BOND.checked_add(STORAGE_RECORD).expect("bond overflow"),
            "attestation must attach the 0.1 NEAR bond + 0.01 NEAR storage"
        );
        let mut asset = self.asset(&asset_id);
        let mut community = self.community(&asset.community_id);
        require_member(&caller(), &community.members);
        // The epoch in which the points are awarded: capture it before
        // the entry borrow below.
        let epoch = asset.epoch;
        // Scope the entry borrow: it must end before the asset's work
        // points are updated below.
        let (recorder, points) = {
            let entry = asset
                .revenue
                .get_mut(entry_id as usize)
                .expect("revenue entry not found");
            assert_eq!(entry.status, RevenueStatus::Pending, "only a pending entry can be attested");
            assert_ne!(entry.recorded_by, caller(), "self-attestation is rejected");
            assert!(entry.attestor.is_none(), "entry already attested");
            let points = community.work_points_for(entry.amount);
            entry.status = RevenueStatus::Verified;
            entry.attestor = Some(caller());
            entry.verified_at = Some(env::block_timestamp());
            entry.points_awarded = points;
            entry.epoch = epoch;
            entry.bond_attestor = Some(caller());
            entry.bond_status = Some(BondStatus::Held);
            (entry.recorded_by.clone(), points)
        };
        // Work points are awarded exactly once, tied to this entry id.
        asset.add_work_points(&recorder, points);
        community.total_bonds_held = community
            .total_bonds_held
            .checked_add(ATTESTATION_BOND)
            .expect("bonds held overflow");
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        self.save_asset(&asset);
        events::emit(
            "revenue_attested",
            near_sdk::serde_json::json!({
                "asset_id": asset_id,
                "entry_id": entry_id,
                "attestor": caller().to_string(),
                "points_awarded": points,
            }),
        );
    }

    /// Dispute a verified revenue entry. Any member except the recorder
    /// and the attestor may call it within the dispute window (from
    /// attestation). The entry becomes Disputed and its work points are
    /// suspended: removed from the recorder's current-epoch points,
    /// floored at 0. The suspension is epoch-scoped: if the entry's
    /// epoch already closed (a distribution ran since), suspending is a
    /// no-op — the points are already consumed or reset, and the
    /// dispute must not dock the member's new-epoch points. A
    /// distribution already paid is never re-run.
    /// Attaches exactly 0.01 NEAR storage.
    #[payable]
    pub fn dispute_revenue(&mut self, asset_id: String, entry_id: u64) {
        self.require_attached(STORAGE_RECORD);
        let mut asset = self.asset(&asset_id);
        let community = self.community(&asset.community_id);
        require_member(&caller(), &community.members);
        let (recorder, points, entry_epoch) = {
            let entry = asset
                .revenue
                .get_mut(entry_id as usize)
                .expect("revenue entry not found");
            assert_eq!(entry.status, RevenueStatus::Verified, "only a verified entry can be disputed");
            assert_ne!(entry.recorded_by, caller(), "the recorder cannot dispute their own entry");
            assert_ne!(
                entry.attestor,
                Some(caller()),
                "the attestor cannot dispute their own attestation"
            );
            let verified_at = entry.verified_at.expect("verified entry has no attestation time");
            assert!(
                env::block_timestamp() <= verified_at + community.dispute_window_ns,
                "dispute window has passed"
            );
            let recorder = entry.recorded_by.clone();
            let points = entry.points_awarded;
            let entry_epoch = entry.epoch;
            entry.status = RevenueStatus::Disputed;
            (recorder, points, entry_epoch)
        };
        asset.suspend_work_points(&recorder, points, entry_epoch);
        let mut community = community;
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        self.save_asset(&asset);
        events::emit(
            "revenue_disputed",
            near_sdk::serde_json::json!({
                "asset_id": asset_id,
                "entry_id": entry_id,
                "disputer": caller().to_string(),
                "points_suspended": points,
            }),
        );
    }

    /// Resolve a disputed entry. DAO only (a DAO proposal calls this).
    /// Attaches exactly 0.01 NEAR storage.
    /// * uphold = true: the verification is overturned. The entry becomes
    ///   Rejected, the recorder's points stay removed, and the attestor's
    ///   bond goes to the community treasury as revenue.
    /// * uphold = false: the verification stands. The entry returns to
    ///   Verified, the suspended points are restored, and the bond is
    ///   returned to the attestor.
    /// Both point changes are epoch-scoped (see assets.rs): if the
    /// entry's epoch already closed — a distribution ran between the
    /// dispute and this resolution — uphold only rejects the entry and
    /// forfeits the bond with NO point changes, and reject only
    /// re-verifies the entry with NO restore. Paid money is never
    /// re-run, and new-epoch points are never docked or double-paid.
    #[payable]
    pub fn resolve_dispute(&mut self, asset_id: String, entry_id: u64, uphold: bool) {
        self.require_attached(STORAGE_RECORD);
        let mut asset = self.asset(&asset_id);
        let mut community = self.community(&asset.community_id);
        require_dao(&caller(), &community.dao_id);
        let (recorder, points, entry_epoch, bond_attestor) = {
            let entry = asset
                .revenue
                .get_mut(entry_id as usize)
                .expect("revenue entry not found");
            assert_eq!(entry.status, RevenueStatus::Disputed, "only a disputed entry can be resolved");
            let recorder = entry.recorded_by.clone();
            let points = entry.points_awarded;
            let entry_epoch = entry.epoch;
            let bond_attestor = entry.bond_attestor.clone().expect("disputed entry has no bond");
            if uphold {
                entry.status = RevenueStatus::Rejected;
                entry.bond_status = Some(BondStatus::Forfeited);
            } else {
                entry.status = RevenueStatus::Verified;
                entry.bond_status = Some(BondStatus::Released);
            }
            (recorder, points, entry_epoch, bond_attestor)
        };
        if uphold {
            // The forfeited bond enters the treasury as revenue: it is
            // real money already held by the contract, so the treasury
            // equation stays exact and the bond becomes distributable.
            // Record it on the asset too, so the per-asset D formula
            // (distributable) sees it; the recorder's points stay removed.
            asset.bond_forfeits = asset
                .bond_forfeits
                .checked_add(ATTESTATION_BOND)
                .expect("bond forfeits overflow");
            community.total_revenue = community
                .total_revenue
                .checked_add(ATTESTATION_BOND)
                .expect("total revenue overflow");
            community.total_bonds_held = community
                .total_bonds_held
                .saturating_sub(ATTESTATION_BOND);
        } else {
            asset.restore_work_points(&recorder, points, entry_epoch);
            let _ = Promise::new(bond_attestor.clone())
                .transfer(NearToken::from_yoctonear(ATTESTATION_BOND))
                .then(
                    Self::ext(env::current_account_id()).on_bond_returned(
                        asset_id.clone(),
                        entry_id,
                        bond_attestor.clone(),
                        U128(ATTESTATION_BOND),
                    ),
                );
        }
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        self.save_asset(&asset);
        events::emit(
            "dispute_resolved",
            near_sdk::serde_json::json!({
                "asset_id": asset_id,
                "entry_id": entry_id,
                "uphold": uphold,
            }),
        );
    }

    /// Release an attestation bond after the dispute window passes with
    /// no dispute. Only the attestor may call it, only on a Verified
    /// entry. Attaches exactly 0.01 NEAR storage. The bond is returned
    /// by transfer with a callback: if the transfer fails, the bond
    /// stays held and the attestor can retry.
    #[payable]
    pub fn release_attestation_bond(&mut self, asset_id: String, entry_id: u64) {
        self.require_attached(STORAGE_RECORD);
        let mut asset = self.asset(&asset_id);
        let community = self.community(&asset.community_id);
        let attestor = {
            let entry = asset
                .revenue
                .get_mut(entry_id as usize)
                .expect("revenue entry not found");
            assert_eq!(entry.status, RevenueStatus::Verified, "only a verified entry can release its bond");
            assert_eq!(
                entry.bond_attestor,
                Some(caller()),
                "only the attestor can release the bond"
            );
            assert_eq!(entry.bond_status, Some(BondStatus::Held), "bond is not held");
            let verified_at = entry.verified_at.expect("verified entry has no attestation time");
            assert!(
                env::block_timestamp() > verified_at + community.dispute_window_ns,
                "dispute window has not passed yet"
            );
            let attestor = entry.bond_attestor.clone().unwrap();
            entry.bond_status = Some(BondStatus::Released);
            attestor
        };
        let mut community = community;
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        self.save_asset(&asset);
        let _ = Promise::new(attestor.clone())
            .transfer(NearToken::from_yoctonear(ATTESTATION_BOND))
            .then(
                Self::ext(env::current_account_id())
                    .on_bond_returned(asset_id.clone(), entry_id, attestor.clone(), U128(ATTESTATION_BOND)),
            );
        events::emit(
            "bond_released",
            near_sdk::serde_json::json!({
                "asset_id": asset_id,
                "entry_id": entry_id,
                "attestor": attestor.to_string(),
            }),
        );
    }

    /// Pay an operating expense from the treasury. DAO only. Attaches
    /// exactly 0.01 NEAR storage. Enforcement order, before any transfer:
    /// the locked-funds guard, then the spending policy if the DAO set one
    /// (single-expense cap, treasury reserve floor, allowed category).
    /// The transfer carries a callback: if it fails, the expense entry
    /// is removed and total_expenses decremented, so the DAO can retry
    /// and the ledger never counts a failed transfer as spent.
    #[payable]
    pub fn pay_expense(
        &mut self,
        asset_id: String,
        amount: U128,
        recipient: AccountId,
        description: String,
        category: String,
    ) {
        self.require_attached(STORAGE_RECORD);
        let amount: u128 = amount.into();
        assert!(amount > 0, "expense amount must be greater than zero");
        let mut asset = self.asset(&asset_id);
        let mut community = self.community(&asset.community_id);
        require_dao(&caller(), &community.dao_id);
        let campaigns = self.community_campaigns(&community);
        let available = spendable(&community, &campaigns);
        assert!(amount <= available, "expense exceeds spendable funds");
        // The spending policy binds every pay_expense call, including a
        // DAO-approved one: the guards run regardless of caller. To spend
        // beyond the policy, the community must first pass a separate
        // policy amendment, and only then propose the expense.
        let policy = &community.spending_policy;
        if policy.max_single_expense.0 > 0 {
            assert!(
                amount <= policy.max_single_expense.0,
                "expense exceeds max_single_expense"
            );
        }
        assert!(
            available - amount >= policy.min_treasury_reserve.0,
            "expense would breach min_treasury_reserve"
        );
        assert!(
            policy.allowed_categories.contains(&category),
            "expense category not allowed"
        );
        community.total_expenses = community
            .total_expenses
            .checked_add(amount)
            .expect("total expenses overflow");
        community.storage_reserve += STORAGE_RECORD;
        // The entry's index identifies it to the callback: expenses are
        // only ever appended, so the index stays valid.
        let expense_index = asset.expenses.len() as u64;
        asset.expenses.push(ExpenseEntry {
            amount,
            recipient: recipient.clone(),
            description,
            category,
            recorded_at: env::block_timestamp(),
        });
        self.save_community(&community);
        self.save_asset(&asset);
        let _ = Promise::new(recipient.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id()).on_expense_complete(
                    asset_id.clone(),
                    expense_index,
                    recipient.clone(),
                    U128(amount),
                ),
            );
        events::emit(
            "expense_paid",
            near_sdk::serde_json::json!({
                "asset_id": asset_id,
                "amount": amount.to_string(),
                "recipient": recipient.to_string(),
            }),
        );
    }

    /// Callback for one expense transfer. Private: only the contract
    /// itself may call it, as the continuation of the transfer promise.
    /// On failure the expense entry is removed and total_expenses
    /// decremented so the DAO can retry. A direct call (no promise
    /// results) is a no-op.
    #[private]
    pub fn on_expense_complete(
        &mut self,
        asset_id: String,
        expense_index: u64,
        recipient: AccountId,
        amount: U128,
    ) {
        if env::promise_results_count() == 0 {
            return;
        }
        if env::promise_result_checked(0, 100).is_err() {
            self.revert_failed_expense(&asset_id, expense_index, &recipient, amount.0);
        }
    }

    /// Remove a failed expense entry and decrement total_expenses.
    /// The entry at the recorded index must still match the amount
    /// and recipient — if it does not, the entry was already reverted
    /// (or superseded) and nothing changes. Idempotent. Extracted so
    /// unit tests can drive it directly (the mock blockchain carries
    /// no promise results).
    fn revert_failed_expense(
        &mut self,
        asset_id: &str,
        expense_index: u64,
        recipient: &AccountId,
        amount: u128,
    ) {
        let mut asset = match self.assets.get(asset_id) {
            Some(a) => a.clone(),
            None => return,
        };
        let entry = match asset.expenses.get(expense_index as usize) {
            Some(e) => e.clone(),
            None => return,
        };
        if entry.amount != amount || entry.recipient != *recipient {
            return;
        }
        asset.expenses.remove(expense_index as usize);
        self.save_asset(&asset);
        let mut community = self.community(&asset.community_id);
        community.total_expenses = community.total_expenses.saturating_sub(amount);
        self.save_community(&community);
        events::emit(
            "expense_failed",
            near_sdk::serde_json::json!({
                "asset_id": asset_id,
                "amount": amount.to_string(),
                "recipient": recipient.to_string(),
            }),
        );
    }

    // -- distribution ------------------------------------------------------

    /// Propose a policy change. DAO only (a DAO proposal calls this).
    /// Records a pending amendment with a voting deadline (now +
    /// timelock) and emits policy_amendment_proposed. A new proposal for
    /// a policy type supersedes any pending amendment of that type. The
    /// old policy stays in force until an amendment is executed.
    /// Attaches exactly 0.01 NEAR storage. Returns the amendment id.
    #[payable]
    pub fn propose_policy_change(
        &mut self,
        community_id: String,
        policy_type: PolicyType,
        new_params: PolicyParams,
    ) -> u64 {
        self.require_attached(STORAGE_RECORD);
        let mut community = self.community(&community_id);
        require_dao(&caller(), &community.dao_id);
        let old_params = self.current_params(&community, &policy_type);
        // Validate the new parameters before recording anything.
        self.validate_params(&policy_type, &new_params);
        for a in community.amendments.iter_mut() {
            if a.policy_type == policy_type && a.status == AmendmentStatus::Pending {
                a.status = AmendmentStatus::Superseded;
            }
        }
        let id = community.amendments.len() as u64;
        let now = env::block_timestamp();
        community.amendments.push(PolicyAmendment {
            id,
            policy_type: policy_type.clone(),
            new_params: new_params.clone(),
            old_params: old_params.clone(),
            proposed_at: now,
            deadline: now + community.timelock_ns,
            status: AmendmentStatus::Pending,
        });
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        events::emit(
            "policy_amendment_proposed",
            near_sdk::serde_json::json!({
                "community_id": community_id,
                "amendment_id": id,
                "policy_type": format!("{:?}", policy_type),
                "deadline": now + community.timelock_ns,
            }),
        );
        id
    }

    /// Execute a pending policy amendment. Anyone may call it, after the
    /// deadline and within 30 days after it. Applies the new parameters,
    /// stores the amendment as executed, and emits
    /// policy_amendment_executed with the old and new parameters.
    /// Executing before the deadline, or after expiry, is rejected.
    /// Attaches exactly 0.01 NEAR storage.
    #[payable]
    pub fn execute_policy_change(&mut self, community_id: String, amendment_id: u64) {
        self.require_attached(STORAGE_RECORD);
        let mut community = self.community(&community_id);
        let now = env::block_timestamp();
        // Scope the amendment borrow: it must end before the parameters
        // are applied below.
        let (policy_type, new_params, old_params) = {
            let amendment = community
                .amendments
                .get_mut(amendment_id as usize)
                .expect("amendment not found");
            assert_eq!(amendment.status, AmendmentStatus::Pending, "amendment is not pending");
            assert!(now >= amendment.deadline, "timelock has not passed yet");
            // A panic rolls the transaction back, so the amendment is not
            // marked Expired here; the views report it as expired from the
            // timestamps (deadline + 30 days) until it is re-proposed.
            assert!(
                now <= amendment.deadline + AMENDMENT_EXPIRY_NS,
                "amendment expired"
            );
            (
                amendment.policy_type.clone(),
                amendment.new_params.clone(),
                amendment.old_params.clone(),
            )
        };
        self.apply_params(&mut community, &policy_type, &new_params);
        community.amendments[amendment_id as usize].status = AmendmentStatus::Executed;
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        events::emit(
            "policy_amendment_executed",
            near_sdk::serde_json::json!({
                "community_id": community_id,
                "amendment_id": amendment_id,
                "policy_type": format!("{:?}", policy_type),
                "old_params": format!("{:?}", old_params),
                "new_params": format!("{:?}", new_params),
            }),
        );
    }

    /// Cancel a pending policy amendment. DAO only. Attaches exactly
    /// 0.01 NEAR storage.
    #[payable]
    pub fn cancel_policy_change(&mut self, community_id: String, amendment_id: u64) {
        self.require_attached(STORAGE_RECORD);
        let mut community = self.community(&community_id);
        require_dao(&caller(), &community.dao_id);
        let amendment = community
            .amendments
            .get_mut(amendment_id as usize)
            .expect("amendment not found");
        assert_eq!(amendment.status, AmendmentStatus::Pending, "amendment is not pending");
        amendment.status = AmendmentStatus::Cancelled;
        community.storage_reserve += STORAGE_RECORD;
        self.save_community(&community);
        events::emit(
            "policy_amendment_cancelled",
            near_sdk::serde_json::json!({
                "community_id": community_id,
                "amendment_id": amendment_id,
            }),
        );
    }

    fn current_params(&self, community: &Community, policy_type: &PolicyType) -> PolicyParams {
        match policy_type {
            PolicyType::Distribution => PolicyParams::Distribution {
                members_bp: community.policy.members_bp,
                treasury_bp: community.policy.treasury_bp,
                maintenance_bp: community.policy.maintenance_bp,
                activity_bp: community.policy.activity_bp,
            },
            PolicyType::Spending => PolicyParams::Spending {
                max_single_expense: community.spending_policy.max_single_expense,
                min_treasury_reserve: community.spending_policy.min_treasury_reserve,
                allowed_categories: community.spending_policy.allowed_categories.clone(),
            },
            PolicyType::Activity => PolicyParams::Activity {
                capital_per_near: community.activity_policy.capital_per_near,
                work_per_revenue_record: community.activity_policy.work_per_revenue_record,
                work_per_revenue_near: community.activity_policy.work_per_revenue_near,
            },
        }
    }

    fn validate_params(&self, policy_type: &PolicyType, params: &PolicyParams) {
        // ONE shared validation path for deserialized input (the same
        // one create_community uses): serde bypasses constructors, so
        // a direct contract call must be checked here.
        match (policy_type, params) {
            (
                PolicyType::Distribution,
                PolicyParams::Distribution { members_bp, treasury_bp, maintenance_bp, activity_bp },
            ) => {
                validate_distribution_policy(*members_bp, *treasury_bp, *maintenance_bp, *activity_bp);
            }
            (
                PolicyType::Spending,
                PolicyParams::Spending { max_single_expense, min_treasury_reserve, allowed_categories },
            ) => {
                validate_spending_policy(&SpendingPolicy {
                    max_single_expense: *max_single_expense,
                    min_treasury_reserve: *min_treasury_reserve,
                    allowed_categories: allowed_categories.clone(),
                });
            }
            (
                PolicyType::Activity,
                PolicyParams::Activity { capital_per_near, work_per_revenue_record, work_per_revenue_near },
            ) => {
                validate_activity_policy(&ActivityPolicy {
                    capital_per_near: *capital_per_near,
                    work_per_revenue_record: *work_per_revenue_record,
                    work_per_revenue_near: *work_per_revenue_near,
                });
            }
            _ => env::panic_str("policy type and parameters do not match"),
        }
    }

    fn apply_params(&self, community: &mut Community, policy_type: &PolicyType, params: &PolicyParams) {
        match (policy_type, params) {
            (
                PolicyType::Distribution,
                PolicyParams::Distribution { members_bp, treasury_bp, maintenance_bp, activity_bp },
            ) => {
                community.policy = DistributionPolicy::new_with_activity(
                    *members_bp,
                    *treasury_bp,
                    *maintenance_bp,
                    *activity_bp,
                );
            }
            (
                PolicyType::Spending,
                PolicyParams::Spending { max_single_expense, min_treasury_reserve, allowed_categories },
            ) => {
                // Re-validated here as well as at proposal time: an
                // amendment recorded before this validation existed
                // must not be able to apply an invalid policy.
                validate_spending_policy(&SpendingPolicy {
                    max_single_expense: *max_single_expense,
                    min_treasury_reserve: *min_treasury_reserve,
                    allowed_categories: allowed_categories.clone(),
                });
                community.spending_policy = SpendingPolicy {
                    max_single_expense: *max_single_expense,
                    min_treasury_reserve: *min_treasury_reserve,
                    allowed_categories: allowed_categories.clone(),
                };
            }
            (
                PolicyType::Activity,
                PolicyParams::Activity { capital_per_near, work_per_revenue_record, work_per_revenue_near },
            ) => {
                validate_activity_policy(&ActivityPolicy {
                    capital_per_near: *capital_per_near,
                    work_per_revenue_record: *work_per_revenue_record,
                    work_per_revenue_near: *work_per_revenue_near,
                });
                community.activity_policy = ActivityPolicy {
                    capital_per_near: *capital_per_near,
                    work_per_revenue_record: *work_per_revenue_record,
                    work_per_revenue_near: *work_per_revenue_near,
                };
            }
            _ => env::panic_str("policy type and parameters do not match"),
        }
    }

    /// Execute a distribution for one asset. Anyone may call it; attaches
    /// exactly 0.01 NEAR storage. The activity slice is split by the
    /// asset's current-epoch work points only; after the distribution the
    /// epoch increments and the current points reset to 0, so points
    /// reward recent activity. Pays every owner in the same call (real
    /// NEAR transfers, one promise per payout, each with a callback that
    /// reconciles a failed transfer). A second call with no new revenue
    /// computes D = 0 and is rejected — that rejection IS the one-shot
    /// guard.
    #[payable]
    pub fn execute_distribution(&mut self, asset_id: String) -> DistributionRecordView {
        self.require_attached(STORAGE_RECORD);
        let mut asset = self.asset(&asset_id);
        let mut community = self.community(&asset.community_id);
        let policy = community.policy.clone();
        let d_asset = distributable(&asset);
        let campaigns = self.community_campaigns(&community);
        let available = spendable(&community, &campaigns);
        // Community net earnings cap: an expense charged to one asset must
        // not let another asset distribute more than the policy share of
        // true net earnings (see DESIGN.md Case E).
        let community_net = community.total_revenue.saturating_sub(community.total_expenses);
        let remaining_net = community_net.saturating_sub(community.total_distributed);
        let d_effective = d_asset.min(available).min(remaining_net);
        assert!(d_effective > 0, "nothing distributable for this asset");
        let work_points = asset.work_current();
        let split = split_distribution(d_effective, &policy, &asset.allocations, &work_points);
        // State first, transfers second.
        asset.distributed_total = asset
            .distributed_total
            .checked_add(d_effective)
            .expect("distributed total overflow");
        community.total_distributed = community
            .total_distributed
            .checked_add(d_effective)
            .expect("total distributed overflow");
        community.total_payouts = community
            .total_payouts
            .checked_add(split.member_total)
            .expect("total payouts overflow");
        community.total_retained = community
            .total_retained
            .checked_add(split.retention.checked_add(split.maintenance).expect("retained overflow"))
            .expect("total retained overflow");
        community.storage_reserve += STORAGE_RECORD;
        let record_id = self.distribution_seq;
        self.distribution_seq += 1;
        let record = DistributionRecord {
            id: record_id,
            asset_id: asset_id.clone(),
            distributed: d_effective,
            ownership_payouts: split.ownership_payouts.clone(),
            activity_payouts: split.activity_payouts.clone(),
            member_total: split.member_total,
            retention: split.retention,
            maintenance: split.maintenance,
            activity_pool: split.activity_pool,
            ownership_pool: split.ownership_pool,
            total_work_points: split.total_work_points,
            work_points_snapshot: work_points.clone(),
            unpaid: Vec::new(),
            executed_at: env::block_timestamp(),
        };
        let mut records = self.distributions.get(&asset_id).cloned().unwrap_or_default();
        records.push(record.clone());
        self.distributions.insert(asset_id.clone(), records);
        self.distribution_asset.insert(record_id, asset_id.clone());
        // End of epoch: the current work points reset; the next epoch
        // needs new verified activity.
        asset.reset_epoch_work();
        self.save_community(&community);
        self.save_asset(&asset);
        for (member, payout) in &split.payouts {
            if *payout > 0 {
                let _ = Promise::new(member.clone())
                    .transfer(NearToken::from_yoctonear(*payout))
                    .then(
                        Self::ext(env::current_account_id()).on_payout_complete(
                            record_id,
                            member.clone(),
                            U128(*payout),
                        ),
                    );
            }
        }
        events::emit(
            "distribution_executed",
            near_sdk::serde_json::json!({
                "asset_id": asset_id,
                "distribution_id": record_id,
                "epoch": asset.epoch,
                "distributed": d_effective.to_string(),
                "member_total": split.member_total.to_string(),
                "retention": split.retention.to_string(),
                "maintenance": split.maintenance.to_string(),
            }),
        );
        DistributionRecordView::from(&record)
    }

    /// Callback for one member payout. Private: only the contract itself
    /// may call it, as the continuation of the transfer promise. If the
    /// transfer failed, the amount is credited back to the undistributed
    /// pool and the member is listed as unpaid in the record, so the
    /// funds are never lost and a later distribution can include them.
    /// A failed payout never changes the distribution's recorded totals.
    #[private]
    pub fn on_payout_complete(&mut self, distribution_id: u64, account: AccountId, amount: U128) {
        if env::promise_results_count() == 0 {
            return;
        }
        // A transfer returns no data, so any result longer than 100
        // bytes cannot happen; Err means the transfer failed.
        if env::promise_result_checked(0, 100).is_err() {
            self.reconcile_failed_payout(distribution_id, account, amount.0);
        }
    }

    /// Reconcile one failed payout: credit the amount back to the
    /// undistributed pool and list the member as unpaid. Extracted from
    /// the callback so unit tests can drive it directly (the mock
    /// blockchain carries no promise results).
    fn reconcile_failed_payout(&mut self, distribution_id: u64, account: AccountId, amount: u128) {
        let asset_id = match self.distribution_asset.get(&distribution_id) {
            Some(id) => id.clone(),
            None => return,
        };
        let mut asset = self.asset(&asset_id);
        let mut community = self.community(&asset.community_id);
        let mut records = self.distributions.get(&asset_id).cloned().unwrap_or_default();
        if let Some(record) = records.iter_mut().find(|r| r.id == distribution_id) {
            if !record.unpaid.contains(&account) {
                record.unpaid.push(account.clone());
            }
        }
        asset.distributed_total = asset.distributed_total.saturating_sub(amount);
        community.total_distributed = community.total_distributed.saturating_sub(amount);
        community.total_payouts = community.total_payouts.saturating_sub(amount);
        self.distributions.insert(asset_id.clone(), records);
        self.save_community(&community);
        self.save_asset(&asset);
        events::emit(
            "payout_failed",
            near_sdk::serde_json::json!({
                "distribution_id": distribution_id,
                "account": account.to_string(),
                "amount": amount.to_string(),
            }),
        );
    }

    /// Callback for a returned attestation bond. Private: only the
    /// contract itself may call it. On success the held bond is released
    /// from the books; on failure the bond goes back to Held so the
    /// attestor can retry the release.
    #[private]
    pub fn on_bond_returned(&mut self, asset_id: String, entry_id: u64, attestor: AccountId, amount: U128) {
        if env::promise_results_count() == 0 {
            return;
        }
        if env::promise_result_checked(0, 100).is_err() {
            self.revert_bond_release(&asset_id, entry_id);
        } else {
            self.confirm_bond_returned(&asset_id, &attestor, amount.0);
        }
    }

    /// A bond transfer succeeded: release the held bond from the books.
    fn confirm_bond_returned(&mut self, asset_id: &str, _attestor: &AccountId, amount: u128) {
        let asset = self.asset(asset_id);
        let mut community = self.community(&asset.community_id);
        community.total_bonds_held = community.total_bonds_held.saturating_sub(amount);
        self.save_community(&community);
    }

    /// A bond transfer failed: put the bond back to Held.
    fn revert_bond_release(&mut self, asset_id: &str, entry_id: u64) {
        let mut asset = self.asset(asset_id);
        if let Some(entry) = asset.revenue.get_mut(entry_id as usize) {
            if entry.bond_status == Some(BondStatus::Released) {
                entry.bond_status = Some(BondStatus::Held);
            }
        }
        self.save_asset(&asset);
    }
}

// -- views ---------------------------------------------------------------

/// View structs use U128 (string) amounts: serde_json cannot encode u128.
#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct CommunityView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub dao_id: AccountId,
    pub members: Vec<AccountId>,
    pub policy: DistributionPolicy,
    pub spending_policy: SpendingPolicy,
    pub activity_policy: ActivityPolicy,
    pub capital_points: Vec<(AccountId, u64)>,
    pub campaign_ids: Vec<String>,
    pub asset_ids: Vec<String>,
    pub dispute_window_ns: u64,
    pub timelock_ns: u64,
    pub total_contributions: U128,
    pub total_revenue: U128,
    pub total_acquisitions: U128,
    pub total_expenses: U128,
    pub total_payouts: U128,
    pub total_distributed: U128,
    pub total_refunds: U128,
    pub total_retained: U128,
    pub total_bonds_held: U128,
    pub storage_reserve: U128,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct CampaignView {
    pub id: String,
    pub community_id: String,
    pub asset_name: String,
    pub category: String,
    pub target: U128,
    pub raised: U128,
    pub contributors: Vec<(AccountId, U128)>,
    pub status: String,
    /// Outstanding claimable refunds, per contributor (cancelled
    /// campaigns; unclaimed amounts are locked funds).
    pub refund_claims: Vec<(AccountId, U128)>,
    pub deadline: u64,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct WorkPointsView {
    pub current: u64,
    pub lifetime: u64,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct AssetView {
    pub id: String,
    pub community_id: String,
    pub name: String,
    pub category: String,
    pub value: U128,
    pub seller: AccountId,
    pub allocations: Vec<(AccountId, u16)>,
    pub status: String,
    pub created_at: u64,
    pub epoch: u64,
    pub work_points: Vec<(AccountId, WorkPointsView)>,
    pub distributed_total: U128,
    pub bond_forfeits: U128,
    pub revenue_onchain: U128,
    pub expenses_total: U128,
    pub revenue_count: usize,
    pub expense_count: usize,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct TreasuryView {
    pub community_id: String,
    pub treasury: U128,
    pub locked: U128,
    pub spendable: U128,
    /// Verified revenue (onchain deposits + forfeited bonds). Reported
    /// revenue moves no money and is never counted here.
    pub total_revenue: U128,
    pub total_expenses: U128,
    /// Retention + maintenance kept by the treasury from distributions.
    pub retained: U128,
    /// Community net earnings not yet distributed.
    pub distributable: U128,
    pub total_contributions: U128,
    pub total_acquisitions: U128,
    pub total_payouts: U128,
    pub total_distributed: U128,
    pub total_refunds: U128,
    pub total_bonds_held: U128,
    pub storage_reserve: U128,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct RevenueEntryView {
    pub id: u64,
    pub amount: U128,
    pub source: String,
    pub reference: String,
    pub status: String,
    pub recorded_at: u64,
    pub recorded_by: AccountId,
    pub attestor: Option<AccountId>,
    pub verified_at: Option<u64>,
    pub points_awarded: u64,
    /// The epoch in which the entry's points were awarded (record
    /// epoch for Onchain entries, attestation epoch for reported ones).
    pub epoch: u64,
    pub bond_status: Option<BondStatus>,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct ExpenseEntryView {
    pub amount: U128,
    pub recipient: AccountId,
    pub description: String,
    pub category: String,
    pub recorded_at: u64,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct DistributionRecordView {
    pub id: u64,
    pub asset_id: String,
    pub distributed: U128,
    /// Ownership + activity combined, per member.
    pub payouts: Vec<(AccountId, U128)>,
    pub ownership_payouts: Vec<(AccountId, U128)>,
    pub activity_payouts: Vec<(AccountId, U128)>,
    pub member_total: U128,
    pub retention: U128,
    pub maintenance: U128,
    pub activity_pool: U128,
    pub ownership_pool: U128,
    pub total_work_points: u64,
    pub unpaid: Vec<AccountId>,
    pub executed_at: u64,
}

impl From<&DistributionRecord> for DistributionRecordView {
    fn from(r: &DistributionRecord) -> Self {
        let mut combined: std::collections::BTreeMap<AccountId, u128> =
            std::collections::BTreeMap::new();
        for (a, p) in r.ownership_payouts.iter().chain(r.activity_payouts.iter()) {
            *combined.entry(a.clone()).or_insert(0) += *p;
        }
        Self {
            id: r.id,
            asset_id: r.asset_id.clone(),
            distributed: U128(r.distributed),
            payouts: combined.into_iter().map(|(a, p)| (a, U128(p))).collect(),
            ownership_payouts: r
                .ownership_payouts
                .iter()
                .map(|(a, p)| (a.clone(), U128(*p)))
                .collect(),
            activity_payouts: r
                .activity_payouts
                .iter()
                .map(|(a, p)| (a.clone(), U128(*p)))
                .collect(),
            member_total: U128(r.member_total),
            retention: U128(r.retention),
            maintenance: U128(r.maintenance),
            activity_pool: U128(r.activity_pool),
            ownership_pool: U128(r.ownership_pool),
            total_work_points: r.total_work_points,
            unpaid: r.unpaid.clone(),
            executed_at: r.executed_at,
        }
    }
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct StatsView {
    pub community_count: u64,
    pub campaign_count: u64,
    pub asset_count: u64,
    pub total_treasury: U128,
    pub total_revenue: U128,
    pub total_payouts: U128,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct ActivityView {
    pub asset_id: String,
    pub epoch: u64,
    /// Current-epoch work points per member (what the next distribution
    /// splits by) with lifetime totals.
    pub work_points: Vec<(AccountId, WorkPointsView)>,
    /// Capital points per member (cumulative contributions). Display
    /// only; they never affect the activity slice.
    pub capital_points: Vec<(AccountId, u64)>,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct AmendmentView {
    pub id: u64,
    pub policy_type: PolicyType,
    pub new_params: PolicyParams,
    pub old_params: PolicyParams,
    pub proposed_at: u64,
    pub deadline: u64,
    pub status: AmendmentStatus,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct PoliciesView {
    pub community_id: String,
    pub distribution: DistributionPolicy,
    pub spending: SpendingPolicy,
    pub activity: ActivityPolicy,
    pub dispute_window_ns: u64,
    pub timelock_ns: u64,
    pub amendments: Vec<AmendmentView>,
}

#[derive(Serialize)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct DistributionBreakdownView {
    pub distribution_id: u64,
    pub asset_id: String,
    pub account: AccountId,
    /// D, the amount distributed.
    pub distributed: U128,
    /// M, the member pool.
    pub member_total: U128,
    pub activity_pool: U128,
    pub ownership_pool: U128,
    pub member_allocation_bp: u16,
    pub member_work_points: u64,
    pub total_work_points: u64,
    pub ownership_payout: U128,
    pub activity_payout: U128,
    pub total_payout: U128,
}

#[near]
impl Contract {
    pub fn get_community(&self, community_id: String) -> CommunityView {
        let c = self.community(&community_id);
        CommunityView {
            id: c.id,
            name: c.name,
            description: c.description,
            dao_id: c.dao_id,
            members: c.members,
            policy: c.policy,
            spending_policy: c.spending_policy,
            activity_policy: c.activity_policy,
            capital_points: c.capital_points,
            campaign_ids: c.campaign_ids,
            asset_ids: c.asset_ids,
            dispute_window_ns: c.dispute_window_ns,
            timelock_ns: c.timelock_ns,
            total_contributions: U128(c.total_contributions),
            total_revenue: U128(c.total_revenue),
            total_acquisitions: U128(c.total_acquisitions),
            total_expenses: U128(c.total_expenses),
            total_payouts: U128(c.total_payouts),
            total_distributed: U128(c.total_distributed),
            total_refunds: U128(c.total_refunds),
            total_retained: U128(c.total_retained),
            total_bonds_held: U128(c.total_bonds_held),
            storage_reserve: U128(c.storage_reserve),
        }
    }

    pub fn get_campaign(&self, campaign_id: String) -> CampaignView {
        let c = self.campaign(&campaign_id);
        CampaignView {
            id: c.id,
            community_id: c.community_id,
            asset_name: c.asset_name,
            category: c.category,
            target: U128(c.target),
            raised: U128(c.raised),
            contributors: c.contributors.into_iter().map(|(a, v)| (a, U128(v))).collect(),
            status: format!("{:?}", c.status),
            refund_claims: c
                .refund_claims
                .into_iter()
                .map(|(a, v)| (a, U128(v)))
                .collect(),
            deadline: c.deadline,
        }
    }

    pub fn get_asset(&self, asset_id: String) -> AssetView {
        let a = self.asset(&asset_id);
        let revenue_onchain = a.revenue_onchain();
        let expenses_total = a.expenses_total();
        let revenue_count = a.revenue.len();
        let expense_count = a.expenses.len();
        AssetView {
            id: a.id,
            community_id: a.community_id,
            name: a.name,
            category: a.category,
            value: U128(a.value),
            seller: a.seller,
            allocations: a.allocations,
            status: format!("{:?}", a.status),
            created_at: a.created_at,
            epoch: a.epoch,
            work_points: a
                .work
                .iter()
                .map(|(acc, p)| {
                    (acc.clone(), WorkPointsView { current: p.current, lifetime: p.lifetime })
                })
                .collect(),
            distributed_total: U128(a.distributed_total),
            bond_forfeits: U128(a.bond_forfeits),
            revenue_onchain: U128(revenue_onchain),
            expenses_total: U128(expenses_total),
            revenue_count,
            expense_count,
        }
    }

    pub fn get_treasury(&self, community_id: String) -> TreasuryView {
        let c = self.community(&community_id);
        let campaigns = self.community_campaigns(&c);
        let net = c.total_revenue.saturating_sub(c.total_expenses);
        TreasuryView {
            community_id: c.id.clone(),
            treasury: U128(treasury_balance(&c)),
            locked: U128(locked_funds(&campaigns)),
            spendable: U128(spendable(&c, &campaigns)),
            total_revenue: U128(c.total_revenue),
            total_expenses: U128(c.total_expenses),
            retained: U128(c.total_retained),
            distributable: U128(net.saturating_sub(c.total_distributed)),
            total_contributions: U128(c.total_contributions),
            total_acquisitions: U128(c.total_acquisitions),
            total_payouts: U128(c.total_payouts),
            total_distributed: U128(c.total_distributed),
            total_refunds: U128(c.total_refunds),
            total_bonds_held: U128(c.total_bonds_held),
            storage_reserve: U128(c.storage_reserve),
        }
    }

    pub fn get_revenue(&self, asset_id: String) -> Vec<RevenueEntryView> {
        self.asset(&asset_id)
            .revenue
            .iter()
            .enumerate()
            .map(|(i, e)| RevenueEntryView {
                id: i as u64,
                amount: U128(e.amount),
                source: e.source.clone(),
                reference: e.reference.clone(),
                status: format!("{:?}", e.status),
                recorded_at: e.recorded_at,
                recorded_by: e.recorded_by.clone(),
                attestor: e.attestor.clone(),
                verified_at: e.verified_at,
                points_awarded: e.points_awarded,
                epoch: e.epoch,
                bond_status: e.bond_status.clone(),
            })
            .collect()
    }

    pub fn get_expenses(&self, asset_id: String) -> Vec<ExpenseEntryView> {
        self.asset(&asset_id)
            .expenses
            .iter()
            .map(|e| ExpenseEntryView {
                amount: U128(e.amount),
                recipient: e.recipient.clone(),
                description: e.description.clone(),
                category: e.category.clone(),
                recorded_at: e.recorded_at,
            })
            .collect()
    }

    pub fn get_distributions(&self, asset_id: String) -> Vec<DistributionRecordView> {
        self.distributions
            .get(&asset_id)
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(DistributionRecordView::from)
            .collect()
    }

    pub fn get_distribution(&self, asset_id: String, distribution_id: u64) -> DistributionRecordView {
        let records = self.distributions.get(&asset_id).cloned().unwrap_or_default();
        let record = records
            .iter()
            .find(|r| r.id == distribution_id)
            .expect("distribution not found");
        DistributionRecordView::from(record)
    }

    /// How one member's payout in one distribution was calculated, so
    /// any member can recompute it from the inputs.
    pub fn get_distribution_breakdown(
        &self,
        distribution_id: u64,
        account: AccountId,
    ) -> DistributionBreakdownView {
        let asset_id = self
            .distribution_asset
            .get(&distribution_id)
            .expect("distribution not found")
            .clone();
        let asset = self.asset(&asset_id);
        let records = self.distributions.get(&asset_id).cloned().unwrap_or_default();
        let record = records
            .iter()
            .find(|r| r.id == distribution_id)
            .expect("distribution not found");
        let allocation = asset
            .allocations
            .iter()
            .find(|(a, _)| *a == account)
            .map(|(_, bp)| *bp)
            .unwrap_or(0);
        let member_work_points = record
            .work_points_snapshot
            .iter()
            .find(|(a, _)| *a == account)
            .map(|(_, p)| *p)
            .unwrap_or(0);
        let ownership_payout = record
            .ownership_payouts
            .iter()
            .find(|(a, _)| *a == account)
            .map(|(_, p)| *p)
            .unwrap_or(0);
        let activity_payout = record
            .activity_payouts
            .iter()
            .find(|(a, _)| *a == account)
            .map(|(_, p)| *p)
            .unwrap_or(0);
        DistributionBreakdownView {
            distribution_id,
            asset_id,
            account,
            distributed: U128(record.distributed),
            member_total: U128(record.member_total),
            activity_pool: U128(record.activity_pool),
            ownership_pool: U128(record.ownership_pool),
            member_allocation_bp: allocation,
            member_work_points,
            total_work_points: record.total_work_points,
            ownership_payout: U128(ownership_payout),
            activity_payout: U128(activity_payout),
            total_payout: U128(ownership_payout + activity_payout),
        }
    }

    /// Activity state for one asset: current-epoch work points (what the
    /// next distribution splits by) and capital points (display only).
    pub fn get_activity(&self, asset_id: String) -> ActivityView {
        let asset = self.asset(&asset_id);
        let community = self.community(&asset.community_id);
        ActivityView {
            asset_id: asset.id.clone(),
            epoch: asset.epoch,
            work_points: asset
                .work
                .iter()
                .map(|(a, p)| {
                    (a.clone(), WorkPointsView { current: p.current, lifetime: p.lifetime })
                })
                .collect(),
            capital_points: community.capital_points,
        }
    }

    /// Current policies and the amendment history. A pending amendment
    /// past its deadline + 30 days is reported as Expired.
    pub fn get_policies(&self, community_id: String) -> PoliciesView {
        let c = self.community(&community_id);
        let now = env::block_timestamp();
        let amendments = c
            .amendments
            .iter()
            .map(|a| {
                let mut status = a.status.clone();
                if status == AmendmentStatus::Pending
                    && now > a.deadline + AMENDMENT_EXPIRY_NS
                {
                    status = AmendmentStatus::Expired;
                }
                AmendmentView {
                    id: a.id,
                    policy_type: a.policy_type.clone(),
                    new_params: a.new_params.clone(),
                    old_params: a.old_params.clone(),
                    proposed_at: a.proposed_at,
                    deadline: a.deadline,
                    status,
                }
            })
            .collect();
        PoliciesView {
            community_id: c.id.clone(),
            distribution: c.policy,
            spending: c.spending_policy,
            activity: c.activity_policy,
            dispute_window_ns: c.dispute_window_ns,
            timelock_ns: c.timelock_ns,
            amendments,
        }
    }

    pub fn get_stats(&self) -> StatsView {
        let mut total_treasury: u128 = 0;
        let mut total_revenue: u128 = 0;
        let mut total_payouts: u128 = 0;
        for id in self.community_ids.iter() {
            let c = self.community(id);
            total_treasury += treasury_balance(&c);
            total_revenue += c.total_revenue;
            total_payouts += c.total_payouts;
        }
        StatsView {
            community_count: self.community_ids.len() as u64,
            campaign_count: self.campaign_seq,
            asset_count: self.asset_seq,
            total_treasury: U128(total_treasury),
            total_revenue: U128(total_revenue),
            total_payouts: U128(total_payouts),
        }
    }

    pub fn list_communities(&self) -> Vec<String> {
        self.community_ids.iter().cloned().collect()
    }
}

// -- tests ---------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const DAO: &str = "lagos-dao.testnet";
    const SELLER: &str = "seller.testnet";
    const NEAR: u128 = ONE_NEAR;
    const T0: u64 = 1_000_000_000_000_000_000;
    const DEADLINE: u64 = T0 + 30 * 24 * 60 * 60 * 1_000_000_000;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, attached: u128, timestamp_ns: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(acc(predecessor))
            .current_account_id(acc("ownground.testnet"))
            .attached_deposit(NearToken::from_yoctonear(attached))
            .block_timestamp(timestamp_ns);
        b
    }

    fn members() -> Vec<AccountId> {
        vec![acc("alice.testnet"), acc("bob.testnet"), acc("carol.testnet"), acc("dave.testnet")]
    }

    /// The demo's founding distribution policy: 60/25/15, activity 10%.
    fn demo_distribution() -> DistributionPolicy {
        DistributionPolicy::new(6000, 2500, 1500)
    }

    /// The demo's founding spending policy: 1 NEAR cap, 1 NEAR reserve,
    /// maintenance + operations.
    fn demo_spending() -> SpendingPolicy {
        SpendingPolicy {
            max_single_expense: U128(NEAR),
            min_treasury_reserve: U128(NEAR),
            allowed_categories: vec!["maintenance".to_string(), "operations".to_string()],
        }
    }

    /// A spending policy with no cap and no reserve (for tests that need
    /// large expenses outside the demo policy).
    fn open_spending() -> SpendingPolicy {
        SpendingPolicy {
            max_single_expense: U128(0),
            min_treasury_reserve: U128(0),
            allowed_categories: vec!["maintenance".to_string(), "operations".to_string()],
        }
    }

    fn create_test_community(c: &mut Contract, id: &str) {
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            id.to_string(),
            "Lagos Energy Cooperative".to_string(),
            "Shared generator".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
    }

    /// A community with 4 members and a funded 10 NEAR generator campaign.
    /// Returns (contract, campaign_id).
    fn setup_funded() -> (Contract, String) {
        setup_funded_with(demo_spending())
    }

    fn setup_funded_with(spending: SpendingPolicy) -> (Contract, String) {
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            "lagos-energy".to_string(),
            "Lagos Energy Cooperative".to_string(),
            "Shared generator".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            spending,
            ActivityPolicy::default(),
            None,
            None,
        );
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign_id = c.create_campaign(
            "lagos-energy".to_string(),
            "Commercial generator".to_string(),
            "energy".to_string(),
            U128(10 * NEAR),
            DEADLINE,
        );
        for m in ["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet"] {
            testing_env!(ctx(m, 25 * NEAR / 10 + STORAGE_RECORD, T0).build());
            c.contribute(campaign_id.clone());
        }
        (c, campaign_id)
    }

    fn alloc_equal() -> Vec<(AccountId, u16)> {
        members().into_iter().map(|m| (m, 2500)).collect()
    }

    fn acquire(c: &mut Contract, campaign_id: &str) -> String {
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.acquire_asset(campaign_id.to_string(), acc(SELLER), alloc_equal())
    }

    #[test]
    fn create_community_fixed_membership_and_storage() {
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            "lagos-energy".to_string(),
            "Lagos Energy Cooperative".to_string(),
            "".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
        let v = c.get_community("lagos-energy".to_string());
        assert_eq!(v.members.len(), 4);
        assert_eq!(v.storage_reserve.0, STORAGE_CREATE_COMMUNITY);
        assert_eq!(v.policy.members_bp, 6000);
        assert_eq!(v.policy.activity_bp, 1000);
        assert_eq!(v.spending_policy.max_single_expense, U128(NEAR));
        assert_eq!(v.activity_policy.capital_per_near, 1);
    }

    #[test]
    #[should_panic(expected = "duplicate members")]
    fn create_community_rejects_duplicate_members() {
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            "x".to_string(),
            "X".to_string(),
            "".to_string(),
            acc(DAO),
            vec![acc("alice.testnet"), acc("alice.testnet")],
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "at least one member")]
    fn create_community_rejects_empty_members() {
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community("x".to_string(), "X".to_string(), "".to_string(), acc(DAO), vec![], demo_distribution(), demo_spending(), ActivityPolicy::default(), None, None);
    }

    #[test]
    #[should_panic(expected = "attached deposit must be exactly")]
    fn create_community_requires_exact_storage_deposit() {
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", 0, T0).build());
        c.create_community(
            "x".to_string(),
            "X".to_string(),
            "".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "not a community member")]
    fn create_campaign_requires_member() {
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            "lagos-energy".to_string(),
            "Lagos Energy Cooperative".to_string(),
            "".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
        testing_env!(ctx("outsider.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        c.create_campaign(
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            U128(10 * NEAR),
            DEADLINE,
        );
    }

    #[test]
    #[should_panic(expected = "target must be greater than zero")]
    fn create_campaign_rejects_zero_target() {
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            "lagos-energy".to_string(),
            "Lagos Energy Cooperative".to_string(),
            "".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        c.create_campaign(
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            U128(0),
            DEADLINE,
        );
    }

    #[test]
    fn contribute_caps_at_target_and_funds() {
        let (c, campaign_id) = setup_funded();
        let v = c.get_campaign(campaign_id);
        assert_eq!(v.raised.0, 10 * NEAR);
        assert_eq!(v.status, "Funded");
        assert_eq!(v.contributors.len(), 4);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.treasury.0, 10 * NEAR);
        assert_eq!(t.locked.0, 10 * NEAR);
        assert_eq!(t.spendable.0, 0);
    }

    #[test]
    #[should_panic(expected = "would exceed the target")]
    fn contribute_past_target_rejected() {
        // Campaign open at 7.5 of 10: a 5 NEAR contribution would exceed it.
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            "lagos-energy".to_string(),
            "Lagos Energy Cooperative".to_string(),
            "".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign_id = c.create_campaign(
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            U128(10 * NEAR),
            DEADLINE,
        );
        for m in ["alice.testnet", "bob.testnet", "carol.testnet"] {
            testing_env!(ctx(m, 25 * NEAR / 10 + STORAGE_RECORD, T0).build());
            c.contribute(campaign_id.clone());
        }
        testing_env!(ctx("dave.testnet", 5 * NEAR + STORAGE_RECORD, T0).build());
        c.contribute(campaign_id);
    }

    #[test]
    #[should_panic(expected = "deadline has passed")]
    fn contribute_after_deadline_rejected() {
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            "lagos-energy".to_string(),
            "Lagos Energy Cooperative".to_string(),
            "".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign_id = c.create_campaign(
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            U128(10 * NEAR),
            T0 + 100,
        );
        testing_env!(ctx("alice.testnet", NEAR + STORAGE_RECORD, T0 + 101).build());
        c.contribute(campaign_id);
    }

    #[test]
    #[should_panic(expected = "only the community DAO")]
    fn acquire_rejects_non_dao() {
        let (mut c, campaign_id) = setup_funded();
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.acquire_asset(campaign_id, acc(SELLER), alloc_equal());
    }

    #[test]
    #[should_panic(expected = "campaign is not funded")]
    fn acquire_rejects_unfunded_campaign() {
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            "lagos-energy".to_string(),
            "Lagos Energy Cooperative".to_string(),
            "".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign_id = c.create_campaign(
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            U128(10 * NEAR),
            DEADLINE,
        );
        testing_env!(ctx("alice.testnet", 5 * NEAR + STORAGE_RECORD, T0).build());
        c.contribute(campaign_id.clone());
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.acquire_asset(campaign_id, acc(SELLER), alloc_equal());
    }

    #[test]
    #[should_panic(expected = "must sum to exactly 10000")]
    fn acquire_rejects_bad_allocation() {
        let (mut c, campaign_id) = setup_funded();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.acquire_asset(
            campaign_id,
            acc(SELLER),
            vec![(acc("alice.testnet"), 5000), (acc("bob.testnet"), 4999)],
        );
    }

    #[test]
    #[should_panic(expected = "not a community member")]
    fn acquire_rejects_non_member_allocation() {
        let (mut c, campaign_id) = setup_funded();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.acquire_asset(
            campaign_id,
            acc(SELLER),
            vec![(acc("alice.testnet"), 5000), (acc("outsider.testnet"), 5000)],
        );
    }

    #[test]
    fn acquire_registers_asset_and_spends_treasury() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        let a = c.get_asset(asset_id);
        assert_eq!(a.value.0, 10 * NEAR);
        assert_eq!(a.seller, acc(SELLER));
        assert_eq!(a.status, "Active");
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.treasury.0, 0);
        assert_eq!(t.locked.0, 0);
        assert_eq!(t.total_acquisitions.0, 10 * NEAR);
        let camp = c.get_campaign(campaign_id);
        assert_eq!(camp.status, "Acquired");
    }

    #[test]
    #[should_panic(expected = "treasury does not hold the target")]
    fn acquire_treasury_check_is_enforced() {
        // Defense in depth: corrupt the counters so the treasury is below
        // the target while the campaign is funded. The lock guard makes
        // this unreachable through the public methods; the check must
        // still fire.
        let (mut c, campaign_id) = setup_funded();
        let mut community = c.community("lagos-energy");
        community.total_expenses = 5 * NEAR;
        c.save_community(&community);
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.acquire_asset(campaign_id, acc(SELLER), alloc_equal());
    }

    #[test]
    fn cancel_records_claims_and_claims_pay_out() {
        let (mut c, campaign_id) = setup_funded();
        // Cancel while funded: NO transfers are pushed. The full 10
        // NEAR is recorded as claimable refunds and counts as LOCKED
        // funds, so the treasury still shows 10 NEAR but spendable is
        // 0 — and total_refunds is still 0, because refunds count at
        // claim payment, not at cancel time.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.cancel_campaign(campaign_id.clone());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.treasury.0, 10 * NEAR);
        assert_eq!(t.locked.0, 10 * NEAR);
        assert_eq!(t.spendable.0, 0);
        assert_eq!(t.total_refunds.0, 0);
        let camp = c.get_campaign(campaign_id.clone());
        assert_eq!(camp.status, "Cancelled");
        assert_eq!(camp.refund_claims.len(), 4);
        // Second cancel is rejected.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.cancel_campaign(campaign_id.clone());
        }));
        assert!(result.is_err());
        // Each contributor claims their 2.5 NEAR; total_refunds grows
        // per claim and the treasury falls.
        for m in ["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet"] {
            testing_env!(ctx(m, STORAGE_RECORD, T0).build());
            c.claim_refund(campaign_id.clone());
        }
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.treasury.0, 0);
        assert_eq!(t.total_refunds.0, 10 * NEAR);
        assert_eq!(t.locked.0, 0);
        assert_eq!(t.spendable.0, 0);
        let camp = c.get_campaign(campaign_id.clone());
        assert!(camp.refund_claims.is_empty());
        // A second claim is rejected: nothing left to claim.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.claim_refund(campaign_id);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn expense_locked_funds_guard() {
        let (mut c, campaign_id) = setup_funded();
        // 6 NEAR expense while 10 NEAR is locked: rejected.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.pay_expense(
                "no-such-asset".to_string(),
                U128(6 * NEAR),
                acc("alice.testnet"),
                "fuel".to_string(),
                "operations".to_string(),
            );
        }));
        assert!(result.is_err(), "expense on a missing asset must fail");
        // Acquire, then record 3 NEAR revenue; 0.5 expense is allowed.
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(
            asset_id.clone(),
            U128(3 * NEAR),
            "rental".to_string(),
            "ref-1".to_string(),
        );
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id.clone(), U128(NEAR / 2), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.treasury.0, 25 * NEAR / 10);
        // A 4 NEAR expense now exceeds the 2.5 NEAR spendable: rejected.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.pay_expense(asset_id, U128(4 * NEAR), acc("bob.testnet"), "too much".to_string(), "operations".to_string());
        }));
        assert!(result.is_err());
    }

    #[test]
    #[should_panic(expected = "only the community DAO")]
    fn expense_rejects_non_dao() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id, U128(NEAR), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
    }

    #[test]
    fn revenue_onchain_requires_exact_attached() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        // Wrong attached deposit: rejected.
        testing_env!(ctx("alice.testnet", 3 * NEAR, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.record_revenue(
                asset_id.clone(),
                U128(3 * NEAR),
                "rental".to_string(),
                "".to_string(),
            );
        }));
        assert!(result.is_err());
        // Exact attached: accepted, treasury rises by 3.
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(
            asset_id.clone(),
            U128(3 * NEAR),
            "rental".to_string(),
            "inv-1".to_string(),
        );
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_revenue.0, 3 * NEAR);
        assert_eq!(t.treasury.0, 3 * NEAR);
        let entries = c.get_revenue(asset_id);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].status, "Onchain");
    }

    #[test]
    fn revenue_reported_member_only_and_no_money_moves() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        // Non-member cannot record reported revenue.
        testing_env!(ctx("outsider.testnet", STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.record_revenue(
                asset_id.clone(),
                U128(NEAR),
                "cash".to_string(),
                "rep-1".to_string(),
            );
        }));
        assert!(result.is_err());
        // Member can; no money moves and D ignores it. The entry is Pending.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(
            asset_id.clone(),
            U128(NEAR),
            "cash".to_string(),
            "rep-1".to_string(),
        );
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_revenue.0, 0);
        assert_eq!(t.treasury.0, 0);
        let entries = c.get_revenue(asset_id);
        assert_eq!(entries[0].status, "Pending");
        assert_eq!(entries[0].points_awarded, 0);
    }

    #[test]
    #[should_panic(expected = "evidence reference is required")]
    fn revenue_rejects_empty_reference() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id, U128(NEAR), "cash".to_string(), "".to_string());
    }

    #[test]
    #[should_panic(expected = "duplicate revenue reference")]
    fn revenue_rejects_duplicate_reference() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx("alice.testnet", NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id, U128(NEAR), "rental".to_string(), "inv-1".to_string());
    }

    #[test]
    fn onchain_revenue_awards_no_work_points() {
        // A deposit proves money moved, not that the asset earned it:
        // onchain revenue earns NO work points, for anyone. It still
        // counts as revenue money.
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        // 3 NEAR onchain by alice: 0 points.
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        // 0.5 NEAR onchain by bob: 0 points.
        testing_env!(ctx("bob.testnet", NEAR / 2 + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR / 2), "rental".to_string(), "inv-2".to_string());
        // A non-member may deposit onchain revenue but earns no points.
        testing_env!(ctx("outsider.testnet", NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "rental".to_string(), "inv-3".to_string());
        let activity = c.get_activity(asset_id.clone());
        assert!(activity
            .work_points
            .iter()
            .all(|(_, p)| p.current == 0 && p.lifetime == 0));
        // The entries record 0 points awarded.
        let entries = c.get_revenue(asset_id);
        assert!(entries.iter().all(|e| e.points_awarded == 0));
        assert!(entries.iter().all(|e| e.status == "Onchain"));
        // But the money still counts: 4.5 NEAR of revenue.
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_revenue.0, 45 * NEAR / 10);
        assert_eq!(t.treasury.0, 45 * NEAR / 10);
    }

    #[test]
    fn reported_revenue_earns_nothing_until_attested() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash".to_string(), "rep-1".to_string());
        let activity = c.get_activity(asset_id.clone());
        assert!(activity.work_points.iter().all(|(_, p)| p.current == 0));
        // A different member attests (bond + storage): bob earns 1 + 1 = 2.
        testing_env!(ctx("alice.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0).build());
        c.attest_revenue(asset_id.clone(), 0);
        let activity = c.get_activity(asset_id.clone());
        let work = |a: &str| activity.work_points.iter().find(|(x, _)| x.as_str() == a).map(|(_, p)| p.current).unwrap_or(0);
        assert_eq!(work("bob.testnet"), 2);
        assert_eq!(work("alice.testnet"), 0, "the attestor earns no points");
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_bonds_held.0, ATTESTATION_BOND);
        let entries = c.get_revenue(asset_id);
        assert_eq!(entries[0].status, "Verified");
        assert_eq!(entries[0].points_awarded, 2);
        assert_eq!(entries[0].attestor, Some(acc("alice.testnet")));
    }

    #[test]
    #[should_panic(expected = "self-attestation is rejected")]
    fn attestation_rejects_self_attestation() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash".to_string(), "rep-1".to_string());
        testing_env!(ctx("bob.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0).build());
        c.attest_revenue(asset_id, 0);
    }

    #[test]
    #[should_panic(expected = "only a pending entry can be attested")]
    fn attestation_rejects_double_attestation() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash".to_string(), "rep-1".to_string());
        testing_env!(ctx("alice.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0).build());
        c.attest_revenue(asset_id.clone(), 0);
        testing_env!(ctx("carol.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0).build());
        c.attest_revenue(asset_id, 0);
    }

    #[test]
    #[should_panic(expected = "not a community member")]
    fn attestation_rejects_non_member() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash".to_string(), "rep-1".to_string());
        testing_env!(ctx("outsider.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0).build());
        c.attest_revenue(asset_id, 0);
    }

    #[test]
    #[should_panic(expected = "attestation must attach the 0.1 NEAR bond")]
    fn attestation_requires_bond() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash".to_string(), "rep-1".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.attest_revenue(asset_id, 0);
    }

    // -- Policy amendments -------------------------------------------------

    fn propose_spending(c: &mut Contract, cap: u128, reserve: u128) -> u64 {
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.propose_policy_change(
            "lagos-energy".to_string(),
            PolicyType::Spending,
            PolicyParams::Spending {
                max_single_expense: U128(cap),
                min_treasury_reserve: U128(reserve),
                allowed_categories: vec!["maintenance".to_string(), "operations".to_string()],
            },
        )
    }

    fn execute_amendment(c: &mut Contract, id: u64, at: u64) {
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, at).build());
        c.execute_policy_change("lagos-energy".to_string(), id);
    }

    #[test]
    #[should_panic(expected = "only the community DAO")]
    fn amendment_propose_requires_dao() {
        let (mut c, _) = setup_funded();
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.propose_policy_change(
            "lagos-energy".to_string(),
            PolicyType::Spending,
            PolicyParams::Spending {
                max_single_expense: U128(2 * NEAR),
                min_treasury_reserve: U128(NEAR),
                allowed_categories: vec!["operations".to_string()],
            },
        );
    }

    #[test]
    #[should_panic(expected = "must sum to exactly 10000")]
    fn amendment_rejects_invalid_distribution_params() {
        let (mut c, _) = setup_funded();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.propose_policy_change(
            "lagos-energy".to_string(),
            PolicyType::Distribution,
            PolicyParams::Distribution { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1501, activity_bp: 1000 },
        );
    }

    #[test]
    #[should_panic(expected = "activity_bp must be between 0 and 10000")]
    fn amendment_rejects_activity_bp_over_10000() {
        let (mut c, _) = setup_funded();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.propose_policy_change(
            "lagos-energy".to_string(),
            PolicyType::Distribution,
            PolicyParams::Distribution { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 10_001 },
        );
    }

    #[test]
    #[should_panic(expected = "policy type and parameters do not match")]
    fn amendment_rejects_mismatched_params() {
        let (mut c, _) = setup_funded();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.propose_policy_change(
            "lagos-energy".to_string(),
            PolicyType::Distribution,
            PolicyParams::Spending {
                max_single_expense: U128(NEAR),
                min_treasury_reserve: U128(0),
                allowed_categories: vec!["operations".to_string()],
            },
        );
    }

    #[test]
    #[should_panic(expected = "timelock has not passed yet")]
    fn amendment_execute_before_deadline_rejected() {
        let (mut c, _) = setup_funded();
        let id = propose_spending(&mut c, 2 * NEAR, NEAR);
        execute_amendment(&mut c, id, T0);
    }

    #[test]
    fn amendment_execute_after_deadline_applies() {
        let (mut c, _) = setup_funded();
        let id = propose_spending(&mut c, 2 * NEAR, NEAR);
        // Anyone may execute after the deadline (that is the anti-deadlock
        // rule: execution is permissionless, proposal and cancel are DAO).
        execute_amendment(&mut c, id, T0 + 4 * 24 * 60 * 60 * 1_000_000_000);
        let p = c.get_policies("lagos-energy".to_string());
        assert_eq!(p.spending.max_single_expense, U128(2 * NEAR));
        assert_eq!(p.amendments.len(), 1);
        assert_eq!(p.amendments[0].status, AmendmentStatus::Executed);
        assert_eq!(p.amendments[0].policy_type, PolicyType::Spending);
    }

    #[test]
    #[should_panic(expected = "amendment expired")]
    fn amendment_execute_after_expiry_rejected() {
        let (mut c, _) = setup_funded();
        let id = propose_spending(&mut c, 2 * NEAR, NEAR);
        // Deadline is T0 + 3 days; expiry is 30 days after that.
        execute_amendment(&mut c, id, T0 + 34 * 24 * 60 * 60 * 1_000_000_000);
    }

    #[test]
    fn amendment_expiry_reported_by_view() {
        let (mut c, _) = setup_funded();
        let _id = propose_spending(&mut c, 2 * NEAR, NEAR);
        let p = c.get_policies("lagos-energy".to_string());
        assert_eq!(p.amendments[0].status, AmendmentStatus::Pending);
        // Read the policies after the expiry point: the view reports Expired.
        testing_env!(ctx("alice.testnet", 0, T0 + 34 * 24 * 60 * 60 * 1_000_000_000).build());
        let p = c.get_policies("lagos-energy".to_string());
        assert_eq!(p.amendments[0].status, AmendmentStatus::Expired);
    }

    #[test]
    fn amendment_cancel_by_dao() {
        let (mut c, _) = setup_funded();
        let id = propose_spending(&mut c, 2 * NEAR, NEAR);
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.cancel_policy_change("lagos-energy".to_string(), id);
        let p = c.get_policies("lagos-energy".to_string());
        assert_eq!(p.amendments[0].status, AmendmentStatus::Cancelled);
        assert_eq!(p.spending.max_single_expense, U128(NEAR), "the old policy stays in force");
        // Executing a cancelled amendment is rejected.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            execute_amendment(&mut c, id, T0 + 4 * 24 * 60 * 60 * 1_000_000_000);
        }));
        assert!(result.is_err());
    }

    #[test]
    #[should_panic(expected = "only the community DAO")]
    fn amendment_cancel_requires_dao() {
        let (mut c, _) = setup_funded();
        let id = propose_spending(&mut c, 2 * NEAR, NEAR);
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.cancel_policy_change("lagos-energy".to_string(), id);
    }

    #[test]
    fn amendment_superseded_by_newer_proposal() {
        let (mut c, _) = setup_funded();
        let first = propose_spending(&mut c, 2 * NEAR, NEAR);
        let second = propose_spending(&mut c, 3 * NEAR, NEAR);
        let p = c.get_policies("lagos-energy".to_string());
        assert_eq!(p.amendments[first as usize].status, AmendmentStatus::Superseded);
        assert_eq!(p.amendments[second as usize].status, AmendmentStatus::Pending);
        // The superseded amendment can no longer execute.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            execute_amendment(&mut c, first, T0 + 4 * 24 * 60 * 60 * 1_000_000_000);
        }));
        assert!(result.is_err());
        // The newer one executes and applies.
        execute_amendment(&mut c, second, T0 + 4 * 24 * 60 * 60 * 1_000_000_000);
        let p = c.get_policies("lagos-energy".to_string());
        assert_eq!(p.spending.max_single_expense, U128(3 * NEAR));
    }

    #[test]
    fn amendment_old_policy_stays_in_force_while_pending() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        // Propose raising the cap from 1 to 2 NEAR. While pending, the old
        // 1 NEAR cap still binds even the DAO.
        let id = propose_spending(&mut c, 2 * NEAR, NEAR);
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.pay_expense(asset_id.clone(), U128(2 * NEAR), acc("bob.testnet"), "repairs".to_string(), "maintenance".to_string());
        }));
        assert!(result.is_err());
        // Execute after the timelock: the same expense now succeeds.
        execute_amendment(&mut c, id, T0 + 4 * 24 * 60 * 60 * 1_000_000_000);
        testing_env!(ctx(DAO, STORAGE_RECORD, T0 + 4 * 24 * 60 * 60 * 1_000_000_000).build());
        c.pay_expense(asset_id, U128(2 * NEAR), acc("bob.testnet"), "repairs".to_string(), "maintenance".to_string());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_expenses.0, 2 * NEAR);
    }

    // -- Distributions (final model: work points only) ---------------------

    #[test]
    fn distribution_exact_payouts_and_one_shot() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id.clone(), U128(NEAR / 2), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
        // Founding policy is 60/25/15, activity 10%. No set call exists.
        // Execute: D = 2.5, M = 1.5. The 3 NEAR was an onchain deposit,
        // so nobody holds work points: the activity slice falls back
        // to ownership (activity pool 0, ownership pool 1.5) and each
        // of the four equal owners gets 0.375.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view = c.execute_distribution(asset_id.clone());
        assert_eq!(view.distributed.0, 25 * NEAR / 10);
        assert_eq!(view.member_total.0, 15 * NEAR / 10);
        assert_eq!(view.retention.0, 625 * NEAR / 1000);
        assert_eq!(view.maintenance.0, 375 * NEAR / 1000);
        let payout_of = |a: &str| view.payouts.iter().find(|(x, _)| x.as_str() == a).unwrap().1 .0;
        assert_eq!(payout_of("alice.testnet"), 375_000_000_000_000_000_000_000u128);
        assert_eq!(payout_of("bob.testnet"), 375_000_000_000_000_000_000_000u128);
        // Ownership and activity parts are separate in the record.
        let act = |a: &str| view.activity_payouts.iter().find(|(x, _)| x.as_str() == a).map(|(_, p)| p.0).unwrap_or(0);
        assert_eq!(act("alice.testnet"), 0);
        assert_eq!(act("bob.testnet"), 0);
        assert_eq!(view.activity_pool.0, 0);
        assert_eq!(view.ownership_pool.0, 1_500_000_000_000_000_000_000_000u128);
        assert_eq!(view.total_work_points, 0);
        assert_eq!(
            view.member_total.0 + view.retention.0 + view.maintenance.0,
            view.distributed.0
        );
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.treasury.0, NEAR);
        assert_eq!(t.total_payouts.0, 15 * NEAR / 10);
        assert_eq!(t.total_distributed.0, 25 * NEAR / 10);
        assert_eq!(t.retained.0, NEAR);
        // Second call with no new revenue: D = 0, rejected.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.execute_distribution(asset_id.clone());
        }));
        assert!(result.is_err());
        // New revenue 1 NEAR by alice (onchain deposit: still 0 work
        // points). The second distribution splits D = 1 by ownership
        // only: each member 0.15.
        testing_env!(ctx("alice.testnet", NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "rental".to_string(), "inv-2".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view2 = c.execute_distribution(asset_id);
        assert_eq!(view2.distributed.0, NEAR);
        assert_eq!(view2.member_total.0, 6 * NEAR / 10);
        let payout2 = |a: &str| view2.payouts.iter().find(|(x, _)| x.as_str() == a).unwrap().1 .0;
        assert_eq!(payout2("alice.testnet"), 150_000_000_000_000_000_000_000u128);
        assert_eq!(payout2("bob.testnet"), 150_000_000_000_000_000_000_000u128);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_payouts.0, 21 * NEAR / 10);
        assert_eq!(t.treasury.0, 14 * NEAR / 10);
        assert_eq!(t.retained.0, 14 * NEAR / 10);
    }

    #[test]
    fn distribution_multi_asset_cap_keeps_policy() {
        // Case E: two assets, asset 1 revenue 10, asset 2 expense 5.
        // The 5 NEAR expense needs the open (uncapped) spending policy.
        let (mut c, campaign1) = setup_funded_with(open_spending());
        let asset1 = acquire(&mut c, &campaign1);
        // Second campaign + asset.
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign2 = c.create_campaign(
            "lagos-energy".to_string(),
            "Van".to_string(),
            "transport".to_string(),
            U128(10 * NEAR),
            DEADLINE,
        );
        for m in ["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet"] {
            testing_env!(ctx(m, 25 * NEAR / 10 + STORAGE_RECORD, T0).build());
            c.contribute(campaign2.clone());
        }
        let asset2 = acquire(&mut c, &campaign2);
        // Revenue 10 on asset 1 (onchain deposit: 0 work points),
        // expense 5 on asset 2.
        testing_env!(ctx("alice.testnet", 10 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset1.clone(), U128(10 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset2, U128(5 * NEAR), acc("bob.testnet"), "repairs".to_string(), "maintenance".to_string());
        // D_asset1 = 10, but only 5 is available and community net is 5.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view = c.execute_distribution(asset1.clone());
        assert_eq!(view.distributed.0, 5 * NEAR);
        // No work points stand, so the whole 3 NEAR member pool goes by
        // ownership: each of the four equal owners gets 0.75.
        let payout_of = |a: &str| view.payouts.iter().find(|(x, _)| x.as_str() == a).unwrap().1 .0;
        assert_eq!(payout_of("alice.testnet"), 750_000_000_000_000_000_000_000u128);
        assert_eq!(payout_of("bob.testnet"), 750_000_000_000_000_000_000_000u128);
        assert_eq!(view.member_total.0, 3 * NEAR);
        // Second call: community net exhausted -> D = 0, rejected.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.execute_distribution(asset1);
        }));
        assert!(result.is_err());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_payouts.0, 3 * NEAR);
        assert!(t.treasury.0 >= 0);
    }

    #[test]
    fn full_demo_flow() {
        // The 15-step Lagos Energy Cooperative flow, end to end, under
        // the final model (work points only, attested reported revenue).
        let (mut c, campaign_id) = setup_funded();
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.treasury.0, 10 * NEAR);
        assert_eq!(t.locked.0, 10 * NEAR);
        let asset_id = acquire(&mut c, &campaign_id);
        let a = c.get_asset(asset_id.clone());
        assert_eq!(a.value.0, 10 * NEAR);
        assert_eq!(a.allocations.len(), 4);
        assert_eq!(a.epoch, 0);
        // 3 NEAR onchain revenue by alice: a deposit, so 0 work points.
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "generator rental".to_string(), "invoice-001".to_string());
        // 1 NEAR reported revenue by bob, attested by alice: bob earns
        // 2 work points; alice (attestor) earns none; bond held.
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash rental".to_string(), "invoice-002".to_string());
        testing_env!(ctx("alice.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0).build());
        c.attest_revenue(asset_id.clone(), 1);
        // 0.5 NEAR DAO-approved expense, inside the 1 NEAR cap.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id.clone(), U128(NEAR / 2), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view = c.execute_distribution(asset_id.clone());
        assert_eq!(view.distributed.0, 25 * NEAR / 10);
        // Bob holds the only work points (2), so he takes the whole
        // 0.15 activity pool: alice 0.3375, bob 0.4875, carol and dave
        // 0.3375 each.
        let payout_of = |a: &str| view.payouts.iter().find(|(x, _)| x.as_str() == a).unwrap().1 .0;
        assert_eq!(payout_of("alice.testnet"), 337_500_000_000_000_000_000_000u128);
        assert_eq!(payout_of("bob.testnet"), 487_500_000_000_000_000_000_000u128);
        assert_eq!(payout_of("carol.testnet"), 337_500_000_000_000_000_000_000u128);
        assert_eq!(payout_of("dave.testnet"), 337_500_000_000_000_000_000_000u128);
        assert_eq!(view.member_total.0, 15 * NEAR / 10);
        assert_eq!(view.retention.0, 625 * NEAR / 1000);
        assert_eq!(view.maintenance.0, 375 * NEAR / 1000);
        // Final treasury: 10 + 3 - 10 - 0.5 - 1.5 = 1.0 NEAR exactly.
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.treasury.0, NEAR);
        assert_eq!(t.total_contributions.0, 10 * NEAR);
        assert_eq!(t.total_revenue.0, 3 * NEAR);
        assert_eq!(t.total_acquisitions.0, 10 * NEAR);
        assert_eq!(t.total_expenses.0, NEAR / 2);
        assert_eq!(t.total_payouts.0, 15 * NEAR / 10);
        assert_eq!(t.total_refunds.0, 0);
        assert_eq!(t.retained.0, NEAR);
        assert_eq!(t.distributable.0, 0);
        assert_eq!(t.total_bonds_held.0, ATTESTATION_BOND);
        // Invariant 1: deposits - spent = treasury.
        let deposits = t.total_contributions.0 + t.total_revenue.0;
        let spent = t.total_acquisitions.0 + t.total_expenses.0 + t.total_payouts.0 + t.total_refunds.0;
        assert_eq!(deposits - spent, t.treasury.0);
        // One distribution record exists for the asset; epoch advanced
        // and the current work points reset, lifetimes kept.
        assert_eq!(c.get_distributions(asset_id.clone()).len(), 1);
        let activity = c.get_activity(asset_id.clone());
        assert_eq!(activity.epoch, 1);
        assert!(activity.work_points.iter().all(|(_, p)| p.current == 0));
        let lifetime = |a: &str| activity.work_points.iter().find(|(x, _)| x.as_str() == a).map(|(_, p)| p.lifetime).unwrap_or(0);
        assert_eq!(lifetime("alice.testnet"), 0, "onchain deposits earn no lifetime points");
        assert_eq!(lifetime("bob.testnet"), 2);
        // The breakdown view lets any member recompute their payout.
        let b = c.get_distribution_breakdown(0, acc("alice.testnet"));
        assert_eq!(b.distributed.0, 25 * NEAR / 10);
        assert_eq!(b.member_total.0, 15 * NEAR / 10);
        assert_eq!(b.activity_pool.0, 150_000_000_000_000_000_000_000u128);
        assert_eq!(b.ownership_pool.0, 1_350_000_000_000_000_000_000_000u128);
        assert_eq!(b.member_allocation_bp, 2500);
        assert_eq!(b.member_work_points, 0);
        assert_eq!(b.total_work_points, 2);
        assert_eq!(b.ownership_payout.0, 337_500_000_000_000_000_000_000u128);
        assert_eq!(b.activity_payout.0, 0);
        assert_eq!(b.total_payout.0, 337_500_000_000_000_000_000_000u128);
        let bb = c.get_distribution_breakdown(0, acc("bob.testnet"));
        assert_eq!(bb.member_work_points, 2);
        assert_eq!(bb.ownership_payout.0, 337_500_000_000_000_000_000_000u128);
        assert_eq!(bb.activity_payout.0, 150_000_000_000_000_000_000_000u128);
        assert_eq!(bb.total_payout.0, 487_500_000_000_000_000_000_000u128);
        let stats = c.get_stats();
        assert_eq!(stats.community_count, 1);
        assert_eq!(stats.campaign_count, 1);
        assert_eq!(stats.asset_count, 1);
    }

    #[test]
    fn distribution_tiny_amounts_are_exact() {
        // D = 7 yocto: M = 4, retention = 2, maintenance = 1.
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 7 + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(7), "dust".to_string(), "inv-1".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view = c.execute_distribution(asset_id);
        assert_eq!(view.distributed.0, 7);
        assert_eq!(view.member_total.0, 4);
        assert_eq!(view.retention.0, 2);
        assert_eq!(view.maintenance.0, 1);
        assert_eq!(view.member_total.0 + view.retention.0 + view.maintenance.0, 7);
    }

    #[test]
    fn distribution_one_yocto_goes_to_retention() {
        // D = 1 yocto: every floor is 0, the whole yocto is retention.
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 1 + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(1), "dust".to_string(), "inv-1".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view = c.execute_distribution(asset_id);
        assert_eq!(view.distributed.0, 1);
        assert_eq!(view.member_total.0, 0);
        assert_eq!(view.retention.0, 1);
        assert_eq!(view.maintenance.0, 0);
    }

    #[test]
    fn distribution_zero_work_points_falls_back_to_ownership() {
        // Revenue deposited by a non-member earns no work points, so the
        // whole member pool goes by ownership.
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("outsider.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view = c.execute_distribution(asset_id);
        assert_eq!(view.distributed.0, 3 * NEAR);
        assert_eq!(view.member_total.0, 18 * NEAR / 10);
        assert!(view.payouts.iter().all(|(_, p)| p.0 == 45 * NEAR / 100));
        assert_eq!(view.activity_pool.0, 0);
        assert_eq!(view.total_work_points, 0);
    }

    #[test]
    fn circular_farming_loses_money_and_epochs_reset() {
        // Alice deposits 3 NEAR of revenue and cycles it: an onchain
        // deposit earns no work points, so she recovers only her 25%
        // ownership share of the member pool (0.45), far less than the
        // 3 NEAR deposit.
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view = c.execute_distribution(asset_id.clone());
        let alice_first = view.payouts.iter().find(|(x, _)| x.as_str() == "alice.testnet").unwrap().1 .0;
        assert_eq!(alice_first, 450_000_000_000_000_000_000_000u128);
        assert!(alice_first < 3 * NEAR, "cycling capital must lose money");
        // Epoch reset: the epoch advanced and the current points are 0.
        // New verified activity by bob only, in the new epoch: bob
        // deposits 1 NEAR onchain (the money for D = 1) and records
        // 1 NEAR reported revenue, attested by alice, earning 2 fresh
        // work points. The next distribution's activity slice goes to
        // bob alone, and alice gets ownership only.
        let activity = c.get_activity(asset_id.clone());
        assert_eq!(activity.epoch, 1);
        assert!(activity.work_points.iter().all(|(_, p)| p.current == 0));
        testing_env!(ctx("bob.testnet", NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "rental".to_string(), "inv-2".to_string());
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash".to_string(), "rep-1".to_string());
        testing_env!(ctx("alice.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0).build());
        c.attest_revenue(asset_id.clone(), 2);
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view2 = c.execute_distribution(asset_id);
        let act2 = |a: &str| view2.activity_payouts.iter().find(|(x, _)| x.as_str() == a).map(|(_, p)| p.0).unwrap_or(0);
        assert_eq!(act2("alice.testnet"), 0, "past-epoch points do not carry over");
        assert_eq!(act2("bob.testnet"), 60_000_000_000_000_000_000_000u128);
        let total2 = |a: &str| view2.payouts.iter().find(|(x, _)| x.as_str() == a).unwrap().1 .0;
        assert_eq!(total2("alice.testnet"), 135_000_000_000_000_000_000_000u128);
        assert_eq!(total2("bob.testnet"), 195_000_000_000_000_000_000_000u128);
    }

    #[test]
    fn failed_payout_reconciled_and_repaid_later() {
        // Simulate a failed transfer by calling the reconciliation
        // directly (the mock blockchain carries no promise results).
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id.clone(), U128(NEAR / 2), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view = c.execute_distribution(asset_id.clone());
        assert_eq!(view.id, 0);
        // Alice's 0.375 NEAR transfer fails: reconcile it. (No work
        // points stand — the revenue was an onchain deposit — so each
        // of the four equal owners gets 0.375.)
        c.reconcile_failed_payout(0, acc("alice.testnet"), 375_000_000_000_000_000_000_000u128);
        let record = c.get_distribution(asset_id.clone(), 0);
        assert_eq!(record.unpaid, vec![acc("alice.testnet")]);
        assert_eq!(record.member_total.0, 15 * NEAR / 10, "the recorded totals never change");
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_payouts.0, 15 * NEAR / 10 - 375_000_000_000_000_000_000_000u128);
        // The credited-back amount is distributable again.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let view2 = c.execute_distribution(asset_id);
        assert_eq!(view2.distributed.0, 375_000_000_000_000_000_000_000u128);
    }

    #[test]
    fn payout_callback_with_no_results_is_a_noop() {
        // The mock blockchain carries no promise results, so the
        // callback returns without reconciling anything.
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.execute_distribution(asset_id);
        // Callbacks are private: only the contract itself may call them.
        testing_env!(ctx("ownground.testnet", 0, T0).build());
        c.on_payout_complete(0, acc("alice.testnet"), U128(450_000_000_000_000_000_000_000u128));
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_payouts.0, 18 * NEAR / 10);
    }

    // -- Spending policy (founding policy; DAO-bound) -----------------------

    fn setup_with_spending_policy() -> (Contract, String) {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        (c, asset_id)
    }

    #[test]
    fn spending_policy_allows_an_expense_inside_all_rules() {
        let (mut c, asset_id) = setup_with_spending_policy();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id, U128(NEAR / 2), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_expenses.0, NEAR / 2);
    }

    #[test]
    #[should_panic(expected = "expense exceeds max_single_expense")]
    fn spending_policy_rejects_over_cap_expense() {
        // The DAO itself is the caller: the policy binds the DAO too.
        let (mut c, asset_id) = setup_with_spending_policy();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id, U128(2 * NEAR), acc("bob.testnet"), "big repair".to_string(), "maintenance".to_string());
    }

    #[test]
    #[should_panic(expected = "expense would breach min_treasury_reserve")]
    fn spending_policy_rejects_below_reserve_expense() {
        // Uncapped but with a 1 NEAR reserve: a 2.5 NEAR expense would
        // leave 0.5 NEAR of the 3 NEAR unlocked treasury.
        let (mut c, campaign_id) = setup_funded_with(SpendingPolicy {
            max_single_expense: U128(0),
            min_treasury_reserve: U128(NEAR),
            allowed_categories: vec!["maintenance".to_string(), "operations".to_string()],
        });
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id, U128(25 * NEAR / 10), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
    }

    #[test]
    #[should_panic(expected = "expense category not allowed")]
    fn spending_policy_rejects_disallowed_category() {
        let (mut c, asset_id) = setup_with_spending_policy();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id, U128(NEAR / 2), acc("bob.testnet"), "ads".to_string(), "marketing".to_string());
    }

    #[test]
    fn spending_policy_zero_cap_means_uncapped() {
        let (mut c, campaign_id) = setup_funded_with(open_spending());
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id, U128(25 * NEAR / 10), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_expenses.0, 25 * NEAR / 10);
    }

    #[test]
    fn spending_policy_does_not_cap_acquisitions() {
        // The 10 NEAR acquisition is far above the 1 NEAR expense cap and
        // must still succeed: the cap binds expenses, not acquisitions.
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        assert_eq!(c.get_asset(asset_id).value.0, 10 * NEAR);
    }

    #[test]
    fn failed_expense_does_not_change_the_policy() {
        // A DAO expense proposal cannot change the policy in force: the
        // failed spend leaves the spending policy exactly as it was.
        let (mut c, asset_id) = setup_with_spending_policy();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.pay_expense(asset_id.clone(), U128(2 * NEAR), acc("bob.testnet"), "repairs".to_string(), "maintenance".to_string());
        }));
        assert!(result.is_err());
        let p = c.get_policies("lagos-energy".to_string());
        assert_eq!(p.spending.max_single_expense, U128(NEAR));
        assert_eq!(p.spending.min_treasury_reserve, U128(NEAR));
    }

    // -- Capital points ------------------------------------------------------

    #[test]
    fn capital_points_whole_near() {
        let (c, _) = setup_funded();
        let v = c.get_community("lagos-energy".to_string());
        // Each member contributed 2.5 NEAR: 2 capital points each.
        assert_eq!(v.capital_points.len(), 4);
        assert!(v.capital_points.iter().all(|(_, p)| *p == 2));
    }

    #[test]
    fn capital_points_no_gain_from_splitting() {
        // One member contributes 0.5 NEAR five times (2.5 total) and
        // another contributes 2.5 NEAR once: both hold 2 points. A single
        // 0.5 NEAR contribution earns 0 (sub-1-NEAR cumulative).
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            "lagos-energy".to_string(),
            "Lagos Energy Cooperative".to_string(),
            "".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign_id = c.create_campaign(
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            U128(10 * NEAR),
            DEADLINE,
        );
        for _ in 0..5 {
            testing_env!(ctx("alice.testnet", NEAR / 2 + STORAGE_RECORD, T0).build());
            c.contribute(campaign_id.clone());
        }
        testing_env!(ctx("bob.testnet", 25 * NEAR / 10 + STORAGE_RECORD, T0).build());
        c.contribute(campaign_id.clone());
        testing_env!(ctx("carol.testnet", NEAR / 2 + STORAGE_RECORD, T0).build());
        c.contribute(campaign_id);
        let v = c.get_community("lagos-energy".to_string());
        let points = |a: &str| v.capital_points.iter().find(|(x, _)| x.as_str() == a).unwrap().1;
        assert_eq!(points("alice.testnet"), 2);
        assert_eq!(points("bob.testnet"), 2);
        assert_eq!(points("carol.testnet"), 0);
    }

    #[test]
    fn activity_policy_weights_change_points() {
        // Custom founding activity policy: 2 capital points per NEAR,
        // 3 record points + 2 per NEAR of verified revenue.
        let mut c = Contract::new();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            "lagos-energy".to_string(),
            "Lagos Energy Cooperative".to_string(),
            "".to_string(),
            acc(DAO),
            members(),
            demo_distribution(),
            demo_spending(),
            ActivityPolicy { capital_per_near: 2, work_per_revenue_record: 3, work_per_revenue_near: 2 },
            None,
            None,
        );
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign_id = c.create_campaign(
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            U128(25 * NEAR / 10),
            DEADLINE,
        );
        testing_env!(ctx("alice.testnet", 25 * NEAR / 10 + STORAGE_RECORD, T0).build());
        c.contribute(campaign_id.clone());
        let asset_id = acquire(&mut c, &campaign_id);
        // Alice records 3 NEAR reported revenue; bob attests it, so
        // alice earns 3 + 2 x 3 = 9 work points under the custom
        // weights. (An onchain deposit would earn 0.)
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx("bob.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0).build());
        c.attest_revenue(asset_id.clone(), 0);
        let v = c.get_community("lagos-energy".to_string());
        // 2.5 NEAR contributed: floor(2.5) = 2 whole NEAR x 2 = 4 points.
        assert_eq!(v.capital_points.iter().find(|(x, _)| x.as_str() == "alice.testnet").unwrap().1, 4);
        let activity = c.get_activity(asset_id);
        let work = activity.work_points.iter().find(|(x, _)| x.as_str() == "alice.testnet").unwrap().1.current;
        // 3 NEAR verified: 3 + 2 x 3 = 9 work points.
        assert_eq!(work, 9);
    }

    #[test]
    fn distribution_policy_default_activity_is_ten_percent() {
        let (c, _) = setup_funded();
        let v = c.get_community("lagos-energy".to_string());
        assert_eq!(v.policy.members_bp, 6000);
        assert_eq!(v.policy.treasury_bp, 2500);
        assert_eq!(v.policy.maintenance_bp, 1500);
        assert_eq!(v.policy.activity_bp, 1000);
    }

    // -- Disputes and bonds --------------------------------------------------

    fn setup_attested() -> (Contract, String) {
        // Bob records 1 NEAR reported revenue; alice attests it at T0.
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash".to_string(), "rep-1".to_string());
        testing_env!(ctx("alice.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0).build());
        c.attest_revenue(asset_id.clone(), 0);
        (c, asset_id)
    }

    #[test]
    #[should_panic(expected = "the recorder cannot dispute")]
    fn dispute_rejects_recorder() {
        let (mut c, asset_id) = setup_attested();
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.dispute_revenue(asset_id, 0);
    }

    #[test]
    #[should_panic(expected = "the attestor cannot dispute")]
    fn dispute_rejects_attestor() {
        let (mut c, asset_id) = setup_attested();
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.dispute_revenue(asset_id, 0);
    }

    #[test]
    #[should_panic(expected = "not a community member")]
    fn dispute_rejects_non_member() {
        let (mut c, asset_id) = setup_attested();
        testing_env!(ctx("outsider.testnet", STORAGE_RECORD, T0).build());
        c.dispute_revenue(asset_id, 0);
    }

    #[test]
    #[should_panic(expected = "only a verified entry can be disputed")]
    fn dispute_rejects_pending_entry() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash".to_string(), "rep-1".to_string());
        testing_env!(ctx("carol.testnet", STORAGE_RECORD, T0).build());
        c.dispute_revenue(asset_id, 0);
    }

    #[test]
    #[should_panic(expected = "only a verified entry can be disputed")]
    fn dispute_rejects_onchain_entry() {
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("alice.testnet", NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx("carol.testnet", STORAGE_RECORD, T0).build());
        c.dispute_revenue(asset_id, 0);
    }

    #[test]
    #[should_panic(expected = "dispute window has passed")]
    fn dispute_after_window_rejected() {
        let (mut c, asset_id) = setup_attested();
        // Dispute window is 7 days from attestation (T0).
        testing_env!(ctx("carol.testnet", STORAGE_RECORD, T0 + 8 * 24 * 60 * 60 * 1_000_000_000).build());
        c.dispute_revenue(asset_id, 0);
    }

    #[test]
    fn dispute_upheld_removes_points_and_bond_goes_to_treasury() {
        let (mut c, asset_id) = setup_attested();
        // Carol disputes within the window: bob's 2 points are suspended.
        testing_env!(ctx("carol.testnet", STORAGE_RECORD, T0 + 24 * 60 * 60 * 1_000_000_000).build());
        c.dispute_revenue(asset_id.clone(), 0);
        let activity = c.get_activity(asset_id.clone());
        let work = activity.work_points.iter().find(|(x, _)| x.as_str() == "bob.testnet").map(|(_, p)| p.current).unwrap_or(0);
        assert_eq!(work, 0, "disputed points are suspended");
        let entries = c.get_revenue(asset_id.clone());
        assert_eq!(entries[0].status, "Disputed");
        // The DAO upholds the dispute: entry rejected, bond to treasury.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0 + 2 * 24 * 60 * 60 * 1_000_000_000).build());
        c.resolve_dispute(asset_id.clone(), 0, true);
        let entries = c.get_revenue(asset_id.clone());
        assert_eq!(entries[0].status, "Rejected");
        assert_eq!(entries[0].bond_status, Some(BondStatus::Forfeited));
        let activity = c.get_activity(asset_id.clone());
        let work = activity.work_points.iter().find(|(x, _)| x.as_str() == "bob.testnet").map(|(_, p)| p.current).unwrap_or(0);
        assert_eq!(work, 0, "the points stay removed");
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_bonds_held.0, 0);
        assert_eq!(t.total_revenue.0, ATTESTATION_BOND, "the forfeited bond is treasury revenue");
        assert_eq!(t.treasury.0, ATTESTATION_BOND);
    }

    #[test]
    fn dispute_rejected_restores_points_and_returns_bond() {
        let (mut c, asset_id) = setup_attested();
        testing_env!(ctx("carol.testnet", STORAGE_RECORD, T0 + 24 * 60 * 60 * 1_000_000_000).build());
        c.dispute_revenue(asset_id.clone(), 0);
        // The DAO rejects the dispute: verification stands, points return.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0 + 2 * 24 * 60 * 60 * 1_000_000_000).build());
        c.resolve_dispute(asset_id.clone(), 0, false);
        let entries = c.get_revenue(asset_id.clone());
        assert_eq!(entries[0].status, "Verified");
        assert_eq!(entries[0].bond_status, Some(BondStatus::Released));
        let activity = c.get_activity(asset_id.clone());
        let work = activity.work_points.iter().find(|(x, _)| x.as_str() == "bob.testnet").map(|(_, p)| p.current).unwrap_or(0);
        assert_eq!(work, 2, "the suspended points are restored");
        // Simulate the bond transfer landing: the callback releases the
        // held bond from the books.
        c.confirm_bond_returned(&asset_id, &acc("alice.testnet"), ATTESTATION_BOND);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_bonds_held.0, 0);
    }

    #[test]
    #[should_panic(expected = "only the community DAO")]
    fn resolve_dispute_requires_dao() {
        let (mut c, asset_id) = setup_attested();
        testing_env!(ctx("carol.testnet", STORAGE_RECORD, T0).build());
        c.dispute_revenue(asset_id.clone(), 0);
        testing_env!(ctx("carol.testnet", STORAGE_RECORD, T0).build());
        c.resolve_dispute(asset_id, 0, true);
    }

    #[test]
    fn bond_release_after_window_returns_bond() {
        let (mut c, asset_id) = setup_attested();
        // Too early: the 7-day window has not passed.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0 + 24 * 60 * 60 * 1_000_000_000).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.release_attestation_bond(asset_id.clone(), 0);
        }));
        assert!(result.is_err());
        // After the window, only the attestor may release it.
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0 + 8 * 24 * 60 * 60 * 1_000_000_000).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.release_attestation_bond(asset_id.clone(), 0);
        }));
        assert!(result.is_err());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0 + 8 * 24 * 60 * 60 * 1_000_000_000).build());
        c.release_attestation_bond(asset_id.clone(), 0);
        let entries = c.get_revenue(asset_id.clone());
        assert_eq!(entries[0].bond_status, Some(BondStatus::Released));
        // Simulate the transfer landing.
        c.confirm_bond_returned(&asset_id, &acc("alice.testnet"), ATTESTATION_BOND);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_bonds_held.0, 0);
    }

    #[test]
    fn failed_bond_transfer_goes_back_to_held() {
        // Simulate a failed bond transfer: the release is reverted.
        let (mut c, asset_id) = setup_attested();
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0 + 8 * 24 * 60 * 60 * 1_000_000_000).build());
        c.release_attestation_bond(asset_id.clone(), 0);
        c.revert_bond_release(&asset_id, 0);
        let entries = c.get_revenue(asset_id);
        assert_eq!(entries[0].bond_status, Some(BondStatus::Held));
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_bonds_held.0, ATTESTATION_BOND);
    }

    // -- Refunds -------------------------------------------------------------

    #[test]
    fn refund_from_open_campaign_returns_contribution() {
        let mut c = Contract::new();
        create_test_community(&mut c, "lagos-energy");
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign_id = c.create_campaign(
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            U128(10 * NEAR),
            DEADLINE,
        );
        testing_env!(ctx("alice.testnet", 25 * NEAR / 10 + STORAGE_RECORD, T0).build());
        c.contribute(campaign_id.clone());
        let v = c.get_community("lagos-energy".to_string());
        assert_eq!(v.capital_points.iter().find(|(x, _)| x.as_str() == "alice.testnet").unwrap().1, 2);
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.refund(campaign_id.clone());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 25 * NEAR / 10);
        assert_eq!(t.treasury.0, 0);
        let camp = c.get_campaign(campaign_id.clone());
        assert_eq!(camp.raised.0, 0);
        let v = c.get_community("lagos-energy".to_string());
        assert_eq!(v.capital_points.iter().find(|(x, _)| x.as_str() == "alice.testnet").unwrap().1, 0);
        // A second refund is rejected: nothing left to refund.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.refund(campaign_id);
        }));
        assert!(result.is_err());
    }

    #[test]
    #[should_panic(expected = "only an open campaign can be refunded")]
    fn refund_after_funded_rejected() {
        let (mut c, campaign_id) = setup_funded();
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.refund(campaign_id);
    }

    #[test]
    #[should_panic(expected = "caller has no contribution")]
    fn refund_by_non_contributor_rejected() {
        let mut c = Contract::new();
        create_test_community(&mut c, "lagos-energy");
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign_id = c.create_campaign(
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            U128(10 * NEAR),
            DEADLINE,
        );
        testing_env!(ctx("alice.testnet", 25 * NEAR / 10 + STORAGE_RECORD, T0).build());
        c.contribute(campaign_id.clone());
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0).build());
        c.refund(campaign_id);
    }

    // -- Transfer callbacks (failed transfers revert) ---------------------

    #[test]
    fn failed_acquire_reverts_and_retry_succeeds() {
        // Simulate a failed seller transfer by calling the revert
        // directly (the mock blockchain carries no promise results).
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        assert_eq!(c.get_campaign(campaign_id.clone()).status, "Acquired");
        c.revert_failed_acquire(&campaign_id, &asset_id, &acc(SELLER), 10 * NEAR);
        // Campaign back to Funded, asset removed, acquisitions 0.
        assert_eq!(c.get_campaign(campaign_id.clone()).status, "Funded");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.get_asset(asset_id.clone());
        }));
        assert!(result.is_err(), "the asset record is removed");
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_acquisitions.0, 0);
        assert_eq!(t.treasury.0, 10 * NEAR);
        assert_eq!(t.locked.0, 10 * NEAR, "the funded campaign locks its raised again");
        // Reverting twice is a no-op (idempotent).
        c.revert_failed_acquire(&campaign_id, &asset_id, &acc(SELLER), 10 * NEAR);
        assert_eq!(c.get_campaign(campaign_id.clone()).status, "Funded");
        // Retry: the DAO acquires again; a fresh asset id is created.
        let asset_id2 = acquire(&mut c, &campaign_id);
        assert_ne!(asset_id2, asset_id);
        assert_eq!(c.get_campaign(campaign_id).status, "Acquired");
        assert_eq!(c.get_asset(asset_id2).value.0, 10 * NEAR);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_acquisitions.0, 10 * NEAR);
    }

    #[test]
    fn acquire_callback_with_no_results_is_a_noop() {
        // The mock blockchain carries no promise results, so the
        // callback returns without reverting anything.
        let (mut c, campaign_id) = setup_funded();
        let asset_id = acquire(&mut c, &campaign_id);
        testing_env!(ctx("ownground.testnet", 0, T0).build());
        c.on_acquire_complete(campaign_id.clone(), asset_id.clone(), acc(SELLER), U128(10 * NEAR));
        assert_eq!(c.get_campaign(campaign_id).status, "Acquired");
        assert_eq!(c.get_asset(asset_id).value.0, 10 * NEAR);
    }

    #[test]
    fn failed_expense_reverts_and_retry_succeeds() {
        let (mut c, asset_id) = setup_with_spending_policy();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id.clone(), U128(NEAR / 2), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
        assert_eq!(c.get_expenses(asset_id.clone()).len(), 1);
        // Simulate the failed transfer.
        c.revert_failed_expense(&asset_id, 0, &acc("bob.testnet"), NEAR / 2);
        assert_eq!(c.get_expenses(asset_id.clone()).len(), 0);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_expenses.0, 0);
        assert_eq!(t.treasury.0, 3 * NEAR);
        // Reverting twice is a no-op.
        c.revert_failed_expense(&asset_id, 0, &acc("bob.testnet"), NEAR / 2);
        assert_eq!(c.get_expenses(asset_id.clone()).len(), 0);
        // Retry: the same expense succeeds.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id.clone(), U128(NEAR / 2), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
        assert_eq!(c.get_expenses(asset_id).len(), 1);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_expenses.0, NEAR / 2);
    }

    #[test]
    fn expense_callback_with_no_results_is_a_noop() {
        let (mut c, asset_id) = setup_with_spending_policy();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id.clone(), U128(NEAR / 2), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
        testing_env!(ctx("ownground.testnet", 0, T0).build());
        c.on_expense_complete(asset_id.clone(), 0, acc("bob.testnet"), U128(NEAR / 2));
        assert_eq!(c.get_expenses(asset_id).len(), 1);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_expenses.0, NEAR / 2);
    }

    /// An open campaign with a single 2.5 NEAR contribution by alice.
    fn setup_open_refund() -> (Contract, String) {
        let mut c = Contract::new();
        create_test_community(&mut c, "lagos-energy");
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign_id = c.create_campaign(
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            U128(10 * NEAR),
            DEADLINE,
        );
        testing_env!(ctx("alice.testnet", 25 * NEAR / 10 + STORAGE_RECORD, T0).build());
        c.contribute(campaign_id.clone());
        (c, campaign_id)
    }

    #[test]
    fn failed_refund_restores_contribution_and_retry_succeeds() {
        let (mut c, campaign_id) = setup_open_refund();
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.refund(campaign_id.clone());
        let camp = c.get_campaign(campaign_id.clone());
        assert_eq!(camp.raised.0, 0);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 25 * NEAR / 10);
        // Simulate the failed transfer: the contribution is restored.
        c.revert_failed_refund(&campaign_id, &acc("alice.testnet"), 25 * NEAR / 10);
        let camp = c.get_campaign(campaign_id.clone());
        assert_eq!(camp.raised.0, 25 * NEAR / 10);
        assert_eq!(camp.contributors.len(), 1);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 0);
        let v = c.get_community("lagos-energy".to_string());
        assert_eq!(v.capital_points.iter().find(|(x, _)| x.as_str() == "alice.testnet").unwrap().1, 2);
        // Reverting twice is a no-op.
        c.revert_failed_refund(&campaign_id, &acc("alice.testnet"), 25 * NEAR / 10);
        assert_eq!(c.get_campaign(campaign_id.clone()).raised.0, 25 * NEAR / 10);
        // Retry: the refund succeeds.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.refund(campaign_id.clone());
        assert_eq!(c.get_campaign(campaign_id).raised.0, 0);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 25 * NEAR / 10);
    }

    #[test]
    fn refund_callback_with_no_results_is_a_noop() {
        let (mut c, campaign_id) = setup_open_refund();
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.refund(campaign_id.clone());
        testing_env!(ctx("ownground.testnet", 0, T0).build());
        c.on_refund_complete(campaign_id.clone(), acc("alice.testnet"), U128(25 * NEAR / 10));
        assert_eq!(c.get_campaign(campaign_id).raised.0, 0);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 25 * NEAR / 10);
    }

    #[test]
    fn failed_refund_after_campaign_funded_becomes_claim() {
        // Alice refunds 2.5 NEAR from an open campaign; before the
        // callback lands, others fill the campaign to its 10 NEAR
        // target, so restoring her contribution would exceed the
        // target. The money is never lost: it becomes a claimable
        // refund (locked funds) she collects via claim_refund.
        let (mut c, campaign_id) = setup_open_refund();
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.refund(campaign_id.clone());
        testing_env!(ctx("bob.testnet", 5 * NEAR + STORAGE_RECORD, T0).build());
        c.contribute(campaign_id.clone());
        testing_env!(ctx("carol.testnet", 5 * NEAR + STORAGE_RECORD, T0).build());
        c.contribute(campaign_id.clone());
        assert_eq!(c.get_campaign(campaign_id.clone()).status, "Funded");
        // Simulate the failed transfer.
        c.revert_failed_refund(&campaign_id, &acc("alice.testnet"), 25 * NEAR / 10);
        let camp = c.get_campaign(campaign_id.clone());
        assert_eq!(camp.refund_claims.len(), 1);
        assert_eq!(camp.refund_claims[0].1 .0, 25 * NEAR / 10);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 0, "nothing was paid");
        assert_eq!(t.treasury.0, 125 * NEAR / 10);
        assert_eq!(t.locked.0, 125 * NEAR / 10, "funded raised 10 + claim 2.5");
        assert_eq!(t.spendable.0, 0);
        // Alice claims it.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.claim_refund(campaign_id.clone());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 25 * NEAR / 10);
        assert_eq!(t.treasury.0, 10 * NEAR);
        assert_eq!(t.locked.0, 10 * NEAR);
    }

    #[test]
    fn failed_claim_refund_restores_claim_and_retry_succeeds() {
        let (mut c, campaign_id) = setup_funded();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.cancel_campaign(campaign_id.clone());
        // Alice claims her 2.5 NEAR.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.claim_refund(campaign_id.clone());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 25 * NEAR / 10);
        assert_eq!(t.treasury.0, 75 * NEAR / 10);
        assert_eq!(t.locked.0, 75 * NEAR / 10);
        // Simulate the failed transfer: the claim is restored.
        c.revert_failed_claim_refund(&campaign_id, &acc("alice.testnet"), 25 * NEAR / 10);
        let camp = c.get_campaign(campaign_id.clone());
        assert_eq!(camp.refund_claims.len(), 4);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 0);
        assert_eq!(t.treasury.0, 10 * NEAR);
        assert_eq!(t.locked.0, 10 * NEAR);
        // Reverting twice is a no-op.
        c.revert_failed_claim_refund(&campaign_id, &acc("alice.testnet"), 25 * NEAR / 10);
        assert_eq!(c.get_campaign(campaign_id.clone()).refund_claims.len(), 4);
        // Retry: the claim succeeds.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.claim_refund(campaign_id.clone());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 25 * NEAR / 10);
        assert_eq!(c.get_campaign(campaign_id).refund_claims.len(), 3);
    }

    #[test]
    fn claim_callback_with_no_results_is_a_noop() {
        let (mut c, campaign_id) = setup_funded();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.cancel_campaign(campaign_id.clone());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.claim_refund(campaign_id.clone());
        testing_env!(ctx("ownground.testnet", 0, T0).build());
        c.on_claim_refund_complete(campaign_id.clone(), acc("alice.testnet"), U128(25 * NEAR / 10));
        assert_eq!(c.get_campaign(campaign_id).refund_claims.len(), 3);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 25 * NEAR / 10);
    }

    #[test]
    fn cancelled_claims_block_spending() {
        // Two campaigns: campaign 1 funds and acquires the generator;
        // campaign 2 holds a 2.5 NEAR open contribution. After the
        // generator earns 3 NEAR onchain and campaign 2 is cancelled,
        // its 2.5 NEAR claim is locked: the DAO cannot spend it, even
        // though the treasury holds 5.5 NEAR.
        let (mut c, campaign1) = setup_funded();
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_CAMPAIGN, T0).build());
        let campaign2 = c.create_campaign(
            "lagos-energy".to_string(),
            "Van".to_string(),
            "transport".to_string(),
            U128(10 * NEAR),
            DEADLINE,
        );
        testing_env!(ctx("alice.testnet", 25 * NEAR / 10 + STORAGE_RECORD, T0).build());
        c.contribute(campaign2.clone());
        let asset_id = acquire(&mut c, &campaign1);
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.cancel_campaign(campaign2.clone());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.treasury.0, 55 * NEAR / 10);
        assert_eq!(t.locked.0, 25 * NEAR / 10, "the unclaimed refund is locked");
        assert_eq!(t.spendable.0, 3 * NEAR);
        // A 3.5 NEAR expense exceeds the 3 NEAR spendable: rejected,
        // even though the raw treasury is 5.5 NEAR.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.pay_expense(asset_id.clone(), U128(35 * NEAR / 10), acc("bob.testnet"), "repairs".to_string(), "maintenance".to_string());
        }));
        assert!(result.is_err());
        // A 0.5 NEAR expense fits the spendable and succeeds.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.pay_expense(asset_id.clone(), U128(NEAR / 2), acc("bob.testnet"), "fuel".to_string(), "operations".to_string());
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_expenses.0, NEAR / 2);
        // The claim is still payable afterwards: the money was never spent.
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.claim_refund(campaign2);
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_refunds.0, 25 * NEAR / 10);
        assert_eq!(t.locked.0, 0);
    }

    #[test]
    #[should_panic(expected = "caller has no claimable refund")]
    fn claim_refund_by_non_claimant_rejected() {
        let (mut c, campaign_id) = setup_funded();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.cancel_campaign(campaign_id.clone());
        testing_env!(ctx("outsider.testnet", STORAGE_RECORD, T0).build());
        c.claim_refund(campaign_id);
    }

    // -- Policy validation (shared path: create + amendment) -------------

    fn create_community_with(
        c: &mut Contract,
        id: &str,
        distribution: DistributionPolicy,
        spending: SpendingPolicy,
        activity: ActivityPolicy,
        dispute_window_ns: Option<u64>,
        timelock_ns: Option<u64>,
    ) {
        testing_env!(ctx("alice.testnet", STORAGE_CREATE_COMMUNITY, T0).build());
        c.create_community(
            id.to_string(),
            "X".to_string(),
            "".to_string(),
            acc(DAO),
            members(),
            distribution,
            spending,
            activity,
            dispute_window_ns,
            timelock_ns,
        );
    }

    #[test]
    #[should_panic(expected = "policy shares must sum to exactly 10000")]
    fn create_community_rejects_invalid_distribution() {
        let mut c = Contract::new();
        create_community_with(
            &mut c,
            "x",
            DistributionPolicy { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1501, activity_bp: 1000 },
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "activity_bp must be between 0 and 10000")]
    fn create_community_rejects_activity_bp_over_10000() {
        let mut c = Contract::new();
        create_community_with(
            &mut c,
            "x",
            DistributionPolicy { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 10_001 },
            demo_spending(),
            ActivityPolicy::default(),
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "must allow at least one category")]
    fn create_community_rejects_empty_spending_categories() {
        let mut c = Contract::new();
        create_community_with(
            &mut c,
            "x",
            demo_distribution(),
            SpendingPolicy { max_single_expense: U128(0), min_treasury_reserve: U128(0), allowed_categories: vec![] },
            ActivityPolicy::default(),
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "duplicate spending category")]
    fn create_community_rejects_duplicate_spending_category() {
        let mut c = Contract::new();
        create_community_with(
            &mut c,
            "x",
            demo_distribution(),
            SpendingPolicy {
                max_single_expense: U128(0),
                min_treasury_reserve: U128(0),
                allowed_categories: vec!["operations".to_string(), "operations".to_string()],
            },
            ActivityPolicy::default(),
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "spending category must not be empty")]
    fn create_community_rejects_empty_spending_category() {
        let mut c = Contract::new();
        create_community_with(
            &mut c,
            "x",
            demo_distribution(),
            SpendingPolicy {
                max_single_expense: U128(0),
                min_treasury_reserve: U128(0),
                allowed_categories: vec!["operations".to_string(), "   ".to_string()],
            },
            ActivityPolicy::default(),
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "at most 64 characters")]
    fn create_community_rejects_long_spending_category() {
        let mut c = Contract::new();
        create_community_with(
            &mut c,
            "x",
            demo_distribution(),
            SpendingPolicy {
                max_single_expense: U128(0),
                min_treasury_reserve: U128(0),
                allowed_categories: vec!["a".repeat(65)],
            },
            ActivityPolicy::default(),
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "at most 20 categories")]
    fn create_community_rejects_too_many_spending_categories() {
        let mut c = Contract::new();
        create_community_with(
            &mut c,
            "x",
            demo_distribution(),
            SpendingPolicy {
                max_single_expense: U128(0),
                min_treasury_reserve: U128(0),
                allowed_categories: (0..21).map(|i| format!("cat-{}", i)).collect(),
            },
            ActivityPolicy::default(),
            None,
            None,
        );
    }

    #[test]
    fn create_community_rejects_oversized_activity_weights() {
        // Each weight above 1,000,000 is rejected, whichever it is.
        for (capital, record, per_near) in [
            (1_000_001, 1, 1),
            (1, 1_000_001, 1),
            (1, 1, 1_000_001),
        ] {
            let mut c = Contract::new();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                create_community_with(
                    &mut c,
                    "x",
                    demo_distribution(),
                    demo_spending(),
                    ActivityPolicy { capital_per_near: capital, work_per_revenue_record: record, work_per_revenue_near: per_near },
                    None,
                    None,
                );
            }));
            assert!(result.is_err(), "weight {:?} must be rejected", (capital, record, per_near));
        }
        // Exactly 1,000,000 is allowed.
        let mut c = Contract::new();
        create_community_with(
            &mut c,
            "x",
            demo_distribution(),
            demo_spending(),
            ActivityPolicy { capital_per_near: 1_000_000, work_per_revenue_record: 1_000_000, work_per_revenue_near: 1_000_000 },
            None,
            None,
        );
        assert_eq!(c.get_community("x".to_string()).activity_policy.capital_per_near, 1_000_000);
    }

    #[test]
    #[should_panic(expected = "must be between 60 seconds and 365 days")]
    fn create_community_rejects_zero_timelock() {
        let mut c = Contract::new();
        create_community_with(&mut c, "x", demo_distribution(), demo_spending(), ActivityPolicy::default(), None, Some(0));
    }

    #[test]
    #[should_panic(expected = "must be between 60 seconds and 365 days")]
    fn create_community_rejects_zero_dispute_window() {
        let mut c = Contract::new();
        create_community_with(&mut c, "x", demo_distribution(), demo_spending(), ActivityPolicy::default(), Some(0), None);
    }

    #[test]
    fn create_community_rejects_over_max_time_windows() {
        // 366 days exceeds the 365-day maximum, for either window.
        let over_max = 366 * 24 * 60 * 60 * 1_000_000_000u64;
        let mut c = Contract::new();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            create_community_with(&mut c, "x", demo_distribution(), demo_spending(), ActivityPolicy::default(), None, Some(over_max));
        }));
        assert!(result.is_err(), "over-max timelock must be rejected");
        let mut c = Contract::new();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            create_community_with(&mut c, "x", demo_distribution(), demo_spending(), ActivityPolicy::default(), Some(over_max), None);
        }));
        assert!(result.is_err(), "over-max dispute window must be rejected");
    }

    #[test]
    fn create_community_accepts_time_window_bounds() {
        // Both bounds are inclusive: 60 seconds and 365 days pass.
        // The demo's own values (120s timelock, 300s dispute window)
        // sit inside the bounds.
        let mut c = Contract::new();
        create_community_with(
            &mut c,
            "min",
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            Some(60 * 1_000_000_000),
            Some(60 * 1_000_000_000),
        );
        create_community_with(
            &mut c,
            "max",
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            Some(365 * 24 * 60 * 60 * 1_000_000_000),
            Some(365 * 24 * 60 * 60 * 1_000_000_000),
        );
        create_community_with(
            &mut c,
            "demo",
            demo_distribution(),
            demo_spending(),
            ActivityPolicy::default(),
            Some(300_000_000_000),
            Some(120_000_000_000),
        );
        assert_eq!(c.get_community("min".to_string()).timelock_ns, 60 * 1_000_000_000);
        assert_eq!(c.get_community("max".to_string()).timelock_ns, 365 * 24 * 60 * 60 * 1_000_000_000);
        assert_eq!(c.get_community("demo".to_string()).dispute_window_ns, 300_000_000_000);
    }

    #[test]
    #[should_panic(expected = "duplicate spending category")]
    fn amendment_rejects_invalid_spending_params() {
        let (mut c, _) = setup_funded();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.propose_policy_change(
            "lagos-energy".to_string(),
            PolicyType::Spending,
            PolicyParams::Spending {
                max_single_expense: U128(NEAR),
                min_treasury_reserve: U128(0),
                allowed_categories: vec!["operations".to_string(), "operations".to_string()],
            },
        );
    }

    #[test]
    #[should_panic(expected = "must be at most 1000000")]
    fn amendment_rejects_oversized_activity_params() {
        let (mut c, _) = setup_funded();
        testing_env!(ctx(DAO, STORAGE_RECORD, T0).build());
        c.propose_policy_change(
            "lagos-energy".to_string(),
            PolicyType::Activity,
            PolicyParams::Activity { capital_per_near: 1, work_per_revenue_record: 1_000_001, work_per_revenue_near: 1 },
        );
    }

    // -- Epoch-safe disputes -----------------------------------------------
    //
    // Full sequence: dispute -> distribution -> new activity ->
    // resolution, both upheld and rejected. A resolution after the
    // distribution must never touch current-epoch points: no docking
    // of new-epoch points on uphold, no double-pay on reject.

    /// Dispute bob's attested entry, then distribute (3 NEAR onchain)
    /// and give bob 2 fresh work points in the new epoch. Returns the
    /// contract and asset id with the dispute still open.
    fn setup_dispute_then_distribution() -> (Contract, String) {
        let (mut c, asset_id) = setup_attested();
        testing_env!(ctx("carol.testnet", STORAGE_RECORD, T0 + 24 * 60 * 60 * 1_000_000_000).build());
        c.dispute_revenue(asset_id.clone(), 0);
        // 3 NEAR onchain revenue (0 points) funds a distribution.
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0 + 24 * 60 * 60 * 1_000_000_000).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0 + 24 * 60 * 60 * 1_000_000_000).build());
        let view = c.execute_distribution(asset_id.clone());
        assert_eq!(view.distributed.0, 3 * NEAR);
        assert_eq!(c.get_asset(asset_id.clone()).epoch, 1);
        // New verified activity in epoch 1: bob records 1 NEAR
        // reported revenue, alice attests it — bob earns 2 fresh points.
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0 + 2 * 24 * 60 * 60 * 1_000_000_000).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash".to_string(), "rep-2".to_string());
        testing_env!(ctx("alice.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0 + 2 * 24 * 60 * 60 * 1_000_000_000).build());
        c.attest_revenue(asset_id.clone(), 2);
        let activity = c.get_activity(asset_id.clone());
        let work = activity.work_points.iter().find(|(x, _)| x.as_str() == "bob.testnet").map(|(_, p)| p.current).unwrap_or(0);
        assert_eq!(work, 2, "bob holds 2 fresh epoch-1 points before resolution");
        (c, asset_id)
    }

    #[test]
    fn dispute_after_distribution_uphold_keeps_new_epoch_points() {
        let (mut c, asset_id) = setup_dispute_then_distribution();
        // The DAO upholds the old dispute: entry 0 is rejected and the
        // bond forfeits — but bob's new-epoch points are untouched.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0 + 3 * 24 * 60 * 60 * 1_000_000_000).build());
        c.resolve_dispute(asset_id.clone(), 0, true);
        let entries = c.get_revenue(asset_id.clone());
        assert_eq!(entries[0].status, "Rejected");
        assert_eq!(entries[0].bond_status, Some(BondStatus::Forfeited));
        assert_eq!(entries[2].status, "Verified", "the new entry stands");
        let activity = c.get_activity(asset_id.clone());
        let work = activity.work_points.iter().find(|(x, _)| x.as_str() == "bob.testnet").map(|(_, p)| p.current).unwrap_or(0);
        assert_eq!(work, 2, "upholding an old dispute must not dock new-epoch points");
        let t = c.get_treasury("lagos-energy".to_string());
        assert_eq!(t.total_revenue.0, 3 * NEAR + ATTESTATION_BOND, "onchain 3 + forfeited bond 0.1");
    }

    #[test]
    fn dispute_after_distribution_reject_does_not_double_pay() {
        let (mut c, asset_id) = setup_dispute_then_distribution();
        // The DAO rejects the old dispute: entry 0 is verified again
        // and the bond is released — but bob's points are NOT restored
        // on top of his new-epoch points (that would double-pay: 4).
        testing_env!(ctx(DAO, STORAGE_RECORD, T0 + 3 * 24 * 60 * 60 * 1_000_000_000).build());
        c.resolve_dispute(asset_id.clone(), 0, false);
        let entries = c.get_revenue(asset_id.clone());
        assert_eq!(entries[0].status, "Verified");
        assert_eq!(entries[0].bond_status, Some(BondStatus::Released));
        let activity = c.get_activity(asset_id.clone());
        let work = activity.work_points.iter().find(|(x, _)| x.as_str() == "bob.testnet").map(|(_, p)| p.current).unwrap_or(0);
        assert_eq!(work, 2, "rejecting an old dispute must not restore points into a new epoch");
    }

    #[test]
    fn dispute_of_old_entry_in_new_epoch_does_not_suspend_new_points() {
        // Bob's entry is attested in epoch 0; a distribution closes
        // the epoch; bob earns 2 fresh points in epoch 1. Disputing
        // the OLD entry now must not suspend the new points.
        let (mut c, asset_id) = setup_attested();
        testing_env!(ctx("alice.testnet", 3 * NEAR + STORAGE_RECORD, T0).build());
        c.record_revenue(asset_id.clone(), U128(3 * NEAR), "rental".to_string(), "inv-1".to_string());
        testing_env!(ctx("alice.testnet", STORAGE_RECORD, T0).build());
        c.execute_distribution(asset_id.clone());
        assert_eq!(c.get_asset(asset_id.clone()).epoch, 1);
        testing_env!(ctx("bob.testnet", STORAGE_RECORD, T0 + 24 * 60 * 60 * 1_000_000_000).build());
        c.record_revenue(asset_id.clone(), U128(NEAR), "cash".to_string(), "rep-2".to_string());
        testing_env!(ctx("alice.testnet", ATTESTATION_BOND + STORAGE_RECORD, T0 + 24 * 60 * 60 * 1_000_000_000).build());
        c.attest_revenue(asset_id.clone(), 2);
        // Carol disputes the OLD entry 0 (still Verified, in window).
        testing_env!(ctx("carol.testnet", STORAGE_RECORD, T0 + 2 * 24 * 60 * 60 * 1_000_000_000).build());
        c.dispute_revenue(asset_id.clone(), 0);
        let entries = c.get_revenue(asset_id.clone());
        assert_eq!(entries[0].status, "Disputed");
        let activity = c.get_activity(asset_id.clone());
        let work = activity.work_points.iter().find(|(x, _)| x.as_str() == "bob.testnet").map(|(_, p)| p.current).unwrap_or(0);
        assert_eq!(work, 2, "suspending an old-epoch entry must not dock new-epoch points");
        // Upholding it forfeits the bond but still leaves the points.
        testing_env!(ctx(DAO, STORAGE_RECORD, T0 + 3 * 24 * 60 * 60 * 1_000_000_000).build());
        c.resolve_dispute(asset_id.clone(), 0, true);
        let activity = c.get_activity(asset_id.clone());
        let work = activity.work_points.iter().find(|(x, _)| x.as_str() == "bob.testnet").map(|(_, p)| p.current).unwrap_or(0);
        assert_eq!(work, 2);
    }
}
