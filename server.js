import express from "express";
import cors from "cors";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";
import fetch from "node-fetch";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createPublicClient, http, isAddress, parseAbi } from "viem";
import { base, mainnet } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8080);
const app = express();
const CMC_API_KEY = process.env.CMC_API_KEY || "55b8ef4e-0abb-4934-82d1-18abdc505a37";
const CMC_BASE_URL = "https://pro-api.coinmarketcap.com";
app.use(cors());
app.use((req, res, next) => {
  // Coinbase/Base Smart Wallet popups need opener access for postMessage.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});
app.use(express.json());

let cdpClient = null;
const NATIVE_ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const MAX_UINT256 = (1n << 256n) - 1n;
const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const baseClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const mainnetClient = createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_URL || "https://ethereum.publicnode.com") });
const taskStore = new Map();
const visitProofs = new Map();

const TASKS = [
  { id: "x-follow-baseapp", type: "x-follow", title: "Follow Base App", target: "baseapp", xp: 100, url: "https://x.com/baseapp" },
  { id: "x-follow-jessepollak", type: "x-follow", title: "Follow Jesse Pollak", target: "jessepollak", xp: 100, url: "https://x.com/jessepollak" },
  { id: "x-follow-coinbasedev", type: "x-follow", title: "Follow Coinbase Dev", target: "CoinbaseDev", xp: 100, url: "https://x.com/CoinbaseDev" },
  { id: "x-follow-brian", type: "x-follow", title: "Follow Brian Armstrong", target: "brian_armstrong", xp: 100, url: "https://x.com/brian_armstrong" },
  { id: "x-follow-exiros", type: "x-follow", title: "Follow Exiros", target: "theExiros", xp: 100, url: "https://x.com/theExiros" },
  { id: "x-like-repost-base-1", type: "x-engagement", title: "Like + repost Base post", tweetId: "2062212551622939074", xp: 100, url: "https://x.com/base/status/2062212551622939074?s=20" },
  { id: "x-like-repost-baseapp-2", type: "x-engagement", title: "Like + repost Base App post", tweetId: "2062295278498066766", xp: 100, url: "https://x.com/baseapp/status/2062295278498066766?s=20" },
  { id: "visit-guild-base", type: "visit", title: "Visit Base Guild", xp: 100, url: "https://guild.xyz/base" },
  { id: "visit-base-org", type: "visit", title: "Visit Base.org", xp: 100, url: "https://base.org/" },
  { id: "deploy-on-base", type: "base-deploy", title: "Deploy on Base", xp: 100, url: "https://base.org/builders" },
];

function normalizeWallet(wallet) {
  const value = String(wallet || "").trim();
  return isAddress(value) ? value.toLowerCase() : null;
}

function taskRecord(wallet) {
  const key = normalizeWallet(wallet);
  if (!key) return null;
  if (!taskStore.has(key)) {
    taskStore.set(key, { verified: {} });
  }
  return taskStore.get(key);
}

function markVerified(wallet, taskId, proof) {
  const record = taskRecord(wallet);
  const task = TASKS.find(t => t.id === taskId);
  if (!record || !task) return null;
  record.verified[taskId] = {
    verified: true,
    xp: task.xp,
    verifiedAt: new Date().toISOString(),
    proof,
  };
  return record.verified[taskId];
}

function randomId(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function getCdpClient() {
  if (cdpClient) return cdpClient;

  const keyPath = process.env.CDP_API_KEY_FILE || path.join(__dirname, "cdp_api_key.json");
  if (!fs.existsSync(keyPath)) {
    throw new Error("Missing cdp_api_key.json. Coinbase Swap API needs your CDP API key JSON file.");
  }

  const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const apiKeyId = key.id || key.apiKeyId || key.name;
  const apiKeySecret = key.privateKey || key.private_key || key.apiKeySecret;

  if (!apiKeyId || !apiKeySecret) {
    throw new Error("Invalid cdp_api_key.json. Expected fields: id and privateKey.");
  }

  cdpClient = new CdpClient({ apiKeyId, apiKeySecret });
  return cdpClient;
}

function toHex(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && value.startsWith("0x")) return value;
  return "0x" + BigInt(value).toString(16);
}

