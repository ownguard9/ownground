// Site config. THE BRAND NAME LIVES HERE AND NOWHERE ELSE.
// Working title "OwnGround" — swap this one line when the final name is chosen.
// No page copy hardcodes the brand name; pages read window.BRAND_NAME.
window.BRAND_NAME = "OwnGround";

// Contract address. Empty until the contract is deployed to testnet;
// the pages show a plain "not deployed yet" state until it is set.
window.CONTRACT_ID = "ownground.testnet";

// Testnet only. Never point this at mainnet.
window.NETWORK = "testnet";
window.RPC_ENDPOINTS = ["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com"];
window.DAO_FACTORY_ID = "sputnikv2.testnet";

// Storage deposits the contract requires (yoctoNEAR, as strings).
window.STORAGE = {
  createCommunity: "100000000000000000000000", // 0.1 NEAR
  createCampaign: "50000000000000000000000", // 0.05 NEAR
  record: "10000000000000000000000", // 0.01 NEAR
};
window.GAS_100 = "100000000000000";
window.GAS_150 = "150000000000000";
