// DAO proposal helpers for OwnGround. Pure functions, no DOM, so they
// are unit tested in dao.test.cjs. The browser helpers at the bottom use
// the shared walletCall / rpcViewCall from common.js.
//
// Why this file exists: the contract gates acquire_asset, pay_expense,
// cancel_campaign, propose_policy_change, cancel_policy_change and
// resolve_dispute to the community's Sputnik DAO (require_dao). A member
// wallet calling them directly always fails. The working pattern is the
// one in scripts/demo.mjs (daoCall): read get_last_proposal_id from the
// DAO first, then call add_proposal on the DAO with a FunctionCall action
// whose deposit rides inside the proposal, attached deposit 1 NEAR for
// add_proposal. On the site the MEMBER's wallet signs add_proposal to the
// DAO contract, which is the normal Sputnik flow. Votes use act_proposal
// with 150 TGas and 0 deposit.
const DAO_PROPOSAL_DEPOSIT_YOCTO = "1000000000000000000000000"; // 1 NEAR
const DAO_ACTION_GAS = "100000000000000"; // 100 TGas, as in demo.mjs
const DAO_VOTE_GAS = "150000000000000"; // 150 TGas, as in demo.mjs

function base64Encode(s) {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(s)));
}

// Read the DAO council and the approval threshold out of a Sputnik v2
// get_policy result. The council is the "council" role's Group; the
// threshold comes from that role's vote_policy, falling back to the DAO
// default. Weight is an absolute count. RoleWeight and Ratio are
// fractions of the council's total weight (every member weighs 1), and
// a proposal needs strictly more than the fraction, so the count is
// floor(size * num / den) + 1. A policy with no usable threshold
// returns null, and the page shows approvals without a total.
function daoCouncilMembers(policy) {
  const roles = (policy && policy.roles) || [];
  const council = roles.find((r) => r.name === "council");
  const kind = council && council.kind;
  if (kind && Array.isArray(kind.Group)) return kind.Group.slice();
  return [];
}
function daoVoteThreshold(policy) {
  const roles = (policy && policy.roles) || [];
  const council = roles.find((r) => r.name === "council");
  let vp = (council && council.vote_policy) || {};
  if (!vp || Object.keys(vp).length === 0) vp = (policy && policy.default_vote_policy) || {};
  if (vp.Weight !== undefined) return Number(vp.Weight);
  const councilSize = daoCouncilMembers(policy).length;
  const frac = vp.RoleWeight || vp.Ratio;
  if (Array.isArray(frac) && frac.length === 2 && councilSize > 0 && Number(frac[1]) > 0) {
    return Math.floor((councilSize * Number(frac[0])) / Number(frac[1])) + 1;
  }
  return null;
}
// Approvals so far on a proposal: the first element of each role's
// vote_counts triple [approve, reject, remove], summed across roles.
function daoProposalApprovals(proposal) {
  const counts = (proposal && proposal.vote_counts) || {};
  let total = 0;
  for (const role of Object.keys(counts)) {
    const arr = counts[role];
    if (Array.isArray(arr)) total += Number(arr[0]) || 0;
  }
  return total;
}

// Link to the DAO on the testnet explorer. The proposal id is shown in
// the link text next to it; Nearblocks lists DAO proposals under the
// DAO address.
function daoProposalUrl(daoId) {
  return "https://testnet.nearblocks.io/address/" + daoId;
}

// Build the exact add_proposal arguments demo.mjs uses: { proposal:
// { description, kind: { FunctionCall: { receiver_id, actions: [{
// method_name, args (base64 JSON), deposit (string yoctoNEAR),
// gas: "100000000000000" }] } } } }. The contract method, its args and
// the deposit inside the action are unchanged: the deposit rides inside
// the proposal, exactly as the demo does it.
function buildDaoProposalArgs(contractId, description, method, args, depositYocto) {
  return {
    proposal: {
      description: description,
      kind: {
        FunctionCall: {
          receiver_id: contractId,
          actions: [{
            method_name: method,
            args: base64Encode(JSON.stringify(args)),
            deposit: depositYocto.toString(),
            gas: DAO_ACTION_GAS,
          }],
        },
      },
    },
  };
}