function getCdpErrorMessage(err) {
  const parts = [
    err?.errorMessage,
    err?.message,
    err?.errorType ? `type=${err.errorType}` : null,
    err?.correlationId ? `correlation=${err.correlationId}` : null,
  ].filter(Boolean);
  return parts.join(" | ") || "CDP API Error";
}

async function fetchCoinMarketCap(pathname, params = {}) {
  if (!CMC_API_KEY) throw new Error("Missing CMC_API_KEY");

  const url = new URL(pathname, CMC_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const upstream = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "X-CMC_PRO_API_KEY": CMC_API_KEY,
    },
  });
  const data = await upstream.json();
  if (!upstream.ok) {
    throw new Error(data?.status?.error_message || "CoinMarketCap request failed");
  }
  return data;
}

function normalizeCmcQuote(asset) {
  const quote = asset?.quote?.USD || {};
  return {
    id: asset?.id,
    name: asset?.name,
    symbol: asset?.symbol,
    slug: asset?.slug,
    cmcRank: asset?.cmc_rank,
    price: Number(quote.price || 0),
    percentChange1h: Number(quote.percent_change_1h || 0),
    percentChange24h: Number(quote.percent_change_24h || 0),
    percentChange7d: Number(quote.percent_change_7d || 0),
    marketCap: Number(quote.market_cap || 0),
    volume24h: Number(quote.volume_24h || 0),
    lastUpdated: quote.last_updated || asset?.last_updated || null,
  };
}

function isSuspiciousMarketAsset(asset) {
  const text = `${asset?.name || ""} ${asset?.symbol || ""} ${asset?.slug || ""}`;
  if (/https?:\/\/|www\.|\.com|\.io|\.xyz|\.net|\.org|claim|airdrop|giveaway|reward|bonus|promo|voucher/i.test(text)) return true;
  if (/[\|\*\[\]\{\}<>]/.test(text)) return true;
  if (String(asset?.symbol || "").length > 14) return true;
  return false;
}

