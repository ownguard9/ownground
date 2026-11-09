//! Assets module: the onchain registry of community-owned assets.
//!
//! Ownership allocation is set at acquisition and approved by the DAO
//! vote that approves the acquisition. It is NOT assumed to equal
//! contributions: the acquisition call carries the allocation explicitly,
//! and it is rejected unless the basis points sum to exactly 10000 and
//! every allocation account is a community member.

use crate::revenue::{ExpenseEntry, RevenueEntry};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::AccountId;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum AssetStatus {
    Active,
    Retired,
}

/// Work points for one member on one asset: the current epoch's points
/// (what the next distribution's activity slice uses) and the lifetime
/// total (display only). The current points reset to 0 after every
/// distribution, so points reward recent activity and cannot accumulate
/// without bound from one entry.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(crate = "near_sdk::serde")]
pub struct WorkPoints {
    pub current: u64,
    pub lifetime: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct Asset {
    pub id: String,
    pub community_id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    /// Acquisition value in yoctoNEAR (== the campaign target).
    pub value: u128,
    /// The account that sold the asset (received the target).
    pub seller: AccountId,
    /// Ownership allocation in basis points; sums to exactly 10000.
    pub allocations: Vec<(AccountId, u16)>,
    pub status: AssetStatus,
    pub created_at: u64,
    /// Epoch counter, incremented by every execute_distribution.
    pub epoch: u64,
    /// Work points per member for this asset (current epoch + lifetime).
    pub work: Vec<(AccountId, WorkPoints)>,
    /// Cumulative D consumed by this asset's distributions (D formula
    /// only; see the distribution module).
    pub distributed_total: u128,
    /// Cumulative forfeited attestation bonds for this asset (DESIGN
    /// fix 9): real money already held by the contract, distributable
    /// like any other revenue. Set when a dispute is upheld.
    pub bond_forfeits: u128,
    pub revenue: Vec<RevenueEntry>,
    pub expenses: Vec<ExpenseEntry>,
}

/// Validate an ownership allocation: basis points sum to exactly 10000,
/// every account is a community member, no duplicates, no zero shares.
pub fn validate_allocations(
    allocations: &[(AccountId, u16)],
    members: &[AccountId],
) -> Result<(), String> {
    if allocations.is_empty() {
        return Err("allocation must name at least one owner".to_string());
    }
    let mut sum: u32 = 0;
    let mut seen: Vec<&AccountId> = Vec::new();
    for (account, bp) in allocations {
        if *bp == 0 {
            return Err("allocation shares must be greater than zero".to_string());
        }
        if !members.contains(account) {
            return Err(format!("allocation account {} is not a community member", account));
        }
        if seen.contains(&account) {
            return Err(format!("duplicate allocation for {}", account));
        }
        seen.push(account);
        sum += *bp as u32;
    }
    if sum != 10_000 {
        return Err(format!(
            "allocation basis points must sum to exactly 10000, got {}",
            sum
        ));
    }
    Ok(())
}

impl Asset {
    /// Total onchain revenue recorded for this asset (reported revenue
    /// moves no money, so it is excluded).
    pub fn revenue_onchain(&self) -> u128 {
        self.revenue
            .iter()
            .filter(|e| e.status == crate::revenue::RevenueStatus::Onchain)
            .map(|e| e.amount)
            .fold(0u128, |a, b| a.checked_add(b).expect("revenue sum overflow"))
    }

    /// Total expenses recorded for this asset.
    pub fn expenses_total(&self) -> u128 {
        self.expenses
            .iter()
            .map(|e| e.amount)
            .fold(0u128, |a, b| a.checked_add(b).expect("expense sum overflow"))
    }

    /// A member's current-epoch work points on this asset (0 if none).
    pub fn work_current_of(&self, account: &AccountId) -> u64 {
        self.work
            .iter()
            .find(|(a, _)| a == account)
            .map(|(_, p)| p.current)
            .unwrap_or(0)
    }

    /// Current-epoch work points for every member holding any.
    pub fn work_current(&self) -> Vec<(AccountId, u64)> {
        self.work
            .iter()
            .map(|(a, p)| (a.clone(), p.current))
            .filter(|(_, p)| *p > 0)
            .collect()
    }

    /// Total current-epoch work points on this asset.
    pub fn work_total_current(&self) -> u64 {
        self.work.iter().map(|(_, p)| p.current).sum()
    }

    /// Award verified work points to a member: current and lifetime both
    /// grow. Awarding happens exactly once per revenue entry (the entry
    /// records points_awarded); this is only the bookkeeping.
    pub fn add_work_points(&mut self, account: &AccountId, points: u64) {
        if points == 0 {
            return;
        }
        match self.work.iter_mut().find(|(a, _)| a == account) {
            Some((_, p)) => {
                p.current = p.current.saturating_add(points);
                p.lifetime = p.lifetime.saturating_add(points);
            }
            None => self.work.push((
                account.clone(),
                WorkPoints { current: points, lifetime: points },
            )),
        }
    }

    /// Suspend work points (a dispute): remove them from the current
    /// epoch only, floored at 0. The lifetime total is untouched, and a
    /// distribution already paid is never re-run.
    pub fn suspend_work_points(&mut self, account: &AccountId, points: u64) {
        if let Some((_, p)) = self.work.iter_mut().find(|(a, _)| a == account) {
            p.current = p.current.saturating_sub(points);
        }
    }

    /// Restore suspended work points (a dispute was rejected and the
    /// verification stands). Only the current epoch grows: a restore is
    /// not new work, so the lifetime total is untouched.
    pub fn restore_work_points(&mut self, account: &AccountId, points: u64) {
        if points == 0 {
            return;
        }
        match self.work.iter_mut().find(|(a, _)| a == account) {
            Some((_, p)) => p.current = p.current.saturating_add(points),
            None => self.work.push((
                account.clone(),
                WorkPoints { current: points, lifetime: 0 },
            )),
        }
    }

    /// End of an epoch: the current points reset to 0 and the epoch
    /// counter increments. Lifetime totals are kept for display.
    pub fn reset_epoch_work(&mut self) {
        for (_, p) in self.work.iter_mut() {
            p.current = 0;
        }
        self.epoch = self.epoch.checked_add(1).expect("epoch overflow");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::AccountId;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    #[test]
    fn allocation_must_sum_to_10000() {
        let members = vec![acc("a.testnet"), acc("b.testnet")];
        assert!(validate_allocations(&[(acc("a.testnet"), 5000), (acc("b.testnet"), 5000)], &members)
            .is_ok());
        assert!(validate_allocations(&[(acc("a.testnet"), 5000), (acc("b.testnet"), 4999)], &members)
            .is_err());
    }

    #[test]
    fn allocation_must_be_members_only() {
        let members = vec![acc("a.testnet")];
        assert!(validate_allocations(&[(acc("a.testnet"), 5000), (acc("outsider.testnet"), 5000)], &members)
            .is_err());
    }
}
