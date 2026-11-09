// Asset page for OwnGround. Testnet only.
let assetId = null;
let asset = null;
let community = null;
let currentRevenue = [];

function fmtDate(ns) {
  try { return new Date(Number(BigInt(ns) / 1000000n)).toLocaleString(); } catch (_) { return "unknown"; }
}
function needWallet() {
  if (!walletAccountId) { pageStatus("Connect a wallet first."); return false; }
  return true;
}

async function loadAsset() {
  const params = new URLSearchParams(window.location.search);
  assetId = params.get("id");
  if (!assetId) { pageStatus("No asset id in the link."); return; }
  if (!deployed()) { el("notDeployed").style.display = "block"; return; }
  try {
    asset = await view("get_asset", { asset_id: assetId });
    community = await view("get_community", { community_id: asset.community_id });
    const treasury = await view("get_treasury", { community_id: asset.community_id });
    const revenue = await view("get_revenue", { asset_id: assetId });
    const expenses = await view("get_expenses", { asset_id: assetId });
    const distributions = await view("get_distributions", { asset_id: assetId });
    currentRevenue = revenue;
    el("content").style.display = "block";
    renderAsset(asset, community, treasury, revenue, expenses, distributions);
  } catch (e) {
    pageStatus("Could not load this asset: " + String(e.message).slice(0, 160));
  }
}

