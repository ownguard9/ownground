// Unit tests for the OwnGround failure classifier (site/failure.js).
// Run: node site/classify.test.cjs
const assert = require("node:assert");
const { classifyFailure } = require("./failure.js");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`PASS ${name}`);
}

// 1. Contract policy rejection with the specific rule.
{
  const r = classifyFailure(new Error("Smart contract panicked: expense exceeds max_single_expense"));
  check("contract max expense category", r.category === "contract");
  check("contract max expense names the rule", r.rule === "expense exceeds max_single_expense");
  check("contract max expense text names the policy", r.text.indexOf("spending policy") >= 0 && r.text.indexOf("maximum single expense") >= 0);
}
{
  const r = classifyFailure("expense would breach min_treasury_reserve");
  check("contract reserve rule", r.category === "contract" && r.rule === "expense would breach min_treasury_reserve");
}
{
  const r = classifyFailure("expense category not allowed");
  check("contract category rule", r.category === "contract" && r.rule === "expense category not allowed");
}
{
  const r = classifyFailure("expense exceeds spendable funds");
  check("contract spendable rule", r.category === "contract" && r.rule === "expense exceeds spendable funds");
}

// 2. Network failure.
{
  const r = classifyFailure(new Error("Failed to fetch"));
  check("network category", r.category === "network");
  check("network text says may not have been sent", r.text.indexOf("may not have been sent") >= 0);
}
{
  const r = classifyFailure("All RPC endpoints failed");
  check("network rpc case", r.category === "network");
}

// 3. Gas failure.
{
  const r = classifyFailure(new Error("Transaction ran out of gas"));
  check("gas category", r.category === "gas");
  check("gas text says did not execute", r.text.indexOf("did not execute") >= 0);
}

// 4. Wallet failure.
{
  const r = classifyFailure(new Error("User declined the transaction in the wallet"));
  check("wallet category", r.category === "wallet");
  check("wallet text says nothing was sent", r.text.indexOf("Nothing was sent") >= 0);
}
{
  const r = classifyFailure("Wallet not connected");
  check("wallet not connected case", r.category === "wallet");
}

// 5. A bare contract panic without a known rule still classifies.
{
  const r = classifyFailure("Smart contract panicked: nothing distributable for this asset");
  check("contract generic panic", r.category === "contract" && r.rule === "nothing distributable");
}

// 6. No bare "transaction failed" text is ever produced.
{
  const samples = [
    new Error("expense exceeds max_single_expense"),
    new Error("Failed to fetch"),
    new Error("out of gas"),
    new Error("user declined"),
    new Error("something entirely unexpected"),
    "",
    null,
  ];
  for (const s of samples) {
    const r = classifyFailure(s);
    check("never a bare failure: " + JSON.stringify(String(s)).slice(0, 40),
      r.text !== "transaction failed" && r.text !== "Transaction failed" && r.text.length > 10);
  }
}

console.log(`\n${passed} CLASSIFIER CHECKS PASSED`);
