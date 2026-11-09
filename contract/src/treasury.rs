//! Treasury module: the money equations. All amounts are yoctoNEAR (u128).
//!
//! Treasury (per community):
//!   treasury = (contributions + revenue deposits)
//!            - (acquisitions + expenses + distribution payouts + refunds)
//!
//! Locked funds (per community):
//!   locked = sum of raised over open/funded campaigns
//!          + sum of unclaimed refund claims over every campaign.
//! A cancelled campaign's raised is no longer counted as raised, but
//! every unclaimed refund claim on it is locked instead, so the DAO
//! cannot spend money owed to contributors and brick their claims.
//! A claim recorded when an individual refund's transfer failed after
//! its campaign moved on is locked the same way, whatever the
//! campaign's status. (For an open/funded campaign the claim amount
//! was already subtracted from `raised` when the refund was first
//! recorded, so raised + claims never double-counts.)
//!
//! Identity (holds by the campaign accounting: every campaign's raised
//! amount is exactly one of open/funded (locked), acquired, refunded
//! (paid), or claimable-but-unclaimed (locked)):
//!   treasury - locked = revenue_onchain - expenses - distributed_payouts
//!
//! A failed member payout is counted in total_payouts (and therefore
//! out of the treasury) at distribution time, so it can never be
//! spent by the DAO while its recipient's claim is outstanding; the
//! claim is an exact-amount liability collected via
//! claim_failed_payout, never recomputed.

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

/// Sum of raised over the community's open/funded campaigns, plus
/// every unclaimed refund claim (cancelled campaigns, and claims
/// recorded when an individual refund's transfer failed after its
/// campaign moved on). Spends may only draw on treasury - locked, so
/// money owed to contributors can never be spent by the DAO.
pub fn locked_funds(campaigns: &[Campaign]) -> u128 {
    campaigns
        .iter()
        .map(|c| {
            let mut locked = 0u128;
            if c.status == CampaignStatus::Open || c.status == CampaignStatus::Funded {
                locked = locked
                    .checked_add(c.raised)
                    .expect("locked funds overflow");
            }
            let claims: u128 = c
                .refund_claims
                .iter()
                .map(|(_, v)| *v)
                .fold(0u128, |a, b| a.checked_add(b).expect("locked funds overflow"));
            locked.checked_add(claims).expect("locked funds overflow")
        })
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
            vec![
                "a.testnet".parse().unwrap(),
                "b.testnet".parse().unwrap(),
                "c.testnet".parse().unwrap(),
            ],
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

    #[test]
    fn locked_counts_unclaimed_refund_claims() {
        // A cancelled campaign's raised is no longer locked as raised,
        // but every unclaimed refund claim on it is locked instead, so
        // the DAO cannot spend money owed to contributors.
        let mut cancelled = Campaign::new(
            "c4".to_string(),
            "lagos-energy".to_string(),
            "Pump".to_string(),
            "energy".to_string(),
            10,
            0,
        );
        cancelled.raised = 10;
        cancelled.status = CampaignStatus::Cancelled;
        cancelled.refund_claims = vec![
            ("a.testnet".parse().unwrap(), 6),
            ("b.testnet".parse().unwrap(), 4),
        ];
        assert_eq!(locked_funds(&[cancelled.clone()]), 10);
        // After one claim is paid (removed from refund_claims), only
        // the remaining claim stays locked.
        cancelled.refund_claims.retain(|(a, _)| *a != "a.testnet".parse::<AccountId>().unwrap());
        assert_eq!(locked_funds(&[cancelled]), 4);
    }
}
