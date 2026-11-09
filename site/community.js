// Community dashboard for OwnGround. Testnet only.
let communityId = null;
let community = null;

function fmtDate(ns) {
  try { return new Date(Number(BigInt(ns) / 1000000n)).toLocaleString(); } catch (_) { return "unknown"; }
}
function needWallet(statusFn) {
  if (!walletAccountId) { (statusFn || pageStatus)("Connect a wallet first."); return false; }
  return true;
}

// Feedback next to the button that was clicked, so the user sees the
// result where they are instead of scrolling to the top of the page.
// The page-level status at the top keeps load status only ("Loading
// this community…", load errors). Wording of every message is unchanged.
function localStatus(id, msg) {
  const s = el(id);
  if (s) s.textContent = msg;
}
function localFailure(id, err) {
  let r = null;
  try {
    if (typeof classifyFailure === "function") r = classifyFailure(err);
  } catch (_) { /* classifier unavailable */ }
  if (!r) {
    const m = err && err.message ? err.message : String(err);
    r = { category: "contract", text: "Rejected. " + m.slice(0, 200) + " No money moved." };
  }
  localStatus(id, r.text);
  return r;
}
function campaignStatus(msg) { localStatus("campaignStatus", msg); }
function campaignFailure(err) { return localFailure("campaignStatus", err); }
function campStatus(campaignId, msg) { localStatus("campStatus-" + campaignId, msg); }
function campFailure(campaignId, err) { return localFailure("campStatus-" + campaignId, err); }
function acquireStatus(campaignId, msg) { localStatus("acquireStatus-" + campaignId, msg); }
function acquireFailure(campaignId, err) { return localFailure("acquireStatus-" + campaignId, err); }
function policyStatus(msg) { localStatus("policyStatus", msg); }
function policyFailure(err) { return localFailure("policyStatus", err); }
function spendingStatus(msg) { localStatus("spendingStatus", msg); }
function spendingFailure(err) { return localFailure("spendingStatus", err); }
function amendStatus(msg) { localStatus("amendStatus", msg); }
function amendFailure(err) { return localFailure("amendStatus", err); }

// ---- Pending wallet actions and the return re-check ----
// The wallet opens in a new tab. After signing, the user comes back to
// this tab by hand, so the page never reloads with transactionHashes
// and the "in progress" message just sits there. The action is recorded
// before the wallet opens (localStorage, so it survives a reload too);
// when the tab becomes visible or focused again, the page re-reads the
// chain and resolves the message to a confirmation when the action
// landed, or to a clear not-confirmed message when it did not. The
// re-check is read-only and never sends a transaction. Mirrors the
// create page's recheckPendingOnReturn.
const PENDING_ACTION_KEY = "ownground-pending-action";
const PENDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000; // a day; older entries are stale
let pendingActionToken = 0;
let actionRecheckRunning = false;
let lastActionRecheck = 0;

