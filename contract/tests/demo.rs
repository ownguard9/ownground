// OwnGround integration test: the full Lagos Energy Cooperative demo
// flow on a near-workspaces local sandbox chain. No real wallet, no
// testnet, no Sputnik deployment: the contract's DAO check is
// `caller == dao_id`, so a plain sandbox account plays the DAO.
//
// The wasm must exist first: run `cargo build --target
// wasm32-unknown-unknown --release` in contract/ (or `cargo near
// build` from a TTY). Run with: cargo test --test demo
//
// The sandbox binary is downloaded by near-workspaces at build time.
// Its Rust downloader ignores the proxy, so if that download fails,
// fetch the tarball with curl instead and point the build at it:
//   NEAR_SANDBOX_BIN_PATH=~/.near/near-sandbox-2.14.0/near-sandbox cargo test --test demo
// The node itself needs the file-descriptor limit raised to 65535;
// it cannot start in a container capped at 4096.
//
// The demo timelock is 2 minutes; the test uses a 1-nanosecond timelock
// so the amendment is executable on the next block. The deadline path
// itself (execute before the deadline is rejected) is covered by the
// unit tests; this test covers the full flow end to end.
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

const WASM: &[u8] = include_bytes!(
    "../target/wasm32-unknown-unknown/release/ownground.wasm"
);
const N: u128 = 1_000_000_000_000_000_000_000_000;
const COMMUNITY: &str = "lagos-energy-cooperative";
const ASSET: &str = "generator";
const GAS: Gas = Gas::from_tgas(100);
const STORAGE: NearToken = NearToken::from_yoctonear(10_000_000_000_000_000_000_000);

fn y(n: u128) -> String {
    n.to_string()
}

