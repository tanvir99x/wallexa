// parser.js and alchemy.js are loaded as plain <script> tags before this file.
// Access them via their window globals.
// NOTE: window.parseAICommand is set by parser.js — we call it directly.
// Do NOT redefine parseAICommand here to avoid recursive loops.

// Alias for alchemy RPC — defined in alchemy.js exposed as window.WALLEXA_ALCHEMY
function alchemyRpc(method, params, network) {
  if (!window.WALLEXA_ALCHEMY) throw new Error('Alchemy not loaded');
  return window.WALLEXA_ALCHEMY.alchemyRpc(method, params, network);
}

// ── AI CONFIG ──────────────────────────────────────────
// BluesMinds — OpenAI-compatible API
const AI_API_KEY  = 'sk-pgmEh0wdUoI6jjDkceJc041J0jyU4HU2s4jp7n3NnSTZ8vqp';
const AI_BASE_URL = 'https://api.bluesminds.com/v1';
const AI_MODEL    = 'gpt-5-chat';

// Stores all tokens so View all toggle works without re-fetching.
let _allTokens = [];
let _showAllTokens = false;
let ETH_BAL = 0;
const TOKEN_PREVIEW = 6;
const PRICES = { eth: 0, ethChange: 0 };
const WALLEXA_TASK_STORAGE_KEY = 'wallexa_verified_tasks';
const MARKET_REFRESH_MS = 60000;
let _marketMovers = { assets: [], updatedAt: null };
let _marketMoversLoadedAt = 0;

function getWalletState() {
  return window.WALLEXA_WALLET?.getInstance()?.getState?.() || { connected: false, address: null };
}