function savePendingAction(p) {
  try { localStorage.setItem(PENDING_ACTION_KEY, JSON.stringify(p)); } catch (_) { /* storage unavailable */ }
}
function loadPendingAction() {
  try {
    const raw = localStorage.getItem(PENDING_ACTION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
function clearPendingAction() {
  try { localStorage.removeItem(PENDING_ACTION_KEY); } catch (_) { /* storage unavailable */ }
}
// Clear only the action that just failed in the wallet, never a newer
// one that replaced it while the wallet was open.
function clearPendingActionIfToken(token) {
  const p = loadPendingAction();
  if (p && p.token === token) clearPendingAction();
}

// Check whether a pending action has landed onchain. Returns evidence
// (an object) when it has, null when it has not or cannot be told yet.
// Read-only: every check is a view call.
async function verifyPendingAction(p) {
  try {
    if (p.action === "campaign") {
      const c = await view("get_community", { community_id: p.communityId });
      const known = p.expected.knownCampaignIds || [];
      const candidates = known.length
        ? (c.campaign_ids || []).filter((id) => known.indexOf(id) < 0)
        : (c.campaign_ids || []);
      for (const id of candidates) {
        try {
          const camp = await view("get_campaign", { campaign_id: id });
          const deadlineDiff = (() => {
            const a = BigInt(String(camp.deadline));
            const b = BigInt(p.expected.deadlineNs);
            return a > b ? a - b : b - a;
          })();
          if (camp.asset_name === p.expected.assetName &&
              String(camp.target) === String(p.expected.targetYocto) &&
              deadlineDiff <= 1000n) {
            return { campaignId: id };
          }
        } catch (_) { /* one unreadable campaign is not proof of failure */ }
      }
      return null;
    }
    if (p.action === "contribute") {
      const camp = await view("get_campaign", { campaign_id: p.campaignId });
      const mine = (camp.contributors || []).find(([a]) => a === p.account);
      if (mine && BigInt(mine[1]) >= BigInt(p.expected.myBefore) + BigInt(p.expected.amount)) return {};
      return null;
    }
    if (p.action === "refund") {
      const camp = await view("get_campaign", { campaign_id: p.campaignId });
      const mine = (camp.contributors || []).find(([a]) => a === p.account);
      if (!mine || BigInt(mine[1]) === 0n) return {};
      return null;
    }
    if (p.action === "dao-proposal") {
      const prop = await rpcViewCall(p.daoId, "get_proposal", { id: p.proposalId });
      if (prop && (!p.description || prop.description === p.description)) return { proposal: prop };
      return null;
    }
    if (p.action === "dao-vote") {
      const prop = await rpcViewCall(p.daoId, "get_proposal", { id: p.proposalId });
      if (prop && prop.votes && prop.votes[p.account] === "Approve") return { proposal: prop };
      return null;
    }
    if (p.action === "execute-amendment") {
      const policies = await view("get_policies", { community_id: p.communityId });
      const a = (policies.amendments || []).find((x) => Number(x.id) === Number(p.amendmentId));
      if (a && a.status === "Executed") return {};
      return null;
    }
  } catch (_) { return null; }
  return null;
}

// Resolve a landed action into its local status element. The data
// refresh (loadCommunity) runs first, so the element exists fresh.
function confirmPendingAction(p, found) {
  if (p.action === "campaign") {
    campaignStatus("Campaign " + p.expected.assetName + " started and is open for contributions.");
  } else if (p.action === "contribute") {
    campStatus(p.campaignId, "Contribution of " + fmtYocto(p.expected.amount) + " NEAR confirmed.");
  } else if (p.action === "refund") {
    campStatus(p.campaignId, "Refund confirmed.");
  } else if (p.action === "dao-proposal") {
    localStatus(p.statusId, "DAO proposal " + p.proposalId + " created. Council members vote, then the DAO executes it.");
    showProposalCreated(p.daoId, p.proposalId, p.description || "");
  } else if (p.action === "dao-vote") {
    localStatus(p.statusId, "Vote approve on DAO proposal " + p.proposalId + " confirmed.");
  } else if (p.action === "execute-amendment") {
    amendStatus("Amendment " + p.amendmentId + " executed. The new policy is in force.");
  }
}

// Re-check a pending action when the user comes back to the tab after
// signing in the wallet. Polls up to ~30s: the receipt may still be
// finalizing. Read-only; never sends a transaction. If a newer action
// started while this runs, it aborts without touching the new action's
// status.
async function recheckPendingAction() {
  if (document.hidden) return;
  if (actionRecheckRunning) return;
  const now = Date.now();
  if (now - lastActionRecheck < 10000) return;
  const p = loadPendingAction();
  if (!p || p.communityId !== communityId) return;
  if (now - (p.savedAt || 0) > PENDING_ACTION_TTL_MS) { clearPendingAction(); return; }
  lastActionRecheck = now;
  actionRecheckRunning = true;
  try {
    const token = p.token;
    let found = null;
    for (let attempt = 0; attempt < 10 && !found; attempt++) {
      found = await verifyPendingAction(p);
      if (found) break;
      const current = loadPendingAction();
      if (!current || current.token !== token) return;
      if (attempt < 9) await new Promise((r) => setTimeout(r, 3000));
    }
    const current = loadPendingAction();
    if (!current || current.token !== token) return;
    if (!found) {
      clearPendingAction();
      localStatus(p.statusId, "Could not confirm this onchain. The transaction may not have gone through. Check it on Nearblocks, or try again.");
      return;
    }
    clearPendingAction();
    await loadCommunity();
    const after = loadPendingAction();
    if (after) {
      // A newer action started while the data refreshed. Leave its
      // status alone; put its waiting message back in case the refresh
      // rebuilt the element it lives in.
      if (after.statusId && after.progressMsg) localStatus(after.statusId, after.progressMsg);
      return;
    }
    confirmPendingAction(p, found);
  } finally {
    actionRecheckRunning = false;
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) recheckPendingAction(); });
window.addEventListener("focus", () => { recheckPendingAction(); });

// Read the list page's handoff, if the user just clicked through and
// it is fresh. It only carries the header; the numbers still refresh live.
function readCachedCommunity(id) {
  try {
    const raw = sessionStorage.getItem("ownground-community-" + id);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.c || Date.now() - (data.savedAt || 0) > 120000) return null;
    return data;
  } catch (_) { return null; }
}

function renderHeader(c) {
  el("cName").textContent = c.name;
  el("cMeta").textContent = c.description + "  DAO: " + c.dao_id + "  Members: " + c.members.join(", ");
  el("daoLink").href = "https://testnet.nearblocks.io/address/" + c.dao_id;
}

function renderPolicies(c, policies) {
  el("curPolicy").textContent = "members " + c.policy.members_bp / 100 + "%, retention " + c.policy.treasury_bp / 100 +
    "%, maintenance " + c.policy.maintenance_bp / 100 + "%, activity share " + c.policy.activity_bp / 100 + "% of the member pool";
  const sp = c.spending_policy;
  el("curSpending").textContent = "cap " + fmtYocto(sp.max_single_expense) + " NEAR (0 means no cap), reserve " +
    fmtYocto(sp.min_treasury_reserve) + " NEAR, categories " + sp.allowed_categories.join(", ");
  // Notes are re-created on every load, so drop the previous ones first.
  el("curPolicy").parentElement.querySelectorAll(".policy-note").forEach((n) => n.remove());
  if (c.capital_points.length) {
    const pts = c.capital_points.map(([a, p]) => escapeHtml(a) + " " + p).join(", ");
    const p = document.createElement("p");
    p.className = "small muted policy-note";
    p.textContent = "Capital points (cumulative contributions; display only, they never affect the activity slice): " + pts;
    el("curPolicy").parentElement.appendChild(p);
  }
  const ap = c.activity_policy;
  const q = document.createElement("p");
  q.className = "small muted policy-note";
  q.textContent = "Activity policy: " + ap.capital_per_near + " capital points per whole NEAR, " +
    ap.work_per_revenue_record + " work points per verified revenue entry, " +
    ap.work_per_revenue_near + " work points per whole NEAR of verified revenue. Dispute window " +
    Math.round(c.dispute_window_ns / 86400000000000) + " days, amendment timelock " +
    Math.round(c.timelock_ns / 86400000000000) + " days.";
  el("curPolicy").parentElement.appendChild(q);
  el("amendments").innerHTML = policies.amendments.length ? policies.amendments.map((a) => {
    const when = new Date(Number(BigInt(a.deadline) / 1000000n)).toLocaleString();
    return '<div class="panel"><p>Amendment ' + a.id + ": " + escapeHtml(a.policy_type) + " is " + escapeHtml(a.status) +
      ". Executable after " + when + ".</p>" +
      (a.status === "Pending"
        ? '<button onclick="executeAmendment(' + a.id + ')">Execute amendment</button> ' +
          '<button onclick="cancelAmendment(' + a.id + ')">Cancel amendment (DAO)</button>'
        : "") + "</div>";
  }).join("") : "<p>No amendments yet.</p>";
}

async function loadCommunity() {
  const params = new URLSearchParams(window.location.search);
  communityId = params.get("id");
  if (!communityId) { pageStatus("No community id in the link."); return; }
  if (!deployed()) { el("notDeployed").style.display = "block"; return; }
  // The list page already fetched this community: show its name at once
  // when the user just clicked through, then refresh live below.
  const cached = readCachedCommunity(communityId);
  if (cached) {
    community = cached.c;
    el("content").style.display = "block";
    renderHeader(cached.c);
    pageStatus("Refreshing live numbers…");
  } else {
    pageStatus("Loading this community…");
  }
  try {
    const [c, t, policies] = await Promise.all([
      view("get_community", { community_id: communityId }),
      view("get_treasury", { community_id: communityId }),
      view("get_policies", { community_id: communityId }),
    ]);
    community = c;
    // Header and policies show now; campaigns, assets and distributions
    // arrive in one batch below instead of two sequential ones.
    el("content").style.display = "block";
    renderHeader(c);
    renderPolicies(c, policies);
    pageStatus("Loading campaigns and assets…");
    const [campaigns, assets, distributions, daoData] = await Promise.all([
      Promise.all(community.campaign_ids.map((id) => view("get_campaign", { campaign_id: id }))),
      Promise.all(community.asset_ids.map((id) => view("get_asset", { asset_id: id }))),
      Promise.all(community.asset_ids.map((id) => view("get_distributions", { asset_id: id }))),
      // A DAO read failing must not take the community page down.
      loadDaoData().catch(() => null),
    ]);
    pageStatus("");
    renderCommunity(community, t, policies, campaigns, assets, distributions);
    if (daoData) renderDaoProposals(daoData.policy, daoData.proposals);
    else {
      const box = el("daoProposals");
      if (box) box.innerHTML = "<p>Could not load DAO proposals. Check the DAO on Nearblocks.</p>";
    }
  } catch (e) {
    pageStatus("Could not load this community: " + String(e.message).slice(0, 160));
  }
}

// Sum what each member deposited across every campaign, and what each
// member has been paid across every distribution. Both come from live
// contract state; members who never deposited or were never paid show 0.
function aggregateDeposits(members, campaigns) {
  const totals = new Map(members.map((m) => [m, 0n]));
  for (const camp of campaigns) {
    for (const [account, amount] of camp.contributors) {
      totals.set(account, (totals.get(account) || 0n) + BigInt(amount));
    }
  }
  return [...totals.entries()]
    .map(([account, amount]) => ({ account, amount }))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}
function aggregatePayouts(members, distributions) {
  const totals = new Map(members.map((m) => [m, 0n]));
  for (const list of distributions) {
    for (const record of list) {
      for (const [account, amount] of record.payouts) {
        totals.set(account, (totals.get(account) || 0n) + BigInt(amount));
      }
    }
  }
  return new Map([...totals.entries()].map(([account, amount]) => [account, amount]));
}
function shortName(account) {
  return String(account).split(".")[0];
}

function renderCommunity(c, t, policies, campaigns, assets, distributions) {
  // Four separate figures, never combined into one total: onchain
  // revenue (deposits confirmed onchain only), forfeited attestation
  // bonds as their own figure, expenses, retained reserves, and
  // distributable revenue. Treasury detail follows below them. The
  // treasury total_revenue INCLUDES forfeited bonds, so it is never
  // used as a revenue headline.
  const onchainRevenue = assets.reduce((sum, a) => sum + BigInt(a.revenue_onchain), 0n);
  const forfeitedBonds = assets.reduce((sum, a) => sum + BigInt(a.bond_forfeits || 0), 0n);
  const expenseCount = assets.reduce((n, a) => n + (a.expense_count || 0), 0);
  const paidMembers = aggregatePayouts(c.members, distributions);
  const paidCount = [...paidMembers.values()].filter((v) => v > 0n).length;
  const cards = [
    ["Onchain revenue", fmtYocto(onchainRevenue) + " NEAR", "deposits confirmed onchain only", "tone-green"],
    ["Forfeited attestation bonds", fmtYocto(forfeitedBonds) + " NEAR", "bonds forfeited to the treasury after upheld disputes", "tone-amber"],
    ["Expenses", fmtYocto(t.total_expenses) + " NEAR", expenseCount + (expenseCount === 1 ? " expense recorded" : " expenses recorded"), "tone-amber"],
    ["Retained reserves", fmtYocto(t.retained) + " NEAR", (c.policy.treasury_bp / 100) + "% of each distribution", "tone-blue"],
    ["Distributable revenue", fmtYocto(t.distributable) + " NEAR", BigInt(t.distributable) > 0n ? "ready for the next distribution" : "nothing waiting to share", "tone-purple"],
    ["Treasury balance", fmtYocto(t.treasury) + " NEAR", "held by the contract", "tone-green"],
    ["Locked in open campaigns", fmtYocto(t.locked) + " NEAR", "in open campaigns", "tone-blue"],
    ["Spendable now", fmtYocto(t.spendable) + " NEAR", "treasury minus locked campaign funds", "tone-amber"],
    ["Total contributed", fmtYocto(t.total_contributions) + " NEAR", "from " + c.members.length + " members", "tone-purple"],
    ["Total paid out to members", fmtYocto(t.total_payouts) + " NEAR", paidCount + (paidCount === 1 ? " member paid" : " members paid"), "tone-green"],
    ["Attestation bonds held", fmtYocto(t.total_bonds_held) + " NEAR", BigInt(t.total_bonds_held) > 0n ? "held while attestations are open" : "no bonds held right now", "tone-blue"],
  ];
  el("treasuryCards").innerHTML = cards.map(([k, v, sub, tone]) =>
    '<div class="card ' + tone + '"><div class="label">' + escapeHtml(k) + '</div><div class="big">' + escapeHtml(v) + '</div><div class="sub">' + escapeHtml(sub) + "</div></div>").join("");

  // Member deposits and payouts: one card per member, two bars on one
  // scale, so a payout bar is directly comparable to a deposit bar.
  const deposits = aggregateDeposits(c.members, campaigns);
  const payouts = aggregatePayouts(c.members, distributions);
  const totalDeposited = deposits.reduce((sum, d) => sum + d.amount, 0n);
  const maxAmount = deposits.reduce((m, d) => (d.amount > m ? d.amount : m), 0n);
  const pct = (amount, total) => (total > 0n ? Number((amount * 100n) / total) : 0);
  el("deposits").innerHTML =
    '<p class="legend"><span><i class="dot blue"></i>Deposited</span><span><i class="dot green"></i>Paid out</span></p>' +
    (deposits.length ? deposits.map((d, i) => {
      const paid = payouts.get(d.account) || 0n;
      const depW = maxAmount > 0n ? Number((d.amount * 100n) / maxAmount) : 0;
      const payW = maxAmount > 0n ? Number((paid * 100n) / maxAmount) : 0;
      const back = d.amount > 0n ? Math.round(Number((paid * 100n) / d.amount)) : 0;
      return '<div class="panel dep-card"><div class="dep-head"><span class="member-dot tone-' + (i % 4) + '">' +
        escapeHtml(shortName(d.account)[0].toUpperCase()) + '</span>' + escapeHtml(shortName(d.account)) +
        ' <span class="full">' + escapeHtml(d.account) + '</span></div>' +
        '<div class="dep-row"><span><i class="dot blue"></i>Deposited</span><span class="amt">' + fmtYocto(d.amount) + ' NEAR · ' + pct(d.amount, totalDeposited) + '% of all deposits</span></div>' +
        '<div class="bar-track"><i class="bar-fill dep" style="width:' + depW + '%"></i></div>' +
        '<div class="dep-row"><span><i class="dot green"></i>Paid out</span><span class="amt">' + fmtYocto(paid) + ' NEAR' + (d.amount > 0n ? ' · ' + back + '% back' : '') + '</span></div>' +
        '<div class="bar-track"><i class="bar-fill pay" style="width:' + payW + '%"></i></div></div>';
    }).join("") : "<p>No deposits yet.</p>");

  const steps = [
    "Fund a campaign: members contribute until the target is reached.",
    "Acquire the asset: the DAO approves the purchase and the seller is paid in the same call.",
    "Earn revenue: the asset works and revenue is recorded onchain or reported.",
    "Approve spending: the DAO approves expenses inside the spending policy.",
    "Distribute: members are paid from realised revenue under the approved policy.",
  ];
  el("flowSteps").innerHTML = steps.map((s) => "<li>" + escapeHtml(s) + "</li>").join("");

  el("campaigns").innerHTML = campaigns.length ? campaigns.map((camp) => {
    const mine = camp.contributors.find(([a]) => a === walletAccountId);
    // The contract rejects refunds unless the campaign is Open, so the
    // button is only rendered while it is Open.
    const refundBtn = camp.status === "Open"
      ? ' <button onclick="refund(\'' + escapeHtml(camp.id) + '\')">Refund my contribution</button>'
      : "";
    // The contract only cancels Open or Funded campaigns, and only the
    // DAO may cancel, so this creates a DAO proposal.
    const cancelBtn = (camp.status === "Open" || camp.status === "Funded")
      ? ' <button onclick="cancelCampaign(\'' + escapeHtml(camp.id) + '\')">Cancel campaign (DAO)</button>'
      : "";
    // The contract only acquires Funded campaigns. The allocation editor
    // is prefilled pro-rata by each contributor's share of the raised
    // amount; the DAO proposal is blocked unless the shares sum to
    // exactly 10000 basis points.
    let acquireBox = "";
    if (camp.status === "Funded") {
      const alloc = proRataAllocations(camp.contributors);
      const rows = alloc.map(([account, bp], i) =>
        '<label>' + escapeHtml(account) + ' share in basis points (10000 = 100%)' +
        '<input id="alloc-' + escapeHtml(camp.id) + "-" + i + '" data-account="' + escapeHtml(account) +
        '" value="' + bp + '" inputmode="numeric" oninput="updateAllocSum(\'' + escapeHtml(camp.id) + '\')"></label>'
      ).join("");
      acquireBox = '<div class="panel"><h3>Acquire this asset</h3>' +
        '<p class="small muted">Only the DAO can acquire the asset. This creates a DAO proposal; council members vote, then the DAO executes it. Ownership shares must sum to exactly 10000 basis points.</p>' +
        '<label>Seller account id<input id="seller-' + escapeHtml(camp.id) + '" placeholder="seller.testnet"></label>' +
        rows +
        '<p class="small">Allocation total: <span id="allocSum-' + escapeHtml(camp.id) + '">10000</span> of 10000 basis points</p>' +
        '<button onclick="acquireAsset(\'' + escapeHtml(camp.id) + '\')">Propose acquisition (DAO)</button>' +
        '<p id="acquireStatus-' + escapeHtml(camp.id) + '" class="status"></p></div>';
    }
    return '<div class="panel"><h3>' + escapeHtml(camp.asset_name) + '</h3>' +
      "<p>Target " + fmtYocto(camp.target) + " NEAR, raised " + fmtYocto(camp.raised) + " NEAR. Status " + escapeHtml(camp.status) + ". Deadline " + fmtDate(camp.deadline) + ".</p>" +
      "<p class=\"small muted\">You contributed " + (mine ? fmtYocto(mine[1]) + " NEAR" : "nothing yet") + ".</p>" +
      '<label>Amount in NEAR<input id="amt-' + escapeHtml(camp.id) + '" placeholder="2.5"></label>' +
      '<button onclick="contribute(\'' + escapeHtml(camp.id) + '\')">Contribute</button>' + refundBtn + cancelBtn +
      '<p id="campStatus-' + escapeHtml(camp.id) + '" class="status"></p></div>' + acquireBox;
  }).join("") : "<p>No campaigns yet.</p>";

  el("assets").innerHTML = assets.length ? assets.map((a) => {
    const alloc = (a.allocations || []).map(([account, bp]) =>
      escapeHtml(account) + " " + (bp / 100) + "%").join(", ");
    return '<div class="panel"><h3><a href="asset.html?id=' + encodeURIComponent(a.id) + '">' + escapeHtml(a.name) + "</a></h3>" +
    "<p>Value " + fmtYocto(a.value) + " NEAR. Realised revenue " + fmtYocto(a.revenue_onchain) + " NEAR. Expenses " + fmtYocto(a.expenses_total) + " NEAR. Status " + escapeHtml(a.status) + ".</p>" +
    "<p class=\"small\">Ownership allocations: " + (alloc || "none set yet") + "</p></div>";
  }).join("") : "<p>No assets yet.</p>";
}

async function createCampaign() {
  if (!needWallet(campaignStatus)) return;
  const name = el("campName").value.trim();
  const cat = el("campCat").value.trim();
  const target = el("campTarget").value.trim();
  const date = el("campDeadline").value;
  if (!name || !cat || !target || !date) { campaignStatus("Fill in the asset name, category, target and deadline."); return; }
  let targetYocto, deadlineNs;
  try { targetYocto = nearToYocto(target); } catch (e) { campaignStatus(e.message); return; }
  deadlineNs = BigInt(Date.parse(date + "T00:00:00Z")) * 1000000n;
  if (deadlineNs <= BigInt(Date.now()) * 1000000n) { campaignStatus("Pick a future deadline."); return; }
  const campaignToken = ++pendingActionToken;
  savePendingAction({
    token: campaignToken, action: "campaign", communityId: communityId,
    account: walletAccountId, statusId: "campaignStatus", progressMsg: "Starting the campaign…",
    expected: {
      assetName: name, targetYocto: targetYocto.toString(), deadlineNs: deadlineNs.toString(),
      knownCampaignIds: community ? community.campaign_ids.slice() : [],
    },
    savedAt: Date.now(),
  });
  try {
    campaignStatus("Starting the campaign…");
    // deadline is u64 in the contract, so it goes as a JSON number.
    // Number() rounds the nanosecond BigInt to the nearest double
    // (at most ~128 ns off), which is irrelevant for a deadline, and
    // JSON.stringify writes it as a plain integer below 1e21, which
    // serde parses as u64. target stays a string: it is U128.
    await walletCall(contractId(), "create_campaign", {
      community_id: communityId, asset_name: name, category: cat,
      target: targetYocto.toString(), deadline: Number(deadlineNs),
    }, "50000000000000000000000");
  } catch (e) { clearPendingActionIfToken(campaignToken); campaignFailure(e); }
}

async function contribute(campaignId) {
  if (!needWallet((m) => campStatus(campaignId, m))) return;
  let amount;
  try { amount = nearToYocto(el("amt-" + campaignId).value); } catch (e) { campStatus(campaignId, e.message); return; }
  if (amount <= 0n) { campStatus(campaignId, "Enter an amount above 0."); return; }
  // The contract takes the contribution from the attached deposit minus
  // the 0.01 NEAR storage deposit, so attach amount plus 0.01 NEAR.
  const deposit = amount + 10000000000000000000000n;
  // Read the campaign first, so the return re-check can tell this
  // contribution apart from any earlier one by the same wallet.
  let myBefore = 0n;
  try {
    const camp = await view("get_campaign", { campaign_id: campaignId });
    const mine = (camp.contributors || []).find(([a]) => a === walletAccountId);
    if (mine) myBefore = BigInt(mine[1]);
  } catch (_) { /* the re-check falls back to myBefore 0 */ }
  const contributeToken = ++pendingActionToken;
  savePendingAction({
    token: contributeToken, action: "contribute", communityId: communityId, campaignId: campaignId,
    account: walletAccountId, statusId: "campStatus-" + campaignId, progressMsg: "Contributing…",
    expected: { amount: amount.toString(), myBefore: myBefore.toString() },
    savedAt: Date.now(),
  });
  try {
    campStatus(campaignId, "Contributing…");
    await walletCall(contractId(), "contribute", { campaign_id: campaignId }, deposit.toString());
  } catch (e) { clearPendingActionIfToken(contributeToken); campFailure(campaignId, e); }
}

async function refund(campaignId) {
  if (!needWallet((m) => campStatus(campaignId, m))) return;
  const refundToken = ++pendingActionToken;
  savePendingAction({
    token: refundToken, action: "refund", communityId: communityId, campaignId: campaignId,
    account: walletAccountId, statusId: "campStatus-" + campaignId, progressMsg: "Requesting a refund…",
    expected: {}, savedAt: Date.now(),
  });
  try {
    campStatus(campaignId, "Requesting a refund…");
    await walletCall(contractId(), "refund", { campaign_id: campaignId }, "10000000000000000000000");
  } catch (e) { clearPendingActionIfToken(refundToken); campFailure(campaignId, e); }
}

// Live total for the allocation editor: the proposal is blocked unless
// the shares sum to exactly 10000 basis points.
function updateAllocSum(campaignId) {
  const inputs = document.querySelectorAll('input[id^="alloc-' + campaignId + '-"]');
  let sum = 0;
  inputs.forEach((n) => { const v = Number(n.value); if (Number.isInteger(v)) sum += v; });
  const span = el("allocSum-" + campaignId);
  if (span) span.textContent = String(sum);
}

function readAllocations(campaignId) {
  const inputs = document.querySelectorAll('input[id^="alloc-' + campaignId + '-"]');
  const out = [];
  inputs.forEach((n) => out.push([n.getAttribute("data-account"), Number(n.value)]));
  return out;
}

async function acquireAsset(campaignId) {
  if (!needWallet((m) => acquireStatus(campaignId, m))) return;
  const seller = el("seller-" + campaignId).value.trim();
  if (!seller) { acquireStatus(campaignId, "Enter the seller account id."); return; }
  const allocation = readAllocations(campaignId);
  const check = validateAllocations(allocation, community.members);
  if (!check.ok) { acquireStatus(campaignId, check.error); return; }
  const acquireToken = ++pendingActionToken;
  try {
    acquireStatus(campaignId, "Creating a DAO proposal to acquire the asset…");
    const id = await createDaoProposal(
      community.dao_id,
      "Acquire the asset for campaign " + campaignId + " from " + seller,
      "acquire_asset",
      { campaign_id: campaignId, seller: seller, allocation: allocation },
      "10000000000000000000000",
      { token: acquireToken, communityId: communityId, campaignId: campaignId, account: walletAccountId, statusId: "acquireStatus-" + campaignId, progressMsg: "Creating a DAO proposal to acquire the asset…" }
    );
    showProposalCreated(community.dao_id, id, "Acquire the asset for campaign " + campaignId + " from " + seller);
  } catch (e) { clearPendingActionIfToken(acquireToken); acquireFailure(campaignId, e); }
}

async function cancelCampaign(campaignId) {
  if (!needWallet((m) => campStatus(campaignId, m))) return;
  const cancelToken = ++pendingActionToken;
  try {
    campStatus(campaignId, "Creating a DAO proposal to cancel the campaign…");
    const id = await createDaoProposal(
      community.dao_id,
      "Cancel campaign " + campaignId + " and refund every contributor",
      "cancel_campaign",
      { campaign_id: campaignId },
      "10000000000000000000000",
      { token: cancelToken, communityId: communityId, campaignId: campaignId, account: walletAccountId, statusId: "campStatus-" + campaignId, progressMsg: "Creating a DAO proposal to cancel the campaign…" }
    );
    showProposalCreated(community.dao_id, id, "Cancel campaign " + campaignId + " and refund every contributor");
  } catch (e) { clearPendingActionIfToken(cancelToken); campFailure(campaignId, e); }
}

async function proposePolicy() {
  if (!needWallet(policyStatus)) return;
  const m = Number(el("polMembers").value);
  const t = Number(el("polTreasury").value);
  const mn = Number(el("polMaint").value);
  const a = Number(el("polActivity").value);
  if ([m, t, mn, a].some((x) => Number.isNaN(x) || x < 0 || x > 100)) { policyStatus("Percents must be numbers between 0 and 100."); return; }
  if (m + t + mn !== 100) { policyStatus("Members, retention and maintenance must sum to 100."); return; }
  const policyToken = ++pendingActionToken;
  try {
    policyStatus("Creating a DAO proposal for the distribution policy change…");
    const id = await createDaoProposal(
      community.dao_id,
      "Propose a distribution policy change for community " + communityId,
      "propose_policy_change",
      {
        community_id: communityId,
        policy_type: "Distribution",
        new_params: {
          Distribution: {
            members_bp: Math.round(m * 100), treasury_bp: Math.round(t * 100),
            maintenance_bp: Math.round(mn * 100), activity_bp: Math.round(a * 100),
          },
        },
      },
      "10000000000000000000000",
      { token: policyToken, communityId: communityId, account: walletAccountId, statusId: "policyStatus", progressMsg: "Creating a DAO proposal for the distribution policy change…" }
    );
    showProposalCreated(community.dao_id, id, "Propose a distribution policy change for community " + communityId);
  } catch (e) { clearPendingActionIfToken(policyToken); policyFailure(e); }
}

async function proposeSpendingPolicy() {
  if (!needWallet(spendingStatus)) return;
  let cap, reserve;
  try {
    cap = nearToYocto(el("spCap").value);
    reserve = nearToYocto(el("spReserve").value);
  } catch (e) { spendingStatus(e.message); return; }
  const cats = el("spCats").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!cats.length) { spendingStatus("List at least one allowed category."); return; }
  const spendingToken = ++pendingActionToken;
  try {
    spendingStatus("Creating a DAO proposal for the spending policy change…");
    const id = await createDaoProposal(
      community.dao_id,
      "Propose a spending policy change for community " + communityId,
      "propose_policy_change",
      {
        community_id: communityId,
        policy_type: "Spending",
        new_params: {
          Spending: {
            max_single_expense: cap.toString(),
            min_treasury_reserve: reserve.toString(),
            allowed_categories: cats,
          },
        },
      },
      "10000000000000000000000",
      { token: spendingToken, communityId: communityId, account: walletAccountId, statusId: "spendingStatus", progressMsg: "Creating a DAO proposal for the spending policy change…" }
    );
    showProposalCreated(community.dao_id, id, "Propose a spending policy change for community " + communityId);
  } catch (e) { clearPendingActionIfToken(spendingToken); spendingFailure(e); }
}

