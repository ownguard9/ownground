// Verifies the DAO proposals list and vote buttons on the community
// page (site/community.js + site/dao.js). Serves site/ locally, stubs
// RPC in the page (the sandbox cannot reach live RPC), simulates the
// connected wallet by setting walletAccountId, stubs walletCall so no
// transaction is ever sent, and asserts: the list renders the two
// InProgress proposals with descriptions and vote counts, the Vote
// button appears for a council wallet and is replaced by the note for
// a non-council wallet, clicking Vote records a pending dao-vote
// action and the return re-check confirms it in the proposal's own
// status, and no page errors occur. Never sends a transaction and
// never votes on a real proposal.
//
// Run: cp hidden_files/verify-community-proposals.mjs /tmp/og-test/ && node /tmp/og-test/verify-community-proposals.mjs
// (puppeteer-core lives in /tmp/og-test/node_modules; ESM bare imports
// resolve from the file's own directory, so it runs from there.)
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const SITE_DIR = "/home/hatch/workspace/commonhold/site";
const PORT = 8932;
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

// ---- Stubbed onchain state: the live Oceanic group DAO shape ----
function baseState() {
  return {
    community: {
      community_id: COMMUNITY_ID, name: "Oceanic group", description: "Oceanic",
      dao_id: DAO_ID,
      members: ["clearsite587.testnet", "peter-vehicles.testnet", "felix-vehicles.testnet", "grace-vehicles.testnet", "james54.testnet"],
      campaign_ids: [COMMUNITY_ID + "-c3"], asset_ids: [],
      policy: { members_bp: 6000, treasury_bp: 2500, maintenance_bp: 1500, activity_bp: 1000 },
      spending_policy: { max_single_expense: "10000000000000000000000000", min_treasury_reserve: "2000000000000000000000000", allowed_categories: ["maintenance", "operations"] },
      capital_points: [],
      activity_policy: { capital_per_near: 1, work_per_revenue_record: 1, work_per_revenue_near: 1 },
      dispute_window_ns: 604800000000000, timelock_ns: 259200000000000,
    },
    treasury: { total_expenses: "0", retained: "0", distributable: "0", treasury: "0", locked: "0", spendable: "0", total_contributions: "0", total_payouts: "0", total_bonds_held: "0" },
    policies: { amendments: [] },
    campaigns: {
      [COMMUNITY_ID + "-c3"]: { id: COMMUNITY_ID + "-c3", asset_name: "Park", category: "Commercial", target: Y(25), raised: Y(25), deadline: PARK_DEADLINE_NS, status: "Funded", contributors: [["clearsite587.testnet", Y(10)], ["james54.testnet", Y(3)]] },
    },
    assets: {}, distributions: {},
    policy: {
      roles: [
        { name: "all", kind: { Group: ["*"] }, permissions: ["*:AddProposal"], vote_policy: {} },
        { name: "council", kind: { Group: ["peter-vehicles.testnet", "felix-vehicles.testnet", "grace-vehicles.testnet", "daniel-vehicles.testnet"] }, permissions: ["*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:AddProposal", "*:Finalize"], vote_policy: {} },
        { name: "community", kind: { Group: ["*"] }, permissions: [], vote_policy: {} },
      ],
      default_vote_policy: { Weight: "2" },
      proposal_bond: "1000000000000000000000000",
      proposal_period: "604800000000000",
      bounty_bond: "1000000000000000000000000",
      bounty_forgiveness_period: "604800000000000",
    },
    lastProposalId: 2,
    proposals: {
      0: { id: 0, proposer: "clearsite587.testnet", description: "Propose a distribution policy change for community " + COMMUNITY_ID, status: "InProgress", vote_counts: { council: [0, 0, 0] }, votes: {} },
      1: { id: 1, proposer: "clearsite587.testnet", description: "Propose a spending policy change for community " + COMMUNITY_ID, status: "InProgress", vote_counts: { council: [0, 0, 0] }, votes: {} },
    },
  };
}
function stateWithPeterVote(st) {
  st.proposals[0].votes = { "peter-vehicles.testnet": "Approve" };
  st.proposals[0].vote_counts = { council: [1, 0, 0] };
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
        if (st.failDao) return errorResponse(body, "stub: DAO read failed");
        if (method === "get_last_proposal_id") result = st.lastProposalId;
        else if (method === "get_proposal") {
          const p = (st.proposals || {})[String(args.id)];
          result = p === undefined ? null : p;
        } else if (method === "get_proposals") {
          result = Object.keys(st.proposals || {}).map(Number).sort((a, b) => a - b).map((id) => st.proposals[String(id)]);
        } else if (method === "get_policy") result = st.policy;
        else handled = false;
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
      if (m.text().indexOf("Failed to load resource") === 0) sandboxNoise.push(m.text());
      else pageErrors.push("console.error: " + m.text());
    });
    await page.evaluateOnNewDocument(installRpcStub);

    const text = (id) => page.evaluate((i) => { const n = document.getElementById(i); return n ? n.textContent : null; }, id);
    const html = (id) => page.evaluate((i) => { const n = document.getElementById(i); return n ? n.innerHTML : null; }, id);
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
    const connectAs = (accountId) => page.evaluate((a) => {
      walletAccountId = a;
      refreshWalletBtn();
      return loadCommunity();
    }, accountId);
    const waitProposals = async (substr) => {
      await page.waitForFunction((s) => { const n = document.getElementById("daoProposals"); return n && n.textContent.indexOf(s) >= 0; }, { timeout: 20000 }, substr);
    };

    // Seed the stub state on the origin first, then open the page.
    await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded" });
    await setStubState(baseState());
    await page.goto(ORIGIN + "/community.html?id=" + COMMUNITY_ID, { waitUntil: "domcontentloaded" });
    await waitLoaded();
    await waitProposals("Proposal 0");

    // --- Scenario 1: list renders for a non-council wallet ---
    await connectAs("clearsite587.testnet");
    await waitProposals("Proposal 1");
    const listText = await text("daoProposals");
    check("both InProgress proposals listed with descriptions",
      listText.includes("Propose a distribution policy change for community " + COMMUNITY_ID) &&
      listText.includes("Propose a spending policy change for community " + COMMUNITY_ID),
      listText.slice(0, 200));
    check("vote counts show 0 of 2 approvals",
      listText.includes("Approvals: 0 of 2."), listText.slice(0, 400));
    check("statuses shown as InProgress", listText.includes("Status InProgress."));
    check("no Vote button for a non-council wallet",
      (await html("daoProposals")).indexOf("Vote approve proposal") < 0);
    check("non-council note shown instead of the button",
      listText.includes("Only DAO council members can vote"), listText.slice(0, 400));

    // --- Scenario 2: council wallet sees Vote buttons ---
    await connectAs("peter-vehicles.testnet");
    await waitProposals("Vote approve proposal 0");
    const councilHtml = await html("daoProposals");
    check("Vote buttons appear for a council wallet",
      councilHtml.includes("Vote approve proposal 0") && councilHtml.includes("Vote approve proposal 1"));
    check("newest proposal listed first",
      (await text("daoProposals")).indexOf("Proposal 1") < (await text("daoProposals")).indexOf("Proposal 0"));

    // --- Scenario 3: click Vote, pending dao-vote recorded, walletCall shape ---
    await page.evaluate(() => {
      window.__walletCalls = [];
      window.walletCall = async (contractId, method, args, deposit, gas) => {
        window.__walletCalls.push({ contractId, method, args, deposit, gas });
      };
    });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#daoProposals button")].find((x) => x.textContent.includes("Vote approve proposal 0"));
      b.click();
    });
    await waitText("propStatus-0", "Voting approve on DAO proposal 0");
    const pending = await getPending();
    check("vote records a pending dao-vote action",
      pending && pending.action === "dao-vote" && pending.proposalId === 0 && pending.daoId === DAO_ID &&
      pending.statusId === "propStatus-0" && pending.account === "peter-vehicles.testnet",
      JSON.stringify(pending));
    check("vote progress shows in the proposal's own status",
      (await text("propStatus-0")) === "Voting approve on DAO proposal 0…", await text("propStatus-0"));
    const calls = await page.evaluate(() => window.__walletCalls);
    check("vote sends act_proposal VoteApprove with 0 deposit and 150 TGas",
      calls.length === 1 && calls[0].contractId === DAO_ID && calls[0].method === "act_proposal" &&
      calls[0].args.id === 0 && calls[0].args.action === "VoteApprove" &&
      calls[0].deposit === "0" && calls[0].gas === "150000000000000",
      JSON.stringify(calls));

    // --- Scenario 4: return after the vote landed -> confirmation ---
    await setStubState(stateWithPeterVote(baseState()));
    await returnToTab();
    await waitText("propStatus-0", "Vote approve on DAO proposal 0 confirmed.");
    check("vote confirms in the proposal's own status after return",
      (await text("propStatus-0")) === "Vote approve on DAO proposal 0 confirmed.",
      await text("propStatus-0"));
    check("pending action cleared after vote confirm", (await getPending()) === null);
    const afterText = await text("daoProposals");
    check("refreshed list shows 1 of 2 approvals on proposal 0",
      afterText.includes("Approvals: 1 of 2."), afterText.slice(0, 400));
    check("already-voted note replaces the button for proposal 0",
      afterText.includes("You already voted approve on this proposal."));

    // --- Scenario 5: unlanded vote -> clear not-confirmed message ---
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLoaded();
    await connectAs("peter-vehicles.testnet");
    await waitProposals("Vote approve proposal 1");
    await setStubState(baseState()); // no vote onchain
    await setStatus("propStatus-1", "Voting approve on DAO proposal 1…");
    await setPending({
      token: 9, action: "dao-vote", communityId: COMMUNITY_ID, daoId: DAO_ID, proposalId: 1,
      account: "peter-vehicles.testnet", statusId: "propStatus-1",
      progressMsg: "Voting approve on DAO proposal 1…", savedAt: Date.now(),
    });
    await returnToTab();
    await waitText("propStatus-1", "Could not confirm this onchain", 45000);
    check("unlanded vote resolves to a clear not-confirmed message",
      (await text("propStatus-1")).indexOf("Could not confirm this onchain") === 0,
      await text("propStatus-1"));
    check("pending action cleared after not-confirmed", (await getPending()) === null);

    // --- Scenario 6: DAO read failure does not take the page down ---
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLoaded();
    await page.evaluate(() => {
      const st = JSON.parse(localStorage.getItem("og-stub-state") || "{}");
      st.failDao = true; // every DAO view call now errors
      localStorage.setItem("og-stub-state", JSON.stringify(st));
    });
    await connectAs("peter-vehicles.testnet");
    await waitProposals("Could not load DAO proposals");
    check("community page still loads when the DAO read fails",
      (await text("cName")) === "Oceanic group" && (await text("campaigns")).includes("Park"));

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