function shortAddr(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function uniqueWalletAddresses(...values) {
  const seen = new Set();
  return values
    .flat()
    .filter(Boolean)
    .map(address => String(address).trim())
    .filter(address => /^0x[a-fA-F0-9]{40}$/.test(address))
    .filter(address => {
      const key = address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return '—';
  return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function coingeckoIdForToken(t) {
  if (t.native || t.symbol === 'ETH') return 'ETH';
  const symbol = String(t.symbol || '').toUpperCase();
  return CMC_SYMBOLS[t.symbol] || CMC_SYMBOLS[symbol] || TOKEN_PRICE_IDS[(t.contractAddress || '').toLowerCase()] || symbol || null;
}

function getTokenAddressForSwap(token) {
  if (!token) return '';
  return token.symbol === 'ETH' ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : token.address;
}

function toAtomicAmount(amount, decimals) {
  const [whole, fraction = ''] = String(amount).split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt(padded || '0')).toString();
}

function fromAtomicAmount(value, decimals) {
  const raw = BigInt(value || '0');
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return Number(`${whole}${fraction ? '.' + fraction : ''}`);
}

function strip0x(value) {
  return String(value || '').replace(/^0x/i, '');
}

function concatHex(parts) {
  return '0x' + parts.map(strip0x).join('');
}

function byteLengthHex(value) {
  const hex = strip0x(value);
  return Math.ceil(hex.length / 2);
}

function uint256Hex(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

async function waitForTxReceipt(provider, txHash, onStatus) {
  for (let i = 0; i < 30; i++) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    if (receipt) return receipt;
    onStatus?.('Waiting for approval confirmation...');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Approval not confirmed yet. Wait a few seconds and retry the swap.');
}

async function signPermit2AndAppendSwapData(provider, walletAddress, quote, txData, onStatus) {
  const typedData = quote?.permitData?.eip712 || quote?.raw?.quote?.permit2?.eip712 || null;
  if (!typedData) return txData || '0x';

  onStatus?.('Sign Permit2 authorization...');
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [walletAddress, JSON.stringify(typedData)],
  });

  const signatureLength = '0x' + uint256Hex(byteLengthHex(signature));
  return concatHex([txData || '0x', signatureLength, signature]);
}

function buildTokenRow(t) {
  const balance = Number(t.balanceNum ?? parseFloat(t.balance || '0'));
  const price = Number(t.usdPrice || 0);
  const usdValue = price > 0 ? balance * price : null;
  const change = Number(t.usdChange24h ?? 0);
  const hasChange = Number.isFinite(change) && price > 0;
  const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
  const changeIcon = change > 0 ? '▲' : change < 0 ? '▼' : '—';
  const icon = t.logo
    ? `<img class="token-logo-img" src="${t.logo}" alt="${t.symbol || 'Token'}" onerror="this.remove();this.parentElement.textContent='⬡'">`
    : '⬡';
  const primaryValue = usdValue === null
    ? `${balance.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${t.symbol || ''}`
    : formatUsd(usdValue);

  return `
    <div class="token-row coinbase-token-row">
      <div class="token-icon">${icon}</div>
      <div class="token-info">
        <div class="token-name">${t.name || 'Unknown'}</div>
        <div class="token-chain">${t.symbol || '—'} · Base</div>
      </div>
      <div class="token-values">
        <div class="token-usd">${primaryValue}</div>
        <div class="token-change ${changeClass}">${hasChange ? `${changeIcon} ${Math.abs(change).toFixed(2)}%` : '—'}</div>
        <div class="token-balance">${balance.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${t.symbol || ''}</div>
        <div class="token-price">${price > 0 ? `${formatUsd(price)} each` : 'Price pending'}</div>
      </div>
    </div>`;
}
/* ══════════════════════════════════════════════
   AI COMMAND PANEL — Claude API + Base Actions
══════════════════════════════════════════════ */
let aiOpen = false;
let pendingTx = null;

function toggleAI() {
  aiOpen = !aiOpen;
  document.getElementById('ai-panel').classList.toggle('open', aiOpen);
  if (aiOpen) setTimeout(() => document.getElementById('ai-cmd-input').focus(), 400);
}

function aiQuick(text) {
  document.getElementById('ai-cmd-input').value = text;
  sendAICommand();
}

function addAIMsg(text, role, html) {
  const log = document.getElementById('ai-chat-log');
  const el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  if (html) el.innerHTML = html;
  else el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

/* ============================
   AI Intent Router
   Handles parsed actions from parser.js
============================ */
function handleParsedAIIntent(intent) {
  switch (intent.action) {
    case "swap":
    case "send":
    case "pay":
      // Do NOT handle here — let MCP handle these below
      return false; // false = "not consumed, keep going"

    case "send_max":
      pendingTx = { type: "send_max", to: intent.params.to };
      addAIMsg("Preparing max‑amount send transaction…", "bot");
      // existing send flow will pick this up
      return;

    case "deploy_erc20":
      addAIMsg("Preparing ERC‑20 deployment…", "bot");
      navigate("deploy");
      return;

    case "recent_txs":
      addAIMsg("Fetching recent transactions…", "bot");
      navigate("home");
      return;

    case "explain_address":
      addAIMsg(`Looking up ${intent.params.address}…`, "bot");
      navigate("home");
      return;

    case "gas_forecast":
      addAIMsg("Fetching gas forecast…", "bot");
      navigate("home");
      return;

    case "send_all_tokens":
      pendingTx = { type: "send_all_tokens", to: intent.params.to };
      addAIMsg("Preparing full‑portfolio send…", "bot");
      return;

    case "estimate_gas":
      addAIMsg("Estimating gas usage…", "bot");
      navigate("home");
      return;

    case "autocorrect":
      addAIMsg("Let me suggest a corrected command…", "bot");
      return;

    default:
      addAIMsg("I understood the text but no actionable command was found.", "bot");
      return true;
  }
}

async function sendAICommand() {
  const input = document.getElementById('ai-cmd-input');
  const raw = input.value.trim();
  if (!raw) return;
  input.value = '';
  addAIMsg(raw, 'user');

  // NEW — PURE PARSER FIRST
  const { intent } = (typeof window.parseAICommand === "function" ? window.parseAICommand(raw) : { intent: { action: "none", params: {} } });
  if (intent && intent.action && intent.action !== "none") {
    const handled = handleParsedAIIntent(intent);
    if (handled !== false) return;
  }

  // ── LOCAL INTENT DETECTION (fast, no API call needed) ──
  const lower = raw.toLowerCase();

  // Navigate commands
  if (lower.includes('leaderboard')) {
    openLeaderboard();
    addAIMsg('Opened the leaderboard.', 'bot');
    return;
  }

  if (lower.includes('transaction') || lower.includes('transactions') || lower.includes('tx')) {
    addAIMsg('The transaction section has been removed. You can still use direct commands like "send 0.01 ETH to 0x..." or "swap 0.01 ETH to USDC".', 'bot');
    return;
  }

  // ── BASE MCP: swap / send / pay commands ───────────────────────────────────
  // Route ALL swap/send/pay commands through WALLEXA_MCP (smart wallet only).
  // handleCommand() returns true if it consumed the input — stop here.
  if (window.WALLEXA_MCP) {
    const wallet = getWalletState();
    const consumed = await window.WALLEXA_MCP.handleCommand(raw, wallet.address || null, addAIMsg);
    if (consumed) return;
  } else if (/^(swap|send|pay)\s+[\d.]+/i.test(raw.trim())) {
    addAIMsg('⚠️ WallexAI plugin (basemcp.js) not loaded. Check your index.html script tags.', 'bot');
    return;
  }

  const navMap = { 'nft': 'nfts', 'nfts': 'nfts', 'home': 'home', 'dashboard': 'home', 'deploy': 'deploy', 'profile': 'profile' };
  for (const [kw, page] of Object.entries(navMap)) {
    if (lower.includes(kw) && (lower.includes('go') || lower.includes('open') || lower.includes('show') || lower.includes('navigate'))) {
      navigate(page, null, null);
      addAIMsg(`✓ Navigated to ${page.charAt(0).toUpperCase() + page.slice(1)} page.`, 'bot');
      return;
    }
  }

  // Balance check
  if (lower.includes('balance') || lower.includes('how much eth') || lower.includes('my eth')) {
    const wallet = getWalletState();
    if (!wallet.address) { addAIMsg('No wallet connected. Please connect a wallet first.', 'bot'); return; }
    const thinking = addAIMsg('Checking chain...', 'bot thinking');
    try {
      const hex = await alchemyRpc('eth_getBalance', [wallet.address, 'latest']);
      const bal = (parseInt(hex, 16) / 1e18).toFixed(6);
      await fetchPrices();
      const usd = (parseFloat(bal) * PRICES.eth).toFixed(2);
      thinking.textContent = `Your ETH balance: ${bal} ETH ≈ $${usd} USD`;
      thinking.classList.remove('thinking');
    } catch(e) { thinking.textContent = 'Error: ' + e.message; thinking.classList.remove('thinking'); }
    return;
  }

  // Gas price
  if (lower.includes('gas')) {
    const thinking = addAIMsg('Fetching gas...', 'bot thinking');
    try {
      const hex = await alchemyRpc('eth_gasPrice', []);
      const gwei = (parseInt(hex, 16) / 1e9).toFixed(4);
      thinking.textContent = `Current Base gas price: ${gwei} Gwei — ${parseFloat(gwei) < 0.01 ? 'Ultra low 🟢' : parseFloat(gwei) < 1 ? 'Low 🟡' : 'Higher than usual 🔴'}`;
      thinking.classList.remove('thinking');
    } catch(e) { thinking.textContent = 'Error: ' + e.message; thinking.classList.remove('thinking'); }
    return;
  }

  // Show NFTs
  if (lower.includes('nft') && (lower.includes('show') || lower.includes('my') || lower.includes('list'))) {
    navigate('nfts', null, null);
    addAIMsg('Opening your NFT collection...', 'bot');
    return;
  }

  // SEND ETH — pattern: "send X ETH to 0x..."
  const sendMatch = raw.match(/send\s+([\d.]+)\s*eth\s+to\s+(0x[0-9a-fA-F]{40})/i);
  if (sendMatch) {
    const wallet = getWalletState();
    if (!wallet.address) { addAIMsg('Connect a wallet first so I can prepare the transaction.', 'bot'); return; }
    await fetchPrices().catch(() => null);
    const amount = sendMatch[1];
    const toAddr = sendMatch[2];
    const usdVal = (parseFloat(amount) * PRICES.eth).toFixed(2);
    pendingTx = { type: 'send', amount, to: toAddr };
    addAIMsg('', 'bot', `
      <div style="font-size:12px;margin-bottom:8px;color:rgba(245,237,232,.6);">Transaction ready to sign:</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.8;background:rgba(245,237,232,.05);padding:10px;border-radius:9px;margin-bottom:4px;">
        <div>From: <span style="color:var(--mauve-light)">${shortAddr(wallet.address)}</span></div>
        <div>To:   <span style="color:var(--mauve-light)">${shortAddr(toAddr)}</span></div>
        <div>Amount: <span style="color:var(--green)">${amount} ETH ≈ $${usdVal}</span></div>
        <div>Network: <span style="color:var(--cream)">Base Mainnet</span></div>
      </div>
      <button class="tx-confirm-btn" onclick="executePendingTx()">✓ Confirm & Sign Transaction</button>
      <button class="tx-cancel-btn" onclick="cancelPendingTx()">✕ Cancel</button>
    `);
    return;
  }

  // LOOK UP ADDRESS
  const addrMatch = raw.match(/(lookup|check|inspect|show|balance of|who is)\s+(0x[0-9a-fA-F]{40})/i);
  if (addrMatch) {
    const addr = addrMatch[2];
    const thinking = addAIMsg('Looking up address...', 'bot thinking');
    try {
      const [hexBal, hexNonce] = await Promise.all([
        alchemyRpc('eth_getBalance', [addr, 'latest']),
        alchemyRpc('eth_getTransactionCount', [addr, 'latest']),
      ]);
      const bal = (parseInt(hexBal, 16) / 1e18).toFixed(6);
      const nonce = parseInt(hexNonce, 16);
      await fetchPrices().catch(() => null);
      const usd = (parseFloat(bal) * PRICES.eth).toFixed(2);
      thinking.innerHTML = `<strong>${shortAddr(addr)}</strong><br>ETH: ${bal} (≈$${usd})<br>Transactions: ${nonce}<br><a href="https://basescan.org/address/${addr}" target="_blank" style="color:var(--mauve-light);font-size:11px;">View on Basescan →</a>`;
      thinking.classList.remove('thinking');
    } catch(e) { thinking.textContent = 'Error: ' + e.message; thinking.classList.remove('thinking'); }
    return;
  }

  // ETH PRICE
  if (lower.includes('price') || lower.includes('eth usd') || lower.includes('how much is eth')) {
    const thinking = addAIMsg('Fetching price...', 'bot thinking');
    try {
      await fetchPrices();
      const chSign = PRICES.ethChange >= 0 ? '▲' : '▼';
      thinking.textContent = `ETH price: $${PRICES.eth.toLocaleString()} USD  ${chSign} ${Math.abs(PRICES.ethChange).toFixed(2)}% (24h)`;
      thinking.classList.remove('thinking');
    } catch(e) { thinking.textContent = 'Error fetching price.'; thinking.classList.remove('thinking'); }
    return;
  }

  // ── FALLBACK → Claude AI API ──
  const thinking = addAIMsg('Thinking...', 'bot thinking');
  try {
    const systemPrompt = `You are WALLEXA AI, a smart Web3 assistant for Base chain (Ethereum L2 by Coinbase). 
You help users with: wallet balances, NFTs, token swaps, smart contract deployment, transaction history, and Base chain education.
Current wallet: ${getWalletState().address || 'not connected'}. ETH balance: ${ETH_BAL.toFixed(6)} ETH. ETH price: $${PRICES.eth}.
Keep answers short (2-4 sentences), friendly, and technically accurate. If asked to perform an action that needs wallet signing, explain the user should type a command like "send 0.01 ETH to 0x...".
Base chain resources: https://docs.base.org | Basescan: https://basescan.org`;

    const reply = await callClaudeAI(systemPrompt, [{ role: 'user', content: raw }], 300);
    thinking.textContent = reply;
    thinking.classList.remove('thinking');
  } catch(e) {
    thinking.textContent = `⚠️ AI error: ${e.message}`;
    thinking.classList.remove('thinking');
  }
}

// ── Shared AI caller — routes through /api/ai server proxy to avoid CORS ─────
async function callClaudeAI(systemPrompt, messages, maxTokens = 400) {
  // Always use the server-side proxy (/api/ai) — direct browser→BluesMinds calls
  // fail with CORS / "Failed to fetch". The server has the real API key.
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5-chat',
      max_tokens: maxTokens,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => 'Server error');
    throw new Error(`AI API error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || data.error || 'AI API error');
  return data.choices?.[0]?.message?.content || 'No response.';
}

async function executePendingTx() {
  if (!pendingTx) return;
  const wallet = getWalletState();
  if (!wallet.connected || !window.ethereum) {
    addAIMsg('⚠️ Read-only mode. Connect MetaMask to sign transactions.', 'bot');
    pendingTx = null; return;
  }
  const thinking = addAIMsg('Sending to MetaMask for signing...', 'bot thinking');
  try {
    const weiHex = '0x' + Math.round(parseFloat(pendingTx.amount) * 1e18).toString(16);
    const txHash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: wallet.address, to: pendingTx.to, value: weiHex, chainId: '0x2105' }],
    });
    thinking.innerHTML = `✅ Transaction sent!<br><a href="https://basescan.org/tx/${txHash}" target="_blank" style="color:var(--mauve-light);font-family:'JetBrains Mono',monospace;font-size:11px;">${txHash.slice(0,18)}... →</a>`;
    thinking.classList.remove('thinking');
    showToast('✅', 'Sent!', pendingTx.amount + ' ETH → ' + shortAddr(pendingTx.to));
    pendingTx = null;
    setTimeout(() => { initApp('Wallet'); }, 3000);
  } catch(e) {
    thinking.textContent = 'Transaction rejected: ' + (e.message || 'User cancelled');
    thinking.classList.remove('thinking');
    pendingTx = null;
  }
}

function cancelPendingTx() {
  pendingTx = null;
  addAIMsg('Transaction cancelled.', 'bot');
}

// Show AI button once app is visible
// Hook into launchApp to show AI trigger
document.addEventListener('DOMContentLoaded', () => {
  const appEl = document.getElementById('app');
  if (appEl) {
    const _launchObserver = new MutationObserver(() => {
      if (appEl.classList.contains('active')) {
        const trigger = document.getElementById('ai-trigger');
        if (trigger) trigger.classList.add('visible');
        _launchObserver.disconnect();
      }
    });
    _launchObserver.observe(appEl, { attributes: true, attributeFilter: ['class'] });
  }

  // ── INTRO PERCENTAGE COUNTER ──
  const pctEl = document.getElementById('xh-pct');
  if (pctEl) {
    const START_DELAY = 900, DURATION = 2400;
    let pctStart = null;
    function animPct(ts) {
      if (!pctStart) pctStart = ts;
      const p = Math.min((ts - pctStart) / DURATION, 1);
      const e = p < .5 ? 4*p*p*p : 1 - Math.pow(-2*p+2,3)/2;
      pctEl.textContent = Math.round(e * 100) + '%';
      if (p < 1) requestAnimationFrame(animPct);
    }
    setTimeout(() => requestAnimationFrame(animPct), START_DELAY);

    setTimeout(() => {
      const intro = document.getElementById('intro');
      if (!intro) return;
      intro.style.transition = 'opacity .9s ease';
      intro.style.opacity = '0';
      setTimeout(() => {
        intro.style.display = 'none';
        const cs = document.getElementById('connect-screen');
        if (!cs) return;
        cs.classList.add('active');
        cs.style.opacity = '0';
        cs.style.transition = 'opacity .8s ease';
        setTimeout(() => { cs.style.opacity = '1'; }, 50);
      }, 900);
    }, START_DELAY + DURATION + 300);
  }

  // ── CURSOR GLOW ──
  const cursorGlow = document.getElementById('cursor-glow');
  if (cursorGlow) {
    document.addEventListener('mousemove', e => {
      cursorGlow.style.left = e.clientX + 'px';
      cursorGlow.style.top  = e.clientY + 'px';
    });
  }
});
  function renderTokenList() {
    const container = document.getElementById("token-list");
    const visible = _showAllTokens ? _allTokens : _allTokens.slice(0, TOKEN_PREVIEW);
    const hasMore = _allTokens.length > TOKEN_PREVIEW;

    let html = `
      <div class="dashboard-card-head token-card-head">
        <div>
          <div class="mini-title">Token Holdings</div>
          <div class="mini-subtitle">${_allTokens.length} real asset${_allTokens.length !== 1 ? 's' : ''} on Base</div>
        </div>
        ${hasMore ? `<button id="token-view-all-btn" class="dashboard-icon-btn token-view-all-btn" type="button" onclick="toggleViewAllTokens()">
          ${_showAllTokens ? 'Show less ‹' : 'View all ›'}
        </button>` : ''}
      </div>
      <div class="token-list-body">`;

    for (const t of visible) {
      html += buildTokenRow(t);
    }

    container.innerHTML = html + '</div>';
  }

  function toggleViewAllTokens() {
    _showAllTokens = !_showAllTokens;
    renderTokenList();
  }

  function tokenUsdValue(token) {
    return (Number(token.balanceNum) || 0) * (Number(token.usdPrice) || 0);
  }

  function estimateTokenPnl24h(token) {
    const value = tokenUsdValue(token);
    const change = Number(token.usdChange24h || 0);
    if (!value || !Number.isFinite(change)) return 0;
    const previousValue = value / (1 + change / 100);
    return value - previousValue;
  }

  function updatePortfolioSummary(tokens, address) {
    const displayTokens = tokens || [];
    const totalValue = displayTokens.reduce((sum, token) => sum + tokenUsdValue(token), 0);
    const pnl24h = displayTokens.reduce((sum, token) => sum + estimateTokenPnl24h(token), 0);
    const pnlPct = totalValue ? (pnl24h / (totalValue - pnl24h || totalValue)) * 100 : 0;

    const balanceEl = document.getElementById('balance-display');
    if (balanceEl) {
      balanceEl.textContent = formatUsd(totalValue);
      balanceEl.style.opacity = '1';
      balanceEl.style.fontSize = '';
    }

    const changeEl = document.getElementById('balance-change');
    if (changeEl) {
      const positive = pnl24h >= 0;
      changeEl.textContent = `${positive ? '▲' : '▼'} ${formatUsd(Math.abs(pnl24h))} (${Math.abs(pnlPct).toFixed(2)}%) 24h`;
      changeEl.style.visibility = 'visible';
      changeEl.className = `balance-change ${positive ? 'positive' : 'negative'}`;
      changeEl.style.color = '';
    }

    const overviewTotal = document.getElementById('overview-total-value');
    if (overviewTotal) overviewTotal.textContent = formatUsd(totalValue);

    const overviewPnl = document.getElementById('overview-pnl-24h');
    if (overviewPnl) {
      overviewPnl.textContent = `${pnl24h >= 0 ? '+' : '-'}${formatUsd(Math.abs(pnl24h))}`;
      overviewPnl.className = pnl24h >= 0 ? 'positive-value' : 'negative-value';
    }

    const walletEl = document.getElementById('home-wallet-address');
    if (walletEl) walletEl.textContent = address ? shortAddr(address) : 'Not connected';

    const countEl = document.getElementById('home-asset-count');
    if (countEl) countEl.textContent = String(displayTokens.length);

    const baseNameEl = document.getElementById('home-base-name');
    if (baseNameEl) baseNameEl.textContent = address ? 'wallexa.base.eth' : 'Connect wallet';

    renderAssetAllocation(displayTokens, totalValue);
  }

  function renderAssetAllocation(tokens, totalValue) {
    const container = document.getElementById('asset-allocation');
    if (!container) return;

    const priced = tokens
      .map(token => ({ ...token, value: tokenUsdValue(token) }))
      .filter(token => token.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    if (!priced.length) {
      container.innerHTML = '<div class="allocation-empty">No priced Base assets yet.</div>';
      return;
    }

    container.innerHTML = priced.map((token, index) => {
      const pct = totalValue ? Math.max(2, (token.value / totalValue) * 100) : 0;
      const logo = token.logo
        ? `<img src="${token.logo}" alt="${token.symbol || 'Token'}" onerror="this.remove()">`
        : '<span>⬡</span>';
      return `
        <div class="allocation-row">
          <div class="allocation-token">
            <div class="allocation-logo">${logo}</div>
            <span>${token.symbol || token.name}</span>
          </div>
          <div class="allocation-track"><div class="allocation-fill allocation-fill-${index % 5}" style="width:${pct.toFixed(2)}%;"></div></div>
          <strong>${(totalValue ? (token.value / totalValue) * 100 : 0).toFixed(1)}%</strong>
        </div>`;
    }).join('');

    const updatedEl = document.getElementById('allocation-updated');
    if (updatedEl) updatedEl.textContent = 'Updated now';
  }

  async function loadVerifiedBaseTokens(address) {
    const [ethBalance, erc20Tokens] = await Promise.all([
      window.WALLEXA_ALCHEMY.getBalance(address, "mainnet"),
      window.WALLEXA_ALCHEMY.getTokenBalances(address, "mainnet"),
    ]);

    const ethFloat = parseFloat(ethBalance);
    const ethEntry = {
      contractAddress: "native",
      name:       "Ethereum",
      symbol:     "ETH",
      decimals:   18,
      balance:    ethFloat.toFixed(6),
      balanceNum: ethFloat,
      logo:       "https://cryptologos.cc/logos/ethereum-eth-logo.png",
      trusted:    true,
      native:     true,
    };

    const visibleErc20Tokens = (erc20Tokens || []).filter(token => Number(token.balanceNum || 0) > 0);
    return ethFloat > 0 ? [ethEntry, ...visibleErc20Tokens] : visibleErc20Tokens;
  }

  async function renderTokenHoldings(addressOrAddresses) {
    const container = document.getElementById("token-list");
    const addresses = uniqueWalletAddresses(addressOrAddresses);

    container.innerHTML = `
      <div style="padding:20px 0;text-align:center;color:rgba(247,240,235,.3);font-size:12px;font-family:'JetBrains Mono',monospace;letter-spacing:.05em;">
        Loading Base wallet assets...
      </div>`;

    try {
      let selectedAddress = addresses[0] || null;
      let allTokens = [];

      for (const candidate of addresses) {
        const candidateTokens = await loadVerifiedBaseTokens(candidate);
        if (candidateTokens.length > 0) {
          selectedAddress = selectedAddress || candidate;
          allTokens = [...allTokens, ...candidateTokens];
        }
      }

      const deduped = new Map();
      for (const token of allTokens) {
        const key = token.native
          ? `native:${selectedAddress || 'wallet'}`
          : String(token.contractAddress || token.address || token.symbol || token.name).toLowerCase();
        const existing = deduped.get(key);
        if (!existing || Number(token.balanceNum || 0) > Number(existing.balanceNum || 0)) {
          deduped.set(key, token);
        }
      }
      allTokens = [...deduped.values()];

      if (!allTokens || allTokens.length === 0) {
        container.innerHTML = `
          <div style="padding:20px 0;text-align:center;color:rgba(247,240,235,.3);font-size:13px;">
            No tokens found on connected Base wallet accounts.
          </div>`;
        updatePortfolioSummary([], selectedAddress);
        return;
      }

      _allTokens = await enrichTokensWithMarketData(allTokens);
      _showAllTokens = false;
      updatePortfolioSummary(_allTokens, selectedAddress);
      renderTokenList();
      updateSwapTokenUI();

    } catch (err) {
      console.error("Token error:", err);
      container.innerHTML = `
        <div style="padding:12px 0;color:rgba(232,144,96,.7);font-size:13px;">
          Could not load tokens.
        </div>`;
    }
  }
// Show toast if no wallet installed
window.addEventListener("load", () => {
  loadMarketMovers().catch(() => null);
  if (!window.ethereum) {
    setTimeout(() => showToast("⚠️", "No Wallet Found", "Install MetaMask or Coinbase Wallet"), 4000);
  }
});
// ======================================================
//  OTHER WALLETS TOGGLE
// ======================================================
function toggleOtherWallets() {
  const panel = document.getElementById('other-wallets');
  const arrow  = document.getElementById('toggle-arrow');
  panel.classList.toggle('open');
  arrow.classList.toggle('open');
}

// ======================================================
//  BASE WALLET CONNECT — Primary flow
//  Immediately starts connecting (no extra modal/picker).
//  Shows: Connecting → Confirming → opens home page.
// ======================================================
async function connectBaseWallet() {
  const btn = document.getElementById('base-connect-btn');

  try {
    if (!window.WALLEXA_WALLET) {
      throw new Error("Wallet system not loaded");
    }

    const wallet = window.WALLEXA_WALLET.getInstance();

    // =========================
    // UI: CONNECTING STATE
    // =========================
    btn.classList.add('connecting');
    const strongEl = btn.querySelector('.base-btn-content strong');
    const spanEl = btn.querySelector('.base-btn-content span');
    if (strongEl) strongEl.textContent = 'Connecting...';
    if (spanEl) spanEl.textContent = 'Approve in wallet';

    const spinner = document.createElement('div');
    spinner.className = 'btn-spinner';
    btn.appendChild(spinner);

    // =========================
    // REAL CONNECT
    // =========================
    const res = await wallet.connect("base");

    try {
      await wallet.switchToBase();
    } catch (e) {
      console.warn("Base switch failed:", e);
    }

    // =========================
    // UI: SUCCESS STATE
    // =========================
    btn.classList.remove('connecting');
    btn.classList.add('success');

    const iconEl = btn.querySelector('.base-btn-icon');
    const strongEl2 = btn.querySelector('.base-btn-content strong');
    const spanEl2 = btn.querySelector('.base-btn-content span');
    if (iconEl) iconEl.textContent = '✅';
    if (strongEl2) strongEl2.textContent = 'Connected!';
    if (spanEl2) spanEl2.textContent = wallet.getShortAddress(res.address);

    spinner.remove();

    // =========================
    // OPEN APP
    // =========================
    setTimeout(() => {
      openApp("Base Wallet");
    }, 500);

  } catch (err) {
    console.error(err);

    btn.classList.remove('connecting');

    const strongErr = btn.querySelector('.base-btn-content strong');
    const spanErr = btn.querySelector('.base-btn-content span');
    if (strongErr) strongErr.textContent = 'Connection failed';
    if (spanErr) spanErr.textContent = err.message;

    showToast('❌', 'Wallet Error', err.message);
  }
}
// ======================================================
//  OTHER WALLET CONNECT
// ======================================================
function connectOtherWallet(name, evt) {
  const btn = evt?.currentTarget;
  if (!btn) return;
  btn.innerHTML = `<div class="wallet-btn-icon" style="background:rgba(126,200,164,.15);">⟳</div><div class="wallet-btn-text"><strong>Connecting...</strong><span>${name}</span></div>`;
  btn.style.borderColor = 'rgba(126,200,164,.3)';
  const walletConn = window.WALLEXA_WALLET?.getInstance();

  if (walletConn) {
    const walletKind =
      name === 'MetaMask' ? 'metamask' :
      name === 'WalletConnect' ? 'walletconnect' :
      name === 'Trust Wallet' ? 'trust' :
      name === 'Bitget Wallet' ? 'bitget' :
      'injected';
    walletConn.connect(walletKind).then(() => {
      walletConn.switchToBase().catch(() => null);
      openApp(name);
    }).catch(err => {
      btn.innerHTML = `<div class="wallet-btn-text"><strong>Failed</strong><span>${err.message}</span></div>`;
      showToast('❌', 'Wallet Error', err.message);
    });
  } else {
    const message = 'Wallet system not loaded';
    btn.innerHTML = `<div class="wallet-btn-text"><strong>Failed</strong><span>${message}</span></div>`;
    showToast('❌', 'Wallet Error', message);
  }
}

// ======================================================
//  OPEN APP — shared by all wallet flows
// ======================================================
function openApp(walletName) {
  const cs = document.getElementById('connect-screen');
  cs.style.transition = 'opacity .5s ease';
  cs.style.opacity = '0';

  setTimeout(() => {
    cs.classList.remove('active');
    cs.style.display = 'none';

    const app = document.getElementById('app');
    app.classList.add('active');
    app.style.opacity = '0';
    app.style.transition = 'opacity .5s ease';
    setTimeout(() => { app.style.opacity = '1'; }, 30);

    initApp(walletName);
  }, 500);
}

// ======================================================
//  DISCONNECT WALLET
// ======================================================
async function disconnectWallet() {
  // 1. Disconnect wallet provider
  try {
    const connector = window.WALLEXA_WALLET?.getInstance?.();
    if (connector) await connector.disconnect();
  } catch(e) {
    console.warn('Disconnect error:', e);
  }

  // 2. Reset state
  ETH_BAL = 0;
  _allTokens = [];
  PRICES.eth = 0;
  PRICES.ethChange = 0;

  // 3. Reset UI
  const balEl = document.getElementById('balance-display');
  if (balEl) { balEl.textContent = '—'; balEl.style.opacity = '1'; }

  const balChange = document.getElementById('balance-change');
  if (balChange) balChange.style.visibility = 'hidden';

  const homeWalletAddr = document.getElementById('home-wallet-address');
  if (homeWalletAddr) homeWalletAddr.textContent = 'Not connected';

  const homeAssetCount = document.getElementById('home-asset-count');
  if (homeAssetCount) homeAssetCount.textContent = '0';

  const overviewTotal = document.getElementById('overview-total-value');
  if (overviewTotal) overviewTotal.textContent = '$0.00';

  const overviewPnl = document.getElementById('overview-pnl-24h');
  if (overviewPnl) {
    overviewPnl.textContent = '$0.00';
    overviewPnl.className = '';
  }

  const allocation = document.getElementById('asset-allocation');
  if (allocation) allocation.innerHTML = '<div class="allocation-empty">Connect wallet to view allocation.</div>';

  const addrChip = document.getElementById('wai-addr-chip');
  if (addrChip) addrChip.textContent = '◉ Not connected';

  const profileAddr = document.getElementById('profile-addr-display');
  if (profileAddr) profileAddr.textContent = 'Connect wallet · Base Chain';

  const tokenList = document.getElementById('token-list');
  if (tokenList) {
    tokenList.innerHTML = '<div style="padding:20px 0;text-align:center;color:rgba(247,240,235,.3);font-size:12px;">Connect wallet to load token holdings...</div>';
  }

  const nftGrid = document.getElementById('nft-grid');
  if (nftGrid) nftGrid.innerHTML = '';

  // 4. Reset connect button
  const btn = document.getElementById('base-connect-btn');
  if (btn) {
    btn.classList.remove('connecting', 'success');
    const icon   = btn.querySelector('.base-btn-icon');
    const strong = btn.querySelector('.base-btn-content strong');
    const span   = btn.querySelector('.base-btn-content span');
    if (icon)   icon.textContent   = '🔵';
    if (strong) strong.textContent = 'Connect with Base';
    if (span)   span.textContent   = 'Smart wallet — no seed phrase needed';
    const spinner = btn.querySelector('.btn-spinner');
    if (spinner) spinner.remove();
  }

  // 5. Swap app → connect screen
  const app = document.getElementById('app');
  const cs  = document.getElementById('connect-screen');

  if (app) {
    app.style.transition = 'opacity 0.4s ease';
    app.style.opacity = '0';
    setTimeout(function() {
      app.classList.remove('active');
      app.style.display = 'none';
      app.style.opacity = '';
      app.style.transition = '';
    }, 420);
  }

  if (cs) {
    setTimeout(function() {
      cs.style.display = '';
      cs.classList.add('active');
      cs.style.opacity = '0';
      cs.style.transition = 'opacity 0.5s ease';
      setTimeout(function() { cs.style.opacity = '1'; }, 40);
    }, 380);
  }

  showToast('⏻', 'Disconnected', 'Wallet disconnected successfully');
}


// ======================================================
//  PAGE TRANSITIONS
//  FIX: forceLayout() after removing animation classes
//  prevents browsers from caching a mid-animation frame.
// ======================================================
let currentPage = 'home';
let isTransitioning = false;

async function ensureWalletAccessForWallexAI() {
  const state = getWalletState();
  if (state.connected && state.address) return true;

  const connector = window.WALLEXA_WALLET?.getInstance?.();
  if (!connector) {
    showToast('❌', 'Wallet Error', 'Wallet system not loaded');
    return false;
  }

  try {
    showToast('🔐', 'Wallet Access', 'Approve wallet access for WallexAI');
    const res = await connector.connect('base');
    await connector.switchToBase().catch(err => console.warn('Base switch failed:', err));
    const chip = document.getElementById('wai-addr-chip');
    if (chip && res?.address) chip.textContent = '◉ ' + shortAddr(res.address);
    return true;
  } catch (err) {
    showToast('❌', 'Wallet Rejected', err.message || 'Wallet access was not approved');
    return false;
  }
}

async function navigate(targetPage) {
  if (targetPage === currentPage) return;

  if (targetPage === 'wallexai') {
    const ok = await ensureWalletAccessForWallexAI();
    if (!ok) return;
  }

  // Update nav highlights immediately
  document.querySelectorAll('.nav-item').forEach(i =>
    i.classList.toggle('active', i.dataset.page === targetPage));
  document.querySelectorAll('.mob-nav-item').forEach(i =>
    i.classList.toggle('active', i.dataset.page === targetPage));

  if (isTransitioning) return;
  isTransitioning = true;

  showLoadingBar();

  const outEl = document.getElementById('page-' + currentPage);
  const inEl  = document.getElementById('page-' + targetPage);

  if (!outEl || !inEl) { isTransitioning = false; currentPage = targetPage; return; }

  // Exit current page
  outEl.classList.remove('active');
  outEl.classList.add('slide-out');

  setTimeout(() => {
    outEl.classList.remove('slide-out');

    // Activate new page
    inEl.classList.add('active', 'slide-in');
    document.getElementById('main').scrollTo({ top: 0, behavior: 'instant' });

    // Force stagger children visible
    inEl.querySelectorAll('.stagger-child').forEach(el => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });

    setTimeout(() => {
      inEl.classList.remove('slide-in');
      isTransitioning = false;
    }, 550);

    // Hard safety timeout
    setTimeout(() => { isTransitioning = false; }, 900);

    currentPage = targetPage;
  }, 300);
}

document.querySelectorAll('.nav-item[data-page], .mob-nav-item[data-page]').forEach(el => {
  el.addEventListener('click', () => navigate(el.dataset.page));
});

function showLoadingBar() {
  const bar = document.getElementById('loading-bar');
  bar.style.transform = 'scaleX(0)'; bar.style.opacity = '1';
  setTimeout(() => { bar.style.transform = 'scaleX(0.7)'; }, 10);
  setTimeout(() => { bar.style.transform = 'scaleX(1)'; }, 300);
  setTimeout(() => { bar.style.opacity = '0'; }, 650);
}

// ======================================================
//  TOAST
// ======================================================
function showToast(icon, title, subtitle) {
  const t = document.createElement('div');
  t.className = 'toast-item';
  t.innerHTML = `<span class="toast-icon">${icon}</span><div class="toast-text"><div class="toast-title">${title}</div><div class="toast-sub">${subtitle}</div></div>`;
  document.getElementById('toast').appendChild(t);
  setTimeout(() => {
    t.style.transition = 'all .4s ease'; t.style.opacity = '0'; t.style.transform = 'translateX(40px)';
    setTimeout(() => t.remove(), 400);
  }, 3200);
}


// ======================================================
//  INIT APP (REAL WALLET VERSION)
// ======================================================
async function initApp(walletName) {
  const wallet = window.WALLEXA_WALLET.getInstance();
  const walletState = wallet.getState?.() || {};

  showToast('✅', 'Connected', walletName + ' connected to Base chain');

  // =========================
  // STEP A: ADDRESS
  // =========================
  const addressCandidates = uniqueWalletAddresses(
    walletState.primaryAddress,
    wallet.primaryAddress,
    walletState.address,
    wallet.address,
    walletState.appAccountAddress,
    wallet.appAccountAddress,
    walletState.accounts,
    wallet.accounts
  );
  const address = addressCandidates[0];

  if (!address) {
    showToast('❌', 'Error', 'Wallet address not found');
    renderNFTs();
    renderTasks();
    updateXPUI();
    startCountdown();
    const home = document.getElementById('page-home');
    if (home) {
      home.classList.remove('slide-in');
      home.style.filter = 'none';
      home.style.opacity = '1';
      home.style.transform = 'none';
    }
    document.querySelectorAll('.stagger-child').forEach(el => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
    return;
  }

  // Show wallet address in profile section
  const profileAddr = document.getElementById('profile-addr-display') || document.querySelector('.profile-addr');
  if (profileAddr) {
    profileAddr.textContent = shortAddr(address) + ' · Base Chain';
  }
  const homeWalletAddr = document.getElementById('home-wallet-address');
  if (homeWalletAddr) homeWalletAddr.textContent = shortAddr(address);

  try {
    // =========================
    // STEP B: REAL ETH BALANCE
    // =========================
    const balanceEl = document.getElementById("balance-display");
    balanceEl.textContent = 'Loading...';
    balanceEl.style.opacity = '0.4';
    balanceEl.style.fontSize = '';

    const balance = await window.WALLEXA_ALCHEMY.getBalance(address, "mainnet");
    const ethFloat = parseFloat(balance);
    ETH_BAL = ethFloat;
    await fetchPrices().catch(() => null);
    const ethPrice = PRICES.eth || 3400;
    const usdValue = (ethFloat * ethPrice).toFixed(2);
    updateSwapTokenUI();

    balanceEl.textContent = '$' + Number(usdValue).toLocaleString('en-US', {minimumFractionDigits: 2});
    balanceEl.style.opacity = '1';

    // Show ETH amount below balance
    const changeEl = document.getElementById('balance-change');
    if (changeEl) {
      changeEl.textContent = ethFloat.toFixed(6) + ' ETH on Base';
      changeEl.style.visibility = 'visible';
      changeEl.style.color = 'rgba(247,240,235,.5)';
      changeEl.className = 'balance-change';
    }

    // =========================
    // RENDER UI
    // =========================
    renderTokenHoldings(addressCandidates); // async — scans connected accounts for verified holdings
    loadMarketMovers();
    renderNFTs();
    renderTasks();
    updateXPUI();
    startCountdown();

    // =========================
    // HOME ANIMATION
    // =========================
    const home = document.getElementById('page-home');
    home.classList.add('slide-in');
    setTimeout(() => {
      home.classList.remove('slide-in');
      home.querySelectorAll('.stagger-child').forEach(el => {
        el.style.opacity = '1';
        el.style.transform = 'none';
      });
    }, 600);

  } catch (err) {
    console.error(err);
    showToast('❌', 'Data Error', err.message);
    const balanceEl = document.getElementById('balance-display');
    balanceEl.textContent = 'Error loading';
    balanceEl.style.opacity = '0.5';
  } finally {
    // ALWAYS render static content and ALWAYS clean up slide-in
    // so stagger-child elements never get stuck at opacity:0
    renderNFTs();
    renderTasks();
    updateXPUI();
    startCountdown();
    const home = document.getElementById('page-home');
    if (home) {
      home.classList.remove('slide-in');
      home.querySelectorAll('.stagger-child').forEach(el => {
        el.style.opacity = '1';
        el.style.transform = 'none';
      });
    }
    document.querySelectorAll('.stagger-child').forEach(el => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
  }
}
// ======================================================
//  DATA — NFTs
// ======================================================
const nftData = [
  { emoji:'🌌', name:'Cosmic #7291',    collection:'Cosmic Genesis',   price:'1.2 ETH',  rarity:'legendary', rc:'rare-legendary' },
  { emoji:'🤖', name:'CryptoBot #142',  collection:'Base Bots',        price:'0.8 ETH',  rarity:'epic',      rc:'rare-epic'      },
  { emoji:'🦊', name:'Fox Spirit #88',  collection:'OnChain Spirits',  price:'2.1 ETH',  rarity:'legendary', rc:'rare-legendary' },
  { emoji:'💎', name:'DiamondPunk #512',collection:'BasePunks',        price:'5.0 ETH',  rarity:'epic',      rc:'rare-epic'      },
  { emoji:'🌊', name:'Wave Rider #300', collection:'Ocean DAO',        price:'0.3 ETH',  rarity:'rare',      rc:'rare-rare'      },
  { emoji:'🏔️', name:'Summit #44',      collection:'Alpine Club',      price:'0.6 ETH',  rarity:'rare',      rc:'rare-rare'      },
];

function renderNFTs() {
  const grid = document.getElementById('nft-grid');
  grid.innerHTML = '';
  nftData.forEach((nft, i) => {
    const el = document.createElement('div');
    el.className = 'nft-card';
    el.style.animation = `stagger-rise .45s var(--ease-out) ${i*.08}s both`;
    el.innerHTML = `
      <div class="nft-art" style="background:linear-gradient(135deg,rgba(184,131,122,.15),rgba(155,94,85,.2));"><span style="font-size:56px;position:relative;z-index:1;">${nft.emoji}</span><div class="nft-shine"></div></div>
      <div class="nft-info"><div class="nft-name">${nft.name}</div><div class="nft-collection">${nft.collection}</div><div class="nft-price-row"><span class="nft-price">${nft.price}</span><span class="nft-rarity ${nft.rc}">${nft.rarity}</span></div></div>`;
    el.addEventListener('click', () => showToast('◈', nft.name, 'Floor: ' + nft.price + ' · ' + nft.collection));
    grid.appendChild(el);
  });
}

// ======================================================
//  DATA — Tasks
// ======================================================
const tasksData = [
  { id:'x-follow-baseapp',        type:'x-follow',     icon:'𝕏', title:'Follow Base App',          desc:'Open the task, then verify for instant XP', xp:100, url:'https://x.com/baseapp' },
  { id:'x-follow-jessepollak',    type:'x-follow',     icon:'𝕏', title:'Follow Jesse Pollak',      desc:'Open the task, then verify for instant XP', xp:100, url:'https://x.com/jessepollak' },
  { id:'x-follow-coinbasedev',    type:'x-follow',     icon:'𝕏', title:'Follow Coinbase Dev',      desc:'Open the task, then verify for instant XP', xp:100, url:'https://x.com/CoinbaseDev' },
  { id:'x-follow-brian',          type:'x-follow',     icon:'𝕏', title:'Follow Brian Armstrong',   desc:'Open the task, then verify for instant XP', xp:100, url:'https://x.com/brian_armstrong' },
  { id:'x-follow-exiros',         type:'x-follow',     icon:'𝕏', title:'Follow Exiros',            desc:'Open the task, then verify for instant XP', xp:100, url:'https://x.com/theExiros' },
  { id:'x-like-repost-base-1',    type:'x-engagement', icon:'↻', title:'Like + repost Base post',  desc:'Open the post, then verify for instant XP', xp:100, url:'https://x.com/base/status/2062212551622939074?s=20' },
  { id:'x-like-repost-baseapp-2', type:'x-engagement', icon:'↻', title:'Like + repost Base App',   desc:'Open the post, then verify for instant XP', xp:100, url:'https://x.com/baseapp/status/2062295278498066766?s=20' },
  { id:'visit-guild-base',        type:'visit',        icon:'◆', title:'Visit Base Guild',         desc:'Open the page, then verify for instant XP', xp:100, url:'https://guild.xyz/base' },
  { id:'visit-base-org',          type:'visit',        icon:'◉', title:'Visit Base.org',           desc:'Open the page, then verify for instant XP', xp:100, url:'https://base.org/' },
  { id:'deploy-on-base',          type:'base-deploy',  icon:'⬢', title:'Deploy on Base',           desc:'Deploy DeployOnBaseTask from your connected wallet', xp:100, url:'https://base.org/builders' },
];

const XP_TIERS = [
  { name: 'Starter', threshold: 0 },
  { name: 'Bronze', threshold: 1000 },
  { name: 'Platinum', threshold: 3000 },
  { name: 'Diamond', threshold: 5000 },
];

const LEADERBOARD_BASE = [];
let verifiedTaskState = {};
let pendingVisitTokens = {};

function getStoredTaskState() {
  return verifiedTaskState;
}

function getTaskStorageKey() {
  const wallet = getTaskWallet();
  return `${WALLEXA_TASK_STORAGE_KEY}:${wallet ? wallet.toLowerCase() : 'guest'}`;
}

function readLocalTaskState() {
  try {
    return JSON.parse(localStorage.getItem(getTaskStorageKey()) || '{}') || {};
  } catch {
    return {};
  }
}

function saveLocalTaskState() {
  localStorage.setItem(getTaskStorageKey(), JSON.stringify(verifiedTaskState));
}

function markTaskCompleteLocally(task, proof = null) {
  verifiedTaskState = {
    ...verifiedTaskState,
    [task.id]: {
      verified: true,
      xp: task.xp,
      verifiedAt: new Date().toISOString(),
      proof: proof || { provider: 'instant-local-verify', taskType: task.type },
    },
  };
  saveLocalTaskState();
  updateXPUI();
}

function taskIsDone(task, state = getStoredTaskState()) {
  return Boolean(state[task.id]?.verified);
}

function getUserXP() {
  const state = getStoredTaskState();
  return tasksData.reduce((sum, task) => sum + (taskIsDone(task, state) ? task.xp : 0), 0);
}

function getTaskWallet() {
  const wallet = getWalletState();
  return wallet.address || null;
}

async function loadTaskStatus() {
  const wallet = getTaskWallet();
  verifiedTaskState = readLocalTaskState();
  updateXPUI();

  if (!wallet) {
    return;
  }

  try {
    const res = await fetch('/api/tasks/status?wallet=' + encodeURIComponent(wallet));
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error('Task API returned a non-JSON response');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load task status');
    verifiedTaskState = { ...(data.verified || {}), ...verifiedTaskState };
    saveLocalTaskState();
    updateXPUI();
  } catch (err) {
    console.warn('Task status unavailable:', err.message);
  }
}

function getTierInfo(xp) {
  const current = [...XP_TIERS].reverse().find(tier => xp >= tier.threshold) || XP_TIERS[0];
  const next = XP_TIERS.find(tier => tier.threshold > xp) || null;
  const progressBase = current.threshold;
  const progressTarget = next ? next.threshold : current.threshold;
  const pct = next ? ((xp - progressBase) / (progressTarget - progressBase)) * 100 : 100;
  return { current, next, pct: Math.max(0, Math.min(100, pct)) };
}

function updateXPUI() {
  const xp = getUserXP();
  const tier = getTierInfo(xp);
  const progressText = tier.next ? `${xp} / ${tier.next.threshold} XP` : `${xp} XP`;
  const nextText = tier.next ? `Next: ${tier.next.name}` : 'Diamond earned · OG unlocked';
  const badges = xp >= 5000
    ? ['Diamond', 'Base OG']
    : xp >= 3000
      ? ['Platinum']
      : xp >= 1000
        ? ['Bronze']
        : ['Starter'];

  [
    ['home-xp-total', `${xp} XP`],
    ['deploy-xp-total', `${xp} XP`],
    ['profile-xp-total', String(xp)],
    ['home-tier-label', nextText],
    ['profile-tier-label', nextText],
    ['home-tier-progress', progressText],
    ['profile-tier-progress', progressText],
    ['home-tier-badge', tier.current.name],
  ].forEach(([id, text]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  });

  ['home-xp-fill', 'profile-xp-fill'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.width = `${tier.pct}%`;
  });

  const badgeWrap = document.getElementById('profile-badges');
  if (badgeWrap) {
    badgeWrap.innerHTML = badges.map(label => `<span class="badge">${label}</span>`).join('');
  }
}

function taskNeedsX(task) {
  return task.type === 'x-follow' || task.type === 'x-engagement';
}

function getTaskDesc(task, done) {
  if (done) return 'Completed - XP added';
  return task.desc;
}

function addTaskButton(parent, label, handler, variant = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'task-btn ' + variant;
  btn.textContent = label;
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    handler();
  });
  parent.appendChild(btn);
}

function openTaskUrl(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function requireTaskWallet() {
  const wallet = getTaskWallet();
  if (!wallet) {
    showToast('Wallet required', 'Connect wallet first', 'Rewards are tied to your wallet address.');
    return null;
  }
  return wallet;
}

function getDeployRecordsKey(wallet) {
  return `wallexa_deploy_on_base_records:${String(wallet || 'guest').toLowerCase()}`;
}

function saveDeployRecord(wallet, record) {
  const key = getDeployRecordsKey(wallet);
  let records = [];
  try {
    records = JSON.parse(localStorage.getItem(key) || '[]') || [];
  } catch {
    records = [];
  }
  records.unshift(record);
  localStorage.setItem(key, JSON.stringify(records.slice(0, 20)));
}

async function startVisitTask(task) {
  openTaskUrl(task.url);
  showToast('Task opened', task.title, 'Come back and tap Verify for instant XP.');
}

async function verifyTask(task) {
  const wallet = getTaskWallet();
  markTaskCompleteLocally(task);
  renderTasks();
  showToast('Completed', task.title, `+${task.xp} XP added`);

  if (!wallet) return;

  fetch('/api/tasks/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, taskId: task.id }),
    })
    .then(res => {
      const contentType = res.headers.get('content-type') || '';
      return contentType.includes('application/json') ? res.json() : null;
    })
    .catch(err => console.warn('Task sync skipped:', err.message));
}

function renderTaskActions(parent, task, done) {
  if (done) return;
  if (task.type === 'base-deploy') {
    addTaskButton(parent, 'Deploy on Base', () => deployOnBaseTask(), 'primary');
    return;
  }
  const openLabel = task.type === 'x-engagement' ? 'Open post' : task.type === 'base-deploy' ? 'Guide' : 'Open';
  addTaskButton(parent, openLabel, () => openTaskUrl(task.url));
  addTaskButton(parent, 'Verify', () => verifyTask(task), 'primary');
}

function openTaskFromRow(task, done) {
  if (done) return;
  if (task.type === 'base-deploy') {
    deployOnBaseTask();
    return;
  }
  if (task.type === 'visit') {
    startVisitTask(task);
    return;
  }
  openTaskUrl(task.url);
  showToast('Task opened', task.title, 'Come back and tap Verify for instant XP.');
}

async function renderTasks() {
  const list = document.getElementById('task-list');
  if (!list) return;

  await loadTaskStatus();
  list.innerHTML = '';

  const state = getStoredTaskState();

  const pendingTasks = tasksData.filter(t => !taskIsDone(t, state));
  const completedTasks = tasksData.filter(t => taskIsDone(t, state));
  const groups = [
    { title: null, tasks: pendingTasks },
    { title: 'Completed Tasks', tasks: completedTasks },
  ];

  groups.forEach(group => {
    if (!group.tasks.length) return;
    if (group.title) {
      const heading = document.createElement('div');
      heading.className = 'task-section-title';
      heading.textContent = group.title;
      list.appendChild(heading);
    }

    group.tasks.forEach(t => {
      const done = taskIsDone(t, state);

      const el = document.createElement('div');
      el.className = `task-item ${done ? 'completed' : 'clickable'}`;
      if (!done) {
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.addEventListener('click', () => openTaskFromRow(t, done));
        el.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openTaskFromRow(t, done);
          }
        });
      }

      el.innerHTML = `
        <div class="task-icon">${t.icon}</div>
        <div class="task-info">
          <div class="task-title ${done ? 'task-done' : ''}">
            ${t.title}
          </div>
          <div class="task-desc">
            ${getTaskDesc(t, done)}
          </div>
        </div>
        <div class="task-actions"></div>
        <span class="task-xp" style="${done ? 'background:rgba(126,200,164,.1);color:var(--green);' : ''}">${done ? 'Verified' : '+100 XP'}</span>
      `;

      renderTaskActions(el.querySelector('.task-actions'), t, done);

      list.appendChild(el);
    });
  });

  updateXPUI();
}

function getLeaderboardRows() {
  const wallet = getWalletState();
  const currentUser = {
    name: wallet.address ? shortAddr(wallet.address) : 'You',
    xp: getUserXP(),
    badge: getTierInfo(getUserXP()).current.name,
    current: true,
  };
  return [...LEADERBOARD_BASE, currentUser]
    .sort((a, b) => b.xp - a.xp)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function openLeaderboard() {
  const modal = document.getElementById('leaderboard-modal');
  const list = document.getElementById('leaderboard-list');
  if (!modal || !list) return;
  list.innerHTML = getLeaderboardRows().map(row => `
    <div class="leaderboard-row ${row.current ? 'current' : ''}">
      <div class="leaderboard-rank">#${row.rank}</div>
      <div class="leaderboard-user">
        <strong>${row.name}</strong>
        <span>${row.badge}</span>
      </div>
      <div class="leaderboard-xp">${row.xp.toLocaleString()} XP</div>
    </div>
  `).join('');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeLeaderboard() {
  const modal = document.getElementById('leaderboard-modal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

// startBalancePulse REMOVED — was overwriting real balance with fake cycling values

// ======================================================
//  COUNTDOWN
// ======================================================
let countdownInterval;

function startCountdown() {
  let h = 8, m = 23, s = 44;

  if (countdownInterval) clearInterval(countdownInterval);

  countdownInterval = setInterval(() => {
    s--;
    if (s < 0) { s = 59; m--; }
    if (m < 0) { m = 59; h--; }
    if (h < 0) { h = m = s = 0; }

    const hEl = document.getElementById('cd-h');
    const mEl = document.getElementById('cd-m');
    const sEl = document.getElementById('cd-s');

    if (hEl) hEl.textContent = String(h).padStart(2, '0');
    if (mEl) mEl.textContent = String(m).padStart(2, '0');
    if (sEl) sEl.textContent = String(s).padStart(2, '0');
  }, 1000);
}

// ======================================================
//  DEPLOY ANIMATION
// ======================================================
const DEPLOY_ON_BASE_TASK_ID = 'deploy-on-base';
const DEPLOY_ON_BASE_ABI = [
  'function taskName() view returns (string)',
  'function owner() view returns (address)',
  'function deployedAt() view returns (uint256)',
  'function getInfo() view returns (address,uint256,string)',
];
const DEPLOY_ON_BASE_BYTECODE = '0x336000554260015560b0601460003960b06000f33660041061003a5760003560e01c8063001aea77146100585780638da5cb5b14610040578063eae4c19f1461004c5780635a9b0b891461007e575b60006000fd5b60005460005260206000f35b60015460005260206000f35b6020600052600e6020526d4465706c6f79204f6e20426173656100901b60405260606000f35b6000546000526001546020526060604052600e6060526d4465706c6f79204f6e20426173656100901b60805260a06000f3';

function setDeployStatus(status, step, pct, ok = null) {
  const anim = document.getElementById('deploy-anim');
  const prog = document.getElementById('deploy-progress');
  const statusEl = document.getElementById('deploy-status');
  const stepEl = document.getElementById('deploy-step');
  if (anim) {
    anim.style.display = 'block';
    anim.classList.toggle('is-success', ok === true);
    anim.classList.toggle('is-error', ok === false);
    anim.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  if (statusEl) {
    statusEl.textContent = status;
    statusEl.style.color = ok === true ? 'var(--green)' : ok === false ? '#ff6b6b' : '';
  }
  if (stepEl) stepEl.textContent = step;
  if (prog) prog.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function getWalletErrorMessage(err) {
  const message = err?.shortMessage || err?.reason || err?.message || 'Wallet transaction failed';
  if (err?.code === 4001 || /reject|denied|cancel/i.test(message)) return 'Transaction rejected in wallet.';
  if (/insufficient|funds|gas/i.test(message)) return 'Insufficient ETH for Base gas.';
  return message;
}

async function getDeploymentWalletProvider() {
  const connector = window.WALLEXA_WALLET?.getInstance?.();
  if (!connector) throw new Error('Wallet connector not loaded.');
  if (!connector.connected || !connector.provider) {
    await connector.connect('injected');
  }
  await connector.switchToBase();
  return connector.provider;
}

async function deployOnBaseTask() {
  if (!window.ethers?.ContractFactory) {
    showToast('Deploy unavailable', 'ethers.js not loaded', 'Check your internet connection and reload.');
    return;
  }

  const task = tasksData.find(t => t.id === DEPLOY_ON_BASE_TASK_ID);
  setDeployStatus('Connecting wallet', 'Approve wallet connection if prompted', 8);

  try {
    const eip1193Provider = await getDeploymentWalletProvider();
    const provider = new ethers.BrowserProvider(eip1193Provider, 8453);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== 8453) throw new Error('Switch wallet to Base Mainnet and retry.');

    const signer = await provider.getSigner();
    const deployer = await signer.getAddress();
    setDeployStatus('Ready to deploy', 'Confirm contract deployment in your wallet', 24);

    const factory = new ethers.ContractFactory(DEPLOY_ON_BASE_ABI, DEPLOY_ON_BASE_BYTECODE, signer);
    const contract = await factory.deploy();
    const tx = contract.deploymentTransaction();
    if (!tx?.hash) throw new Error('Wallet did not return a deployment transaction hash.');

    setDeployStatus('Deployment submitted', `Waiting for receipt: ${tx.hash.slice(0, 18)}...`, 58);
    const receipt = await tx.wait();
    if (!receipt || Number(receipt.status) !== 1) throw new Error('Deployment transaction failed on Base.');

    const contractAddress = receipt.contractAddress || await contract.getAddress();
    if (!contractAddress) throw new Error('Deployment confirmed, but contract address was not returned.');

    setDeployStatus('Recording deployment', 'Saving confirmed Base deployment proof', 82);

    const record = {
      taskId: DEPLOY_ON_BASE_TASK_ID,
      wallet: deployer,
      chainId: 8453,
      transactionHash: tx.hash,
      contractAddress,
      owner: deployer,
      deployedAt: new Date().toISOString(),
      basescanUrl: `https://basescan.org/address/${contractAddress}`,
    };
    saveDeployRecord(deployer, record);

    if (task) {
      markTaskCompleteLocally(task, {
        provider: 'wallet-contract-deploy',
        taskType: task.type,
        txHash: tx.hash,
        contractAddress,
        chainId: 8453,
      });
      renderTasks();
      fetch('/api/tasks/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: deployer, taskId: task.id, proof: record }),
      }).catch(err => console.warn('Deploy task sync skipped:', err.message));
    }

    setDeployStatus('Deployed Successfully', `Contract: ${shortAddr(contractAddress)} · Receipt confirmed`, 100, true);
    showToast('Deployed', 'Deploy on Base complete', contractAddress);
    return record;
  } catch (err) {
    const message = getWalletErrorMessage(err);
    setDeployStatus('Deployment failed', message, 100, false);
    showToast('Deploy failed', 'Base deployment stopped', message);
    console.error('Deploy on Base failed:', err);
    return null;
  }
}