// execute_policy_change is NOT DAO gated: the contract lets anyone call
// it after the timelock, so this stays a direct member call.
async function executeAmendment(id) {
  if (!needWallet(amendStatus)) return;
  const amendToken = ++pendingActionToken;
  savePendingAction({
    token: amendToken, action: "execute-amendment", communityId: communityId, amendmentId: id,
    account: walletAccountId, statusId: "amendStatus", progressMsg: "Executing the amendment…",
    expected: {}, savedAt: Date.now(),
  });
  try {
    amendStatus("Executing the amendment…");
    await walletCall(contractId(), "execute_policy_change", {
      community_id: communityId,
      amendment_id: id,
    }, "10000000000000000000000");
  } catch (e) { clearPendingActionIfToken(amendToken); amendFailure(e); }
}

async function cancelAmendment(id) {
  if (!needWallet(amendStatus)) return;
  const cancelAmendToken = ++pendingActionToken;
  try {
    amendStatus("Creating a DAO proposal to cancel the amendment…");
    const pid = await createDaoProposal(
      community.dao_id,
      "Cancel policy amendment " + id + " for community " + communityId,
      "cancel_policy_change",
      {
        community_id: communityId,
        amendment_id: id,
      },
      "10000000000000000000000",
      { token: cancelAmendToken, communityId: communityId, account: walletAccountId, statusId: "amendStatus", progressMsg: "Creating a DAO proposal to cancel the amendment…" }
    );
    showProposalCreated(community.dao_id, pid, "Cancel policy amendment " + id + " for community " + communityId);
  } catch (e) { clearPendingActionIfToken(cancelAmendToken); amendFailure(e); }
}

