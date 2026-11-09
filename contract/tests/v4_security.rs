// OwnGround v4 security integration tests — REAL end-to-end proofs
// against the compiled v4 WASM on a local near-workspaces sandbox.
//
// What this proves (each test is independent, own sandbox):
//  1. real Sputnik DAO happy path (council 4, threshold 3)
//  2. plain account as DAO is rejected (no community created)
//  3. council/member mismatch is rejected
//  4. wrong threshold (2 of 4, not strict majority 3) is rejected
//  5. adversarial revenue: 100 NEAR claim caps at 10 points, needs a
//     10.1 NEAR bond (0.2 NEAR is refused), and a DAO-upheld dispute
//     removes the points and forfeits the bond
//  6. dispute auto-resolve: anyone may resolve past the deadline, the
//     entry becomes Rejected and distributions unblock
//  7. payout failure: a deleted member's exact payout (ownership +
//     activity points) becomes claimable and claim_failed_payout pays
//     exactly that stored amount, never a recomputation
//  8. fuzzed community ids (XSS payloads, uppercase, underscore,
//     leading/trailing hyphen, 65 chars, empty, unicode) are rejected
//  9. a 2-member community is rejected (min 3)
//
// The Sputnik DAO is REAL, not a mock: `sputnik-v2.wasm` is the Sputnik
// v2 bytecode read off testnet via view_code from lagos-energy3.testnet
// (469,723 bytes, sha256 6e3f1814d40769d8f57b9a7af689d22aaab96d3232cec4d86
// 1311829c1d2318f — identical to the wasm in dao-log-v3.json, which was
// read from genesis.sputnikv2.testnet). Each DAO is deployed directly
// from that WASM and initialised with new() — the same direct-deploy
// route the live v3 demo DAO used (no factory; the DAO account keeps a
// full-access key in the sandbox, so DAO-gated calls are made as the DAO
// account itself, exactly as the live demo scripts did).
//
// Run with:
//   export PATH="$HOME/.cargo/bin:$PATH"
//   NEAR_SANDBOX_BIN_PATH=$HOME/.near/near-sandbox-2.14.0/near-sandbox \
//   LD_PRELOAD=$PWD/../hidden_files/fd-shim/setrlimit_shim.so \
//     cargo test --test v4_security -- --nocapture --test-threads=1
// The LD_PRELOAD shim is needed because this container caps the hard
// RLIMIT_NOFILE at 4096 and the sandbox binary refuses to start below
// 65535; the shim only fakes the limit check (see
// hidden_files/fd-shim/README.md). Without it the sandbox exits at
// startup and no test can run. The WASM must exist first:
// `cargo build --target wasm32-unknown-unknown --release` in contract/.
use near_workspaces::network::Sandbox;
use near_workspaces::result::{ExecutionFinalResult, ExecutionSuccess};
use near_workspaces::types::{AccountId, Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;

const OWNGROUND_WASM: &[u8] =
    include_bytes!("../target/wasm32-unknown-unknown/release/ownground.wasm");
const SPUTNIK_WASM: &[u8] = include_bytes!("sputnik-v2.wasm");
const N: u128 = 1_000_000_000_000_000_000_000_000;
const GAS: Gas = Gas::from_tgas(100);
/// 0.01 NEAR storage deposit, in yoctoNEAR.
const STORAGE: u128 = N / 100;
/// 60-second dispute window / timelock (the contract minimum).
const WINDOW_60S: u64 = 60_000_000_000;

fn y(n: u128) -> String {
    n.to_string()
}

fn policies() -> serde_json::Value {
    json!({
        "distribution_policy": { "members_bp": 6000, "treasury_bp": 2500, "maintenance_bp": 1500, "activity_bp": 1000 },
        "spending_policy": {
            "max_single_expense": y(N),
            "min_treasury_reserve": y(N),
            "allowed_categories": ["maintenance", "operations"],
        },
        "activity_policy": { "capital_per_near": 1, "work_per_revenue_record": 1, "work_per_revenue_near": 1 },
    })
}

fn community_args(
    id: &str,
    dao_id: &AccountId,
    members: &[AccountId],
) -> serde_json::Value {
    let mut a = json!({
        "id": id,
        "name": "Test Community",
        "description": "v4 security test community",
        "dao_id": dao_id,
        "members": members,
        "dispute_window_ns": WINDOW_60S,
        "timelock_ns": WINDOW_60S,
    });
    let p = policies();
    a.as_object_mut().unwrap().extend(
        p.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())),
    );
    a
}