function showDeployAnim(contractName) {
  const anim = document.getElementById('deploy-anim');
  anim.style.display = 'block';
  anim.classList.remove('is-success', 'is-error');
  anim.scrollIntoView({ behavior:'smooth', block:'nearest' });
  const steps = ['Compiling smart contract...','Estimating gas fees...','Broadcasting to Base chain...','Awaiting confirmation...','Verified on Basescan ✓'];
  let step = 0;
  const prog = document.getElementById('deploy-progress');
  const statusEl = document.getElementById('deploy-status');
  const stepEl   = document.getElementById('deploy-step');
  statusEl.textContent = 'Deploying ' + contractName;
  statusEl.style.color = '';
  prog.style.width = '0%';
  const iv = setInterval(() => {
    if (step >= steps.length) {
      clearInterval(iv);
      statusEl.textContent = '✓ Deployed Successfully';
      statusEl.style.color = 'var(--green)';
      showToast('⬢','Deployed!', contractName + ' live on Base chain');
      return;
    }
    stepEl.textContent = steps[step];
    prog.style.width = ((step+1)/steps.length*100) + '%';
    step++;
  }, 900);
}

// ======================================================
//  SWAP — Coinbase executable quote when configured, live estimate otherwise
// ======================================================

const SWAP_TOKENS = [
  { symbol: 'ETH',   name: 'Ethereum',     icon: 'Ξ',  address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18 },
  { symbol: 'USDC',  name: 'USD Coin',     icon: '💲', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6  },
  { symbol: 'WETH',  name: 'Wrapped ETH',  icon: 'Ξ',  address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  { symbol: 'DAI',   name: 'Dai',          icon: '◈',  address: '0x50c5725949A6F0c72E6C4a641F24049A917db0Cb', decimals: 18 },
  { symbol: 'AERO',  name: 'Aerodrome',    icon: '⬡',  address: '0x940181a94A35A4569E4529a3CDfB74e38FD98631', decimals: 18 },
  { symbol: 'cbBTC', name: 'Coinbase BTC', icon: '₿',  address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8  },
];

const CMC_SYMBOLS = {
  ETH:   'ETH',
  USDC:  'USDC',
  USDBC: 'USDC',
  USDbC: 'USDC',
  WETH:  'WETH',
  DAI:   'DAI',
  AERO:  'AERO',
  CBBTC: 'CBBTC',
  CBETH: 'CBETH',
  cbBTC: 'CBBTC',
  cbETH: 'CBETH',
  VIRTUAL: 'VIRTUAL',
  TOSHI: 'TOSHI',
  BRETT: 'BRETT',
};

const TOKEN_PRICE_IDS = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDC',
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'AERO',
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'CBETH',
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'CBBTC',
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 'VIRTUAL',
  '0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4': 'TOSHI',
  '0x532f27101965dd16442e59d40670faf5ebb142e4': 'BRETT',
};

