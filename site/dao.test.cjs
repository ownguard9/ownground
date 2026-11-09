// Unit tests for the OwnGround DAO proposal helpers (site/dao.js).
// Run: node site/dao.test.cjs
const assert = require("node:assert");
const {
  buildDaoProposalArgs,
  proRataAllocations,
  validateAllocations,
  daoProposalUrl,
  daoCouncilMembers,
  daoVoteThreshold,
  daoProposalApprovals,
  DAO_PROPOSAL_DEPOSIT_YOCTO,
  DAO_ACTION_GAS,
  DAO_VOTE_GAS,
} = require("./dao.js");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`PASS ${name}`);
}
function sumBp(list) { return list.reduce((s, [, bp]) => s + bp, 0); }

// 1. Proposal args shape matches demo.mjs daoCall exactly.
{
  const args = buildDaoProposalArgs(
    "ownground.testnet",
    "Acquire the asset",
    "acquire_asset",
    { campaign_id: "c1", seller: "seller.testnet", allocation: [["alice.testnet", 6000], ["bob.testnet", 4000]] },
    "10000000000000000000000"
  );
  check("proposal description", args.proposal.description === "Acquire the asset");
  const fc = args.proposal.kind.FunctionCall;
  check("proposal receiver is the contract", fc.receiver_id === "ownground.testnet");
  check("proposal one action", fc.actions.length === 1);
  const a = fc.actions[0];
  check("proposal method name", a.method_name === "acquire_asset");
  check("proposal args base64 JSON round trips",
    JSON.parse(Buffer.from(a.args, "base64").toString("utf8")).campaign_id === "c1");
  check("proposal action deposit is a string", a.deposit === "10000000000000000000000");
  check("proposal action gas is 100 TGas", a.gas === "100000000000000");
  check("add_proposal deposit is 1 NEAR", DAO_PROPOSAL_DEPOSIT_YOCTO === "1000000000000000000000000");
  check("vote gas is 150 TGas", DAO_VOTE_GAS === "150000000000000");
  check("action gas constant is 100 TGas", DAO_ACTION_GAS === "100000000000000");
}

// 2. Pro-rata allocations always sum to exactly 10000.
{
  const cases = [
    [["alice.testnet", "6000000000000000000000000"], ["bob.testnet", "4000000000000000000000000"]],
    [["a.testnet", "1"], ["b.testnet", "1"], ["c.testnet", "1"]],
    [["a.testnet", "7"], ["b.testnet", "3"]],
    [["solo.testnet", "10000000000000000000000000"]],
    [["a.testnet", "1000000000000000000000000"], ["b.testnet", "0"]],
  ];
  for (const contributors of cases) {
    const alloc = proRataAllocations(contributors);
    check("pro-rata sums to 10000: " + JSON.stringify(alloc), sumBp(alloc) === 10000);
    check("pro-rata every share above zero", alloc.every(([, bp]) => bp > 0));
  }
  check("pro-rata 60/40 split", JSON.stringify(proRataAllocations(cases[0])) === JSON.stringify([["alice.testnet", 6000], ["bob.testnet", 4000]]));
  check("pro-rata equal thirds use largest remainder", JSON.stringify(proRataAllocations(cases[1])) === JSON.stringify([["a.testnet", 3334], ["b.testnet", 3333], ["c.testnet", 3333]]));
  check("pro-rata solo owner gets 10000", JSON.stringify(proRataAllocations(cases[3])) === JSON.stringify([["solo.testnet", 10000]]));
  check("pro-rata drops zero contributors", JSON.stringify(proRataAllocations(cases[4])) === JSON.stringify([["a.testnet", 10000]]));
  check("pro-rata empty when nobody contributed", proRataAllocations([]).length === 0);
}