/// One signed call; returns the final outcome (success or failure) so
/// tests can assert on either.
async fn call_tx(
    signer: &Account,
    cid: &AccountId,
    method: &str,
    args: serde_json::Value,
    deposit_yocto: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(signer
        .call(cid, method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit_yocto))
        .gas(GAS)
        .transact()
        .await?)
}

/// One signed call that must succeed; returns the success value.
async fn call_ok(
    signer: &Account,
    cid: &AccountId,
    method: &str,
    args: serde_json::Value,
    deposit_yocto: u128,
) -> anyhow::Result<ExecutionSuccess> {
    Ok(call_tx(signer, cid, method, args, deposit_yocto)
        .await?
        .into_result()?)
}

/// View call; Ok only when the contract returns a value.
async fn view(
    worker: &Worker<Sandbox>,
    cid: &AccountId,
    method: &str,
    args: serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    Ok(worker
        .view(cid, method)
        .args_json(args)
        .await?
        .json::<serde_json::Value>()?)
}

/// View call that returns None when the contract errors (e.g.
/// get_community on a community that was never created).
async fn view_opt(
    worker: &Worker<Sandbox>,
    cid: &AccountId,
    method: &str,
    args: serde_json::Value,
) -> Option<serde_json::Value> {
    worker
        .view(cid, method)
        .args_json(args)
        .await
        .ok()?
        .json::<serde_json::Value>()
        .ok()
}

async fn is_pending(worker: &Worker<Sandbox>, cid: &AccountId, id: &str) -> bool {
    view(worker, cid, "is_community_pending", json!({ "community_id": id }))
        .await
        .map(|v| v.as_bool().unwrap_or(false))
        .unwrap_or(false)
}

