//! Funding module: asset acquisition campaigns.
//!
//! A contribution is rejected if it would push `raised` above `target`,
//! so `raised <= target` always and `raised = sum(contributions)` exactly.
//! Acquisition requires `raised == target` (plus the treasury check in
//! the method). Cancellation is allowed only from open/funded status and
//! refunds contributors exactly once.

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
