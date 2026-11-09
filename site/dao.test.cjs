// Unit tests for the OwnGround DAO proposal helpers (site/dao.js).
// Run: node site/dao.test.cjs
const assert = require("node:assert");
const {
  buildDaoProposalArgs,
  proRataAllocations,
  validateAllocations,
  daoProposalUrl,
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

console.log(`\n${passed} DAO HELPER CHECKS PASSED`);