async function getBaseTokenBalance(owner, token) {
  if (token.toLowerCase() === NATIVE_ETH) {
    return baseClient.getBalance({ address: owner });
  }
  return baseClient.readContract({
    address: token,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

app.get("/api/token-balance", async (req, res) => {
  try {
    const owner = normalizeWallet(req.query.owner);
    const token = String(req.query.token || "").trim();
    if (!owner || !isAddress(token)) {
      return res.status(400).json({ error: "Valid owner and token are required" });
    }

    const balance = await getBaseTokenBalance(owner, token);
    res.json({ owner, token, balance: balance.toString() });
  } catch (err) {
    res.status(502).json({ error: err.message || "Could not fetch token balance" });
  }
});

function serializeCoinbaseSwapQuote(quote) {
  if (!quote?.liquidityAvailable) {
    return { liquidityAvailable: false };
  }

  const fromAmount = quote.fromAmount?.toString?.() || "0";
  const allowance = quote.issues?.allowance;
  const approval = allowance?.spender
    ? {
        to: quote.fromToken,
        data:
          "0x095ea7b3" +
          allowance.spender.replace(/^0x/, "").padStart(64, "0") +
          MAX_UINT256.toString(16).padStart(64, "0"),
        value: "0x0",
        spender: allowance.spender,
        amount: MAX_UINT256.toString(),
      }
    : null;

  return {
    liquidityAvailable: true,
    network: quote.network,
    toToken: quote.toToken,
    fromToken: quote.fromToken,
    fromAmount,
    toAmount: quote.toAmount?.toString?.(),
    minToAmount: quote.minToAmount?.toString?.(),
    blockNumber: quote.blockNumber?.toString?.(),
    fees: {
      gasFee: quote.fees?.gasFee
        ? {
            amount: quote.fees.gasFee.amount?.toString?.(),
            token: quote.fees.gasFee.token,
          }
        : null,
      protocolFee: quote.fees?.protocolFee
        ? {
            amount: quote.fees.protocolFee.amount?.toString?.(),
            token: quote.fees.protocolFee.token,
          }
        : null,
    },
    issues: {
      allowance: allowance
        ? {
            currentAllowance: allowance.currentAllowance?.toString?.(),
            spender: allowance.spender,
          }
        : null,
      balance: quote.issues?.balance
        ? {
            token: quote.issues.balance.token,
            currentBalance: quote.issues.balance.currentBalance?.toString?.(),
            requiredBalance: quote.issues.balance.requiredBalance?.toString?.(),
          }
        : null,
      simulationIncomplete: quote.issues?.simulationIncomplete || false,
    },
    transaction: quote.transaction
      ? {
          to: quote.transaction.to,
          data: quote.transaction.data,
          value: toHex(quote.transaction.value),
          gas: toHex(quote.transaction.gas),
          gasPrice: toHex(quote.transaction.gasPrice),
        }
      : null,
    permit2: quote.permit2 || null,
    approval,
  };
}

// ── Health ─────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

// ── AI Proxy ───────────────────────────
app.post("/api/ai", async (req, res) => {
  try {
    const apiKey = process.env.BLUESMINDS_API_KEY;
    if (!apiKey)
      return res.status(500).json({ error: "Missing BLUESMINDS_API_KEY" });

    const upstream = await fetch(
      "https://api.bluesminds.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL || "gpt-5-chat",
          ...req.body,
        }),
      }
    );

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── RPC Proxy ──────────────────────────
app.post("/api/rpc", async (req, res) => {
  try {
    const key = process.env.ALCHEMY_API_KEY;
    if (!key)
      return res.status(500).json({ error: "Missing ALCHEMY_API_KEY" });

    const { method, params = [] } = req.body;

    const url = `https://base-mainnet.g.alchemy.com/v2/${key}`;

    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Name Resolver ──────────────────────
app.get("/api/resolve-name", async (req, res) => {
  try {
    const rawName = String(req.query.name || "").trim();
    if (!rawName) return res.status(400).json({ error: "name is required" });
    if (isAddress(rawName)) return res.json({ address: rawName });

    const name = rawName.toLowerCase();
    const clients = name.endsWith(".base.eth")
      ? [baseClient, mainnetClient]
      : [mainnetClient, baseClient];

    let address = null;
    for (const client of clients) {
      try {
        address = await client.getEnsAddress({ name });
        if (address) break;
      } catch {
        // Try the next resolver. Some RPCs do not support every resolver call.
      }
    }

    if (!address) return res.status(404).json({ error: `Could not resolve ${rawName}` });
    res.json({ address, name });
  } catch (err) {
    res.status(502).json({ error: err.message || "Name resolver error" });
  }
});

// ── NFT Proxy ──────────────────────────
app.get("/api/nft", async (req, res) => {
  try {
    const key = process.env.ALCHEMY_API_KEY;
    const { owner } = req.query;

    const url = `https://base-mainnet.g.alchemy.com/nft/v3/${key}/getNFTsForOwner?owner=${owner}&withMetadata=true`;

    const upstream = await fetch(url);
    const data = await upstream.json();

    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── CoinMarketCap Proxy ───────────────────────────────
app.get("/api/cmc/quotes", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "")
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (!symbols.length) return res.status(400).json({ error: "symbols are required" });

    const data = await fetchCoinMarketCap("/v2/cryptocurrency/quotes/latest", {
      symbol: [...new Set(symbols)].join(","),
      convert: "USD",
    });

    const assets = {};
    for (const [symbol, entries] of Object.entries(data.data || {})) {
      const asset = Array.isArray(entries) ? entries[0] : entries;
      if (asset) assets[symbol] = normalizeCmcQuote(asset);
    }

    res.json({ assets, status: data.status });
  } catch (err) {
    res.status(502).json({ error: err.message || "CoinMarketCap quotes unavailable" });
  }
});

app.get("/api/cmc/info", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "")
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (!symbols.length) return res.status(400).json({ error: "symbols are required" });

    const data = await fetchCoinMarketCap("/v2/cryptocurrency/info", {
      symbol: [...new Set(symbols)].join(","),
      aux: "urls,logo,description,notice,status,platform",
    });

    const assets = {};
    for (const [symbol, entries] of Object.entries(data.data || {})) {
      const asset = Array.isArray(entries) ? entries[0] : entries;
      if (!asset) continue;
      assets[symbol] = {
        id: asset.id,
        name: asset.name,
        symbol: asset.symbol,
        logo: asset.logo,
        slug: asset.slug,
        platform: asset.platform || null,
        notice: asset.notice || null,
        status: asset.status || null,
      };
    }

    res.json({ assets, status: data.status });
  } catch (err) {
    res.status(502).json({ error: err.message || "CoinMarketCap metadata unavailable" });
  }
});

app.get("/api/cmc/market-movers", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 8), 1), 25);
    const upstreamLimit = Math.min(limit * 4, 100);
    const [gainersData, losersData] = await Promise.all([
      fetchCoinMarketCap("/v1/cryptocurrency/listings/latest", {
        start: 1,
        limit: upstreamLimit,
        convert: "USD",
        sort: "percent_change_24h",
        sort_dir: "desc",
        cryptocurrency_type: "tokens",
      }),
      fetchCoinMarketCap("/v1/cryptocurrency/listings/latest", {
        start: 1,
        limit: upstreamLimit,
        convert: "USD",
        sort: "percent_change_24h",
        sort_dir: "asc",
        cryptocurrency_type: "tokens",
      }),
    ]);

    const gainers = (gainersData.data || [])
      .filter(asset => !isSuspiciousMarketAsset(asset))
      .map(normalizeCmcQuote)
      .slice(0, limit);
    const losers = (losersData.data || [])
      .filter(asset => !isSuspiciousMarketAsset(asset))
      .map(normalizeCmcQuote)
      .slice(0, limit);
    const ids = [...new Set([...gainers, ...losers].map(asset => asset.id).filter(Boolean))];
    let logos = {};

    if (ids.length) {
      const info = await fetchCoinMarketCap("/v2/cryptocurrency/info", {
        id: ids.join(","),
        aux: "logo,urls,platform",
      });
      logos = Object.fromEntries(
        Object.values(info.data || {}).map(asset => [
          String(asset.id),
          { logo: asset.logo, platform: asset.platform || null },
        ])
      );
    }

    const withLogos = asset => ({ ...asset, ...(logos[String(asset.id)] || {}) });
    res.json({
      gainers: gainers.map(withLogos),
      losers: losers.map(withLogos),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(502).json({ error: err.message || "CoinMarketCap movers unavailable" });
  }
});

