//! Governance module: who may call the money methods, and how a DAO
//! is proven genuine at community creation.
//!
//! Treasury spending happens ONLY through DAO-approved calls. The
//! contract checks that the predecessor is the community's Sputnik DAO
//! for: acquire_asset, pay_expense, set_distribution_policy,
//! cancel_campaign. A frontend check never authorises a spend.
//!
//! DAO verification (v4, finding 2): at creation the contract calls
//! `dao_id.get_policy()` and only registers the community if the
//! returned Sputnik v2 policy proves (a) the account answers as a
//! Sputnik DAO at all — an ordinary account has no get_policy method,
//! so the call fails and the community is never created — (b) the
//! "council" role's Group is exactly the community member set, and
//! (c) the council's vote threshold is the strict majority
//! floor(n/2)+1. Any genuine Sputnik DAO passes: factory-created or
//! direct-deployed from the Sputnik v2 WASM (like the v3 demo DAO
//! lagos-energy3.testnet). No specific factory is required, and the
//! code hash is NOT checked — the policy itself is the proof. A
//! contract that merely mimics get_policy's shape would pass this
//! check; that residual spoofing risk is disclosed in the report.
//!
//! The policy JSON the live DAO returns (verified against
//! lagos-energy3.testnet, 2026-11-09) looks like:
//! ```json
//! {"roles": [
//!   {"name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {}},
//!   {"name": "council", "kind": {"Group": ["a.testnet", "..."]},
//!    "permissions": ["*:*"], "vote_policy": {}}
//! ],
//! "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "2"},
//! "proposal_bond": "1000000000000000000000000", ...}
//! ```
//! The council role's vote_policy is usually empty, so the threshold
//! falls back to default_vote_policy. The threshold itself is a
//! WeightOrRatio: a bare U128 string/number ("2") for an absolute
//! Weight, or a [num, den] pair for a Ratio (the factory default
//! Ratio(1,2) already yields floor(n/2)+1). Defensive shapes the
//! parser also accepts: {"Weight": "2"}, {"RoleWeight": [1, 2]},
//! {"Ratio": [1, 2]}.

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

/// Strict-majority threshold for a council of `n` members (v4,
/// finding 4): floor(n/2)+1. n=3 -> 2, n=4 -> 3, n=5 -> 3, n=20 -> 11.
pub fn dao_threshold(n: usize) -> u64 {
    (n / 2 + 1) as u64
}