function renderAsset(a, c, t, revenue, expenses, distributions) {
  el("aName").textContent = a.name;
  el("aMeta").textContent = a.category + "  Seller: " + a.seller + "  Status " + a.status +
    "  Ownership is pro rata to contributions.";
  el("backLink").href = "community.html?id=" + encodeURIComponent(a.community_id);

  const cards = [
    ["Acquisition value", fmtYocto(a.value) + " NEAR"],
    ["Treasury balance", fmtYocto(t.treasury) + " NEAR"],
    ["Realised revenue", fmtYocto(a.revenue_onchain) + " NEAR"],
    ["Expenses on this asset", fmtYocto(a.expenses_total) + " NEAR"],
    ["Already distributed", fmtYocto(a.distributed_total) + " NEAR"],
  ];
  el("assetCards").innerHTML = cards.map(([k, v]) =>
    '<div class="card"><div class="muted small">' + escapeHtml(k) + '</div><div class="big">' + escapeHtml(v) + "</div></div>").join("");

  // "Onchain" means the deposit was confirmed onchain, never that the
  // asset generated the income. An attested entry is a member-attested
  // claim: another member bonded it, not proof the revenue happened.
  // Nothing on this page calls an attested entry "verified".
  const statusLabel = {
    Onchain: "Deposit confirmed",
    Pending: "Reported — not independently verified",
    Verified: "Member-attested claim",
    Disputed: "Disputed — points suspended",
    Rejected: "Rejected by DAO vote",
  };
  el("revenueList").innerHTML = revenue.length ? revenue.map((r) => {
    const entryId = String(Number(r.id));
    const bond = attestationBondYocto(r.amount);
    let actions = "";
    let note = "";
    if (r.status === "Pending" && walletAccountId && walletAccountId !== r.recorded_by) {
      actions += ' <button data-action="attest" data-entry-id="' + entryId + '">Attest (' + fmtYocto(bond) + ' NEAR bond)</button>';
      note = "<p class=\"small muted\">Attesting this " + fmtYocto(r.amount) + " NEAR claim requires a " + fmtYocto(bond) +
        " NEAR bond (0.1 NEAR + 10% of the claim) plus 0.01 NEAR storage.</p>";
    }
    if (r.status === "Verified" && walletAccountId && walletAccountId !== r.recorded_by && walletAccountId !== r.attestor) {
      actions += ' <button data-action="dispute" data-entry-id="' + entryId + '">Dispute</button>';
      note = "<p class=\"small muted\">Disputing attaches a 0.05 NEAR bond plus 0.01 NEAR storage.</p>";
    }
    if (r.status === "Verified" && r.bond_status === "Held" && walletAccountId === r.attestor) {
      actions += ' <button data-action="release-bond" data-entry-id="' + entryId + '">Release bond</button>';
    }
    if (r.status === "Disputed") {
      actions += ' <button data-action="resolve-uphold" data-entry-id="' + entryId + '">Propose uphold dispute (DAO)</button>' +
        ' <button data-action="resolve-reject" data-entry-id="' + entryId + '">Propose reject dispute (DAO)</button>';
      const autoNs = disputeAutoResolveNs(r, community ? community.dispute_window_ns : null);
      if (autoNs !== null) {
        const autoDate = fmtDate(autoNs);
        if (BigInt(Date.now()) * 1000000n >= autoNs) {
          note = "<p class=\"small muted\">This dispute can now be auto-resolved: the resolution deadline passed on " + escapeHtml(autoDate) + ".</p>";
          actions += ' <button data-action="auto-resolve" data-entry-id="' + entryId + '">Auto-resolve expired dispute</button>';
        } else {
          note = "<p class=\"small muted\">This dispute can be auto-resolved after " + escapeHtml(autoDate) + " if the DAO has not resolved it by then.</p>";
        }
      }
    }
    return '<div class="panel"><p>' + fmtYocto(r.amount) + " NEAR, " + escapeHtml(r.source) +
      " (" + escapeHtml(statusLabel[r.status] || r.status) + "). Reference " + escapeHtml(r.reference) +
      ", recorded by " + escapeHtml(r.recorded_by) + " on " + fmtDate(r.recorded_at) +
      (r.attestor ? ", attested by " + escapeHtml(r.attestor) : "") +
      (r.points_awarded ? ", work points " + r.points_awarded : "") + ".</p>" + note + actions + "</div>";
  }).join("") : "<p>No revenue recorded yet.</p>";

  el("expenseList").innerHTML = expenses.length ? expenses.map((x) =>
    '<div class="panel"><p>' + fmtYocto(x.amount) + " NEAR to " + escapeHtml(x.recipient) +
    ", " + escapeHtml(x.description) + " (" + escapeHtml(x.category) + "), " + fmtDate(x.recorded_at) + ".</p></div>"
  ).join("") : "<p>No expenses yet.</p>";

  el("distributionList").innerHTML = distributions.length ? distributions.map((d) => {
    const own = d.ownership_payouts.map(([a, v]) => escapeHtml(a) + " " + fmtYocto(v) + " NEAR").join(", ");
    const act = d.activity_payouts.map(([a, v]) => escapeHtml(a) + " " + fmtYocto(v) + " NEAR").join(", ");
    const myPayoutFailed = walletAccountId && (d.unpaid || []).indexOf(walletAccountId) >= 0;
    return '<div class="panel"><p>Distribution ' + d.id + " on " + fmtDate(d.executed_at) + ": " +
      fmtYocto(d.distributed) + " NEAR total, " + fmtYocto(d.member_total) + " NEAR to members, " +
      fmtYocto(d.retention) + " NEAR kept in the treasury, " + fmtYocto(d.maintenance) + " NEAR to maintenance. " +
      "Activity pool " + fmtYocto(d.activity_pool) + " NEAR, ownership pool " + fmtYocto(d.ownership_pool) +
      " NEAR, total work points " + d.total_work_points + ".</p>" +
      "<p class=\"small\">Ownership: " + (own || "none") + "</p>" +
      "<p class=\"small\">Activity (member-attested work): " + (act || "none") + "</p>" +
      (d.unpaid.length ? "<p class=\"small\">Unpaid (transfer failed, credited back): " + d.unpaid.map(escapeHtml).join(", ") + "</p>" : "") +
      (myPayoutFailed
        ? "<p class=\"small\">Your payout from this distribution failed to transfer. Claiming pays the exact original amount to you.</p>" +
          ' <button data-action="claim-payout" data-distribution-id="' + d.id + '">Claim payout</button>'
        : "") +
      "</div>";
  }).join("") : "<p>No distributions yet.</p>";

  const sp = c.spending_policy;
  el("spendingNow").textContent = "cap " + fmtYocto(sp.max_single_expense) + " NEAR (0 means no cap), reserve " +
    fmtYocto(sp.min_treasury_reserve) + " NEAR, categories " + sp.allowed_categories.join(", ");
  el("distPolicy").textContent = "members " + c.policy.members_bp / 100 + "%, retention " + c.policy.treasury_bp / 100 +
    "%, maintenance " + c.policy.maintenance_bp / 100 + "%, activity share " + c.policy.activity_bp / 100 + "% of the member pool";
  el("epochNow").textContent = String(a.epoch);
  const work = a.work_points.map(([m, p]) => escapeHtml(m) + " current " + p.current + ", lifetime " + p.lifetime).join(", ");
  if (work) {
    const p = document.createElement("p");
    p.className = "small muted";
    p.textContent = "Work points on this asset (current epoch / lifetime): " + work;
    el("epochNow").parentElement.appendChild(p);
  }
}