app.get("/api/cmc/trending", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 15), 1), 25);
    const data = await fetchCoinMarketCap("/v1/cryptocurrency/listings/latest", {
      start: 1,
      limit,
      convert: "USD",
      sort: "market_cap",
      sort_dir: "desc",
      cryptocurrency_type: "all",
    });

    const assets = (data.data || [])
      .filter(asset => !isSuspiciousMarketAsset(asset))
      .map(normalizeCmcQuote)
      .slice(0, limit);

    const ids = [...new Set(assets.map(asset => asset.id).filter(Boolean))];
    let logos = {};
    if (ids.length) {
      const info = await fetchCoinMarketCap("/v2/cryptocurrency/info", {
        id: ids.join(","),
        aux: "logo,urls,platform",
      });
      logos = Object.fromEntries(
        Object.values(info.data || {}).map(asset => [
          String(asset.id),
          { logo: asset.logo, platform: asset.platform || null },
        ])
      );
    }

    res.json({
      assets: assets.map(asset => ({ ...asset, ...(logos[String(asset.id)] || {}) })),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(502).json({ error: err.message || "CoinMarketCap trending unavailable" });
  }
});

// ── CDP SWAP ENDPOINT ───────────
app.post("/api/cdp-swap", async (req, res) => {
  try {
    const { fromToken, toToken, fromAmount, taker, signerAddress, slippageBps = 100, allowSpendPermissionFlow = false } = req.body;
    if (!fromToken || !toToken || !fromAmount || !taker) {
      return res.status(400).json({ error: "fromToken, toToken, fromAmount, and taker are required" });
    }
    if (!isAddress(fromToken) || !isAddress(toToken) || !isAddress(taker)) {
      return res.status(400).json({ error: "Invalid token or taker address" });
    }
    const amountAtomic = BigInt(fromAmount.toString());
    if (!allowSpendPermissionFlow) {
      const balanceAtomic = await getBaseTokenBalance(taker, fromToken);
      if (balanceAtomic < amountAtomic) {
        return res.status(400).json({
          error: "Insufficient balance for this swap amount on Base.",
          balance: balanceAtomic.toString(),
          required: amountAtomic.toString(),
        });
      }
    }

    const client = getCdpClient();
    
    // Call CDP SDK createSwapQuote
    const quote = await client.evm.createSwapQuote({
      network: "base",
      fromToken,
      toToken,
      fromAmount: amountAtomic,
      taker,
      signerAddress: signerAddress || taker,
      slippageBps: Number(slippageBps),
    });

    if (!quote.liquidityAvailable) {
      return res.status(400).json({ error: "Liquidity unavailable for this swap pair/amount." });
    }

    const serialized = serializeCoinbaseSwapQuote(quote);

    res.json({
      success: true,
      quote: serialized,
      transaction: serialized.transaction,
      approval: serialized.approval,
    });
  } catch (err) {
    console.error("CDP Swap Error:", err);
    res.status(err.statusCode || 502).json({ error: getCdpErrorMessage(err) });
  }
});

