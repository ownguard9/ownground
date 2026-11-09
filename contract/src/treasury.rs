//! Treasury module: the money equations. All amounts are yoctoNEAR (u128).
//!
//! Treasury (per community):
//!   treasury = (contributions + revenue deposits)
//!            - (acquisitions + expenses + distribution payouts + refunds)
//!
//! Locked funds (per community):
//!   locked = sum of raised over open/funded campaigns.
//!
//! Identity (holds by the campaign accounting: every campaign's raised
//! amount is exactly one of open/funded (locked), acquired, or refunded):
//!   treasury - locked = revenue_onchain - expenses - distributed_payouts

use crate::funding::{Campaign, CampaignStatus};
use crate::registry::Community;

/// Treasury balance derived from the counters. Panics if the counters
/// are inconsistent (that would be a contract bug, never a user input).
pub fn treasury_balance(c: &Community) -> u128 {
    let deposits = c
        .total_contributions
        .checked_add(c.total_revenue)
        .expect("treasury deposits overflow");
    let spent = c
        .total_acquisitions
        .checked_add(c.total_expenses)
        .and_then(|s| s.checked_add(c.total_payouts))
        .and_then(|s| s.checked_add(c.total_refunds))
        .expect("treasury spent overflow");
    deposits.checked_sub(spent).expect("treasury underflow: counters inconsistent")
}

/// Sum of raised over the community's open/funded campaigns.
pub fn locked_funds(campaigns: &[Campaign]) -> u128 {
    campaigns
        .iter()
        .filter(|c| c.status == CampaignStatus::Open || c.status == CampaignStatus::Funded)
        .map(|c| c.raised)
        .fold(0u128, |a, b| a.checked_add(b).expect("locked funds overflow"))
}

/// Funds a spend may draw on: the treasury minus what campaigns hold.
pub fn spendable(c: &Community, campaigns: &[Campaign]) -> u128 {
    treasury_balance(c).saturating_sub(locked_funds(campaigns))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Community;
    use near_sdk::AccountId;

    fn community() -> Community {
        Community::new(
            "lagos-energy".to_string(),
            "Lagos Energy Cooperative".to_string(),
            "".to_string(),
            "lagos-dao.testnet".parse().unwrap(),
            vec!["a.testnet".parse::<AccountId>().unwrap()],
        )
    }

    #[test]
    fn treasury_equation_with_refunds() {
        let mut c = community();
        c.total_contributions = 10;
        c.total_refunds = 10;
        assert_eq!(treasury_balance(&c), 0);
    }

    #[test]
    fn locked_counts_only_open_and_funded() {
        let mut open = Campaign::new(
            "c1".to_string(),
            "lagos-energy".to_string(),
            "Generator".to_string(),
            "energy".to_string(),
            10,
            0,
        );
        open.raised = 4;
        let mut funded = Campaign::new(
            "c2".to_string(),
            "lagos-energy".to_string(),
            "Van".to_string(),
            "transport".to_string(),
            6,
            0,
        );
        funded.raised = 6;
        funded.status = CampaignStatus::Funded;
        let mut acquired = Campaign::new(
            "c3".to_string(),
            "lagos-energy".to_string(),
            "Freezer".to_string(),
            "cold".to_string(),
            5,
            0,
        );
        acquired.raised = 5;
        acquired.status = CampaignStatus::Acquired;
        assert_eq!(locked_funds(&[open, funded, acquired]), 10);
    }
}