// Pro-rata allocations in basis points, by each contributor's share of
// the campaign total. Largest remainder method, so the result always
// sums to exactly 10000. Contributors who put in nothing get no share:
// the contract rejects a zero share. Returns [[account, bp], ...].
function proRataAllocations(contributors) {
  const rows = (contributors || [])
    .map(([account, amount]) => [account, BigInt(amount)])
    .filter(([, amount]) => amount > 0n);
  const total = rows.reduce((sum, [, amount]) => sum + amount, 0n);
  if (!rows.length || total === 0n) return [];
  const shares = rows.map(([account, amount]) => {
    const scaled = amount * 10000n;
    return { account: account, whole: Number(scaled / total), rem: scaled % total };
  });
  let assigned = shares.reduce((sum, s) => sum + s.whole, 0);
  shares.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0));
  for (let i = 0; assigned < 10000 && i < shares.length; i++) {
    shares[i].whole += 1;
    assigned += 1;
  }
  return shares.map((s) => [s.account, s.whole]);
}

// Client-side allocation validation. Mirrors the contract's
// validate_allocations: at least one owner, every share above zero, every
// account a community member, no duplicates, and the sum exactly 10000.
// Returns { ok, sum, error }; error is plain text for the page status.
function validateAllocations(allocations, members) {
  const list = allocations || [];
  if (!list.length) return { ok: false, sum: 0, error: "Name at least one owner in the allocation." };
  let sum = 0;
  const seen = [];
  for (const [account, bp] of list) {
    const n = Number(bp);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, sum: sum, error: "Every allocation share must be a whole number above zero." };
    }
    if (members && members.indexOf(account) < 0) {
      return { ok: false, sum: sum, error: account + " is not a community member, so it cannot own a share." };
    }
    if (seen.indexOf(account) >= 0) {
      return { ok: false, sum: sum, error: "Duplicate allocation for " + account + "." };
    }
    seen.push(account);
    sum += n;
  }
  if (sum !== 10000) {
    return { ok: false, sum: sum, error: "Allocation shares must sum to exactly 10000 basis points (100 percent). They sum to " + sum + " right now." };
  }
  return { ok: true, sum: sum, error: null };
}

(function (root) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      DAO_PROPOSAL_DEPOSIT_YOCTO: DAO_PROPOSAL_DEPOSIT_YOCTO,
      DAO_ACTION_GAS: DAO_ACTION_GAS,
      DAO_VOTE_GAS: DAO_VOTE_GAS,
      daoProposalUrl: daoProposalUrl,
      daoCouncilMembers: daoCouncilMembers,
      daoVoteThreshold: daoVoteThreshold,
      daoProposalApprovals: daoProposalApprovals,
      buildDaoProposalArgs: buildDaoProposalArgs,
      proRataAllocations: proRataAllocations,
      validateAllocations: validateAllocations,
    };
  }
  if (root) {
    root.DAO_PROPOSAL_DEPOSIT_YOCTO = DAO_PROPOSAL_DEPOSIT_YOCTO;
    root.DAO_ACTION_GAS = DAO_ACTION_GAS;
    root.DAO_VOTE_GAS = DAO_VOTE_GAS;
    root.daoProposalUrl = daoProposalUrl;
    root.daoCouncilMembers = daoCouncilMembers;
    root.daoVoteThreshold = daoVoteThreshold;
    root.daoProposalApprovals = daoProposalApprovals;
    root.buildDaoProposalArgs = buildDaoProposalArgs;
    root.proRataAllocations = proRataAllocations;
    root.validateAllocations = validateAllocations;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));