#[tokio::test]
async fn lagos_energy_cooperative_demo() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(WASM).await?;
    let dao = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let dave = worker.dev_create_account().await?;
    let seller = worker.dev_create_account().await?;
    let members = vec![
        alice.id().to_string(),
        bob.id().to_string(),
        carol.id().to_string(),
        dave.id().to_string(),
    ];
    let cid = contract.id();

    // 1. Create the community (founding policies set here).
    alice
        .call(cid, "create_community")
        .args_json(json!({
            "id": COMMUNITY,
            "name": "Lagos Energy Cooperative",
            "description": "Neighbours owning a generator together",
            "dao_id": dao.id(),
            "members": members,
            "distribution_policy": { "members_bp": 6000, "treasury_bp": 2500, "maintenance_bp": 1500, "activity_bp": 1000 },
            "spending_policy": {
                "max_single_expense": y(N),
                "min_treasury_reserve": y(N),
                "allowed_categories": ["maintenance", "operations"],
            },
            "activity_policy": { "capital_per_near": 1, "work_per_revenue_record": 1, "work_per_revenue_near": 1 },
            "dispute_window_ns": 300_000_000_000u64,
            "timelock_ns": 1u64,
        }))
        .deposit(NearToken::from_yoctonear(N / 10))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;

    // 2. Create the generator campaign, target 10 NEAR.
    let deadline = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos() as u64
        + 86_400_000_000_000;
    alice
        .call(cid, "create_campaign")
        .args_json(json!({
            "community_id": COMMUNITY,
            "asset_name": "Generator",
            "category": "energy",
            "target": y(10 * N),
            "deadline": deadline,
        }))
        .deposit(NearToken::from_yoctonear(5 * N / 100))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;

    // 3. Four members contribute 2.5 NEAR each.
    for m in [&alice, &bob, &carol, &dave] {
        m.call(cid, "contribute")
            .args_json(json!({ "campaign_id": ASSET }))
            .deposit(NearToken::from_yoctonear(25 * N / 10 + N / 100))
            .gas(GAS)
            .transact()
            .await?
            .into_result()?;
    }
    let campaign: serde_json::Value = worker
        .view(cid, "get_campaign")
        .args_json(json!({ "campaign_id": ASSET }))
        .await?
        .json()?;
    assert_eq!(campaign["raised"], y(10 * N));
    assert_eq!(campaign["status"], "Funded");

    // 4. DAO acquires the generator; the seller receives exactly 10 NEAR.
    let seller_before = seller.view_account().await?.balance;
    dao.call(cid, "acquire_asset")
        .args_json(json!({ "campaign_id": ASSET, "seller": seller.id() }))
        .deposit(STORAGE)
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let seller_after = seller.view_account().await?.balance;
    assert_eq!(
        seller_after.as_yoctonear() - seller_before.as_yoctonear(),
        10 * N,
        "seller receives exactly 10 NEAR"
    );
    let asset: serde_json::Value = worker
        .view(cid, "get_asset")
        .args_json(json!({ "asset_id": ASSET }))
        .await?
        .json()?;
    assert_eq!(asset["value"], y(10 * N));
    assert_eq!(asset["seller"], seller.id().to_string());

    // 5. Alice records 3 NEAR onchain revenue: 4 work points.
    alice
        .call(cid, "record_revenue")
        .args_json(json!({
            "asset_id": ASSET, "amount": y(3 * N),
            "source": "Generator rental", "reference": "invoice-001",
        }))
        .deposit(NearToken::from_yoctonear(3 * N + N / 100))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let revenue: serde_json::Value = worker
        .view(cid, "get_revenue")
        .args_json(json!({ "asset_id": ASSET }))
        .await?
        .json()?;
    assert_eq!(revenue[0]["status"], "Onchain");
    assert_eq!(revenue[0]["points_awarded"], 4);

    // 6. Bob records 1 NEAR reported revenue: no points (proof 3).
    bob.call(cid, "record_revenue")
        .args_json(json!({
            "asset_id": ASSET, "amount": y(N),
            "source": "Generator rental", "reference": "invoice-002",
        }))
        .deposit(STORAGE)
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let revenue: serde_json::Value = worker
        .view(cid, "get_revenue")
        .args_json(json!({ "asset_id": ASSET }))
        .await?
        .json()?;
    assert_eq!(revenue[1]["status"], "Pending");
    assert_eq!(revenue[1]["points_awarded"], 0);

    // 7. Alice attests bob's entry with a 0.1 NEAR bond (proof 4).
    alice
        .call(cid, "attest_revenue")
        .args_json(json!({ "asset_id": ASSET, "entry_id": 1 }))
        .deposit(NearToken::from_yoctonear(N / 10 + N / 100))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let revenue: serde_json::Value = worker
        .view(cid, "get_revenue")
        .args_json(json!({ "asset_id": ASSET }))
        .await?
        .json()?;
    assert_eq!(revenue[1]["status"], "Verified");
    assert_eq!(revenue[1]["points_awarded"], 2);
    let treasury: serde_json::Value = worker
        .view(cid, "get_treasury")
        .args_json(json!({ "community_id": COMMUNITY }))
        .await?
        .json()?;
    assert_eq!(treasury["total_bonds_held"], y(N / 10));

    // 8. A 2 NEAR expense is rejected onchain with the spending-policy
    // reason (proof 2); the treasury is unchanged.
    let bad = dao
        .call(cid, "pay_expense")
        .args_json(json!({
            "asset_id": ASSET, "amount": y(2 * N), "recipient": "ops.testnet",
            "description": "Oversized service bill", "category": "operations",
        }))
        .deposit(STORAGE)
        .gas(GAS)
        .transact()
        .await?;
    assert!(bad.is_failure(), "over-cap expense must fail");
    let failures = format!("{:?}", bad.failures());
    assert!(
        failures.contains("expense exceeds max_single_expense"),
        "failure names the rule: {}",
        failures
    );
    let treasury: serde_json::Value = worker
        .view(cid, "get_treasury")
        .args_json(json!({ "community_id": COMMUNITY }))
        .await?
        .json()?;
    assert_eq!(treasury["total_expenses"], "0");
    assert_eq!(treasury["treasury"], y(3 * N));

    // 9. A 0.5 NEAR operations expense succeeds (proof 1).
    dao.call(cid, "pay_expense")
        .args_json(json!({
            "asset_id": ASSET, "amount": y(5 * N / 10), "recipient": "ops.testnet",
            "description": "Generator service", "category": "operations",
        }))
        .deposit(STORAGE)
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let treasury: serde_json::Value = worker
        .view(cid, "get_treasury")
        .args_json(json!({ "community_id": COMMUNITY }))
        .await?
        .json()?;
    assert_eq!(treasury["total_expenses"], y(5 * N / 10));
    assert_eq!(treasury["treasury"], y(25 * N / 10));

    // 10. DAO proposes raising the spending cap from 1 to 2 NEAR.
    dao.call(cid, "propose_policy_change")
        .args_json(json!({
            "community_id": COMMUNITY,
            "policy_type": "Spending",
            "new_params": { "Spending": {
                "max_single_expense": y(2 * N),
                "min_treasury_reserve": y(N),
                "allowed_categories": ["maintenance", "operations"],
            } },
        }))
        .deposit(STORAGE)
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let policies: serde_json::Value = worker
        .view(cid, "get_policies")
        .args_json(json!({ "community_id": COMMUNITY }))
        .await?
        .json()?;
    assert_eq!(policies["amendments"][0]["status"], "Pending");
    assert_eq!(policies["spending"]["max_single_expense"], y(N));

    // 11. Carol disputes bob's attested entry: bob's points suspend.
    carol
        .call(cid, "dispute_revenue")
        .args_json(json!({ "asset_id": ASSET, "entry_id": 1 }))
        .deposit(STORAGE)
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let activity: serde_json::Value = worker
        .view(cid, "get_activity")
        .args_json(json!({ "asset_id": ASSET }))
        .await?
        .json()?;
    let bob_points = activity["work_points"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p[0] == bob.id().to_string())
        .map(|p| p[1]["current"].as_u64().unwrap())
        .unwrap_or(0);
    assert_eq!(bob_points, 0, "bob's points suspend while disputed");

    // 12. DAO upholds the dispute (proof 7).
    dao.call(cid, "resolve_dispute")
        .args_json(json!({ "asset_id": ASSET, "entry_id": 1, "uphold": true }))
        .deposit(STORAGE)
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let revenue: serde_json::Value = worker
        .view(cid, "get_revenue")
        .args_json(json!({ "asset_id": ASSET }))
        .await?
        .json()?;
    assert_eq!(revenue[1]["status"], "Rejected");
    assert_eq!(revenue[1]["bond_status"], "Forfeited");
    let treasury: serde_json::Value = worker
        .view(cid, "get_treasury")
        .args_json(json!({ "community_id": COMMUNITY }))
        .await?
        .json()?;
    assert_eq!(treasury["total_revenue"], y(31 * N / 10));
    assert_eq!(treasury["total_bonds_held"], "0");

    // 13. Execute the amendment after the timelock (proof 8).
    dao.call(cid, "execute_policy_change")
        .args_json(json!({ "community_id": COMMUNITY, "amendment_id": 0 }))
        .deposit(STORAGE)
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let policies: serde_json::Value = worker
        .view(cid, "get_policies")
        .args_json(json!({ "community_id": COMMUNITY }))
        .await?
        .json()?;
    assert_eq!(policies["spending"]["max_single_expense"], y(2 * N));
    assert_eq!(policies["amendments"][0]["status"], "Executed");

    // 14. Execute the distribution (proofs 5 and 6).
    alice
        .call(cid, "execute_distribution")
        .args_json(json!({ "asset_id": ASSET }))
        .deposit(STORAGE)
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    let dists: serde_json::Value = worker
        .view(cid, "get_distributions")
        .args_json(json!({ "asset_id": ASSET }))
        .await?
        .json()?;
    let d = &dists[0];
    assert_eq!(d["distributed"], y(26 * N / 10), "D = 2.6 NEAR");
    assert_eq!(d["member_total"], y(156 * N / 100));
    assert_eq!(d["retention"], y(65 * N / 100));
    assert_eq!(d["maintenance"], y(39 * N / 100));
    assert_eq!(d["activity_pool"], y(156 * N / 1000));
    assert_eq!(d["ownership_pool"], y(1404 * N / 1000));
    let payout = |acct: &str| -> u128 {
        d["payouts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p[0] == acct)
            .map(|p| p[1].as_str().unwrap().parse().unwrap())
            .unwrap_or(0)
    };
    assert_eq!(payout(alice.id().as_str()), 507 * N / 1000, "alice 0.507");
    assert_eq!(payout(bob.id().as_str()), 351 * N / 1000, "bob 0.351");
    assert_eq!(payout(carol.id().as_str()), 351 * N / 1000, "carol 0.351");
    assert_eq!(payout(dave.id().as_str()), 351 * N / 1000, "dave 0.351");
    let member_total: u128 = d["member_total"].as_str().unwrap().parse().unwrap();
    let retention: u128 = d["retention"].as_str().unwrap().parse().unwrap();
    let maintenance: u128 = d["maintenance"].as_str().unwrap().parse().unwrap();
    let distributed: u128 = d["distributed"].as_str().unwrap().parse().unwrap();
    assert_eq!(member_total + retention + maintenance, distributed, "exact sum");
    assert!(d["unpaid"].as_array().unwrap().is_empty());

    // 15. Final state: treasury 0, epoch advanced, points reset.
    let treasury: serde_json::Value = worker
        .view(cid, "get_treasury")
        .args_json(json!({ "community_id": COMMUNITY }))
        .await?
        .json()?;
    assert_eq!(treasury["treasury"], "0", "final treasury 0.0 NEAR");
    assert_eq!(treasury["distributable"], "0");
    let activity: serde_json::Value = worker
        .view(cid, "get_activity")
        .args_json(json!({ "asset_id": ASSET }))
        .await?
        .json()?;
    assert_eq!(activity["epoch"], 1);
    assert!(activity["work_points"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p[1]["current"] == 0));

    Ok(())
}
