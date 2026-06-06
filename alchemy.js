// alchemy.js
// WALLEXA — Alchemy helper (uses provided API key)

const ALCHEMY_CONFIG = {
  apiKey: "A8Ua6ADCb1Hmf2KbCjcSn",
  networks: {
    mainnet:  "https://base-mainnet.g.alchemy.com/v2/",
    sepolia:  "https://base-sepolia.g.alchemy.com/v2/",
  },
  get rpc() { return this.networks.mainnet + this.apiKey; },
  get sepoliaRpc() { return this.networks.sepolia + this.apiKey; },
  nftApi: (address, network = "base-mainnet") =>
    `https://${network}.g.alchemy.com/nft/v3/${ALCHEMY_CONFIG.apiKey}/getNFTsForOwner?owner=${address}&withMetadata=true`,
  priceApi: "https://api.coingecko.com/api/v3/simple/price",
};

// -------------------------------------------------------
// KNOWN LEGIT TOKENS on Base (whitelist — always shown)
// -------------------------------------------------------
const KNOWN_TOKENS = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { name: "USD Coin",        symbol: "USDC",  logo: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png" },
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { name: "Dai Stablecoin",  symbol: "DAI",   logo: "https://cryptologos.cc/logos/multi-collateral-dai-dai-logo.png" },
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { name: "USD Base Coin",   symbol: "USDbC", logo: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png" },
  "0x4200000000000000000000000000000000000006": { name: "Wrapped Ether",    symbol: "WETH",  logo: "https://cryptologos.cc/logos/ethereum-eth-logo.png" },
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22": { name: "Coinbase Wrapped Staked ETH", symbol: "cbETH", logo: "https://assets.coingecko.com/coins/images/27008/standard/cbeth.png" },
  "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b": { name: "Virtuals Protocol", symbol: "VIRTUAL", logo: "https://assets.coingecko.com/coins/images/34057/standard/LOGOMARK.png" },
  "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4": { name: "Toshi",            symbol: "TOSHI", logo: "https://assets.coingecko.com/coins/images/31126/standard/Toshi_Logo_-_Circular.png" },
  "0x532f27101965dd16442e59d40670faf5ebb142e4": { name: "Brett",            symbol: "BRETT", logo: "https://assets.coingecko.com/coins/images/35529/standard/1000050750.png" },
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": { name: "Aerodrome",         symbol: "AERO",  logo: "https://assets.coingecko.com/coins/images/31745/standard/token.png" },
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { name: "Coinbase BTC",     symbol: "cbBTC", logo: "https://assets.coingecko.com/coins/images/40143/standard/cbbtc.webp" },
};

const SYMBOL_ALLOWLIST = new Set([
  "ETH", "USDC", "USDBC", "WETH", "DAI", "AERO", "CBBTC", "CBETH",
  "VIRTUAL", "TOSHI", "BRETT", "QR", "WTC",
]);

// -------------------------------------------------------
// SPAM DETECTION — strict multi-layer filter
// -------------------------------------------------------
function isSpamToken(name = "", symbol = "") {
  const n = (name || "").trim();
  const s = (symbol || "").trim();
  const combined = `${n} ${s}`;
  const upperSymbol = s.toUpperCase();

  if (SYMBOL_ALLOWLIST.has(upperSymbol)) return false;

  // 1. Blank or missing
  if (!n && !s) return true;

  // 2. URLs / social links anywhere in name or symbol
  if (/https?:\/\/|t\.me\/|discord\.gg\/|\.com|\.io|\.xyz|\.net|\.org|www\./i.test(combined)) return true;

  // 3. Claim / airdrop / promo keywords
  if (/claim|airdrop|distribution|reward|bonus|free|giveaway|visit|voucher|promo|winner|congratu/i.test(combined)) return true;

  // 3b. Common fake-token slogan fragments seen in wallet spam.
  if (/roadmap|bridg(e|ing)|octo?rilla|clawnal|trump|dios|nue?vo|clear.*bridge|wear.*bridg/i.test(combined)) return true;

  // 4. Pipe, asterisk or bracket abuse (common in spam names)
  if (/[\|\*\[\]\{\}<>]/.test(combined)) return true;

  // 5. Emoji abuse in name or symbol
  if (/[\u2700-\u27BF\u{1F300}-\u{1FAFF}]/u.test(combined)) return true;

  // 6. Dollar-sign prefix on symbol ($7, $USDC, $100)
  if (/^\$/.test(s)) return true;

  // 7. All-digit, mostly-digit, or very long symbols.
  if (/^\d+$/.test(s)) return true;
  if (/\d{3,}/.test(s)) return true;
  if (s.length > 14) return true;
  if (/[._-]/.test(s) && s.length > 10) return true;

  // 8. Suspiciously long names (spam dumps paragraphs in name)
  if (n.length > 32) return true;

  // 9. ALL CAPS long names that look like shouts/spam, with or without spaces.
  if (n.length > 16 && n === n.toUpperCase() && /[A-Z]/.test(n)) return true;

  // 10. Symbols with $ in them (PYRO$, etc.)
  if (s.includes("$")) return true;

  // 11. Known scam name fragments
  if (/moon|rocket|safe|elon|doge|shib|inu|pepe.*2|baby|mini|micro|turbo.*2/i.test(n) && n.length > 15) return true;

  return false;
}

// -------------------------------------------------------
// DUST threshold — ignore tiny worthless balances
// -------------------------------------------------------
const DUST_THRESHOLD = 0;

function atomicToDecimalString(value, decimals, maxFractionDigits = 6) {
  const raw = BigInt(value || "0");
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0");
  const trimmed = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
  return `${whole}${trimmed ? "." + trimmed : ""}`;
}

// -------------------------------------------------------
// RPC helper
// -------------------------------------------------------
async function alchemyRpc(method, params = [], network = "mainnet") {
  if (network === "mainnet" && typeof window !== "undefined") {
    try {
      const proxyRes = await fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
      const proxyData = await proxyRes.json();
      if (proxyRes.ok && !proxyData.error) return proxyData.result;
    } catch {
      // Fall back to direct Alchemy below when the local server proxy is unavailable.
    }
  }

  const url = network === "sepolia" ? ALCHEMY_CONFIG.sepoliaRpc : ALCHEMY_CONFIG.rpc;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

// -------------------------------------------------------
// Native ETH balance
// -------------------------------------------------------
async function getBalance(address, network = "mainnet") {
  const hex = await alchemyRpc("eth_getBalance", [address, "latest"], network);
  return (parseInt(hex, 16) / 1e18).toFixed(6);
}

// -------------------------------------------------------
// Token metadata
// -------------------------------------------------------
async function getTokenMetadata(contractAddress, network = "mainnet") {
  return await alchemyRpc("alchemy_getTokenMetadata", [contractAddress], network);
}

// -------------------------------------------------------
// ERC-20 token balances — filtered, sorted, deduplicated
// Also prepends native ETH as first entry
// -------------------------------------------------------
async function getTokenBalances(address, network = "mainnet") {
  const res = await alchemyRpc("alchemy_getTokenBalances", [address, "erc20"], network);
  if (!res || !res.tokenBalances) return [];

  // Step 1: Non-zero hex balances only
  const nonZero = res.tokenBalances.filter(t => {
    try {
      return BigInt(t.tokenBalance || "0x0") > 0n;
    } catch {
      return false;
    }
  });

  // Step 2: Fetch metadata in parallel
  const settled = await Promise.allSettled(
    nonZero.map(async (t) => {
      const addr = t.contractAddress.toLowerCase();
      const rawBalance = BigInt(t.tokenBalance || "0x0");

      // Use whitelist entry if available (trusted metadata)
      if (KNOWN_TOKENS[addr]) {
        const known = KNOWN_TOKENS[addr];
        const meta = await getTokenMetadata(t.contractAddress, network).catch(() => null);
        const decimals = meta?.decimals ?? 18;
        const balance = atomicToDecimalString(rawBalance, decimals);
        return {
          contractAddress: addr,
          address:        addr,
          name:       known.name,
          symbol:     known.symbol,
          decimals,
          balance,
          balanceNum: parseFloat(balance),
          logo:       known.logo || meta?.logo || null,
          trusted:    true,
        };
      }

      // Unknown token — fetch metadata and apply spam filter
      const meta = await getTokenMetadata(t.contractAddress, network);
      const decimals = meta?.decimals ?? 18;
      const balance = atomicToDecimalString(rawBalance, decimals);

      return {
        contractAddress: addr,
        address:        addr,
        name:       meta?.name    ?? "",
        symbol:     meta?.symbol  ?? "",
        decimals,
        balance,
        balanceNum: parseFloat(balance),
        logo:       meta?.logo    ?? null,
        trusted:    false,
      };
    })
  );

  // Step 3: Extract fulfilled results
  const tokens = settled
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);

  // Step 4: Filter — spam, dust, no metadata
  const clean = tokens.filter(t => {
    if (!t.name && !t.symbol) return false;
    if (!t.trusted && t.balanceNum < DUST_THRESHOLD) return false;
    if (!t.trusted && isSpamToken(t.name, t.symbol)) return false;
    return true;
  });

  // Step 5: Sort — trusted/known first, then by balance descending
  clean.sort((a, b) => {
    if (a.trusted && !b.trusted) return -1;
    if (!a.trusted && b.trusted) return 1;
    return b.balanceNum - a.balanceNum;
  });

  return clean;
}

// -------------------------------------------------------
// NFTs
// -------------------------------------------------------
async function getNFTs(ownerAddress, network = "base-mainnet") {
  const url = ALCHEMY_CONFIG.nftApi(ownerAddress, network);
  const r = await fetch(url, { headers: { accept: "application/json" } });
  return r.json();
}

// -------------------------------------------------------
// Exports
// -------------------------------------------------------
if (typeof module !== "undefined") {
  module.exports = {
    ALCHEMY_CONFIG, alchemyRpc,
    getBalance, getTokenBalances, getTokenMetadata, getNFTs,
    isSpamToken, KNOWN_TOKENS,
  };
} else {
  window.WALLEXA_ALCHEMY = {
    ALCHEMY_CONFIG, alchemyRpc,
    getBalance, getTokenBalances, getTokenMetadata, getNFTs,
    isSpamToken, KNOWN_TOKENS,
  };
}