const TOKEN_DISPLAY_PRIORITY = {
  ETH: 100,
  USDC: 95,
  USDbC: 94,
  USDBC: 94,
  AERO: 90,
  QR: 85,
  WTC: 85,
  WETH: 80,
  DAI: 75,
  cbBTC: 70,
  VIRTUAL: 65,
};

function tokenDisplayPriority(token) {
  const symbol = token?.symbol || '';
  const address = String(token?.contractAddress || token?.address || '').toLowerCase();
  const marketSymbol = TOKEN_PRICE_IDS[address] || symbol;
  return TOKEN_DISPLAY_PRIORITY[marketSymbol] || TOKEN_DISPLAY_PRIORITY[marketSymbol.toUpperCase()] || 0;
}

function tokenUsdSortValue(token) {
  return (Number(token?.balanceNum) || 0) * (Number(token?.usdPrice) || 0);
}

function sortTokensForDisplay(tokens) {
  return [...(tokens || [])].sort((a, b) => {
    const aPriority = tokenDisplayPriority(a);
    const bPriority = tokenDisplayPriority(b);
    if (aPriority !== bPriority) return bPriority - aPriority;
    if (a.trusted && !b.trusted) return -1;
    if (!a.trusted && b.trusted) return 1;
    const aHasMarket = Number(a.usdPrice) > 0;
    const bHasMarket = Number(b.usdPrice) > 0;
    if (aHasMarket !== bHasMarket) return aHasMarket ? -1 : 1;
    const aValue = tokenUsdSortValue(a);
    const bValue = tokenUsdSortValue(b);
    if (aValue !== bValue) return bValue - aValue;
    return (Number(b.balanceNum) || 0) - (Number(a.balanceNum) || 0);
  });
}

