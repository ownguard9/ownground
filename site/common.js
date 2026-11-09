// Shared helpers for the OwnGround site. Same patterns as FairShare:
// the @fastnear/wallet 2.5.0 bundle for signing, RPC fallback for reads,
// the one button wallet toggle. Testnet only.
const YOCTO_PER_NEAR = 10n ** 24n;
const RPC_TIMEOUT_MS = 10000;

function el(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtYocto(yocto) {
  const y = BigInt(yocto);
  const whole = y / YOCTO_PER_NEAR;
  const frac = Number((y % YOCTO_PER_NEAR) * 1000n / YOCTO_PER_NEAR);
  return whole.toString() + "." + String(frac).padStart(3, "0");
}
function nearToYocto(s) {
  const parts = String(s).trim().split(".");
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(24, "0").slice(0, 24);
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) throw new Error("Enter an amount in NEAR, digits only.");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac || "0");
}
function pageStatus(msg) {
  const s = el("pageStatus");
  if (s) s.textContent = msg;
}
// Show a classified failure, never a bare "transaction failed".
function reportFailure(err) {
  let r = null;
  try {
    if (typeof classifyFailure === "function") r = classifyFailure(err);
  } catch (_) { /* classifier unavailable */ }
  if (!r) {
    const m = err && err.message ? err.message : String(err);
    r = { category: "contract", text: "Rejected. " + m.slice(0, 200) + " No money moved." };
  }
  pageStatus(r.text);
  return r;
}
function nearLink(txHash) {
  return "https://testnet.nearblocks.io/txns/" + txHash;
}

// Confirm a transaction onchain before claiming success. Returns
// "confirmed", "failed", or "unknown" (not yet visible onchain).
async function checkTxStatus(txHash, accountId) {
  for (const url of window.RPC_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "tx", method: "tx",
          params: [txHash, accountId],
        }),
      });
      const data = await res.json();
      if (data.error) return "unknown";
      const status = data.result && data.result.status;
      if (!status) return "unknown";
      if (status.SuccessValue !== undefined || status.SuccessReceiptId !== undefined) return "confirmed";
      if (status.Failure !== undefined) return "failed";
      return "unknown";
    } catch (e) { /* try the next endpoint */ }
  }
  return "unknown";
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    return await fetch(url, { ...(opts || {}), signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

async function rpcViewCall(accountId, method, args) {
  let lastErr = null;
  for (const url of window.RPC_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: method, method: "query",
          params: {
            request_type: "call_function",
            account_id: accountId,
            method_name: method,
            args_base64: btoa(JSON.stringify(args || {})),
            finality: "final",
          },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "RPC error");
      const bytes = data.result && data.result.result;
      if (!bytes) throw new Error("Empty RPC result");
      return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("All RPC endpoints failed");
}

async function rpcAccountBalance(accountId) {
  for (const url of window.RPC_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "balance", method: "query",
          params: { request_type: "view_account", account_id: accountId, finality: "final" },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "RPC error");
      return BigInt(data.result.amount);
    } catch (e) { /* try next endpoint */ }
  }
  throw new Error("Could not read account balance");
}