// ── Verified Task System ──────────────────────────────
app.get("/api/tasks", (req, res) => {
  res.json({ tasks: TASKS.map(({ target, tweetId, ...task }) => task) });
});

app.get("/api/tasks/status", (req, res) => {
  const wallet = normalizeWallet(req.query.wallet);
  if (!wallet) return res.status(400).json({ error: "Valid wallet is required" });
  const record = taskRecord(wallet);
  const verified = record?.verified || {};
  const xp = TASKS.reduce((sum, task) => sum + (verified[task.id]?.verified ? task.xp : 0), 0);
  res.json({
    wallet,
    xp,
    verified,
    auth: {},
  });
});

app.post("/api/tasks/visit/start", (req, res) => {
  try {
    const wallet = normalizeWallet(req.body.wallet);
    const task = TASKS.find(t => t.id === req.body.taskId && t.type === "visit");
    if (!wallet || !task) return res.status(400).json({ error: "Valid wallet and visit task are required" });
    const token = randomId();
    visitProofs.set(token, { wallet, taskId: task.id, url: task.url, startedAt: Date.now() });
    res.json({ token, url: task.url, minSeconds: 8 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tasks/verify", async (req, res) => {
  try {
    const wallet = normalizeWallet(req.body.wallet);
    const taskId = String(req.body.taskId || "");
    const task = TASKS.find(t => t.id === taskId);
    const record = taskRecord(wallet);
    if (!wallet || !task || !record) return res.status(400).json({ error: "Valid wallet and taskId are required" });
    if (record.verified[taskId]?.verified) return res.json({ success: true, alreadyVerified: true, task: record.verified[taskId] });

    const proof = { provider: "instant-client-verify", taskType: task.type };
    const verifiedTask = markVerified(wallet, task.id, proof);
    res.json({ success: true, verified: true, task: verifiedTask });
  } catch (err) {
    res.status(502).json({ success: false, verified: false, error: err.message });
  }
});

// ── Static app ─────────────────────────
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── START ──────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`WALLEXA running on http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other server or run: PORT=8081 npm start`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
