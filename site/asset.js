// Asset page for OwnGround. Testnet only.
let assetId = null;
let asset = null;
let community = null;

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
  // asset generated the income. "Verified" is only for attested entries.
  const statusLabel = {
    Onchain: "Deposit confirmed",
    Pending: "Reported — not independently verified",
    Verified: "Verified by attestation",
    Disputed: "Disputed — points suspended",
    Rejected: "Rejected by DAO vote",
  };
  el("revenueList").innerHTML = revenue.length ? revenue.map((r) => {
    let actions = "";
    if (r.status === "Pending" && walletAccountId && walletAccountId !== r.recorded_by) {
      actions += ' <button onclick="attestRevenue(' + r.id + ')">Attest (0.1 NEAR bond)</button>';
    }
    if (r.status === "Verified" && walletAccountId && walletAccountId !== r.recorded_by && walletAccountId !== r.attestor) {
      actions += ' <button onclick="disputeRevenue(' + r.id + ')">Dispute</button>';
    }
    if (r.status === "Verified" && r.bond_status === "Held" && walletAccountId === r.attestor) {
      actions += ' <button onclick="releaseBond(' + r.id + ')">Release bond</button>';
    }
    if (r.status === "Disputed") {
      actions += ' <button onclick="resolveDispute(' + r.id + ', true)">Propose uphold dispute (DAO)</button>' +
        ' <button onclick="resolveDispute(' + r.id + ', false)">Propose reject dispute (DAO)</button>';
    }
    return '<div class="panel"><p>' + fmtYocto(r.amount) + " NEAR, " + escapeHtml(r.source) +
      " (" + escapeHtml(statusLabel[r.status] || r.status) + "). Reference " + escapeHtml(r.reference) +
      ", recorded by " + escapeHtml(r.recorded_by) + " on " + fmtDate(r.recorded_at) +
      (r.attestor ? ", attested by " + escapeHtml(r.attestor) : "") +
      (r.points_awarded ? ", work points " + r.points_awarded : "") + ".</p>" + actions + "</div>";
  }).join("") : "<p>No revenue recorded yet.</p>";

  el("expenseList").innerHTML = expenses.length ? expenses.map((x) =>
    '<div class="panel"><p>' + fmtYocto(x.amount) + " NEAR to " + escapeHtml(x.recipient) +
    ", " + escapeHtml(x.description) + " (" + escapeHtml(x.category) + "), " + fmtDate(x.recorded_at) + ".</p></div>"
  ).join("") : "<p>No expenses yet.</p>";

  el("distributionList").innerHTML = distributions.length ? distributions.map((d) => {
    const own = d.ownership_payouts.map(([a, v]) => escapeHtml(a) + " " + fmtYocto(v) + " NEAR").join(", ");
    const act = d.activity_payouts.map(([a, v]) => escapeHtml(a) + " " + fmtYocto(v) + " NEAR").join(", ");
    return '<div class="panel"><p>Distribution ' + d.id + " on " + fmtDate(d.executed_at) + ": " +
      fmtYocto(d.distributed) + " NEAR total, " + fmtYocto(d.member_total) + " NEAR to members, " +
      fmtYocto(d.retention) + " NEAR kept in the treasury, " + fmtYocto(d.maintenance) + " NEAR to maintenance. " +
      "Activity pool " + fmtYocto(d.activity_pool) + " NEAR, ownership pool " + fmtYocto(d.ownership_pool) +
      " NEAR, total work points " + d.total_work_points + ".</p>" +
      "<p class=\"small\">Ownership: " + (own || "none") + "</p>" +
      "<p class=\"small\">Activity (verified work): " + (act || "none") + "</p>" +
      (d.unpaid.length ? "<p class=\"small\">Unpaid (transfer failed, credited back): " + d.unpaid.map(escapeHtml).join(", ") + "</p>" : "") +
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
  try {
    pageStatus("Attesting the entry…");
    await walletCall(contractId(), "attest_revenue", {
      asset_id: assetId, entry_id: entryId,
    }, "110000000000000000000000");
  } catch (e) { reportFailure(e); }
}

async function disputeRevenue(entryId) {
  if (!needWallet()) return;
  try {
    pageStatus("Disputing the entry…");
    await walletCall(contractId(), "dispute_revenue", {
      asset_id: assetId, entry_id: entryId,
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

window.owngroundWalletChanged = loadAsset;