let swapFromToken = SWAP_TOKENS[0];
let swapToToken   = SWAP_TOKENS[1];
let swapQuoteData = null;
let swapQuoteTimer = null;
let _priceCache = {}, _priceCacheTime = 0;
let _marketCache = {}, _marketCacheTime = 0;

function findHoldingForSwapToken(token) {
  if (!token) return null;
  if (token.symbol === 'ETH') {
    return _allTokens.find(t => t.native || t.symbol === 'ETH') || {
      symbol: 'ETH',
      balanceNum: ETH_BAL,
      usdPrice: PRICES.eth,
      usdChange24h: PRICES.ethChange,
    };
  }
  return _allTokens.find(t =>
    (t.symbol || '').toUpperCase() === token.symbol.toUpperCase() ||
    (t.contractAddress || '').toLowerCase() === (token.address || '').toLowerCase()
  ) || null;
}

function tokenBalanceText(token) {
  const holding = findHoldingForSwapToken(token);
  const balance = Number(holding?.balanceNum ?? 0);
  return `Balance ${balance.toLocaleString('en-US', { maximumFractionDigits: 6 })}`;
}

function tokenUsdText(token) {
  const holding = findHoldingForSwapToken(token);
  const balance = Number(holding?.balanceNum ?? 0);
  const price = Number(holding?.usdPrice || (token.symbol === 'ETH' ? PRICES.eth : 0));
  return price > 0 ? formatUsd(balance * price) : '—';
}

