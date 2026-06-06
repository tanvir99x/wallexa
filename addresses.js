// addresses.js
// WALLEXA — Contract Addresses & API keys (use carefully)

const CONTRACTS = {
  mainnet: {
    USER_WALLET: "0xf2bC67F14F91A27A851d912b457b4705b2b7880F",
    TOKEN:       "0x0000000000000000000000000000000000000000",
    NFT:         "0x0000000000000000000000000000000000000000",
    STAKING:     "0x0000000000000000000000000000000000000000",
    DAO:         "0x0000000000000000000000000000000000000000",
    // Swap router is resolved at runtime from the CDP Swap API quote response (quote.tx.to)
    // No hard-coded router address needed — Coinbase CDP manages routing.
    USDC:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH:  "0x4200000000000000000000000000000000000006",
  }
};

if (typeof module !== "undefined") module.exports = CONTRACTS;
else window.WALLEXA_CONTRACTS = CONTRACTS;