// Verifies the community page return re-check (site/community.js).
// Serves site/ locally, stubs RPC in the page (the sandbox cannot
// reach live RPC), seeds a pending wallet action in localStorage,
// simulates the wallet return (window focus, or a page reload), and
// asserts the pending action's LOCAL status element resolves to a
// confirmation, the refreshed data shows the new onchain state, and
// no page errors occur. Never sends a transaction.
//
// Run: node hidden_files/verify-community-return.mjs
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const SITE_DIR = "/home/hatch/workspace/commonhold/site";
const PORT = 8931;
const ORIGIN = "http://127.0.0.1:" + PORT;
const EXE = "/home/hatch/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";
const COMMUNITY_ID = "oceanic-group";
const DAO_ID = "vehicle-coop.testnet";
const PARK_DEADLINE_NS = "1794268800000000000"; // 10/11/2026 00:00 UTC
const Y = (n) => (BigInt(n) * 10n ** 24n).toString();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  (" + detail + ")" : ""));
}

// ---- Stubbed onchain state (the "before" state: what Isaiah saw) ----
function baseState() {
  return {
    community: {
      community_id: COMMUNITY_ID, name: "Oceanic group", description: "Oceanic",
      dao_id: DAO_ID,
      members: ["clearsite587.testnet", "peter-vehicles.testnet", "felix-vehicles.testnet", "grace-vehicles.testnet"],
      campaign_ids: [COMMUNITY_ID + "-c1", COMMUNITY_ID + "-c2"], asset_ids: [],
      policy: { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 1000 },
      spending_policy: { max_single_expense: "0", min_treasury_reserve: "0", allowed_categories: ["Commercial"] },
      capital_points: [],
      activity_policy: { capital_per_near: 1, work_per_revenue_record: 1, work_per_revenue_near: 1 },
      dispute_window_ns: 604800000000000, timelock_ns: 259200000000000,
    },
    treasury: { total_expenses: "0", retained: "0", distributable: "0", treasury: "0", locked: "0", spendable: "0", total_contributions: "0", total_payouts: "0", total_bonds_held: "0" },
    policies: { amendments: [] },
    campaigns: {
      [COMMUNITY_ID + "-c1"]: { id: COMMUNITY_ID + "-c1", asset_name: "Van", category: "Commercial", target: Y(20), raised: "0", deadline: PARK_DEADLINE_NS, status: "Open", contributors: [] },
      [COMMUNITY_ID + "-c2"]: { id: COMMUNITY_ID + "-c2", asset_name: "Boat", category: "Commercial", target: Y(10), raised: "0", deadline: PARK_DEADLINE_NS, status: "Open", contributors: [] },
    },
    assets: {}, distributions: {},
    lastProposalId: 2,
    proposals: {
      0: { id: 0, description: "Propose a distribution policy change for community " + COMMUNITY_ID, status: "InProgress", proposer: "clearsite587.testnet" },
      1: { id: 1, description: "Propose a spending policy change for community " + COMMUNITY_ID, status: "InProgress", proposer: "clearsite587.testnet" },
    },
  };
}
function stateWithParkCampaign(st) {
  st.community.campaign_ids = st.community.campaign_ids.concat([COMMUNITY_ID + "-c3"]);
  st.campaigns[COMMUNITY_ID + "-c3"] = {
    id: COMMUNITY_ID + "-c3", asset_name: "Park", category: "Commercial",
    target: Y(25), raised: "0", deadline: PARK_DEADLINE_NS, status: "Open", contributors: [],
  };
  return st;
}