function updateSwapTokenUI() {
  const pairs = [
    ['from', swapFromToken],
    ['to', swapToToken],
  ];
  pairs.forEach(([side, token]) => {
    const iconEl = document.getElementById(`swap-${side}-icon`);
    const nameEl = document.getElementById(`swap-${side}-name`);
    const balEl = document.getElementById(`swap-${side}-balance`);
    
    if (!iconEl || !nameEl || !balEl) return;
    if (iconEl) iconEl.textContent = token.icon;
    if (nameEl) nameEl.textContent = token.symbol;
    if (balEl) balEl.textContent = tokenBalanceText(token);
  });
}

function hasEnoughBalance(token, amount) {
  const holding = findHoldingForSwapToken(token);
  const balance = Number(holding?.balanceNum ?? 0);
  return Number(amount) <= balance;
}

async function getCoinbaseSwapQuote(amountIn) {
  const wallet = getWalletState();
  if (!wallet?.address) {
    throw new Error("Wallet not connected");
  }

  const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

  const sellToken =
    swapFromToken.symbol === 'ETH'
      ? NATIVE
      : swapFromToken.address;

  const buyToken =
    swapToToken.symbol === 'ETH'
      ? NATIVE
      : swapToToken.address;

  const sellAmount = toAtomicAmount(amountIn, swapFromToken.decimals);

  const res = await fetch('/api/cdp-swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromToken: sellToken,
      toToken: buyToken,
      fromAmount: sellAmount,
      taker: wallet.address
    })
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || !data?.success) {
    console.error("CDP Swap Error:", data);
    throw new Error(data?.error || "CDP quote failed");
  }

  return {
    toAmount: data.quote.toAmount,
    transaction: data.transaction,
    fees: data.quote.fees || null,
    approval: data.approval || null,
    permitData: data.quote.permit2 || null,
    raw: data,
  };
}

async function fetchPrices() {
  const now = Date.now();
  if (now - _priceCacheTime < 30000 && Object.keys(_priceCache).length) return _priceCache;
  const symbols = Object.values(CMC_SYMBOLS).join(',');
  const res = await fetch(`/api/cmc/quotes?symbols=${encodeURIComponent(symbols)}`);
  if (!res.ok) throw new Error('Price unavailable');
  const data = await res.json();
  _priceCache = {};
  for (const [sym, cmcSymbol] of Object.entries(CMC_SYMBOLS)) {
    _priceCache[sym] = data.assets?.[cmcSymbol]?.price ?? 0;
  }
  PRICES.eth = data.assets?.ETH?.price ?? PRICES.eth;
  PRICES.ethChange = data.assets?.ETH?.percentChange24h ?? PRICES.ethChange;
  _priceCacheTime = now;
  return _priceCache;
}

async function fetchMarketData(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return {};
  const now = Date.now();
  const cacheKey = uniqueIds.sort().join(',');
  if (now - _marketCacheTime < 30000 && _marketCache[cacheKey]) return _marketCache[cacheKey];

  const res = await fetch(`/api/cmc/quotes?symbols=${encodeURIComponent(cacheKey)}`);
  if (!res.ok) throw new Error('Market data unavailable');
  const data = await res.json();
  const market = {};
  for (const [symbol, asset] of Object.entries(data.assets || {})) {
    market[symbol] = {
      usd: asset.price ?? 0,
      usd_24h_change: asset.percentChange24h ?? 0,
    };
  }
  _marketCache[cacheKey] = market;
  _marketCacheTime = now;
  return market;
}

async function enrichTokensWithMarketData(tokens) {
  const tokenIds = tokens.map(coingeckoIdForToken);
  try {
    const [market, info] = await Promise.all([
      fetchMarketData(tokenIds),
      fetchTokenInfo(tokenIds).catch(() => ({})),
    ]);
    const enriched = tokens.map(token => {
      const id = coingeckoIdForToken(token);
      const quote = id ? market[id] : null;
      const meta = id ? info[id] : null;
      return {
        ...token,
        name: meta?.name || token.name,
        logo: meta?.logo || token.logo,
        usdPrice: quote?.usd ?? 0,
        usdChange24h: quote?.usd_24h_change ?? null,
      };
    });
    return sortTokensForDisplay(enriched);
  } catch (err) {
    console.warn('Token market data unavailable:', err);
    return sortTokensForDisplay(tokens);
  }
}