// ---- Browser helpers (need common.js: walletCall, rpcViewCall) ----
// Create a DAO proposal and return its id. The optional pendingMeta
// (from the community page only) records the pending action BEFORE the
// wallet opens, so the page's return re-check can confirm it landed
// after the user comes back from the wallet tab. On pages without a
// pending-action tracker (the asset page) pendingMeta is omitted and
// nothing is recorded; the typeof guard keeps this a no-op there.
async function createDaoProposal(daoId, description, method, args, depositYocto, pendingMeta) {
  // Read the next proposal id BEFORE creating it, as in demo.mjs: a
  // read after add_proposal can return the stale pre-write count.
  const proposalId = Number(await rpcViewCall(daoId, "get_last_proposal_id", {}));
  if (pendingMeta && typeof savePendingAction === "function") {
    savePendingAction({
      token: pendingMeta.token, action: "dao-proposal", communityId: pendingMeta.communityId,
      campaignId: pendingMeta.campaignId || null, daoId: daoId, proposalId: proposalId,
      description: description, account: pendingMeta.account,
      statusId: pendingMeta.statusId, progressMsg: pendingMeta.progressMsg, savedAt: Date.now(),
    });
  }
  await walletCall(
    daoId,
    "add_proposal",
    buildDaoProposalArgs(contractId(), description, method, args, depositYocto),
    DAO_PROPOSAL_DEPOSIT_YOCTO,
    DAO_ACTION_GAS
  );
  return proposalId;
}

// Show the created proposal: its number, a link to the DAO, and what
// happens next, plus a VoteApprove button for the member who created it.
function showProposalCreated(daoId, proposalId, description) {
  const box = typeof document !== "undefined" ? document.getElementById("proposalBox") : null;
  const html =
    "<p><strong>DAO proposal " + proposalId + " created:</strong> " + escapeHtml(description) + "</p>" +
    '<p><a href="' + escapeHtml(daoProposalUrl(daoId)) + '" target="_blank" rel="noopener">Open DAO proposal ' +
    proposalId + " on Nearblocks</a></p>" +
    "<p class=\"small muted\">DAO council members vote on the proposal, and the DAO executes the approved call. " +
    "Nothing moves until the vote passes.</p>" +
    '<button onclick="voteDaoProposal(\'' + escapeHtml(daoId) + "', " + proposalId + ')">Vote approve proposal ' + proposalId + "</button>";
  if (box) {
    box.innerHTML = html;
    box.style.display = "block";
  }
  pageStatus("DAO proposal " + proposalId + " created. Council members vote, then the DAO executes it.");
}

// VoteApprove on a DAO proposal. The optional pendingMeta (community
// page only) records the pending vote BEFORE the wallet opens, so the
// page's return re-check can confirm it landed, and the progress and
// failure messages go to the proposal's own status element instead of
// the page status. Without it (the #proposalBox button) behaviour is
// unchanged. The typeof guards keep the pending path a no-op on pages
// without the community page's pending-action tracker.
async function voteDaoProposal(daoId, proposalId, pendingMeta) {
  if (!walletAccountId) { pageStatus("Connect a wallet first."); return; }
  const token = pendingMeta ? pendingMeta.token : null;
  if (pendingMeta && typeof savePendingAction === "function") {
    savePendingAction({
      token: token, action: "dao-vote", communityId: pendingMeta.communityId,
      daoId: daoId, proposalId: proposalId, account: pendingMeta.account,
      statusId: pendingMeta.statusId, progressMsg: pendingMeta.progressMsg, savedAt: Date.now(),
    });
  }
  const statusFn = (pendingMeta && pendingMeta.statusId && typeof localStatus === "function")
    ? (m) => localStatus(pendingMeta.statusId, m)
    : pageStatus;
  try {
    statusFn(pendingMeta && pendingMeta.progressMsg ? pendingMeta.progressMsg : "Voting approve on DAO proposal " + proposalId + "…");
    await walletCall(daoId, "act_proposal", { id: proposalId, action: "VoteApprove" }, "0", DAO_VOTE_GAS);
  } catch (e) {
    if (pendingMeta) {
      if (typeof clearPendingActionIfToken === "function") clearPendingActionIfToken(token);
      if (typeof localFailure === "function") { localFailure(pendingMeta.statusId, e); return; }
    }
    reportFailure(e);
  }
}
