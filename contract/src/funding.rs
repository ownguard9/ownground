//! Funding module: asset acquisition campaigns.
//!
//! A contribution is rejected if it would push `raised` above `target`,
//! so `raised <= target` always and `raised = sum(contributions)` exactly.
//! Acquisition requires `raised == target` (plus the treasury check in
//! the method). Cancellation is allowed only from open/funded status.
//! It records a claimable refund per contributor (no transfers in a
//! loop — each contributor claims theirs with `claim_refund`, which
//! carries a callback); unclaimed refunds are locked funds until
//! claimed.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::AccountId;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum CampaignStatus {
    Open,
    Funded,
    Acquired,
    Cancelled,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct Campaign {
    pub id: String,
    pub community_id: String,
    pub asset_name: String,
    pub category: String,
    pub target: u128,
    pub raised: u128,
    pub contributors: Vec<(AccountId, u128)>,
    pub status: CampaignStatus,
    /// Outstanding claimable refunds, per contributor. Recorded when
    /// the campaign is cancelled (one entry per contributor, equal to
    /// their contribution); each entry is removed when its
    /// `claim_refund` payment is initiated, and restored if that
    /// transfer fails (callback). Unclaimed amounts are LOCKED funds
    /// (see treasury::locked_funds): the DAO cannot spend money owed
    /// to contributors. `total_refunds` counts a refund only when its
    /// claim payment is initiated — NOT at cancel time — because the
    /// money is still in the contract until claimed, so the treasury
    /// equation stays exact with the raw balance at every step. The
    /// `contributors` list is kept as the contribution record (and
    /// the capital-points input); only `refund_claims` moves.
    pub refund_claims: Vec<(AccountId, u128)>,
    /// Block timestamp (nanoseconds) after which contributions close.
    pub deadline: u64,
}

impl Campaign {
    pub fn new(
        id: String,
        community_id: String,
        asset_name: String,
        category: String,
        target: u128,
        deadline: u64,
    ) -> Self {
        assert!(target > 0, "campaign target must be greater than zero");
        Self {
            id,
            community_id,
            asset_name,
            category,
            target,
            raised: 0,
            contributors: Vec::new(),
            status: CampaignStatus::Open,
            refund_claims: Vec::new(),
            deadline,
        }
    }

    /// Record a contribution. Returns the contributor's new total.
    pub fn add_contribution(&mut self, contributor: AccountId, amount: u128) -> u128 {
        assert!(amount > 0, "contribution must be greater than zero");
        assert_eq!(self.status, CampaignStatus::Open, "campaign is not open");
        let new_raised = self
            .raised
            .checked_add(amount)
            .expect("raised overflow");
        assert!(new_raised <= self.target, "contribution would exceed the target");
        self.raised = new_raised;
        match self.contributors.iter_mut().find(|(a, _)| *a == contributor) {
            Some((_, total)) => {
                *total = total.checked_add(amount).expect("contributor total overflow");
                *total
            }
            None => {
                self.contributors.push((contributor, amount));
                amount
            }
        }
    }

    /// Mark funded once the target is reached.
    pub fn check_funded(&mut self) {
        if self.status == CampaignStatus::Open && self.raised == self.target {
            self.status = CampaignStatus::Funded;
        }
    }
}