/// Validate a Sputnik v2 `get_policy` JSON result against the expected
/// community members. Pure function (no env access) so unit tests can
/// drive it with real policy JSON, including the live v3 DAO's.
///
/// Returns Ok(()) only when:
/// * the JSON parses and has a `roles` array with a `council` role
///   whose kind is a Group of account ids, and
/// * that Group, as a set, equals `members`, and
/// * the council's vote threshold — the role's vote_policy, falling
///   back to default_vote_policy — is the strict majority
///   floor(n/2)+1, counted as absolute votes (RoleWeight).
///
/// Any other shape (missing council, non-Group kind, unparseable
/// threshold, TokenWeight, mismatch) returns Err naming the problem.
/// An EOA never reaches this function: its get_policy call fails
/// first, and the callback treats a failed call as rejection.
pub fn validate_dao_policy(policy_json: &[u8], members: &[AccountId]) -> Result<(), String> {
    let policy: serde_json::Value =
        serde_json::from_slice(policy_json).map_err(|_| "DAO policy is not valid JSON".to_string())?;
    let roles = policy
        .get("roles")
        .and_then(|r| r.as_array())
        .ok_or_else(|| "DAO policy has no roles list".to_string())?;
    let council = roles
        .iter()
        .find(|r| r.get("name").and_then(|n| n.as_str()) == Some("council"))
        .ok_or_else(|| "DAO policy has no council role".to_string())?;
    let group = council
        .get("kind")
        .and_then(|k| k.get("Group"))
        .and_then(|g| g.as_array())
        .ok_or_else(|| "DAO council role is not a Group".to_string())?;
    let mut council_members: Vec<AccountId> = Vec::new();
    for member in group {
        let id = member
            .as_str()
            .ok_or_else(|| "DAO council member is not an account id".to_string())?;
        council_members.push(
            id.parse::<AccountId>()
                .map_err(|_| format!("DAO council member {} is not a valid account id", id))?,
        );
    }
    let mut expected: Vec<AccountId> = members.to_vec();
    let mut actual = council_members.clone();
    expected.sort();
    actual.sort();
    if expected != actual {
        return Err(format!(
            "DAO council does not match the community members: council is {:?}, members are {:?}",
            actual, expected
        ));
    }
    // The threshold lives on the council role's vote_policy when it is
    // non-empty, otherwise on the DAO default (the live DAO sets an
    // empty role vote_policy and a Weight threshold on the default).
    let role_policy = council.get("vote_policy");
    let vote_policy = match role_policy {
        Some(vp) if vp.is_object() && !vp.as_object().unwrap().is_empty() => vp,
        _ => policy
            .get("default_vote_policy")
            .ok_or_else(|| "DAO policy has no default vote policy".to_string())?,
    };
    if let Some(kind) = vote_policy.get("weight_kind").and_then(|k| k.as_str()) {
        if kind != "RoleWeight" {
            return Err(format!(
                "DAO vote weight kind is {}, not RoleWeight: the threshold is not a vote count",
                kind
            ));
        }
    }
    let threshold = vote_threshold_count(vote_policy, members.len())?;
    let expected_threshold = dao_threshold(members.len());
    if threshold != expected_threshold {
        return Err(format!(
            "DAO vote threshold is {}, but a strict majority of {} members requires {}",
            threshold,
            members.len(),
            expected_threshold
        ));
    }
    Ok(())
}

/// Read the approval count out of one Sputnik vote policy object.
/// Accepts the forms Sputnik v2 actually serialises:
/// * {"threshold": "2"} or {"threshold": 2} — absolute Weight.
/// * {"threshold": ["1", "2"]} — Ratio: floor(n*num/den)+1.
/// * {"threshold": {"Weight": "2"}} / {"threshold": {"Ratio": ["1","2"]}}.
/// * {"Weight": "2"}, {"RoleWeight": ["1","2"]}, {"Ratio": ["1","2"]}.
fn vote_threshold_count(vote_policy: &serde_json::Value, council_size: usize) -> Result<u64, String> {
    // A bare threshold field (the live shape) takes precedence.
    if let Some(threshold) = vote_policy.get("threshold") {
        return weight_or_ratio_to_count(threshold, council_size);
    }
    // The dao.js fixture shapes, kept for defence in depth.
    if let Some(weight) = vote_policy.get("Weight") {
        return parse_u128_value(weight)
            .and_then(|n| u64::try_from(n).ok())
            .ok_or_else(|| "DAO vote threshold Weight is not a number".to_string());
    }
    for key in ["RoleWeight", "Ratio"] {
        if let Some(frac) = vote_policy.get(key) {
            return weight_or_ratio_to_count(frac, council_size);
        }
    }
    Err("DAO vote policy has no usable threshold".to_string())
}

/// Convert one WeightOrRatio JSON value to an approval count: a bare
/// number is the count; a [num, den] pair needs strictly more than
/// the fraction, i.e. floor(n*num/den)+1.
fn weight_or_ratio_to_count(value: &serde_json::Value, council_size: usize) -> Result<u64, String> {
    if let Some(n) = parse_u128_value(value) {
        return u64::try_from(n)
            .map_err(|_| "DAO vote threshold Weight is too large".to_string());
    }
    if let Some(pair) = value.as_array() {
        if pair.len() == 2 {
            let num = parse_u128_value(&pair[0]);
            let den = parse_u128_value(&pair[1]);
            if let (Some(num), Some(den)) = (num, den) {
                if den == 0 {
                    return Err("DAO vote threshold ratio has a zero denominator".to_string());
                }
                let count = (council_size as u128)
                    .checked_mul(num)
                    .and_then(|p| p.checked_div(den))
                    .and_then(|q| q.checked_add(1))
                    .and_then(|c| u64::try_from(c).ok())
                    .ok_or_else(|| "DAO vote threshold ratio overflowed".to_string())?;
                return Ok(count);
            }
        }
    }
    if let Some(weight) = value.get("Weight") {
        return parse_u128_value(weight)
            .and_then(|n| u64::try_from(n).ok())
            .ok_or_else(|| "DAO vote threshold Weight is not a number".to_string());
    }
    for key in ["RoleWeight", "Ratio"] {
        if let Some(frac) = value.get(key) {
            return weight_or_ratio_to_count(frac, council_size);
        }
    }
    Err("DAO vote threshold is not a number or ratio".to_string())
}

