//! Revenue module: income and expense records.
//!
//! Verification statuses, kept strictly apart:
//! * `Onchain` — real NEAR was deposited with the record. Verified income.
//!   Work points are awarded at record time.
//! * `Pending` — no deposit; an offchain payment recorded as a ledger
//!   entry. Labelled "Reported — not independently verified" everywhere
//!   and never presented as verified income. Earns no points until a
//!   different member attests it.
//! * `Verified` — a reported entry attested by a different member, with a
//!   0.1 NEAR bond held per entry. Work points are awarded at attestation.
//! * `Disputed` — a member challenged the verification; the entry's work
//!   points are suspended while disputed.
//! * `Rejected` — the DAO upheld a dispute; the verification is overturned,
//!   the points stay removed, and the attestor's bond goes to the treasury.
//!
//! Work points are awarded exactly once per entry, tied to the entry id:
//! the entry records `points_awarded`, set once at verification.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::AccountId;

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub enum RevenueStatus {
    Onchain,
    Pending,
    Verified,
    Disputed,
    Rejected,
}

/// State of one attestation bond (always 0.1 NEAR when present).
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[derive(near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub enum BondStatus {
    Held,
    Released,
    Forfeited,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct RevenueEntry {
    pub amount: u128,
    pub source: String,
    /// Evidence reference. Required and unique per asset: a second entry
    /// with the same reference is rejected.
    pub reference: String,
    pub status: RevenueStatus,
    pub recorded_at: u64,
    pub recorded_by: AccountId,
    /// The member who attested a reported entry, once attested.
    pub attestor: Option<AccountId>,
    /// Block timestamp (ns) of attestation, once attested. The dispute
    /// window runs from here.
    pub verified_at: Option<u64>,
    /// Work points awarded for this entry (0 until verified). Set exactly
    /// once, at verification.
    pub points_awarded: u64,
    /// The member whose bond is held for this entry, once attested.
    pub bond_attestor: Option<AccountId>,
    /// Bond state, once attested.
    pub bond_status: Option<BondStatus>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct ExpenseEntry {
    pub amount: u128,
    pub recipient: AccountId,
    pub description: String,
    /// Category checked against the community's spending policy.
    pub category: String,
    pub recorded_at: u64,
}