async function recordRevenue() {
  if (!needWallet()) return;
  let amount;
  try { amount = nearToYocto(el("revAmount").value); } catch (e) { pageStatus(e.message); return; }
  if (amount <= 0n) { pageStatus("Enter an amount above 0."); return; }
  const source = el("revSource").value.trim();
  const ref = el("revRef").value.trim();
  const status = el("revStatus").value;
  if (!source) { pageStatus("Describe the revenue source."); return; }
  if (!ref) { pageStatus("Every revenue entry needs an evidence reference."); return; }
  const sourceErr = checkFieldLength(source, FIELD_LIMITS.revenueSource, "The revenue source");
  if (sourceErr) { pageStatus(sourceErr); return; }
  const refErr = checkFieldLength(ref, FIELD_LIMITS.revenueReference, "The evidence reference");
  if (refErr) { pageStatus(refErr); return; }
  // The contract derives the status from the deposit: onchain revenue
  // attaches amount plus 0.01 NEAR storage; reported revenue attaches
  // exactly 0.01 NEAR.
  const deposit = status === "Onchain"
    ? amount + 10000000000000000000000n
    : 10000000000000000000000n;
  try {
    pageStatus("Recording revenue…");
    await walletCall(contractId(), "record_revenue", {
      asset_id: assetId, amount: amount.toString(), source: source,
      reference: ref,
    }, deposit.toString());
  } catch (e) { reportFailure(e); }
}

async function payExpense() {
  if (!needWallet()) return;
  let amount;
  try { amount = nearToYocto(el("expAmount").value); } catch (e) { pageStatus(e.message); return; }
  if (amount <= 0n) { pageStatus("Enter an amount above 0."); return; }
  const recipient = el("expRecipient").value.trim();
  const desc = el("expDesc").value.trim();
  const cat = el("expCat").value.trim();
  if (!recipient || !desc || !cat) { pageStatus("Fill in the recipient, description and category."); return; }
  const descErr = checkFieldLength(desc, FIELD_LIMITS.expenseDescription, "The expense description");
  if (descErr) { pageStatus(descErr); return; }
  try {
    pageStatus("Creating a DAO proposal to pay the expense…");
    const id = await createDaoProposal(
      community.dao_id,
      "Pay an expense of " + fmtYocto(amount) + " NEAR to " + recipient + " for asset " + assetId,
      "pay_expense",
      {
        asset_id: assetId, amount: amount.toString(), recipient: recipient,
        description: desc, category: cat,
      },
      "10000000000000000000000"
    );
    showProposalCreated(community.dao_id, id, "Pay an expense of " + fmtYocto(amount) + " NEAR to " + recipient + " for asset " + assetId);
  } catch (e) { reportFailure(e); }
}

async function resolveDispute(entryId, uphold) {
  if (!needWallet()) return;
  const what = uphold ? "uphold" : "reject";
  try {
    pageStatus("Creating a DAO proposal to " + what + " the dispute…");
    const id = await createDaoProposal(
      community.dao_id,
      (uphold ? "Uphold" : "Reject") + " the dispute on revenue entry " + entryId + " for asset " + assetId,
      "resolve_dispute",
      { asset_id: assetId, entry_id: entryId, uphold: uphold },
      "10000000000000000000000"
    );
    showProposalCreated(community.dao_id, id, (uphold ? "Uphold" : "Reject") + " the dispute on revenue entry " + entryId + " for asset " + assetId);
  } catch (e) { reportFailure(e); }
}

async function executeDistribution() {
  if (!needWallet()) return;
  try {
    pageStatus("Executing the distribution…");
    await walletCall(contractId(), "execute_distribution", { asset_id: assetId }, "10000000000000000000000");
  } catch (e) { reportFailure(e); }
}

async function attestRevenue(entryId) {
  if (!needWallet()) return;
  const entry = (currentRevenue || []).find((r) => Number(r.id) === Number(entryId));
  if (!entry) { pageStatus("Could not find that revenue entry. Reload the page and try again."); return; }
  const bond = attestationBondYocto(entry.amount);
  const deposit = attestationDepositYocto(entry.amount);
  try {
    pageStatus("Attesting this " + fmtYocto(entry.amount) + " NEAR claim requires a " + fmtYocto(bond) +
      " NEAR bond (0.1 NEAR + 10% of the claim) plus 0.01 NEAR storage. Signing now.");
    await walletCall(contractId(), "attest_revenue", {
      asset_id: assetId, entry_id: Number(entryId),
    }, deposit.toString());
  } catch (e) { reportFailure(e); }
}