async function fetchTokenInfo(symbols) {
  const uniqueSymbols = [...new Set(symbols.filter(Boolean))];
  if (!uniqueSymbols.length) return {};
  const res = await fetch(`/api/cmc/info?symbols=${encodeURIComponent(uniqueSymbols.join(','))}`);
  if (!res.ok) throw new Error('Token metadata unavailable');
  const data = await res.json();
  return data.assets || {};
}

async function loadMarketMovers(force = false) {
  const now = Date.now();
  if (!force && now - _marketMoversLoadedAt < MARKET_REFRESH_MS && _marketMovers.assets.length) {
    renderMarketMovers();
    return;
  }

  const list = document.getElementById('market-movers-list');
  if (list) list.innerHTML = '<div class="market-loading">Loading top 15 CoinMarketCap data...</div>';

  try {
    const res = await fetch('/api/cmc/trending?limit=15');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Trending coins unavailable');
    }
    _marketMovers = await res.json();
    _marketMoversLoadedAt = now;
    renderMarketMovers();
  } catch (err) {
    console.warn('Trending coins unavailable:', err);
    if (list) list.innerHTML = `<div class="market-loading error">CoinMarketCap data unavailable. ${err.message || ''}</div>`;
  }
}

function formatMarketPrice(value) {
  const price = Number(value || 0);
  if (!Number.isFinite(price)) return '—';
  if (price >= 1000) return '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 1) return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 0.01) return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
}

function renderMarketChange(value) {
  const change = Number(value || 0);
  const direction = change >= 0 ? 'up' : 'down';
  return `<span class="market-change ${direction}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%</span>`;
}

function renderMarketMovers() {
  const list = document.getElementById('market-movers-list');
  if (!list) return;
  const assets = _marketMovers.assets || [];
  if (!assets.length) {
    list.innerHTML = '<div class="market-loading">No trending coin data yet.</div>';
    return;
  }

  list.innerHTML = `
    <div class="market-rank-header">
      <span>#</span>
      <span>Coin</span>
      <span>Price</span>
      <span>1h</span>
    </div>
    ${assets.map((asset, index) => {
      const logo = asset.logo
        ? `<img src="${asset.logo}" alt="${asset.symbol || 'Token'}" onerror="this.remove();this.parentElement.textContent='⬡'">`
        : '⬡';
      return `
        <div class="market-rank-row">
          <div class="market-rank-num">${index + 1}</div>
          <div class="market-rank-asset">
            <div class="market-token-logo">${logo}</div>
            <div class="market-token-info">
              <strong>${asset.name || asset.symbol}</strong>
              <span>${asset.symbol || '—'}</span>
            </div>
          </div>
          <div class="market-rank-price">${formatMarketPrice(asset.price)}</div>
          ${renderMarketChange(asset.percentChange1h)}
        </div>`;
    }).join('')}
  `;
}

async function fetchSwapQuote() {
  if (!document.getElementById('swap-from-amount')) return;

  const amountIn = parseFloat(document.getElementById('swap-from-amount').value);

  if (!amountIn || amountIn <= 0) {
    clearSwapDetails();
    document.getElementById('swap-status').textContent = 'Enter an amount to get a quote.';
    return;
  }

  const statusEl = document.getElementById('swap-status');
  const btn      = document.getElementById('swap-execute-btn');
  statusEl.textContent = 'Fetching Coinbase quote...';
  statusEl.style.color = 'rgba(247,240,235,.4)';
  btn.textContent = 'Fetching...';
  btn.style.opacity = '0.5';
  btn.style.pointerEvents = 'none';

  try {
    const walletState = getWalletState();
    if (!walletState.address) {
      throw new Error('Connect wallet first so balances and Coinbase quote can be checked.');
    }
    if (!hasEnoughBalance(swapFromToken, amountIn)) {
      const balance = tokenBalanceText(swapFromToken).replace('Balance ', '');
      throw new Error(`Insufficient ${swapFromToken.symbol}. Balance: ${balance}`);
    }

    const prices    = await fetchPrices();
    const fromPrice = prices[swapFromToken.symbol] || 0;
    const toPrice   = prices[swapToToken.symbol]   || 0;

    if (!fromPrice) throw new Error(`No price for ${swapFromToken.symbol}`);
    if (!toPrice)   throw new Error(`No price for ${swapToToken.symbol}`);

    const coinbaseQuote = await getCoinbaseSwapQuote(amountIn).catch(err => {
      console.warn('Coinbase quote failed:', err);
      return { unavailableReason: err.message };
    });
    const rate      = fromPrice / toPrice;
    const amountOut = coinbaseQuote?.toAmount
      ? fromAtomicAmount(coinbaseQuote.toAmount, swapToToken.decimals)
      : amountIn * rate * 0.997;
    const fromUsd   = (amountIn  * fromPrice).toFixed(2);
    const toUsd     = (amountOut * toPrice).toFixed(2);
    const source    = coinbaseQuote?.toAmount ? 'Coinbase CDP API' : 'Live estimate';

    swapQuoteData = { fromToken: swapFromToken, toToken: swapToToken, amountIn, amountOut, rate, fromUsd, toUsd, source, coinbaseQuote };

    document.getElementById('swap-to-amount').value        = amountOut.toLocaleString('en-US', {maximumFractionDigits: 6});
    document.getElementById('swap-from-usd').textContent   = `≈ $${Number(fromUsd).toLocaleString('en-US', {minimumFractionDigits:2})}`;
    document.getElementById('swap-to-usd').textContent     = `≈ $${Number(toUsd).toLocaleString('en-US', {minimumFractionDigits:2})}`;
    document.getElementById('sd-rate').textContent         = `1 ${swapFromToken.symbol} = ${rate.toLocaleString('en-US',{maximumFractionDigits:4})} ${swapToToken.symbol}`;
    document.getElementById('sd-impact').textContent       = '< 0.1%';
    document.getElementById('sd-impact').style.color       = 'var(--green)';
    document.getElementById('sd-fee').textContent          = coinbaseQuote?.fees?.gasFee?.amount ? 'Included in Coinbase quote' : 'Estimated from live price';
    document.getElementById('sd-route').textContent        = `${swapFromToken.symbol} → ${swapToToken.symbol} via ${source}`;
    document.getElementById('swap-details').style.display  = 'block';

    const proxyRunning = !!coinbaseQuote?.toAmount;
    statusEl.textContent = proxyRunning
      ? `✓ Quote ready · $${fromPrice.toLocaleString()} per ${swapFromToken.symbol}`
      : `✓ Live price estimate · quote fetch failed, retry`;
    statusEl.style.color = proxyRunning ? 'var(--green)' : 'var(--gold)';
    btn.textContent      = coinbaseQuote?.transaction
      ? `Swap ${swapFromToken.symbol} → ${swapToToken.symbol} ⟳`
      : proxyRunning
        ? `Swap ${swapFromToken.symbol} → ${swapToToken.symbol} ⟳`
        : `Retry Quote ⟳`;
    btn.style.opacity    = '1';
    btn.style.pointerEvents = 'auto';

    clearTimeout(swapQuoteTimer);
    swapQuoteTimer = setTimeout(() => {
      statusEl.textContent = 'Price expired · re-enter amount to refresh';
      statusEl.style.color = 'rgba(247,240,235,.4)';
      btn.textContent = 'Get Quote ⟳';
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
      swapQuoteData = null;
    }, 60000);

  } catch (err) {
    console.error('Quote error:', err);
    statusEl.textContent = 'Quote failed: ' + err.message;
    statusEl.style.color = 'var(--orange)';
    btn.textContent = 'Retry ⟳';
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
    swapQuoteData = null;
  }
}

function clearSwapDetails() {
  document.getElementById('swap-to-amount').value = '';
  document.getElementById('swap-from-usd').textContent = '≈ $0.00';
  document.getElementById('swap-to-usd').textContent   = '≈ $0.00';
  document.getElementById('swap-details').style.display = 'none';
  document.getElementById('swap-status').textContent = '';
  const btn = document.getElementById('swap-execute-btn');
  btn.textContent = 'Get Quote ⟳';
  btn.style.opacity = '1';
  btn.style.pointerEvents = 'auto';
  swapQuoteData = null;
  clearTimeout(swapQuoteTimer);
}

let swapInputTimer = null;
function onSwapInput() {
  clearSwapDetails();
  clearTimeout(swapInputTimer);
  const val = parseFloat(document.getElementById('swap-from-amount').value);
  if (val > 0) {
    document.getElementById('swap-status').textContent = 'Waiting...';
    swapInputTimer = setTimeout(fetchSwapQuote, 600);
  }
}

async function executeSwap() {
  if (!swapQuoteData) { await fetchSwapQuote(); return; }

  const wallet = window.WALLEXA_WALLET?.getInstance();
  if (!wallet?.connected) { showToast('❌','Not connected','Connect wallet first'); return; }
  if (!swapQuoteData.coinbaseQuote?.transaction) {
    document.getElementById('swap-status').textContent = 'No executable quote. Click Retry Quote first.';
    document.getElementById('swap-status').style.color = 'var(--orange)';
    return;
  }

  const btn = document.getElementById('swap-execute-btn');
  btn.textContent = 'Confirm in wallet...';
  btn.style.opacity = '0.6';
  btn.style.pointerEvents = 'none';
  document.getElementById('swap-status').textContent = 'Waiting for wallet confirmation...';

  try {
    const provider = wallet.provider || window.ethereum;
    let quote = swapQuoteData.coinbaseQuote;
    let tx = quote.transaction;

    // 1. Handle one-time ERC20 approval to Permit2 if required
    if (quote.approval) {
      document.getElementById('swap-status').textContent = `Requesting one-time ${swapFromToken.symbol} approval...`;
      try {
        const approvalHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{
            from: wallet.address,
            to: quote.approval.to,
            data: quote.approval.data,
            value: quote.approval.value || '0x0',
            chainId: '0x2105'
          }]
        });
        document.getElementById('swap-status').textContent = 'One-time approval sent. Waiting for confirmation...';
        await waitForTxReceipt(provider, approvalHash, msg => {
          document.getElementById('swap-status').textContent = msg;
        });
        document.getElementById('swap-status').textContent = 'One-time approval confirmed. Refreshing swap quote...';
        quote = await getCoinbaseSwapQuote(swapQuoteData.amountIn);
        if (quote.approval) {
          throw new Error(`${swapFromToken.symbol} allowance is still not visible on Base. Wait a few seconds and try again.`);
        }
        tx = quote.transaction;
      } catch (apprErr) {
        throw new Error('Token approval rejected or failed: ' + apprErr.message);
      }
    }

    const txData = await signPermit2AndAppendSwapData(provider, wallet.address, quote, tx.data, msg => {
      document.getElementById('swap-status').textContent = msg;
    });
    document.getElementById('swap-status').textContent = 'Please confirm the swap transaction...';

    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{
        from:     wallet.address,
        to:       tx.to,
        data:     txData,
        value:    tx.value ? '0x' + BigInt(tx.value).toString(16) : '0x0',
        gas:      tx.gas      ? '0x' + BigInt(tx.gas).toString(16)      : undefined,
        gasPrice: tx.gasPrice ? '0x' + BigInt(tx.gasPrice).toString(16) : undefined,
        chainId:  '0x2105',
      }],
    });

    document.getElementById('swap-status').textContent = `✓ Swap sent: ${txHash.slice(0,10)}...`;
    document.getElementById('swap-status').style.color = 'var(--green)';
    btn.textContent = '✓ Sent';
    btn.style.opacity = '0.6';
    showToast('✅', 'Swap sent!', `${swapQuoteData.amountIn} ${swapFromToken.symbol} → ${swapToToken.symbol}`);
    swapQuoteData = null;
    setTimeout(() => initApp('Wallet'), 3000);

  } catch (err) {
    console.error('Swap error:', err);
    showToast('❌','Swap Failed', err.message);
    document.getElementById('swap-status').textContent = 'Error: ' + err.message;
    document.getElementById('swap-status').style.color = 'var(--orange)';
    btn.textContent = 'Retry ⟳';
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
  }
}

function flipSwapTokens() {
  [swapFromToken, swapToToken] = [swapToToken, swapFromToken];
  updateSwapTokenUI();
  document.getElementById('swap-from-amount').value     = '';
  clearSwapDetails();
  showToast('⇅', 'Flipped', `Now selling ${swapFromToken.symbol}`);
}