/// Poll get_community until the community appears (the on_dao_verified
/// callback lands a few seconds after create_community) or timeout.
async fn poll_created(
    worker: &Worker<Sandbox>,
    cid: &AccountId,
    id: &str,
) -> Option<serde_json::Value> {
    for _ in 0..60 {
        if let Some(c) = view_opt(worker, cid, "get_community", json!({ "community_id": id })).await
        {
            return Some(c);
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    None
}

/// Poll is_community_pending until it is false (callback ran, success
/// or failure) or timeout.
async fn poll_not_pending(worker: &Worker<Sandbox>, cid: &AccountId, id: &str) -> bool {
    for _ in 0..60 {
        if !is_pending(worker, cid, id).await {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    false
}

/// Deploy a REAL Sputnik v2 DAO from the on-chain WASM and initialise
/// it with the given council and absolute Weight threshold. Verifies
/// get_policy shows exactly that council and threshold before returning.
async fn deploy_dao(
    worker: &Worker<Sandbox>,
    council: &[&Account],
    threshold: &str,
    name: &str,
) -> anyhow::Result<Contract> {
    let dao = worker.dev_deploy(SPUTNIK_WASM).await?;
    let council_ids: Vec<String> = council.iter().map(|a| a.id().to_string()).collect();
    dao.as_account()
        .call(dao.id(), "new")
        .args_json(json!({
            "config": { "name": name, "purpose": "v4 security test DAO", "metadata": "" },
            "policy": {
                "roles": [
                    { "name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {} },
                    { "name": "council", "kind": { "Group": council_ids }, "permissions": ["*:*"], "vote_policy": {} },
                ],
                "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": threshold },
                "proposal_bond": "1000000000000000000000000",
                "proposal_period": "604800000000000",
                "bounty_bond": "1000000000000000000000000",
                "bounty_forgiveness_period": "86400000000000",
            },
        }))
        .deposit(NearToken::from_yoctonear(0))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let policy = view(worker, dao.id(), "get_policy", json!({})).await?;
    let roles = policy["roles"].as_array().expect("DAO policy has roles");
    let council_role = roles
        .iter()
        .find(|r| r["name"] == "council")
        .expect("DAO policy has a council role");
    let mut group: Vec<String> = council_role["kind"]["Group"]
        .as_array()
        .expect("council is a Group")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    group.sort();
    let mut expected = council_ids.clone();
    expected.sort();
    assert_eq!(group, expected, "DAO council is not the requested set");
    assert_eq!(
        policy["default_vote_policy"]["threshold"].as_str().unwrap(),
        threshold,
        "DAO threshold is not the requested value"
    );
    Ok(dao)
}

/// Deploy OwnGround and run its `new()` initializer (dev_deploy only
/// installs the code; the contract refuses every call until `new`).
async fn deploy_ownground(worker: &Worker<Sandbox>) -> anyhow::Result<Contract> {
    let contract = worker.dev_deploy(OWNGROUND_WASM).await?;
    contract
        .call("new")
        .args_json(json!({}))
        .deposit(NearToken::from_yoctonear(0))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(contract)
}

struct Four {
    worker: Worker<Sandbox>,
    contract: Contract,
    alice: Account,
    bob: Account,
    carol: Account,
    dave: Account,
    seller: Account,
    dao: Contract,
    members: Vec<AccountId>,
}

impl Four {
    fn cid(&self) -> AccountId {
        self.contract.id().clone()
    }
    fn dao_acct(&self) -> &Account {
        self.dao.as_account()
    }
}

/// Fresh sandbox + OwnGround + real Sputnik DAO (council = the 4
/// members, threshold 3) + a created, verified community.
async fn setup_four(community_id: &str) -> anyhow::Result<Four> {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_ownground(&worker).await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let dave = worker.dev_create_account().await?;
    let seller = worker.dev_create_account().await?;
    let members = vec![
        alice.id().clone(),
        bob.id().clone(),
        carol.id().clone(),
        dave.id().clone(),
    ];
    let dao = deploy_dao(&worker, &[&alice, &bob, &carol, &dave], "3", "test-dao").await?;
    let cid = contract.id().clone();
    call_ok(
        &alice,
        &cid,
        "create_community",
        community_args(community_id, dao.id(), &members),
        N / 10,
    )
    .await?;
    let created = poll_created(&worker, &cid, community_id).await;
    assert!(
        created.is_some(),
        "community {} was not created after DAO verification",
        community_id
    );
    Ok(Four { worker, contract, alice, bob, carol, dave, seller, dao, members })
}

/// Fund a 10 NEAR campaign (2.5 NEAR each) and acquire the asset via
/// the DAO. Returns (campaign_id, asset_id).
async fn setup_asset(f: &Four, community_id: &str) -> anyhow::Result<(String, String)> {
    let cid = f.cid();
    let deadline = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos() as u64
        + 86_400_000_000_000;
    let campaign_id: String = call_ok(
        &f.alice,
        &cid,
        "create_campaign",
        json!({
            "community_id": community_id,
            "asset_name": "Generator",
            "category": "energy",
            "target": y(10 * N),
            "deadline": deadline,
        }),
        5 * N / 100,
    )
    .await?
    .json()?;
    for m in [&f.alice, &f.bob, &f.carol, &f.dave] {
        call_ok(
            m,
            &cid,
            "contribute",
            json!({ "campaign_id": campaign_id }),
            25 * N / 10 + STORAGE,
        )
        .await?;
    }
    let campaign = view(&f.worker, &cid, "get_campaign", json!({ "campaign_id": campaign_id })).await?;
    assert_eq!(campaign["raised"], y(10 * N));
    assert_eq!(campaign["status"], "Funded");
    let asset_id: String = call_ok(
        f.dao_acct(),
        &cid,
        "acquire_asset",
        json!({
            "campaign_id": campaign_id,
            "seller": f.seller.id(),
            "allocation": [
                [f.alice.id().to_string(), 2500],
                [f.bob.id().to_string(), 2500],
                [f.carol.id().to_string(), 2500],
                [f.dave.id().to_string(), 2500],
            ],
        }),
        STORAGE,
    )
    .await?
    .json()?;
    Ok((campaign_id, asset_id))
}

/// Advance sandbox time past a 60s window: fast-forward 70 blocks,
/// which moves block timestamps forward; the wall-clock sleep is only
/// a fallback if the gated call still reports the deadline unpassed
/// (the sandbox's block timestamps may track wall time instead).
async fn advance_past_60s(worker: &Worker<Sandbox>) {
    worker.fast_forward(70).await.expect("fast_forward");
    std::thread::sleep(std::time::Duration::from_secs(2));
}

/// 1. Real Sputnik DAO happy path: council 4, threshold 3.
#[tokio::test]
async fn v4_real_dao_happy_path() -> anyhow::Result<()> {
    let f = setup_four("happy-path").await?;
    let c = view(&f.worker, &f.cid(), "get_community", json!({ "community_id": "happy-path" })).await?;
    assert_eq!(c["dao_id"], f.dao.id().to_string());
    let mut got: Vec<String> = c["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    got.sort();
    let mut want: Vec<String> = f.members.iter().map(|a| a.to_string()).collect();
    want.sort();
    assert_eq!(got, want, "community members are exactly the DAO council");
    assert_eq!(c["policy"]["members_bp"], 6000);
    println!("happy path: community created via real Sputnik DAO {}", f.dao.id());
    Ok(())
}

/// 2. A plain sandbox account as dao_id is rejected: the get_policy
/// cross-contract call fails, the callback removes the pending record,
/// and no community ever appears.
#[tokio::test]
async fn v4_eoa_as_dao_rejected() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_ownground(&worker).await?;
    let eoa = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let dave = worker.dev_create_account().await?;
    let members = vec![alice.id().clone(), bob.id().clone(), carol.id().clone(), dave.id().clone()];
    let cid = contract.id().clone();
    // The create call itself succeeds (it returns a Promise); the
    // rejection happens in the on_dao_verified callback.
    call_ok(&alice, &cid, "create_community", community_args("eoa-dao", eoa.id(), &members), N / 10).await?;
    assert!(poll_not_pending(&worker, &cid, "eoa-dao").await, "pending record never cleared");
    assert!(
        view_opt(&worker, &cid, "get_community", json!({ "community_id": "eoa-dao" })).await.is_none(),
        "EOA-as-DAO must not create a community"
    );
    println!("EOA as DAO rejected: no community created");
    Ok(())
}

/// 3. Council/member mismatch is rejected: DAO council includes
/// mallory, community members include dave instead.
#[tokio::test]
async fn v4_council_mismatch_rejected() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_ownground(&worker).await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let dave = worker.dev_create_account().await?;
    let mallory = worker.dev_create_account().await?;
    let cid = contract.id().clone();
    let dao = deploy_dao(&worker, &[&alice, &bob, &carol, &mallory], "3", "mismatch-dao").await?;
    let members = vec![alice.id().clone(), bob.id().clone(), carol.id().clone(), dave.id().clone()];
    call_ok(&alice, &cid, "create_community", community_args("mismatch", dao.id(), &members), N / 10).await?;
    assert!(poll_not_pending(&worker, &cid, "mismatch").await, "pending record never cleared");
    assert!(
        view_opt(&worker, &cid, "get_community", json!({ "community_id": "mismatch" })).await.is_none(),
        "council/member mismatch must not create a community"
    );
    println!("council/member mismatch rejected: no community created");
    Ok(())
}

/// 4. Wrong threshold is rejected: DAO council of 4 with threshold 2
/// is not the strict majority (3) v4 requires.
#[tokio::test]
async fn v4_wrong_threshold_rejected() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_ownground(&worker).await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let dave = worker.dev_create_account().await?;
    let cid = contract.id().clone();
    let dao = deploy_dao(&worker, &[&alice, &bob, &carol, &dave], "2", "threshold-dao").await?;
    let members = vec![alice.id().clone(), bob.id().clone(), carol.id().clone(), dave.id().clone()];
    call_ok(&alice, &cid, "create_community", community_args("bad-threshold", dao.id(), &members), N / 10).await?;
    assert!(poll_not_pending(&worker, &cid, "bad-threshold").await, "pending record never cleared");
    assert!(
        view_opt(&worker, &cid, "get_community", json!({ "community_id": "bad-threshold" })).await.is_none(),
        "threshold 2 of 4 must not create a community"
    );
    println!("wrong threshold (2 of 4) rejected: no community created");
    Ok(())
}

/// 5. Adversarial revenue: a 100 NEAR reported claim needs a 10.1 NEAR
/// bond (0.2 NEAR is refused), awards at most 10 points, and when two
/// colluding members attest it and a third disputes, a DAO uphold
/// removes the points and forfeits the bond to the treasury.
#[tokio::test]
async fn v4_adversarial_revenue_bond_and_cap() -> anyhow::Result<()> {
    let f = setup_four("adversarial").await?;
    let cid = f.cid();
    let (_campaign, asset) = setup_asset(&f, "adversarial").await?;
    // bob (recorder) reports a 100 NEAR claim; alice (attestor) first
    // tries the old flat 0.2 NEAR — the proportional bond is
    // 0.1 + 100/10 = 10.1 NEAR, so 0.2 + 0.01 storage must fail.
    call_ok(&f.bob, &cid, "record_revenue",
        json!({ "asset_id": asset, "amount": y(100 * N), "source": "Cash rental", "reference": "adv-001" }), STORAGE).await?;
    let cheap = call_tx(&f.alice, &cid, "attest_revenue",
        json!({ "asset_id": asset, "entry_id": 0 }), 21 * N / 100).await?;
    assert!(cheap.is_failure(), "0.2 NEAR bond must not attest a 100 NEAR claim");
    let failures = format!("{:?}", cheap.failures());
    assert!(failures.contains("attestation must attach the bond"), "failure names the bond rule: {}", failures);
    // Correct bond: 10.1 NEAR + 0.01 storage.
    call_ok(&f.alice, &cid, "attest_revenue",
        json!({ "asset_id": asset, "entry_id": 0 }), 1011 * N / 100).await?;
    let revenue = view(&f.worker, &cid, "get_revenue", json!({ "asset_id": asset })).await?;
    assert_eq!(revenue[0]["status"], "Verified");
    // 1 + 100 per-NEAR points would be 101 without the cap; v4 caps at 10.
    assert_eq!(revenue[0]["points_awarded"], 10, "work points capped at 10 per entry");
    assert_eq!(revenue[0]["bond_amount"], y(101 * N / 10), "bond is 0.1 + 10% of 100 NEAR");
    let activity = view(&f.worker, &cid, "get_activity", json!({ "asset_id": asset })).await?;
    let bob_points = activity["work_points"].as_array().unwrap().iter()
        .find(|p| p[0] == f.bob.id().to_string())
        .map(|p| p[1]["current"].as_u64().unwrap()).unwrap_or(0);
    assert_eq!(bob_points, 10, "bob holds exactly the capped 10 points");
    // carol (neither recorder nor attestor) disputes; the DAO upholds.
    call_ok(&f.carol, &cid, "dispute_revenue",
        json!({ "asset_id": asset, "entry_id": 0 }), 6 * N / 100).await?;
    call_ok(f.dao_acct(), &cid, "resolve_dispute",
        json!({ "asset_id": asset, "entry_id": 0, "uphold": true }), STORAGE).await?;
    let revenue = view(&f.worker, &cid, "get_revenue", json!({ "asset_id": asset })).await?;
    assert_eq!(revenue[0]["status"], "Rejected");
    assert_eq!(revenue[0]["bond_status"], "Forfeited", "attestor bond forfeited on uphold");
    assert_eq!(revenue[0]["dispute_bond_status"], "Released", "disputer bond returned on uphold");
    let activity = view(&f.worker, &cid, "get_activity", json!({ "asset_id": asset })).await?;
    let bob_points = activity["work_points"].as_array().unwrap().iter()
        .find(|p| p[0] == f.bob.id().to_string())
        .map(|p| p[1]["current"].as_u64().unwrap()).unwrap_or(0);
    assert_eq!(bob_points, 0, "upheld dispute removes the recorder's points");
    let treasury = view(&f.worker, &cid, "get_treasury", json!({ "community_id": "adversarial" })).await?;
    assert_eq!(treasury["total_revenue"], y(101 * N / 10), "forfeited 10.1 NEAR bond is treasury revenue");
    assert_eq!(treasury["total_bonds_held"], "0");
    println!("adversarial revenue: 100 NEAR claim capped at 10 pts, 10.1 NEAR bond, uphold forfeits bond + removes points");
    Ok(())
}

/// 6. Dispute auto-resolve: after disputed_at + dispute_window, ANYONE
/// (here the seller, an outsider) may resolve as UPHOLD; the entry
/// becomes Rejected and execute_distribution is no longer blocked.
#[tokio::test]
async fn v4_dispute_auto_resolve_unblocks_distribution() -> anyhow::Result<()> {
    let f = setup_four("auto-resolve").await?;
    let cid = f.cid();
    let (_campaign, asset) = setup_asset(&f, "auto-resolve").await?;
    // 3 NEAR real money in, so a distribution has something to pay.
    call_ok(&f.alice, &cid, "record_revenue",
        json!({ "asset_id": asset, "amount": y(3 * N), "source": "Rental", "reference": "auto-001" }), 3 * N + STORAGE).await?;
    // bob reports 1 NEAR, carol attests (0.21 NEAR bond), dave disputes.
    call_ok(&f.bob, &cid, "record_revenue",
        json!({ "asset_id": asset, "amount": y(N), "source": "Rental", "reference": "auto-002" }), STORAGE).await?;
    call_ok(&f.carol, &cid, "attest_revenue",
        json!({ "asset_id": asset, "entry_id": 1 }), 21 * N / 100).await?;
    call_ok(&f.dave, &cid, "dispute_revenue",
        json!({ "asset_id": asset, "entry_id": 1 }), 6 * N / 100).await?;
    // Distribution is blocked while the dispute is open.
    let blocked = call_tx(&f.alice, &cid, "execute_distribution",
        json!({ "asset_id": asset }), STORAGE).await?;
    assert!(blocked.is_failure(), "distribution must be blocked by an open dispute");
    assert!(format!("{:?}", blocked.failures()).contains("distribution blocked"));
    // Wait out the 60s window, then an outsider auto-resolves.
    advance_past_60s(&f.worker).await;
    let mut resolved = call_tx(&f.seller, &cid, "resolve_dispute_expired",
        json!({ "asset_id": asset, "entry_id": 1 }), 0).await?;
    if resolved.is_failure() {
        std::thread::sleep(std::time::Duration::from_secs(65));
        resolved = call_tx(&f.seller, &cid, "resolve_dispute_expired",
            json!({ "asset_id": asset, "entry_id": 1 }), 0).await?;
    }
    assert!(resolved.is_success(), "outsider auto-resolve must succeed past the deadline: {:?}", resolved.failures());
    let revenue = view(&f.worker, &cid, "get_revenue", json!({ "asset_id": asset })).await?;
    assert_eq!(revenue[1]["status"], "Rejected", "auto-resolve upholds: entry Rejected");
    assert_eq!(revenue[1]["bond_status"], "Forfeited");
    // D = 3 NEAR onchain + 0.2 NEAR forfeited bond (the bond itself;
    // the 0.01 storage attached to the attestation is not bond money).
    let dist = call_ok(&f.alice, &cid, "execute_distribution",
        json!({ "asset_id": asset }), STORAGE).await?.json::<serde_json::Value>()?;
    assert_eq!(dist["distributed"], y(320 * N / 100), "D = 3 + 0.2 forfeited bond");
    println!("auto-resolve: outsider resolved past deadline, entry Rejected, distribution paid 3.2 NEAR");
    Ok(())
}

/// 7. Payout failure with activity points: dave's account is deleted
/// before the distribution, so his payout transfer fails; the exact
/// original amount (ownership + activity) must be claimable, and
/// claim_failed_payout must pay exactly that stored amount.
#[tokio::test]
async fn v4_failed_payout_is_claimable_exact() -> anyhow::Result<()> {
    let f = setup_four("failed-payout").await?;
    let cid = f.cid();
    let (_campaign, asset) = setup_asset(&f, "failed-payout").await?;
    call_ok(&f.alice, &cid, "record_revenue",
        json!({ "asset_id": asset, "amount": y(3 * N), "source": "Rental", "reference": "fail-001" }), 3 * N + STORAGE).await?;
    // dave reports 1 NEAR, carol attests: dave earns 2 work points.
    call_ok(&f.dave, &cid, "record_revenue",
        json!({ "asset_id": asset, "amount": y(N), "source": "Rental", "reference": "fail-002" }), STORAGE).await?;
    call_ok(&f.carol, &cid, "attest_revenue",
        json!({ "asset_id": asset, "entry_id": 1 }), 21 * N / 100).await?;
    // Wait out the dispute window, then delete dave's account so his
    // payout transfer fails. Keep his key to recreate the same id.
    advance_past_60s(&f.worker).await;
    let dave_id = f.dave.id().clone();
    let dave_key = f.dave.secret_key().clone();
    let dave_prefix = dave_id
        .as_str()
        .strip_suffix(".test.near")
        .expect("dev account is a test.near subaccount")
        .parse::<AccountId>()?;
    f.dave.delete_account(f.alice.id()).await?.into_result()?;
    // Deletion must have taken effect before distributing.
    assert!(f.worker.view_account(&dave_id).await.is_err(), "dave's account must be deleted before the distribution");
    // D = 3 NEAR. Member pool 1.8 NEAR; activity pool 0.18 NEAR (all
    // dave's, 2 points), ownership pool 1.62 NEAR (0.405 each).
    // Dave's exact payout: 0.405 + 0.18 = 0.585 NEAR.
    let expected_dave: u128 = 585 * N / 1000;
    let mut dist_res = call_tx(&f.alice, &cid, "execute_distribution",
        json!({ "asset_id": asset }), STORAGE).await?;
    if dist_res.is_failure() && format!("{:?}", dist_res.failures()).contains("distribution blocked") {
        // Sandbox block timestamps may track wall time, not
        // fast-forward: wait out the window in real time and retry.
        std::thread::sleep(std::time::Duration::from_secs(65));
        dist_res = call_tx(&f.alice, &cid, "execute_distribution",
            json!({ "asset_id": asset }), STORAGE).await?;
    }
    let dist = dist_res.into_result()?.json::<serde_json::Value>()?;
    assert_eq!(dist["distributed"], y(3 * N));
    // The payout transfers and their on_payout_complete callbacks run
    // as receipts AFTER the execute_distribution call returns, so the
    // returned record's `unpaid` list is still empty at this point.
    // Poll the stored record until the failed payout is reconciled.
    let mut unpaid_has_dave = false;
    for _ in 0..30 {
        let dists = view(&f.worker, &cid, "get_distributions", json!({ "asset_id": asset })).await?;
        if dists[0]["unpaid"].as_array().unwrap().iter().any(|a| a.as_str() == Some(dave_id.as_str())) {
            unpaid_has_dave = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    assert!(unpaid_has_dave, "deleted dave must be listed unpaid once callbacks land");
    let claims = view(&f.worker, &cid, "get_claimable_payouts", json!({ "account": dave_id })).await?;
    assert_eq!(claims.as_array().unwrap().len(), 1, "exactly one claimable payout for dave");
    assert_eq!(claims[0]["distribution_id"], 0);
    assert_eq!(claims[0]["amount"], y(expected_dave), "claimable amount is the exact original split (0.585 NEAR)");
    // A non-recipient cannot claim dave's payout.
    let stranger = call_tx(&f.alice, &cid, "claim_failed_payout",
        json!({ "distribution_id": 0 }), STORAGE).await?;
    assert!(stranger.is_failure(), "only the original recipient may claim");
    // Recreate dave's account with the same id and key, then claim.
    let dave2 = f.worker.create_root_account_subaccount(dave_prefix, dave_key).await?.into_result()?;
    assert_eq!(dave2.id(), &dave_id);
    let before = dave2.view_account().await?.balance.as_yoctonear();
    let claim_res = call_tx(&dave2, &cid, "claim_failed_payout", json!({ "distribution_id": 0 }), STORAGE).await?;
    // Gas this tx burnt, summed over the tx and its receipts (read
    // before into_result consumes the outcome).
    let gas_cost: u128 = claim_res
        .outcomes()
        .iter()
        .map(|o| o.tokens_burnt.as_yoctonear())
        .sum();
    claim_res.into_result()?;
    // The transfer receipt can lag the tx's final status in the
    // sandbox: an immediate balance read caught a mid-settlement
    // value (100.4773 NEAR). Wait, then read the settled balance.
    std::thread::sleep(std::time::Duration::from_secs(5));
    let after = dave2.view_account().await?.balance.as_yoctonear();
    // Exact balance reconciliation: the claim pays the stored 0.585
    // NEAR, less the 0.01 storage deposit and the gas this tx burnt.
    assert_eq!(
        after as i128 - before as i128,
        expected_dave as i128 - STORAGE as i128 - gas_cost as i128,
        "claim must pay exactly 0.585 NEAR (gas burnt was {} yocto)",
        gas_cost
    );
    let claims = view(&f.worker, &cid, "get_claimable_payouts", json!({ "account": dave_id })).await?;
    assert!(claims.as_array().unwrap().is_empty(), "claim is consumed");
    let dists = view(&f.worker, &cid, "get_distributions", json!({ "asset_id": asset })).await?;
    assert!(dists[0]["unpaid"].as_array().unwrap().is_empty(), "unpaid list cleared");
    println!("failed payout: dave's exact 0.585 NEAR claimed after account recreation");
    Ok(())
}

/// 8. Fuzz community ids: every malicious shape is rejected at the
/// create call, and a well-formed id with the same DAO still succeeds.
#[tokio::test]
async fn v4_fuzz_community_ids() -> anyhow::Result<()> {
    let f = setup_four("fuzz-base").await?;
    let cid = f.cid();
    let mut bad: Vec<String> = [
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
        "lagos'",
        "a/b",
        "a\\b",
        "a;b",
        "lagos-énergie",
        "A",
        "a--b--c--",
        "--a",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    bad.push("a".repeat(65));
    for id in &bad {
        let res = call_tx(&f.alice, &cid, "create_community",
            community_args(id, f.dao.id(), &f.members), N / 10).await?;
        assert!(res.is_failure(), "id {:?} must be rejected", id);
        assert!(!is_pending(&f.worker, &cid, id).await, "rejected id {:?} must leave no pending record", id);
        assert!(
            view_opt(&f.worker, &cid, "get_community", json!({ "community_id": id })).await.is_none(),
            "rejected id {:?} must never appear", id
        );
    }
    // Positive control: a well-formed id with the same DAO succeeds.
    call_ok(&f.alice, &cid, "create_community",
        community_args("fuzz-control-ok", f.dao.id(), &f.members), N / 10).await?;
    assert!(
        poll_created(&f.worker, &cid, "fuzz-control-ok").await.is_some(),
        "well-formed id must still be accepted"
    );
    println!("fuzz: {} malicious ids rejected, well-formed control accepted", bad.len());
    Ok(())
}

/// 9. Min members: a 2-member community is rejected at the create call.
#[tokio::test]
async fn v4_min_members_rejected() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_ownground(&worker).await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let dave = worker.dev_create_account().await?;
    let cid = contract.id().clone();
    let dao = deploy_dao(&worker, &[&alice, &bob, &carol, &dave], "3", "min-dao").await?;
    let two = vec![alice.id().clone(), bob.id().clone()];
    let res = call_tx(&alice, &cid, "create_community",
        community_args("two-members", dao.id(), &two), N / 10).await?;
    assert!(res.is_failure(), "2-member community must be rejected");
    assert!(format!("{:?}", res.failures()).contains("at least 3 members"),
        "failure names the min-members rule: {:?}", res.failures());
    assert!(!is_pending(&worker, &cid, "two-members").await);
    assert!(view_opt(&worker, &cid, "get_community", json!({ "community_id": "two-members" })).await.is_none());
    println!("min members: 2-member community rejected");
    Ok(())
}
