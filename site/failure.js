// Failure classifier for OwnGround. Pure function, no DOM: it takes a
// failure (an Error, a string, or anything with a message) and returns
// exactly one of four categories with display text. The site never shows
// a bare "transaction failed", and never shows success before the chain
// confirms it.
//
// Categories:
// * contract: the chain rejected the call (the contract's panic message
//   names the rule violated). No money moved.
// * network: the RPC could not be reached or timed out. The transaction
//   may not have been sent.
// * gas: the call ran out of gas and did not execute. No money moved.
// * wallet: the user declined in the wallet, or no wallet is connected.
//   Nothing was sent.
//
// Visible copy avoids hyphens and dashes, so the display texts use
// periods instead of the em dashes in the design doc.
function classifyFailure(input) {
  const raw = (function (v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v.message === "string") return v.message;
    if (typeof v.toString === "function") return v.toString();
    return String(v);
  })(input);
  const lower = raw.toLowerCase();

  // The specific contract rules, matched first so the display names the
  // rule that was violated.
  const rules = [
    ["expense exceeds max_single_expense",
      "Rejected by the community spending policy. The expense exceeds the maximum single expense. No money moved."],
    ["expense would breach min_treasury_reserve",
      "Rejected by the community spending policy. The expense would breach the minimum treasury reserve. No money moved."],
    ["expense category not allowed",
      "Rejected by the community spending policy. The expense category is not allowed. No money moved."],
    ["expense exceeds spendable funds",
      "Rejected. The expense exceeds the spendable funds, the treasury minus locked campaign funds. No money moved."],
    ["only the community dao",
      "Rejected. Only the community DAO may call this method. No money moved."],
    ["caller is not a community member",
      "Rejected. Only a community member may do this. No money moved."],
    ["duplicate revenue reference",
      "Rejected. A revenue entry with this reference already exists for this asset. No money moved."],
    ["evidence reference is required",
      "Rejected. Every revenue entry needs an evidence reference. No money moved."],
    ["self-attestation is rejected",
      "Rejected. The recorder cannot attest their own revenue entry. No money moved."],
    ["only a pending entry can be attested",
      "Rejected. Only a pending entry can be attested. No money moved."],
    ["only a verified entry can be disputed",
      "Rejected. Only a verified entry can be disputed. No money moved."],
    ["dispute window has passed",
      "Rejected. The dispute window has passed. No money moved."],
    ["timelock has not passed yet",
      "Rejected. The policy amendment timelock has not passed yet. No money moved."],
    ["amendment expired",
      "Rejected. The policy amendment expired. It can be proposed again. No money moved."],
    ["amendment is not pending",
      "Rejected. The policy amendment is not pending. No money moved."],
    ["nothing distributable",
      "Rejected. There is nothing distributable for this asset right now. No money moved."],
    ["only an open campaign can be refunded",
      "Rejected. Only an open campaign can be refunded. No money moved."],
  ];
  for (const [needle, text] of rules) {
    if (lower.indexOf(needle) >= 0) {
      return { category: "contract", rule: needle, text: text };
    }
  }

  // Wallet failures: the user declined, or no wallet is connected.
  if (/declin|user reject|rejected by user|not connected|no wallet|wallet (is )?not|wallet unavailable|aborted by user/i.test(raw)) {
    return { category: "wallet", rule: null, text: "You declined the transaction in your wallet. Nothing was sent." };
  }

  // Gas failures.
  if (/out of gas|exceeded the prepaid gas|gas limit|intrinsic gas|not enough gas/i.test(raw)) {
    return { category: "gas", rule: null, text: "Ran out of gas. The transaction did not execute. No money moved. Try again." };
  }

  // Contract failures: the chain ran the call and it panicked.
  if (/panic|smart contract|guest panic|execution error|receipt.*fail|action.*fail|invalid transaction|account does not exist/i.test(raw)) {
    const shown = raw.length > 200 ? raw.slice(0, 200) : raw;
    return { category: "contract", rule: null, text: "Rejected by the contract. " + shown + " No money moved." };
  }

  // Network failures: the RPC could not be reached or timed out.
  if (/failed to fetch|network ?error|timeout|timed out|rpc|econnrefused|enotfound|socket hang up|all rpc endpoints failed/i.test(raw)) {
    return { category: "network", rule: null, text: "Network error. The transaction may not have been sent. Check your connection and try again. No money moved." };
  }

  // Unknown: show the message itself rather than a bare failure, and
  // treat it as a contract rejection (the chain is the only place a
  // specific rule can come from; if the call never reached the chain,
  // the message above would have matched the network case).
  const shown = raw.length > 200 ? raw.slice(0, 200) : raw;
  return { category: "contract", rule: null, text: "Rejected. " + (shown || "The transaction did not complete.") + " No money moved." };
}

(function (root) {
  if (typeof module !== "undefined" && module.exports) module.exports = { classifyFailure: classifyFailure };
  if (root) root.classifyFailure = classifyFailure;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null));