// 3. Validation: sums to 10000 pass, anything else is rejected.
{
  const members = ["alice.testnet", "bob.testnet"];
  check("valid allocation passes",
    validateAllocations([["alice.testnet", 6000], ["bob.testnet", 4000]], members).ok === true);
  const short = validateAllocations([["alice.testnet", 6000], ["bob.testnet", 3999]], members);
  check("9999 is rejected", short.ok === false && short.sum === 9999 && short.error.indexOf("10000") >= 0);
  const over = validateAllocations([["alice.testnet", 6000], ["bob.testnet", 4001]], members);
  check("10001 is rejected", over.ok === false && over.sum === 10001);
  const zero = validateAllocations([["alice.testnet", 10000], ["bob.testnet", 0]], members);
  check("zero share is rejected", zero.ok === false);
  const outsider = validateAllocations([["alice.testnet", 5000], ["mallory.testnet", 5000]], members);
  check("non-member is rejected", outsider.ok === false && outsider.error.indexOf("mallory.testnet") >= 0);
  const dup = validateAllocations([["alice.testnet", 5000], ["alice.testnet", 5000]], members);
  check("duplicate account is rejected", dup.ok === false);
  const empty = validateAllocations([], members);
  check("empty allocation is rejected", empty.ok === false);
}

// 4. DAO proposal link points at the DAO address on testnet Nearblocks.
{
  check("dao proposal url",
    daoProposalUrl("mydao.sputnikv2.testnet") === "https://testnet.nearblocks.io/address/mydao.sputnikv2.testnet");
}

// 5. Council, threshold and approval counts out of get_policy /
// get_proposal results, including the live vehicle-coop shape.
{
  const policy = {
    roles: [
      { name: "all", kind: { Group: ["*"] }, permissions: ["*:AddProposal"], vote_policy: {} },
      { name: "council", kind: { Group: ["peter-vehicles.testnet", "felix-vehicles.testnet", "grace-vehicles.testnet", "daniel-vehicles.testnet"] }, permissions: ["*:VoteApprove"], vote_policy: {} },
      { name: "community", kind: { Group: ["*"] }, permissions: [], vote_policy: {} },
    ],
    default_vote_policy: { Weight: "2" },
    proposal_bond: "1000000000000000000000000",
    proposal_period: "604800000000000",
  };
  check("council members read from the council role",
    JSON.stringify(daoCouncilMembers(policy)) === JSON.stringify(["peter-vehicles.testnet", "felix-vehicles.testnet", "grace-vehicles.testnet", "daniel-vehicles.testnet"]));
  check("Weight threshold falls back to the DAO default", daoVoteThreshold(policy) === 2);
  check("council members empty when no policy", daoCouncilMembers(null).length === 0);
  check("threshold null when no policy", daoVoteThreshold(null) === null);
  const roleWeight = {
    roles: [{ name: "council", kind: { Group: ["a.testnet", "b.testnet"] }, permissions: [], vote_policy: { RoleWeight: ["1", "2"] } }],
    default_vote_policy: { Weight: "2" },
  };
  check("RoleWeight 1 of 2 with a 2 member council needs 2 approvals", daoVoteThreshold(roleWeight) === 2);
  const ratio = {
    roles: [{ name: "council", kind: { Group: ["a.testnet", "b.testnet", "c.testnet", "d.testnet"] }, permissions: [], vote_policy: { Ratio: ["1", "2"] } }],
    default_vote_policy: {},
  };
  check("Ratio 1 of 2 with a 4 member council needs 3 approvals", daoVoteThreshold(ratio) === 3);
  check("approvals read from the council vote_counts triple",
    daoProposalApprovals({ vote_counts: { council: [1, 0, 0] } }) === 1);
  check("approvals zero when vote_counts is empty",
    daoProposalApprovals({ vote_counts: {} }) === 0);
  check("approvals zero when vote_counts is missing",
    daoProposalApprovals({}) === 0);
  check("approvals sum across roles",
    daoProposalApprovals({ vote_counts: { council: [1, 0, 0], community: [2, 0, 0] } }) === 3);
}

console.log(`\n${passed} DAO HELPER CHECKS PASSED`);