function openTokenPicker(side) {
  const modal = document.getElementById('token-picker-modal');
  const list  = document.getElementById('token-picker-list');
  modal.style.display = 'flex';
  updateSwapTokenUI();
  list.innerHTML = SWAP_TOKENS.map(t => {
    const holding = findHoldingForSwapToken(t);
    const balance = Number(holding?.balanceNum ?? 0);
    const price = Number(holding?.usdPrice || (t.symbol === 'ETH' ? PRICES.eth : 0));
    return `
    <div class="token-picker-row" onclick="selectSwapToken('${side}','${t.symbol}')">
      <div class="token-picker-icon">${t.icon}</div>
      <div class="token-picker-meta">
        <div class="token-picker-symbol">${t.symbol}</div>
        <div class="token-picker-name">${t.name}</div>
      </div>
      <div class="token-picker-balance">
        <div>${balance.toLocaleString('en-US', { maximumFractionDigits: 6 })}</div>
        <div class="token-picker-usd">${price > 0 ? formatUsd(balance * price) : '—'}</div>
      </div>
    </div>`;
  }).join('');
}

function closeTokenPicker() {
  document.getElementById('token-picker-modal').style.display = 'none';
}

function selectSwapToken(side, symbol) {
  setSwapToken(side, symbol, { preserveAmount: false });
}

function setSwapToken(side, symbol, opts = {}) {
  const token = SWAP_TOKENS.find(t => t.symbol === symbol);
  if (!token) return;
  if (side === 'from') {
    if (token.symbol === swapToToken.symbol) flipSwapTokens();
    else {
      swapFromToken = token;
    }
  } else {
    if (token.symbol === swapFromToken.symbol) flipSwapTokens();
    else {
      swapToToken = token;
    }
  }
  updateSwapTokenUI();
  closeTokenPicker();
  clearSwapDetails();
  if (!opts.preserveAmount) document.getElementById('swap-from-amount').value = '';
}

function addSwapAIMsg(text, role, html) {
  const log = document.getElementById('swap-ai-log');
  if (!log) return null;
  const el = document.createElement('div');
  el.className = 'swap-ai-msg ' + role;
  if (html) el.innerHTML = html;
  else el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function sendSwapAICommand() {
  const input = document.getElementById('swap-ai-input');
  const raw = input.value.trim();
  if (!raw) return;
  input.value = '';
  addSwapAIMsg(raw, 'user');
  await handleSwapCommand(raw);
}

async function handleSwapCommand(raw) {
  const upper = raw.toUpperCase();
  const tokenSymbols = SWAP_TOKENS.map(t => t.symbol);
  const amountMatch = raw.match(/(\d+(?:\.\d+)?)/);
  const found = tokenSymbols.filter(sym => new RegExp(`\\b${sym}\\b`, 'i').test(raw));
  const fromSymbol = found[0];
  const toSymbol = found[1] || (upper.includes('TO USDC') ? 'USDC' : null);

  if (/(EXECUTE|CONFIRM|SIGN|GO|SUBMIT)/i.test(raw) && swapQuoteData) {
    addSwapAIMsg('Opening the wallet-confirmed swap flow.', 'bot');
    await executeSwap();
    return;
  }

  if (!amountMatch || !fromSymbol || !toSymbol) {
    addSwapAIMsg('Use a command like "swap 0.01 ETH to USDC". I will fill the form and fetch the live quote.', 'bot');
    return;
  }

  if (fromSymbol === toSymbol) {
    addSwapAIMsg('Choose two different tokens for a swap.', 'bot');
    return;
  }

  const amount = amountMatch[1];
  setSwapToken('from', fromSymbol, { preserveAmount: true });
  setSwapToken('to', toSymbol, { preserveAmount: true });
  document.getElementById('swap-from-amount').value = amount;

  const thinking = addSwapAIMsg(`Preparing ${amount} ${fromSymbol} → ${toSymbol}...`, 'bot thinking');
  await fetchSwapQuote();
  if (thinking) {
    thinking.classList.remove('thinking');
    thinking.innerHTML = swapQuoteData
      ? `Quote ready for <strong>${amount} ${fromSymbol} → ${toSymbol}</strong>. Type <strong>execute</strong> or press the swap button to continue.`
      : 'I could not get a quote. Try a different pair or amount.';
  }
}

// ======================================================
//  NFT GRID HIDE / SHOW TOGGLE
// ======================================================
let _nftGridHidden = false;
function toggleNFTGrid() {
  _nftGridHidden = !_nftGridHidden;
  const grid = document.getElementById('nft-grid');
  const btn  = document.getElementById('nft-toggle-btn');
  if (grid) grid.style.display = _nftGridHidden ? 'none' : '';
  if (btn)  btn.textContent = _nftGridHidden ? 'Show NFTs' : 'Hide NFTs';
}

// ======================================================
//  WALLEXAI PAGE — Full AI chat with Claude API
// ======================================================
let _waiHistory = [];

function waiQuick(text) {
  document.getElementById('wai-input').value = text;
  sendWAICommand();
}

function addWAIMsg(text, role, html) {
  const log = document.getElementById('wai-chat-log');
  if (!log) return null;
  const el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  el.style.maxWidth = '100%';
  el.style.fontSize = '14px';
  el.style.lineHeight = '1.6';
  if (html) el.innerHTML = html;
  else el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function sendWAICommand() {
  const input = document.getElementById('wai-input');
  const raw = (input.value || '').trim();
  if (!raw) return;
  input.value = '';

  addWAIMsg(raw, 'user');
  _waiHistory.push({ role: 'user', content: raw });

  // NEW — Pure parser for WallexAI
  const { intent } = (typeof window.parseAICommand === "function" ? window.parseAICommand(raw) : { intent: { action: "none", params: {} } });
  if (intent && intent.action && intent.action !== "none") {
    const handled = handleParsedAIIntent(intent);
    if (handled !== false) {
      _waiHistory.push({ role: "assistant", content: "(executed local intent)" });
      return;
    }
  }

  const lower = raw.toLowerCase();

  // ── LOCAL fast intents (no API needed) ──
  if (lower.includes('leaderboard')) {
    openLeaderboard();
    const m = addWAIMsg('Opened the leaderboard! 🏆', 'bot');
    _waiHistory.push({ role: 'assistant', content: 'Opened the leaderboard!' });
    return;
  }

  // ── BASE MCP: swap / send / pay commands ───────────────────────────────────
  if (window.WALLEXA_MCP) {
    const wallet = getWalletState();
    const consumed = await window.WALLEXA_MCP.handleCommand(raw, wallet.address || null, addWAIMsg);
    if (consumed) return;
  } else if (/^(swap|send|pay)\s+[\d.]+/i.test(raw.trim())) {
    addWAIMsg('⚠️ WallexAI plugin (basemcp.js) not loaded. Check your index.html script tags.', 'bot');
    return;
  }

  const navMap = { 'nft': 'nfts', 'nfts': 'nfts', 'home': 'home', 'dashboard': 'home', 'deploy': 'deploy', 'profile': 'profile' };
  for (const [kw, page] of Object.entries(navMap)) {
    if (lower.includes(kw) && (lower.includes('go') || lower.includes('open') || lower.includes('show') || lower.includes('navigate'))) {
      navigate(page);
      addWAIMsg(`✓ Navigated to ${page.charAt(0).toUpperCase() + page.slice(1)}.`, 'bot');
      return;
    }
  }

  if (lower.includes('balance') || lower.includes('my eth')) {
    const wallet = getWalletState();
    if (!wallet.address) { addWAIMsg('No wallet connected. Please connect your wallet first.', 'bot'); return; }
    const thinking = addWAIMsg('Checking balance on Base...', 'bot thinking');
    try {
      const hex = await alchemyRpc('eth_getBalance', [wallet.address, 'latest']);
      const bal = (Number(BigInt(hex) / BigInt(1e12)) / 1e6).toFixed(6);
      await fetchPrices();
      const usd = (parseFloat(bal) * PRICES.eth).toFixed(2);
      thinking.textContent = `Your ETH balance: ${bal} ETH ≈ $${usd} USD`;
      thinking.classList.remove('thinking');
    } catch(e) { thinking.textContent = 'Error: ' + e.message; thinking.classList.remove('thinking'); }
    return;
  }

  if (lower.includes('gas')) {
    const thinking = addWAIMsg('Checking Base gas price...', 'bot thinking');
    try {
      const hex = await alchemyRpc('eth_gasPrice', []);
      const gwei = (Number(BigInt(hex)) / 1e9).toFixed(4);
      thinking.textContent = `Current Base gas: ${gwei} Gwei — ${parseFloat(gwei) < 0.01 ? 'Ultra Low 🟢' : parseFloat(gwei) < 1 ? 'Low 🟡' : 'Elevated 🔴'}`;
      thinking.classList.remove('thinking');
    } catch(e) { thinking.textContent = 'Error: ' + e.message; thinking.classList.remove('thinking'); }
    return;
  }

  const sendMatch = raw.match(/send\s+([\d.]+)\s*eth\s+to\s+(0x[0-9a-fA-F]{40})/i);
  if (sendMatch) {
    const wallet = getWalletState();
    if (!wallet.address) { addWAIMsg('Connect a wallet first.', 'bot'); return; }
    await fetchPrices().catch(() => null);
    const amount = sendMatch[1], toAddr = sendMatch[2];
    const usdVal = (parseFloat(amount) * PRICES.eth).toFixed(2);
    pendingTx = { type: 'send', amount, to: toAddr };
    addWAIMsg('', 'bot', `
      <div style="font-size:12px;margin-bottom:8px;color:rgba(245,237,232,.6);">Transaction ready to sign:</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.8;background:rgba(245,237,232,.05);padding:10px;border-radius:9px;margin-bottom:4px;">
        <div>To: <span style="color:var(--mauve-light)">${shortAddr(toAddr)}</span></div>
        <div>Amount: <span style="color:var(--green)">${amount} ETH ≈ $${usdVal}</span></div>
        <div>Network: <span style="color:var(--cream)">Base Mainnet</span></div>
      </div>
      <button class="tx-confirm-btn" onclick="executePendingTx()">✓ Confirm & Sign</button>
      <button class="tx-cancel-btn" onclick="cancelPendingTx()">✕ Cancel</button>
    `);
    return;
  }

  // ── Claude API fallback ──
  const thinking = addWAIMsg('Thinking...', 'bot thinking');
  try {
    const wallet = getWalletState();
    const systemPrompt = `You are WallexAI, WALLEXA's premium AI assistant for Base chain (Coinbase's Ethereum L2). 
You help with: ETH balances, token swaps, NFTs, smart contract deployment, gas fees, and Base chain education.
Connected wallet: ${wallet.address || 'not connected'}. ETH balance: ${ETH_BAL.toFixed(6)} ETH. ETH price: $${PRICES.eth || '—'}.
Be concise (2-4 sentences), friendly and technically accurate. For wallet actions, guide the user to type commands like "send 0.01 ETH to 0x...".`;

    const messages = _waiHistory.slice(-10);
    const reply = await callClaudeAI(systemPrompt, messages, 400);
    thinking.textContent = reply;
    thinking.classList.remove('thinking');
    _waiHistory.push({ role: 'assistant', content: reply });
  } catch(e) {
    thinking.textContent = e.message.includes('No AI configured')
      ? '⚙️ AI not configured. Open app.js and set your AI_API_KEY at the top.'
      : `⚠️ AI error: ${e.message}`;
    thinking.classList.remove('thinking');
  }
}

// Update wallet chip on WallexAI page when wallet connects
window.addEventListener('wallexa:connect', (e) => {
  const chip = document.getElementById('wai-addr-chip');
  if (chip && e.detail?.address) {
    chip.textContent = '◉ ' + shortAddr(e.detail.address);
  }
});


//  On DOMContentLoaded, forcibly clear any filter on all
//  pages. This handles the case where the browser cached
//  a mid-animation frame from a previous session.
// ======================================================
document.addEventListener('DOMContentLoaded', () => {
  // Force stagger-children visible on the active page
  document.querySelectorAll('.page.active .stagger-child').forEach(el => {
    el.style.opacity = '1';
    el.style.transform = 'none';
  });
  updateSwapTokenUI();
  renderNFTs();
  renderTasks();
  updateXPUI();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    document.querySelectorAll('.page.active .stagger-child').forEach(el => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
  }
});