// ---- RPC stub: installed before page scripts, reads state from
// localStorage on every call so the test can flip onchain state. ----
function installRpcStub() {
  const origFetch = window.fetch.bind(window);
  function stubState() {
    try { return JSON.parse(localStorage.getItem("og-stub-state") || "{}"); } catch (_) { return {}; }
  }
  function bytesOf(obj) { return Array.from(new TextEncoder().encode(JSON.stringify(obj))); }
  function rawResponse(body, resultObj) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id || "0", result: resultObj }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  function errorResponse(body, message) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id || "0", error: { code: -32601, message: message } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  window.fetch = async function (url, opts) {
    const u = String(url || "");
    const isRpc = u.indexOf("rpc.testnet.near.org") >= 0 || u.indexOf("rpc.testnet.fastnear.com") >= 0;
    if (!isRpc) return origFetch(url, opts);
    let body = {};
    try { body = JSON.parse(opts && opts.body ? opts.body : "{}"); } catch (_) {}
    const params = body.params || {};
    if (body.method === "query" && params.request_type === "view_account") {
      return rawResponse(body, { amount: "10000000000000000000000000", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 0, storage_paid_at: 0, block_height: 0, block_hash: "11111111111111111111111111111111" });
    }
    if (body.method === "query" && params.request_type === "call_function") {
      const method = params.method_name;
      const account = params.account_id;
      let args = {};
      try { args = JSON.parse(atob(params.args_base64 || "")); } catch (_) {}
      const st = stubState();
      let result;
      let handled = true;
      if (account === "ownground2.testnet" || account === "ownground3.testnet" || account === "ownground4.testnet") {
        if (method === "get_community") result = st.community;
        else if (method === "get_treasury") result = st.treasury;
        else if (method === "get_policies") result = st.policies;
        else if (method === "get_campaign") result = (st.campaigns || {})[args.campaign_id] === undefined ? null : (st.campaigns || {})[args.campaign_id];
        else if (method === "get_asset") result = (st.assets || {})[args.asset_id] === undefined ? null : (st.assets || {})[args.asset_id];
        else if (method === "get_distributions") result = (st.distributions || {})[args.asset_id] || [];
        else handled = false;
      } else if (account === "vehicle-coop.testnet") {
        if (method === "get_last_proposal_id") result = st.lastProposalId;
        else if (method === "get_proposal") {
          const p = (st.proposals || {})[String(args.id)];
          result = p === undefined ? null : p;
        } else handled = false;
      } else handled = false;
      if (!handled) return errorResponse(body, "stub: no handler for " + account + "/" + method);
      return rawResponse(body, { result: bytesOf(result) });
    }
    return errorResponse(body, "stub: unsupported query");
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: SITE_DIR, stdio: "ignore" });
  let browser = null;
  try {
    // Wait for the server to answer.
    for (let i = 0; i < 20; i++) {
      try { const r = await fetch(ORIGIN + "/"); if (r.ok) break; } catch (_) {}
      await sleep(500);
    }
    browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage();
    const pageErrors = [];
    const sandboxNoise = [];
    page.on("pageerror", (e) => pageErrors.push("pageerror: " + e.message));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      // The wallet library fetches its manifest from a CDN on every
      // load; the sandbox proxy blocks that host. It is environmental
      // noise, not a site error, so it is counted separately.
      if (m.text().indexOf("Failed to load resource") === 0) sandboxNoise.push(m.text());
      else pageErrors.push("console.error: " + m.text());
    });
    await page.evaluateOnNewDocument(installRpcStub);

    const text = (id) => page.evaluate((i) => { const n = document.getElementById(i); return n ? n.textContent : null; }, id);
    const setStubState = (s) => page.evaluate((x) => localStorage.setItem("og-stub-state", JSON.stringify(x)), s);
    const setPending = (p) => page.evaluate((x) => localStorage.setItem("ownground-pending-action", JSON.stringify(x)), p);
    const getPending = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem("ownground-pending-action") || "null"); } catch (_) { return "PARSE_ERROR"; } });
    const setStatus = (id, msg) => page.evaluate((i, m) => { const n = document.getElementById(i); if (n) n.textContent = m; }, id, msg);
    const returnToTab = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const waitText = (id, substr, timeout) => page.waitForFunction(
      (i, s) => { const n = document.getElementById(i); return n && n.textContent.indexOf(s) >= 0; },
      { timeout: timeout || 45000 }, id, substr);
    const waitLoaded = async () => {
      await page.waitForFunction(() => { const n = document.getElementById("cName"); return n && n.textContent.length > 0; }, { timeout: 20000 });
      await page.waitForFunction(() => { const n = document.getElementById("pageStatus"); return n && n.textContent === ""; }, { timeout: 20000 });
    };

    // Seed the stub state on the origin first, then open the page.
    await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded" });
    await setStubState(baseState());
    await page.goto(ORIGIN + "/community.html?id=" + COMMUNITY_ID, { waitUntil: "domcontentloaded" });
    await waitLoaded();
    check("page loads with stubbed RPC", (await text("cName")) === "Oceanic group", await text("cName"));
    check("initial campaigns listed (Van, Boat, no Park yet)",
      (await text("campaigns")).includes("Van") && !(await text("campaigns")).includes("Park"));

    // --- Scenario 1: create campaign, return via focus ---
    await setStubState(stateWithParkCampaign(baseState()));
    await setStatus("campaignStatus", "Starting the campaign…");
    await setPending({
      token: 1, action: "campaign", communityId: COMMUNITY_ID, account: "clearsite587.testnet",
      statusId: "campaignStatus", progressMsg: "Starting the campaign…",
      expected: { assetName: "Park", targetYocto: Y(25), deadlineNs: PARK_DEADLINE_NS, knownCampaignIds: [COMMUNITY_ID + "-c1", COMMUNITY_ID + "-c2"] },
      savedAt: Date.now(),
    });
    await returnToTab();
    await waitText("campaignStatus", "started and is open for contributions");
    check("campaign return resolves in campaignStatus (not pageStatus)",
      (await text("campaignStatus")) === "Campaign Park started and is open for contributions.",
      await text("campaignStatus"));
    check("refreshed data shows the new Park campaign", (await text("campaigns")).includes("Park"));
    check("pending action cleared after campaign confirm", (await getPending()) === null);

    // --- Scenario 2: distribution DAO proposal, return via reload ---
    // (reload also resets the 10s re-check throttle from scenario 1)
    await setPending({
      token: 2, action: "dao-proposal", communityId: COMMUNITY_ID, daoId: DAO_ID, proposalId: 0,
      description: "Propose a distribution policy change for community " + COMMUNITY_ID,
      account: "clearsite587.testnet", statusId: "policyStatus",
      progressMsg: "Creating a DAO proposal for the distribution policy change…", savedAt: Date.now(),
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitText("policyStatus", "DAO proposal 0 created");
    check("distribution proposal resolves on page load in policyStatus",
      (await text("policyStatus")) === "DAO proposal 0 created. Council members vote, then the DAO executes it.",
      await text("policyStatus"));
    check("pending action cleared after proposal confirm", (await getPending()) === null);

    // --- Scenario 3: spending DAO proposal, return via focus ---
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLoaded();
    await setStatus("spendingStatus", "Creating a DAO proposal for the spending policy change…");
    await setPending({
      token: 3, action: "dao-proposal", communityId: COMMUNITY_ID, daoId: DAO_ID, proposalId: 1,
      description: "Propose a spending policy change for community " + COMMUNITY_ID,
      account: "clearsite587.testnet", statusId: "spendingStatus",
      progressMsg: "Creating a DAO proposal for the spending policy change…", savedAt: Date.now(),
    });
    await returnToTab();
    await waitText("spendingStatus", "DAO proposal 1 created");
    check("spending proposal resolves in spendingStatus",
      (await text("spendingStatus")) === "DAO proposal 1 created. Council members vote, then the DAO executes it.",
      await text("spendingStatus"));
    check("pending action cleared after spending confirm", (await getPending()) === null);

    // --- Scenario 4: action that did not land -> clear not-confirmed ---
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLoaded();
    await setStubState(baseState()); // no Park campaign onchain
    await setStatus("campaignStatus", "Starting the campaign…");
    await setPending({
      token: 4, action: "campaign", communityId: COMMUNITY_ID, account: "clearsite587.testnet",
      statusId: "campaignStatus", progressMsg: "Starting the campaign…",
      expected: { assetName: "Park", targetYocto: Y(25), deadlineNs: PARK_DEADLINE_NS, knownCampaignIds: [COMMUNITY_ID + "-c1", COMMUNITY_ID + "-c2"] },
      savedAt: Date.now(),
    });
    await returnToTab();
    await waitText("campaignStatus", "Could not confirm this onchain");
    check("unlanded action resolves to a clear not-confirmed message",
      (await text("campaignStatus")).indexOf("Could not confirm this onchain") === 0,
      await text("campaignStatus"));
    check("pending action cleared after not-confirmed", (await getPending()) === null);

    // --- Scenario 5: newer action started mid re-check is not overwritten ---
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLoaded();
    await setStubState(baseState()); // Park not onchain yet, so the re-check polls
    await setStatus("campaignStatus", "Starting the campaign…");
    await setPending({
      token: 5, action: "campaign", communityId: COMMUNITY_ID, account: "clearsite587.testnet",
      statusId: "campaignStatus", progressMsg: "Starting the campaign…",
      expected: { assetName: "Park", targetYocto: Y(25), deadlineNs: PARK_DEADLINE_NS, knownCampaignIds: [COMMUNITY_ID + "-c1", COMMUNITY_ID + "-c2"] },
      savedAt: Date.now(),
    });
    await returnToTab();
    await sleep(1500); // first verify attempt done (not found), now in the 3s sleep
    // While the old re-check polls, the user starts a newer action AND
    // the old campaign lands onchain. The old re-check must abort.
    await setStubState(stateWithParkCampaign(baseState()));
    await setStatus("spendingStatus", "Creating a DAO proposal for the spending policy change…");
    await setPending({
      token: 6, action: "dao-proposal", communityId: COMMUNITY_ID, daoId: DAO_ID, proposalId: 1,
      description: "Propose a spending policy change for community " + COMMUNITY_ID,
      account: "clearsite587.testnet", statusId: "spendingStatus",
      progressMsg: "Creating a DAO proposal for the spending policy change…", savedAt: Date.now(),
    });
    await sleep(6000); // old re-check's next attempt finds Park, then must abort on the token
    const campAfter = await text("campaignStatus");
    const spendAfter = await text("spendingStatus");
    const pendingAfter = await getPending();
    check("old re-check does not confirm the superseded campaign",
      campAfter.indexOf("started and is open") < 0, campAfter);
    check("newer action's progress message untouched",
      spendAfter === "Creating a DAO proposal for the spending policy change…", spendAfter);
    check("newer pending action still recorded", pendingAfter && pendingAfter.token === 6);
    await page.evaluate(() => localStorage.removeItem("ownground-pending-action"));

    // --- Scenario 6: contribute, return via focus ---
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLoaded();
    const st6 = baseState();
    st6.campaigns[COMMUNITY_ID + "-c1"].contributors = [["clearsite587.testnet", Y(1)]];
    await setStubState(st6);
    await setStatus("campStatus-" + COMMUNITY_ID + "-c1", "Contributing…");
    await setPending({
      token: 7, action: "contribute", communityId: COMMUNITY_ID, campaignId: COMMUNITY_ID + "-c1",
      account: "clearsite587.testnet", statusId: "campStatus-" + COMMUNITY_ID + "-c1", progressMsg: "Contributing…",
      expected: { amount: Y(1), myBefore: "0" }, savedAt: Date.now(),
    });
    await returnToTab();
    await waitText("campStatus-" + COMMUNITY_ID + "-c1", "Contribution of 1.000 NEAR confirmed.");
    check("contribute resolves in the per-campaign status element",
      (await text("campStatus-" + COMMUNITY_ID + "-c1")) === "Contribution of 1.000 NEAR confirmed.",
      await text("campStatus-" + COMMUNITY_ID + "-c1"));
    check("pending action cleared after contribute confirm", (await getPending()) === null);

    check("no page errors during the whole run", pageErrors.length === 0, pageErrors.join(" | "));
    if (sandboxNoise.length) console.log("NOTE  sandbox-blocked external resource loads (wallet manifest CDN, expected here): " + sandboxNoise.length);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed" + (failed.length ? ", " + failed.length + " FAILED" : ""));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("VERIFIER CRASHED:", e); process.exit(2); });