// ---- Wallet connect (FastNEAR wallet 2.5.0) ----
let walletAccountId = null;
function fastnear() {
  if (typeof window.nearWallet === "undefined") {
    throw new Error("FastNear wallet library not loaded. Check the script tag.");
  }
  return window.nearWallet;
}
function currentAccountId(nw) {
  try {
    const id = nw.accountId({ network: window.NETWORK });
    return typeof id === "string" && id ? id : null;
  } catch (_) {
    return null;
  }
}
function walletChanged() {
  if (typeof window.owngroundWalletChanged === "function") {
    window.owngroundWalletChanged();
  }
}
async function initWallet() {
  if (typeof window === "undefined") return;
  let skipRestore = false;
  try { skipRestore = localStorage.getItem("ownground-wallet-disconnected") === "1" || sessionStorage.getItem("ownground-wallet-disconnected") === "1"; } catch (_) { /* storage unavailable */ }
  if (!skipRestore) {
    try {
      const nw = fastnear();
      const restored = await nw.restore({ network: window.NETWORK });
      const id = (restored && typeof restored.accountId === "string" && restored.accountId) || currentAccountId(nw);
      if (id) walletAccountId = id;
    } catch (e) { console.warn("wallet restore failed", e); }
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("transactionHashes")) {
      const hashes = params.get("transactionHashes").split(",");
      // Never show success before the chain confirms it: check the
      // receipt status first, and say so honestly if it is not visible.
      const account = walletAccountId;
      let state = "unknown";
      if (account) {
        for (let attempt = 0; attempt < 3 && state === "unknown"; attempt++) {
          state = await checkTxStatus(hashes[0], account);
          if (state === "unknown" && attempt < 2) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (state === "confirmed") {
        const s = el("pageStatus");
        if (s) {
          s.innerHTML = "Transaction <a href=\"" + escapeHtml(nearLink(hashes[0])) + "\" target=\"_blank\" rel=\"noopener\">" +
            escapeHtml(hashes[0]) + "</a> is confirmed onchain.";
        }
      } else if (state === "failed") {
        reportFailure("Smart contract panicked: the transaction failed onchain");
      } else {
        const s = el("pageStatus");
        if (s) {
          s.innerHTML = "Transaction <a href=\"" + escapeHtml(nearLink(hashes[0])) + "\" target=\"_blank\" rel=\"noopener\">" +
            escapeHtml(hashes[0]) + "</a> was sent. Confirmation not verified yet. Check it on Nearblocks.";
        }
      }
      window.history.replaceState({}, "", window.location.pathname + window.location.search + window.location.hash);
    }
  } catch (_) { /* ignore */ }
  refreshWalletBtn();
  walletChanged();
}
function refreshWalletBtn() {
  const btn = el("connectBtn");
  if (!btn) return;
  let libOk = true;
  try { fastnear(); } catch (_) { libOk = false; }
  if (!libOk) { btn.textContent = "Wallet unavailable"; btn.disabled = true; return; }
  const id = walletAccountId;
  btn.textContent = id ? id + " (sign out)" : "Connect wallet";
  if (btn.title !== undefined) btn.title = id ? "Tap to sign out" : "";
  btn.disabled = false;
}
async function disconnectWallet() {
  try { localStorage.setItem("ownground-wallet-disconnected", "1"); } catch (_) { /* storage unavailable */ }
  try { sessionStorage.setItem("ownground-wallet-disconnected", "1"); } catch (_) { /* storage unavailable */ }
  try {
    const nw = fastnear();
    try { await nw.disconnect({ network: window.NETWORK }); } catch (_) { /* wallet already signed out */ }
    try {
      const drop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.indexOf("selected-wallet") >= 0 || k.indexOf("signedAccountId") >= 0 || k.indexOf("near-wallet") >= 0 || k.indexOf("fastnear") >= 0)) drop.push(k);
      }
      drop.forEach((k) => { try { localStorage.removeItem(k); } catch (_) {} });
    } catch (_) { /* storage unavailable */ }
    pageStatus("Signed out.");
  } catch (_) { /* library missing, clear local state anyway */ }
  walletAccountId = null;
  refreshWalletBtn();
  walletChanged();
}
async function toggleWallet() {
  let nw;
  try { nw = fastnear(); } catch (_) { pageStatus("Wallet library did not load. Check your connection and reload."); return; }
  if (walletAccountId) { await disconnectWallet(); return; }
  try { localStorage.removeItem("ownground-wallet-disconnected"); } catch (_) { /* storage unavailable */ }
  try { sessionStorage.removeItem("ownground-wallet-disconnected"); } catch (_) { /* storage unavailable */ }
  try {
    pageStatus("Opening wallet selector…");
    const result = await nw.connect({ network: window.NETWORK });
    const id = (result && typeof result.accountId === "string" && result.accountId) || currentAccountId(nw);
    if (typeof id !== "string" || !id) { pageStatus("Could not determine the connected account. Try again."); return; }
    walletAccountId = id;
    refreshWalletBtn();
    pageStatus("");
    walletChanged();
  } catch (e) { pageStatus("Wallet error: " + String(e.message).slice(0, 160)); }
}
async function walletCall(contractId, method, args, depositYocto, gas) {
  const nw = fastnear();
  return nw.sendTransaction({
    receiverId: contractId,
    network: window.NETWORK,
    actions: [{
      type: "FunctionCall",
      methodName: method,
      args: args,
      gas: (gas || window.GAS_100).toString(),
      deposit: depositYocto.toString(),
    }],
  });
}

// ---- Contract reads (no wallet needed) ----
function contractId() { return window.CONTRACT_ID; }
function deployed() { return Boolean(window.CONTRACT_ID); }
async function view(method, args) {
  if (!deployed()) throw new Error("Contract not deployed yet");
  return rpcViewCall(window.CONTRACT_ID, method, args);
}

// Apply the brand name to every element marked data-brand.
function applyBrand() {
  document.querySelectorAll("[data-brand]").forEach((n) => { n.textContent = window.BRAND_NAME; });
  document.querySelectorAll("[data-repo]").forEach((n) => { n.href = window.REPO_URL; });
  document.title = document.title.replace("OwnGround", window.BRAND_NAME);
}
document.addEventListener("DOMContentLoaded", applyBrand);