/// A U128 serialised as a JSON string ("2") or a JSON number (2).
fn parse_u128_value(value: &serde_json::Value) -> Option<u128> {
    if let Some(s) = value.as_str() {
        return s.parse::<u128>().ok();
    }
    value.as_u64().map(|n| n as u128)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn members4() -> Vec<AccountId> {
        vec![
            acc("alice.testnet"),
            acc("bob.testnet"),
            acc("carol.testnet"),
            acc("dave.testnet"),
        ]
    }

    /// The live v3 DAO policy shape (lagos-energy3.testnet, fetched
    /// 2026-11-09), re-thresholded to the v4 strict majority of 3.
    fn live_policy(threshold: &str, council: &[&str]) -> String {
        let group: Vec<String> = council.iter().map(|m| format!("\"{}\"", m)).collect();
        format!(
            r#"{{"roles":[{{"name":"all","kind":"Everyone","permissions":["*:AddProposal"],"vote_policy":{{}}}},{{"name":"council","kind":{{"Group":[{}]}},"permissions":["*:*"],"vote_policy":{{}}}}],"default_vote_policy":{{"weight_kind":"RoleWeight","quorum":"0","threshold":"{}"}},"proposal_bond":"1000000000000000000000000","proposal_period":"604800000000000","bounty_bond":"1000000000000000000000000","bounty_forgiveness_period":"86400000000000"}}"#,
            group.join(","),
            threshold
        )
    }

    #[test]
    fn threshold_formula_is_strict_majority() {
        assert_eq!(dao_threshold(3), 2);
        assert_eq!(dao_threshold(4), 3);
        assert_eq!(dao_threshold(5), 3);
        assert_eq!(dao_threshold(6), 4);
        assert_eq!(dao_threshold(20), 11);
    }

    #[test]
    fn dao_policy_accepts_live_shape_with_majority_threshold() {
        let json = live_policy(
            "3",
            &["carol.testnet", "alice.testnet", "dave.testnet", "bob.testnet"],
        );
        assert!(validate_dao_policy(json.as_bytes(), &members4()).is_ok());
    }

    #[test]
    fn dao_policy_rejects_live_v3_threshold_two_of_four() {
        // The v3 demo DAO (threshold 2 of 4) is NOT a strict majority:
        // v4 refuses it, so the demo must deploy a fresh DAO at 3.
        let json = live_policy(
            "2",
            &["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet"],
        );
        let err = validate_dao_policy(json.as_bytes(), &members4()).unwrap_err();
        assert!(err.contains("threshold is 2"), "unexpected error: {}", err);
        assert!(err.contains("requires 3"), "unexpected error: {}", err);
    }

    #[test]
    fn dao_policy_rejects_council_mismatch() {
        let json = live_policy(
            "3",
            &["alice.testnet", "bob.testnet", "carol.testnet", "mallory.testnet"],
        );
        let err = validate_dao_policy(json.as_bytes(), &members4()).unwrap_err();
        assert!(err.contains("council does not match"), "unexpected error: {}", err);
    }

    #[test]
    fn dao_policy_rejects_missing_council() {
        let json = r#"{"roles":[{"name":"all","kind":"Everyone","permissions":[],"vote_policy":{}}],"default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":"3"}}"#;
        let err = validate_dao_policy(json.as_bytes(), &members4()).unwrap_err();
        assert!(err.contains("no council role"), "unexpected error: {}", err);
    }

    #[test]
    fn dao_policy_rejects_non_group_council() {
        let json = r#"{"roles":[{"name":"council","kind":"Everyone","permissions":[],"vote_policy":{}}],"default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":"3"}}"#;
        let err = validate_dao_policy(json.as_bytes(), &members4()).unwrap_err();
        assert!(err.contains("not a Group"), "unexpected error: {}", err);
    }

    #[test]
    fn dao_policy_rejects_garbage_and_empty() {
        for json in ["", "not json", "{}", "[]", "{\"roles\":[]}"] {
            assert!(
                validate_dao_policy(json.as_bytes(), &members4()).is_err(),
                "{:?} must be rejected",
                json
            );
        }
    }

    #[test]
    fn dao_policy_accepts_ratio_threshold() {
        // Factory default Ratio(1,2) with 4 members: floor(4/2)+1 = 3.
        let json = r#"{"roles":[{"name":"council","kind":{"Group":["alice.testnet","bob.testnet","carol.testnet","dave.testnet"]},"permissions":["*:*"],"vote_policy":{}}],"default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":["1","2"]}}"#;
        assert!(validate_dao_policy(json.as_bytes(), &members4()).is_ok());
        // Ratio(1,3) with 4 members needs 2, not the majority 3.
        let json = r#"{"roles":[{"name":"council","kind":{"Group":["alice.testnet","bob.testnet","carol.testnet","dave.testnet"]},"permissions":["*:*"],"vote_policy":{}}],"default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":["1","3"]}}"#;
        assert!(validate_dao_policy(json.as_bytes(), &members4()).is_err());
    }

    #[test]
    fn dao_policy_accepts_role_vote_policy_over_default() {
        // Threshold on the council role itself wins over the default.
        let json = r#"{"roles":[{"name":"council","kind":{"Group":["alice.testnet","bob.testnet","carol.testnet","dave.testnet"]},"permissions":["*:*"],"vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":"3"}}],"default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":"2"}}"#;
        assert!(validate_dao_policy(json.as_bytes(), &members4()).is_ok());
    }

    #[test]
    fn dao_policy_rejects_token_weight() {
        let json = r#"{"roles":[{"name":"council","kind":{"Group":["alice.testnet","bob.testnet","carol.testnet","dave.testnet"]},"permissions":["*:*"],"vote_policy":{}}],"default_vote_policy":{"weight_kind":"TokenWeight","quorum":"0","threshold":"3"}}"#;
        let err = validate_dao_policy(json.as_bytes(), &members4()).unwrap_err();
        assert!(err.contains("TokenWeight"), "unexpected error: {}", err);
    }

    #[test]
    fn dao_policy_accepts_three_and_twenty_members() {
        let three = vec![acc("a.testnet"), acc("b.testnet"), acc("c.testnet")];
        let json = live_policy("2", &["a.testnet", "b.testnet", "c.testnet"]);
        assert!(validate_dao_policy(json.as_bytes(), &three).is_ok());
        let twenty: Vec<AccountId> =
            (0..20).map(|i| format!("m{:02}.testnet", i).parse().unwrap()).collect();
        let council: Vec<&str> = (0..20)
            .map(|i| match i {
                0 => "m00.testnet",
                1 => "m01.testnet",
                2 => "m02.testnet",
                3 => "m03.testnet",
                4 => "m04.testnet",
                5 => "m05.testnet",
                6 => "m06.testnet",
                7 => "m07.testnet",
                8 => "m08.testnet",
                9 => "m09.testnet",
                10 => "m10.testnet",
                11 => "m11.testnet",
                12 => "m12.testnet",
                13 => "m13.testnet",
                14 => "m14.testnet",
                15 => "m15.testnet",
                16 => "m16.testnet",
                17 => "m17.testnet",
                18 => "m18.testnet",
                _ => "m19.testnet",
            })
            .collect();
        let json = live_policy("11", &council);
        assert!(validate_dao_policy(json.as_bytes(), &twenty).is_ok());
    }
}
