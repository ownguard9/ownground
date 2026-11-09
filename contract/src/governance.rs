//! Governance module: who may call the money methods.
//!
//! Treasury spending happens ONLY through DAO-approved calls. The
//! contract checks that the predecessor is the community's Sputnik DAO
//! for: acquire_asset, pay_expense, set_distribution_policy,
//! cancel_campaign. A frontend check never authorises a spend.

use near_sdk::{env, AccountId};

/// Panics unless the caller is the community's DAO.
pub fn require_dao(caller: &AccountId, dao_id: &AccountId) {
    assert_eq!(
        caller, dao_id,
        "only the community DAO may call this method"
    );
}

/// Panics unless the caller is a member of the community.
pub fn require_member(caller: &AccountId, members: &[AccountId]) {
    assert!(
        members.contains(caller),
        "caller is not a community member"
    );
}

/// The predecessor of the current call.
pub fn caller() -> AccountId {
    env::predecessor_account_id()
}
