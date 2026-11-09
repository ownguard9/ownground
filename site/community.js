// Community dashboard for OwnGround. Testnet only.
let communityId = null;
let community = null;

function fmtDate(ns) {
  try { return new Date(Number(BigInt(ns) / 1000000n)).toLocaleString(); } catch (_) { return "unknown"; }
}
function needWallet() {
  if (!walletAccountId) { pageStatus("Connect a wallet first."); return false; }
  return true;
}

async function loadCommunity() {
  const params = new URLSearchParams(window.location.search);
  communityId = params.get("id");
  if (!communityId) { pageStatus("No community id in the link."); return; }
  if (!deployed()) { el("notDeployed").style.display = "block"; return; }
  pageStatus("Loading this community…");
  try {
    const [c, t, policies] = await Promise.all([
      view("get_community", { community_id: communityId }),
      view("get_treasury", { community_id: communityId }),
      view("get_policies", { community_id: communityId }),
    ]);
    community = c;
    const [campaigns, assets] = await Promise.all([
      Promise.all(community.campaign_ids.map((id) => view("get_campaign", { campaign_id: id }))),
      Promise.all(community.asset_ids.map((id) => view("get_asset", { asset_id: id }))),
    ]);
    const distributions = await Promise.all(
      community.asset_ids.map((id) => view("get_distributions", { asset_id: id }))
    );
    pageStatus("");
    el("content").style.display = "block";
    renderCommunity(community, t, policies, campaigns, assets, distributions);
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
  el("cName").textContent = c.name;
  el("cMeta").textContent = c.description + "  DAO: " + c.dao_id + "  Members: " + c.members.join(", ");
  el("daoLink").href = "https://testnet.nearblocks.io/address/" + c.dao_id;

  // Four separate figures, never combined into one total: verified
  // revenue (onchain deposits only), expenses, retained reserves, and
  // distributable revenue. Treasury detail follows below them.
  const onchainRevenue = assets.reduce((sum, a) => sum + BigInt(a.revenue_onchain), 0n);
  const expenseCount = assets.reduce((n, a) => n + (a.expense_count || 0), 0);
  const paidMembers = aggregatePayouts(c.members, distributions);
  const paidCount = [...paidMembers.values()].filter((v) => v > 0n).length;
  const cards = [
    ["Verified revenue", fmtYocto(t.total_revenue) + " NEAR", fmtYocto(onchainRevenue) + " NEAR recorded onchain", "tone-green"],
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
    return '<div class="panel"><h3>' + escapeHtml(camp.asset_name) + '</h3>' +
      "<p>Target " + fmtYocto(camp.target) + " NEAR, raised " + fmtYocto(camp.raised) + " NEAR. Status " + escapeHtml(camp.status) + ". Deadline " + fmtDate(camp.deadline) + ".</p>" +
      "<p class=\"small muted\">You contributed " + (mine ? fmtYocto(mine[1]) + " NEAR" : "nothing yet") + ".</p>" +
      '<label>Amount in NEAR<input id="amt-' + escapeHtml(camp.id) + '" placeholder="2.5"></label>' +
      '<button onclick="contribute(\'' + escapeHtml(camp.id) + '\')">Contribute</button> ' +
      '<button onclick="refund(\'' + escapeHtml(camp.id) + '\')">Refund my contribution</button> ' +
      '<button onclick="acquireAsset(\'' + escapeHtml(camp.id) + '\')">Acquire asset (DAO)</button></div>';
  }).join("") : "<p>No campaigns yet.</p>";

  el("assets").innerHTML = assets.length ? assets.map((a) =>
    '<div class="panel"><h3><a href="asset.html?id=' + encodeURIComponent(a.id) + '">' + escapeHtml(a.name) + "</a></h3>" +
    "<p>Value " + fmtYocto(a.value) + " NEAR. Realised revenue " + fmtYocto(a.revenue_onchain) + " NEAR. Expenses " + fmtYocto(a.expenses_total) + " NEAR. Status " + escapeHtml(a.status) + ".</p></div>"
  ).join("") : "<p>No assets yet.</p>";

  el("curPolicy").textContent = "members " + c.policy.members_bp / 100 + "%, retention " + c.policy.treasury_bp / 100 +
    "%, maintenance " + c.policy.maintenance_bp / 100 + "%, activity share " + c.policy.activity_bp / 100 + "% of the member pool";
  const sp = c.spending_policy;
  el("curSpending").textContent = "cap " + fmtYocto(sp.max_single_expense) + " NEAR (0 means no cap), reserve " +
    fmtYocto(sp.min_treasury_reserve) + " NEAR, categories " + sp.allowed_categories.join(", ");
  if (c.capital_points.length) {
    const pts = c.capital_points.map(([a, p]) => escapeHtml(a) + " " + p).join(", ");
    const p = document.createElement("p");
    p.className = "small muted";
    p.textContent = "Capital points (cumulative contributions; display only, they never affect the activity slice): " + pts;
    el("curPolicy").parentElement.appendChild(p);
  }
  const ap = c.activity_policy;
  const q = document.createElement("p");
  q.className = "small muted";
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

async function createCampaign() {
  if (!needWallet()) return;
  const name = el("campName").value.trim();
  const cat = el("campCat").value.trim();
  const target = el("campTarget").value.trim();
  const date = el("campDeadline").value;
  if (!name || !cat || !target || !date) { pageStatus("Fill in the asset name, category, target and deadline."); return; }
  let targetYocto, deadlineNs;
  try { targetYocto = nearToYocto(target); } catch (e) { pageStatus(e.message); return; }
  deadlineNs = BigInt(Date.parse(date + "T00:00:00Z")) * 1000000n;
  if (deadlineNs <= BigInt(Date.now()) * 1000000n) { pageStatus("Pick a future deadline."); return; }
  try {
    pageStatus("Starting the campaign…");
    await walletCall(contractId(), "create_campaign", {
      community_id: communityId, asset_name: name, category: cat,
      target: targetYocto.toString(), deadline: deadlineNs.toString(),
    }, "50000000000000000000000");
  } catch (e) { reportFailure(e); }
}

async function contribute(campaignId) {
  if (!needWallet()) return;
  let amount;
  try { amount = nearToYocto(el("amt-" + campaignId).value); } catch (e) { pageStatus(e.message); return; }
  if (amount <= 0n) { pageStatus("Enter an amount above 0."); return; }
  // The contract takes the contribution from the attached deposit minus
  // the 0.01 NEAR storage deposit, so attach amount plus 0.01 NEAR.
  const deposit = amount + 10000000000000000000000n;
  try {
    pageStatus("Contributing…");
    await walletCall(contractId(), "contribute", { campaign_id: campaignId }, deposit.toString());
  } catch (e) { reportFailure(e); }
}

async function refund(campaignId) {
  if (!needWallet()) return;
  try {
    pageStatus("Requesting a refund…");
    await walletCall(contractId(), "refund", { campaign_id: campaignId }, "10000000000000000000000");
  } catch (e) { reportFailure(e); }
}

async function acquireAsset(campaignId) {
  if (!needWallet()) return;
  const seller = window.prompt("Seller account id (receives the target amount):");
  if (!seller) return;
  try {
    pageStatus("Acquiring the asset…");
    await walletCall(contractId(), "acquire_asset", { campaign_id: campaignId, seller: seller.trim() }, "10000000000000000000000");
  } catch (e) { reportFailure(e); }
}

async function proposePolicy() {
  if (!needWallet()) return;
  const m = Number(el("polMembers").value);
  const t = Number(el("polTreasury").value);
  const mn = Number(el("polMaint").value);
  const a = Number(el("polActivity").value);
  if ([m, t, mn, a].some((x) => Number.isNaN(x) || x < 0 || x > 100)) { pageStatus("Percents must be numbers between 0 and 100."); return; }
  if (m + t + mn !== 100) { pageStatus("Members, retention and maintenance must sum to 100."); return; }
  try {
    pageStatus("Proposing the distribution policy change…");
    await walletCall(contractId(), "propose_policy_change", {
      community_id: communityId,
      policy_type: "Distribution",
      new_params: {
        Distribution: {
          members_bp: Math.round(m * 100), treasury_bp: Math.round(t * 100),
          maintenance_bp: Math.round(mn * 100), activity_bp: Math.round(a * 100),
        },
      },
    }, "10000000000000000000000");
  } catch (e) { reportFailure(e); }
}

async function proposeSpendingPolicy() {
  if (!needWallet()) return;
  let cap, reserve;
  try {
    cap = nearToYocto(el("spCap").value);
    reserve = nearToYocto(el("spReserve").value);
  } catch (e) { pageStatus(e.message); return; }
  const cats = el("spCats").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!cats.length) { pageStatus("List at least one allowed category."); return; }
  try {
    pageStatus("Proposing the spending policy change…");
    await walletCall(contractId(), "propose_policy_change", {
      community_id: communityId,
      policy_type: "Spending",
      new_params: {
        Spending: {
          max_single_expense: cap.toString(),
          min_treasury_reserve: reserve.toString(),
          allowed_categories: cats,
        },
      },
    }, "10000000000000000000000");
  } catch (e) { reportFailure(e); }
}

async function executeAmendment(id) {
  if (!needWallet()) return;
  try {
    pageStatus("Executing the amendment…");
    await walletCall(contractId(), "execute_policy_change", {
      community_id: communityId,
      amendment_id: id,
    }, "10000000000000000000000");
  } catch (e) { reportFailure(e); }
}

async function cancelAmendment(id) {
  if (!needWallet()) return;
  try {
    pageStatus("Cancelling the amendment…");
    await walletCall(contractId(), "cancel_policy_change", {
      community_id: communityId,
      amendment_id: id,
    }, "10000000000000000000000");
  } catch (e) { reportFailure(e); }
}

window.owngroundWalletChanged = loadCommunity;
