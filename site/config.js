// Site config. THE BRAND NAME LIVES HERE AND NOWHERE ELSE.
// Working title "OwnGround" — swap this one line when the final name is chosen.
// No page copy hardcodes the brand name; pages read window.BRAND_NAME.
window.BRAND_NAME = "OwnGround";

// Public repo. The footer GitHub link reads this and nowhere else.
window.REPO_URL = "https://github.com/ownguard9/ownground";

// Contract address. v3 (distribution-timing guard) at ownground3.testnet.
// v2 ownground2.testnet and v1 ownground.testnet are superseded — do not
// point the site at them.
window.CONTRACT_ID = "ownground3.testnet";

// Demo runs superseded by the receipt-verified run. The contract keeps
// their history onchain, but the list shows only the live demo community.
window.HIDDEN_COMMUNITIES = ["lagos-energy-cooperative", "lagos-energy-cooperative-2", "lagos-energy-cooperative-3", "lagos-energy-cooperative-4"];

// Showcase community, pinned at the top of the list: it shows the full
// flow (funded, asset acquired, revenue, distributions), so a new visitor
// sees the complete picture first.
window.PINNED_COMMUNITIES = ["lagos-energy-cooperative-5"];

// Testnet only. Never point this at mainnet.
window.NETWORK = "testnet";
window.RPC_ENDPOINTS = ["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com"];
window.DAO_FACTORY_ID = "sputnikv2.testnet";

// Storage deposits the contract requires (yoctoNEAR, as strings).
window.STORAGE = {
  createCommunity: "100000000000000000000000", // 0.1 NEAR
  createCampaign: "50000000000000000000000", // 0.05 NEAR
  record: "10000000000000000000000", // 0.01 NEAR
  // Creating a DAO through the factory attaches 10 NEAR to the new DAO.
  // The live factory floor is 5.39679 NEAR (its minimum covers the DAO
  // code storage); 10 NEAR clears it with headroom. The deposit becomes
  // the new DAO's own balance for its own storage. It is not a fee.
  createDao: "10000000000000000000000000", // 10 NEAR
};
window.GAS_100 = "100000000000000";
window.GAS_150 = "150000000000000";