async function disputeRevenue(entryId) {
  if (!needWallet()) return;
  try {
    pageStatus("Disputing attaches a 0.05 NEAR bond plus 0.01 NEAR storage. Signing now.");
    await walletCall(contractId(), "dispute_revenue", {
      asset_id: assetId, entry_id: Number(entryId),
    }, DISPUTE_DEPOSIT_YOCTO.toString());
  } catch (e) { reportFailure(e); }
}

// Auto-resolve a dispute whose resolution deadline has passed: the
// contract upholds it (the attestation is overturned) without a DAO vote.
async function resolveDisputeExpired(entryId) {
  if (!needWallet()) return;
  try {
    pageStatus("Auto-resolving the expired dispute…");
    await walletCall(contractId(), "resolve_dispute_expired", {
      asset_id: assetId, entry_id: Number(entryId),
    }, "0");
  } catch (e) { reportFailure(e); }
}

// Claim a payout whose transfer failed: the contract pays the exact
// original amount to the original recipient (the connected wallet).
async function claimFailedPayout(distributionId) {
  if (!needWallet()) return;
  try {
    pageStatus("Claiming your failed payout…");
    await walletCall(contractId(), "claim_failed_payout", {
      distribution_id: Number(distributionId),
    }, "10000000000000000000000");
  } catch (e) { reportFailure(e); }
}

async function releaseBond(entryId) {
  if (!needWallet()) return;
  try {
    pageStatus("Releasing the bond…");
    await walletCall(contractId(), "release_attestation_bond", {
      asset_id: assetId, entry_id: entryId,
    }, "10000000000000000000000");
  } catch (e) { reportFailure(e); }
}

async function showBreakdown() {
  if (!needWallet()) return;
  const id = Number(el("bdId").value);
  if (Number.isNaN(id) || id < 0) { pageStatus("Enter a distribution id."); return; }
  try {
    const b = await view("get_distribution_breakdown", { distribution_id: id, account: walletAccountId });
    el("breakdown").innerHTML =
      "<p>D (distributed) " + fmtYocto(b.distributed) + " NEAR. Member pool " + fmtYocto(b.member_total) +
      " NEAR. Activity pool " + fmtYocto(b.activity_pool) + " NEAR. Ownership pool " + fmtYocto(b.ownership_pool) + " NEAR.</p>" +
      "<p>Your allocation " + (b.member_allocation_bp / 100) + " percent. Your work points " + b.member_work_points +
      " of " + b.total_work_points + " total.</p>" +
      "<p>Ownership payout " + fmtYocto(b.ownership_payout) + " NEAR. Activity payout " + fmtYocto(b.activity_payout) +
      " NEAR. Total " + fmtYocto(b.total_payout) + " NEAR.</p>" +
      "<p class=\"small muted\">Ownership = ownership pool x allocation / 10000. Activity = activity pool x your work points / total work points.</p>";
  } catch (e) { reportFailure(e); }
}

// Delegated actions for the revenue and distribution lists. The lists
// are re-rendered from chain data on every load, so one listener per
// list (attached once, never re-created) handles every button. Buttons
// carry data-action and numeric data-entry-id / data-distribution-id:
// no id is ever interpolated into a JavaScript string.
(function attachAssetListeners() {
  const revenueList = el("revenueList");
  if (revenueList) {
    revenueList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const entryId = Number(btn.getAttribute("data-entry-id"));
      if (Number.isNaN(entryId)) return;
      const action = btn.getAttribute("data-action");
      if (action === "attest") attestRevenue(entryId);
      else if (action === "dispute") disputeRevenue(entryId);
      else if (action === "release-bond") releaseBond(entryId);
      else if (action === "resolve-uphold") resolveDispute(entryId, true);
      else if (action === "resolve-reject") resolveDispute(entryId, false);
      else if (action === "auto-resolve") resolveDisputeExpired(entryId);
    });
  }
  const distributionList = el("distributionList");
  if (distributionList) {
    distributionList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action='claim-payout']");
      if (!btn) return;
      const distributionId = Number(btn.getAttribute("data-distribution-id"));
      if (!Number.isNaN(distributionId)) claimFailedPayout(distributionId);
    });
  }
  const bind = (id, fn) => { const b = el(id); if (b) b.addEventListener("click", fn); };
  bind("connectBtn", toggleWallet);
  bind("recordRevenueBtn", recordRevenue);
  bind("payExpenseBtn", payExpense);
  bind("executeDistributionBtn", executeDistribution);
  bind("showBreakdownBtn", showBreakdown);
})();

window.owngroundWalletChanged = loadAsset;