// ---- DAO proposals: the list and the vote buttons ----
// The page used to show a Vote button only in #proposalBox right after
// a proposal was created in the same session; after a reload there was
// no way to vote. This section loads the DAO's proposals on every
// community load and renders each with its status, vote count and, for
// council members, a Vote button. The DAO is per community, so every
// proposal on it belongs to this community.
function daoProposalStatus(id, msg) { localStatus("propStatus-" + id, msg); }

async function loadDaoData() {
  const [policy, proposals] = await Promise.all([
    rpcViewCall(community.dao_id, "get_policy", {}),
    rpcViewCall(community.dao_id, "get_proposals", { from_index: 0, limit: 50 }),
  ]);
  return { policy: policy, proposals: proposals || [] };
}

function renderDaoProposals(policy, proposals) {
  const box = el("daoProposals");
  if (!box) return;
  const council = daoCouncilMembers(policy);
  const threshold = daoVoteThreshold(policy);
  const list = (proposals || []).slice().reverse(); // newest first
  if (!list.length) { box.innerHTML = "<p>No DAO proposals yet.</p>"; return; }
  box.innerHTML = list.map((p) => {
    const id = Number(p.id);
    const approvals = daoProposalApprovals(p);
    const countText = threshold === null
      ? "Approvals: " + approvals + "."
      : "Approvals: " + approvals + " of " + threshold + ".";
    let action = "";
    if (p.status === "InProgress") {
      if (walletAccountId && council.indexOf(walletAccountId) >= 0) {
        const mine = (p.votes || {})[walletAccountId];
        action = mine === "Approve"
          ? '<p class="small muted">You already voted approve on this proposal.</p>'
          : '<button onclick="voteDaoProposalFromList(' + id + ')">Vote approve proposal ' + id + "</button>";
      } else {
        action = '<p class="small muted">Only DAO council members can vote. Switch to a council member\'s wallet to vote.</p>';
      }
    }
    // The status element is always rendered, so the return re-check
    // has a target even when the vote flips the proposal to Approved
    // and the button goes away on the data refresh.
    return '<div class="panel"><p><strong>Proposal ' + id + ":</strong> " + escapeHtml(p.description) + "</p>" +
      "<p>Status " + escapeHtml(p.status) + ". Proposed by " + escapeHtml(p.proposer) + ".</p>" +
      "<p>" + countText + "</p>" + action +
      '<p id="propStatus-' + id + '" class="status"></p></div>';
  }).join("");
}

async function voteDaoProposalFromList(proposalId) {
  if (!community) return;
  const statusId = "propStatus-" + proposalId;
  if (!needWallet((m) => localStatus(statusId, m))) return;
  const voteToken = ++pendingActionToken;
  await voteDaoProposal(community.dao_id, proposalId, {
    token: voteToken, communityId: communityId, account: walletAccountId, statusId: statusId,
    progressMsg: "Voting approve on DAO proposal " + proposalId + "…",
  });
}

window.owngroundWalletChanged = loadCommunity;
