'use strict';

// ══════════════════════════════════════════════════════════════════
//  WALLEXA basemcp.js  —  Smart Wallet Command Layer
//  RULES:
//  • Works with Smart Wallets and standard EVM wallets for direct sends
//  • Always asks user permission before executing ANY action
//  • No action fires without explicit "yes" / "confirm" from user
// ══════════════════════════════════════════════════════════════════

const BASE_CHAIN_ID = '0x2105'; // Base Mainnet 8453
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const BASE_TOKENS = {
  ETH:   { symbol: 'ETH',   address: NATIVE_ETH,                                      decimals: 18 },
  USDC:  { symbol: 'USDC',  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',    decimals: 6  },
  WETH:  { symbol: 'WETH',  address: '0x4200000000000000000000000000000000000006',    decimals: 18 },
  DAI:   { symbol: 'DAI',   address: '0x50c5725949A6F0c72E6C4a641F24049A917db0Cb',    decimals: 18 },
  AERO:  { symbol: 'AERO',  address: '0x940181a94A35A4569E4529a3CDfB74e38FD98631',    decimals: 18 },
  CBBTC: { symbol: 'CBBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',    decimals: 8  },
};

// ─────────────────────────────────────────────────────────────────
//  SMART WALLET DETECTION
//  Returns true only if the connected wallet supports EIP-5792
//  (Coinbase Smart Wallet, Safe, etc.)
// ─────────────────────────────────────────────────────────────────
function getActiveProvider() {
  return window.WALLEXA_WALLET?.getInstance?.()?.provider || window.ethereum;
}

function getWalletConnectorState() {
  return window.WALLEXA_WALLET?.getInstance?.()?.getState?.() || {};
}

function getCommandWalletAddress(fallback) {
  const walletState = getWalletConnectorState();
  if (walletState?.walletType === 'base-smart-wallet') {
    return walletState.appAccountAddress || walletState.address || fallback;
  }
  return fallback || walletState.address;
}

async function isSmartWallet() {
  const provider = getActiveProvider();
  const walletState = getWalletConnectorState();
  if (walletState?.walletType === 'base-smart-wallet') return true;
  if (!provider) return false;
  try {
    // EIP-5792: wallet_getCapabilities — only smart wallets respond
    const caps = await provider.request({
      method: 'wallet_getCapabilities',
      params: [],
    });
    return !!caps; // any truthy response = smart wallet
  } catch (e) {
    // 4200 = method not supported (EOA / MetaMask regular)
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
//  PERMISSION STATE
//  Tracks whether user has granted WallexAI plugin permission
//  for this session. Reset on page reload.
// ─────────────────────────────────────────────────────────────────
const _mcpState = {
  permissionGranted: false,
  pendingIntent: null,   // intent waiting for confirmation
};

function walletPermissionKey(wallet) {
  return `wallexa_mcp_permission_v1_${String(wallet || '').toLowerCase()}`;
}

function hasStoredWallexaPermission(wallet) {
  try {
    return localStorage.getItem(walletPermissionKey(wallet)) === 'granted';
  } catch {
    return false;
  }
}

function storeWallexaPermission(wallet, granted) {
  try {
    const key = walletPermissionKey(wallet);
    if (granted) localStorage.setItem(key, 'granted');
    else localStorage.removeItem(key);
  } catch {
    // Some browsers can block localStorage. Session permission still works.
  }
}

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
function toAtomic(amount, decimals) {
  const [w, f = ''] = String(amount).split('.');
  const padded = (f + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(w || '0') * (10n ** BigInt(decimals)) + BigInt(padded || '0')).toString();
}

function toHex(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && value.startsWith('0x')) return value;
  return '0x' + BigInt(value).toString(16);
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

function getPermit2TypedData(swapData) {
  return swapData?.quote?.permit2?.eip712 || swapData?.permit2?.eip712 || null;
}

async function signPermit2AndAppendData(provider, wallet, swapData, txData, cb = {}) {
  const typedData = getPermit2TypedData(swapData);
  if (!typedData) return txData || '0x';

  const walletState = getWalletConnectorState();
  const usingAppAccount = walletState?.appAccountAddress && walletState.appAccountAddress.toLowerCase() === String(wallet).toLowerCase();
  cb.onStatus?.(usingAppAccount
    ? 'Authorizing swap with WallexAI app account…'
    : 'Sign Permit2 authorization for token swap…');
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [wallet, JSON.stringify(typedData)],
  });

  const signatureLength = '0x' + uint256Hex(byteLengthHex(signature));
  return concatHex([txData || '0x', signatureLength, signature]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatAtomic(value, decimals, maxDigits = 6) {
  const raw = BigInt(value || '0');
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const trimmed = fraction ? fraction.slice(0, maxDigits) : '';
  return `${whole}${trimmed ? '.' + trimmed : ''}`;
}

async function getTokenBalanceAtomic(wallet, token) {
  try {
    const res = await fetch(`/api/token-balance?owner=${encodeURIComponent(wallet)}&token=${encodeURIComponent(token.address)}`);
    const data = await res.json().catch(() => ({}));
    if (res.ok) return BigInt(data.balance || '0');
    console.warn(`Server balance check failed for ${token.symbol}:`, data.error || res.status);
  } catch (err) {
    console.warn(`Server balance check unavailable for ${token.symbol}:`, err.message);
  }

  const provider = getActiveProvider();
  if (!provider) throw new Error(`Could not check ${token.symbol} balance`);

  if (token.address.toLowerCase() === NATIVE_ETH.toLowerCase()) {
    const hex = await provider.request({ method: 'eth_getBalance', params: [wallet, 'latest'] });
    return BigInt(hex || '0x0');
  }

  const data =
    '0x70a08231' +
    wallet.replace(/^0x/, '').padStart(64, '0');
  const hex = await provider.request({
    method: 'eth_call',
    params: [{ to: token.address, data }, 'latest'],
  });
  return BigInt(hex || '0x0');
}

async function requestSwapQuote(intent, wallet, sellAmount) {
  const walletState = getWalletConnectorState();
  const res = await fetch('/api/cdp-swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromToken:     intent.fromAddress,
      toToken:       intent.toAddress,
      fromAmount:    sellAmount,
      taker:         wallet,
      signerAddress: wallet,
      slippageBps:   100,
      allowSpendPermissionFlow: walletState?.walletType === 'base-smart-wallet',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Swap API error (${res.status})`);
  if (!data.success || !data.transaction) {
    throw new Error(data.error || 'No swap transaction returned from server');
  }
  return data;
}

async function waitForReceipt(txHash, cb = {}) {
  const provider = getActiveProvider();
  if (!provider) throw new Error('No wallet found');
  for (let i = 0; i < 30; i++) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    if (receipt) return receipt;
    cb.onStatus?.('Waiting for confirmation...');
    await sleep(2000);
  }
  throw new Error('Transaction not confirmed yet. Try again after it confirms.');
}

function normalizeTokenSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s === 'BTC') return 'CBBTC';
  if (s === 'WTH') return 'WETH';
  return s;
}

function hydrateSwapIntent(intent) {
  const fromToken = BASE_TOKENS[normalizeTokenSymbol(intent.fromToken)];
  const toToken   = BASE_TOKENS[normalizeTokenSymbol(intent.toToken)];
  if (!fromToken || !toToken) throw new Error(`Unsupported token pair: ${intent.fromToken} → ${intent.toToken}. Supported: ETH, USDC, WETH, DAI, AERO, CBBTC`);
  if (fromToken.symbol === toToken.symbol) throw new Error('Choose two different tokens to swap.');
  return { ...intent, fromToken: fromToken.symbol, toToken: toToken.symbol, fromAddress: fromToken.address, toAddress: toToken.address, fromDecimals: fromToken.decimals, toDecimals: toToken.decimals };
}

function hydrateSendIntent(intent) {
  const token = BASE_TOKENS[normalizeTokenSymbol(intent.token)];
  if (!token) throw new Error(`Unsupported token: ${intent.token}. Supported: ${Object.keys(BASE_TOKENS).join(', ')}`);
  return { ...intent, token: token.symbol, tokenAddress: token.address, decimals: token.decimals };
}

async function resolveRecipient(to) {
  if (/^0x[a-f0-9]{40}$/i.test(to)) return to;
  const res = await fetch(`/api/resolve-name?name=${encodeURIComponent(to)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.address) throw new Error(data.error || `Could not resolve ${to}`);
  return data.address;
}

async function ensureBaseChain(provider) {
  const chainId = await provider.request({ method: 'eth_chainId' }).catch(() => null);
  if (String(chainId).toLowerCase() === BASE_CHAIN_ID.toLowerCase()) return;
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: BASE_CHAIN_ID }],
  });
}

// ─────────────────────────────────────────────────────────────────
//  COMMAND PARSER
// ─────────────────────────────────────────────────────────────────
function parseMCPCommand(raw) {
  const s = raw.toLowerCase().trim();

  // Permission grant: "yes", "confirm", "ok", "allow", "grant"
  if (/^(yes|confirm|ok|allow|grant|sure|proceed|go ahead)[\s!.]*$/.test(s)) {
    return { action: 'confirm_permission' };
  }

  // Permission revoke
  if (/^(no|deny|cancel|revoke|stop|refuse)[\s!.]*$/.test(s)) {
    return { action: 'deny_permission' };
  }

  // Confirm pending tx
  if (/^(execute|yes|confirm|sign|send it|do it)[\s!.]*$/.test(s) && _mcpState.pendingIntent) {
    return { action: 'execute_pending' };
  }

  // Swap: "swap 0.01 eth to usdc"
  const swapMatch = s.match(/swap\s+([\d.]+)\s*([a-z0-9]+)\s+(?:to|for)\s+([a-z0-9]+)/i);
  if (swapMatch) {
    return { action: 'swap', amount: swapMatch[1], fromToken: swapMatch[2].toUpperCase(), toToken: swapMatch[3].toUpperCase() };
  }

  // Send: "send 0.1 eth to 0xabc"
  const sendMatch = s.match(/send\s+([\d.]+)\s*([a-z0-9]+)\s+to\s+([a-z0-9.-]+(?:\.eth)?|0x[a-f0-9]{40})/i);
  if (sendMatch) {
    return { action: 'send', amount: sendMatch[1], token: sendMatch[2].toUpperCase(), to: sendMatch[3] };
  }

  // Pay USDC: "pay 5 usdc to 0xabc"
  const payMatch = s.match(/pay\s+([\d.]+)\s*usdc\s+to\s+([a-z0-9.-]+(?:\.eth)?|0x[a-f0-9]{40})/i);
  if (payMatch) {
    return { action: 'pay', amount: payMatch[1], to: payMatch[2] };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────
//  SWAP via CDP Swap API (server-side)
// ─────────────────────────────────────────────────────────────────
async function executeSwapViaBase(intent, wallet, cb = {}) {
  const { onStatus, onSuccess, onError } = cb;
  const provider = getActiveProvider();
  if (!provider) return onError?.('No wallet found');

  try {
    intent = hydrateSwapIntent(intent);
    onStatus?.(`Getting quote for ${intent.amount} ${intent.fromToken} → ${intent.toToken}…`);

    const sellAmount = toAtomic(intent.amount, intent.fromDecimals);
    const sellAmountAtomic = BigInt(sellAmount);
    const walletState = getWalletConnectorState();
    if (walletState?.walletType !== 'base-smart-wallet') {
      const fromBalance = await getTokenBalanceAtomic(wallet, BASE_TOKENS[intent.fromToken]);
      if (fromBalance < sellAmountAtomic) {
        const balanceText = formatAtomic(fromBalance, intent.fromDecimals);
        const hint = intent.fromToken !== 'ETH'
          ? ` You have ETH for gas, but this command sells ${intent.fromToken}. Try swapping a smaller ${intent.fromToken} amount, or use "swap 0.0003 ETH to ${intent.toToken}" if you want to sell ETH.`
          : ' Try a smaller ETH amount so you keep enough ETH for gas.';
        throw new Error(`Insufficient ${intent.fromToken}. Balance: ${balanceText} ${intent.fromToken}; required: ${intent.amount} ${intent.fromToken}.${hint}`);
      }
    }

    let data = await requestSwapQuote(intent, wallet, sellAmount);

    // ERC-20 approval if needed
    if (data.approval) {
      onStatus?.(`Approve ${intent.fromToken} once for future swaps…`);
      const approvalHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: wallet, to: data.approval.to, data: data.approval.data, value: data.approval.value || '0x0', chainId: BASE_CHAIN_ID }],
      });
      onStatus?.('Approval submitted, waiting for confirmation…');
      await waitForReceipt(approvalHash, cb);
      onStatus?.('One-time approval confirmed. Refreshing swap quote…');
      data = await requestSwapQuote(intent, wallet, sellAmount);
      if (data.approval) {
        throw new Error(`${intent.fromToken} allowance is still not visible on Base. Wait a few seconds and try again.`);
      }
    }

    onStatus?.('Confirm swap transaction in wallet…');

    const tx = data.transaction;
    const txData = await signPermit2AndAppendData(provider, wallet, data, tx.data, cb);
    const txHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{
        from:     wallet,
        to:       tx.to,
        data:     txData,
        value:    toHex(tx.value) || '0x0',
        gas:      toHex(tx.gas),
        gasPrice: toHex(tx.gasPrice),
        chainId:  BASE_CHAIN_ID,
      }],
    });

    onSuccess?.(txHash, data);

  } catch (e) {
    onError?.(e.message || 'Swap failed');
  }
}

// ─────────────────────────────────────────────────────────────────
//  SEND ETH or ERC-20 Token directly (no server needed)
// ─────────────────────────────────────────────────────────────────
async function executeSendDirect(intent, wallet, cb = {}) {
  const { onStatus, onSuccess, onError } = cb;
  const provider = getActiveProvider();
  if (!provider) return onError?.('No wallet found');

  try {
    await ensureBaseChain(provider);
    intent = hydrateSendIntent(intent);
    const originalTo = intent.to;
    intent.to = await resolveRecipient(intent.to);
    onStatus?.(`Sending ${intent.amount} ${intent.token} to ${originalTo === intent.to ? intent.to.slice(0,6) : originalTo}…`);

    const amountAtomic = toAtomic(intent.amount, intent.decimals);
    let txHash;

    if (intent.token === 'ETH') {
      // Native ETH transfer — no server needed
      txHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: wallet, to: intent.to, value: toHex(amountAtomic), chainId: BASE_CHAIN_ID }],
      });
    } else {
      // ERC-20 transfer(address,uint256)
      const data =
        '0xa9059cbb' +
        intent.to.replace('0x', '').padStart(64, '0') +
        BigInt(amountAtomic).toString(16).padStart(64, '0');

      txHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: wallet, to: intent.tokenAddress, data, value: '0x0', chainId: BASE_CHAIN_ID }],
      });
    }

    onSuccess?.(txHash, intent);

  } catch (e) {
    onError?.(e.message || 'Send failed');
  }
}

// ─────────────────────────────────────────────────────────────────
//  MAIN HANDLER — called from app.js
//  Flow:
//   1. Detect smart wallet — if not, refuse
//   2. If no permission yet — show permission prompt, store intent
//   3. If permission granted — show tx preview card, wait for confirm
//   4. On "execute" — fire the transaction
// ─────────────────────────────────────────────────────────────────
const WALLEXA_MCP = {
  parseMCPCommand,
  BASE_TOKENS,
  executeSwapViaBase,
  executeSendDirect,

  // Reset permission (on wallet disconnect)
  resetPermission() {
    _mcpState.permissionGranted = false;
    _mcpState.pendingIntent = null;
  },

  async handleCommand(raw, wallet, addMsg) {
    const intent = parseMCPCommand(raw);
    if (!intent) return false; // not an MCP command
    wallet = getCommandWalletAddress(wallet);

    // ── Wallet required ─────────────────────────────────────────
    if (!wallet) {
      addMsg('🔗 Connect your wallet first before using commands.', 'bot');
      return true;
    }

    if (!_mcpState.permissionGranted && hasStoredWallexaPermission(wallet)) {
      _mcpState.permissionGranted = true;
    }

    // ── Handle confirm/deny permission ─────────────────────────
    if (intent.action === 'confirm_permission') {
      if (!_mcpState.pendingIntent) {
        addMsg('Nothing pending. Try a command like "swap 0.01 ETH to USDC".', 'bot');
        return true;
      }
      _mcpState.permissionGranted = true;
      storeWallexaPermission(wallet, true);
      const pi = _mcpState.pendingIntent;
      _mcpState.pendingIntent = null;
      addMsg('✅ WallexAI permission saved for this wallet. Preparing transaction…', 'bot');
      await WALLEXA_MCP._executeIntent(pi, wallet, addMsg);
      return true;
    }

    if (intent.action === 'deny_permission') {
      _mcpState.permissionGranted = false;
      _mcpState.pendingIntent = null;
      storeWallexaPermission(wallet, false);
      addMsg('❌ Permission denied. No action will be taken.', 'bot');
      return true;
    }

    // ── Execute pending tx ──────────────────────────────────────
    if (intent.action === 'execute_pending') {
      if (!_mcpState.pendingIntent) {
        addMsg('No pending transaction. Send a command first.', 'bot');
        return true;
      }
      const pi = _mcpState.pendingIntent;
      _mcpState.pendingIntent = null;
      await WALLEXA_MCP._executeIntent(pi, wallet, addMsg);
      return true;
    }

    // ── Actionable commands ─────────────────────────────────────
    if (['swap', 'send', 'pay'].includes(intent.action)) {

      if (!_mcpState.permissionGranted) {
        // Store intent, ask for permission first
        _mcpState.pendingIntent = intent;
        addMsg('', 'bot', `
          <div style="font-size:13px;margin-bottom:10px;">
            <strong>🔐 WallexAI Plugin Access Request</strong><br>
            <span style="color:rgba(245,237,232,.6);font-size:12px;">WallexAI wants permission to prepare wallet transactions for this connected wallet.</span>
          </div>
          <div style="font-size:12px;background:rgba(245,237,232,.05);border-radius:8px;padding:10px;margin-bottom:10px;font-family:'JetBrains Mono',monospace;line-height:1.8;">
            <div>Action: <strong>${intent.action.toUpperCase()}</strong></div>
            ${intent.amount ? `<div>Amount: <strong>${intent.amount} ${intent.fromToken || intent.token || 'USDC'}</strong></div>` : ''}
            ${intent.toToken ? `<div>To token: <strong>${intent.toToken}</strong></div>` : ''}
            ${intent.to ? `<div>Recipient: <strong>${intent.to.slice(0,6)}…${intent.to.slice(-4)}</strong></div>` : ''}
          </div>
          <div style="font-size:11px;color:rgba(245,237,232,.4);margin-bottom:10px;">
            Type <strong>yes</strong> once to remember this permission for this wallet, or <strong>no</strong> to deny.
          </div>
        `);
        return true;
      }

      // Permission already granted — show preview card then execute
      await WALLEXA_MCP._executeIntent(intent, wallet, addMsg);
      return true;
    }

    return false;
  },

  // Internal: show preview + execute
  async _executeIntent(intent, wallet, addMsg) {
    if (intent.action === 'swap') {
      const el = addMsg('', 'bot');
      await executeSwapViaBase(intent, wallet, {
        onStatus: m => { if (el) el.textContent = m; },
        onSuccess: (hash) => {
          if (el) el.innerHTML = `✅ Swap submitted!<br><a href="https://basescan.org/tx/${hash}" target="_blank" style="color:var(--mauve-light);font-size:11px;font-family:'JetBrains Mono',monospace;">${hash.slice(0,18)}… →</a>`;
        },
        onError: m => { if (el) el.textContent = `❌ Swap failed: ${m}`; },
      });
      return;
    }

    if (intent.action === 'send') {
      const el = addMsg('', 'bot');
      await executeSendDirect(intent, wallet, {
        onStatus: m => { if (el) el.textContent = m; },
        onSuccess: (hash) => {
          if (el) el.innerHTML = `✅ Sent!<br><a href="https://basescan.org/tx/${hash}" target="_blank" style="color:var(--mauve-light);font-size:11px;font-family:'JetBrains Mono',monospace;">${hash.slice(0,18)}… →</a>`;
        },
        onError: m => { if (el) el.textContent = `❌ Send failed: ${m}`; },
      });
      return;
    }

    if (intent.action === 'pay') {
      // Pay = USDC send
      const el = addMsg('', 'bot');
      await executeSendDirect(
        { action: 'send', amount: intent.amount, token: 'USDC', to: intent.to },
        wallet,
        {
          onStatus: m => { if (el) el.textContent = m; },
          onSuccess: (hash) => {
            if (el) el.innerHTML = `✅ Payment sent!<br><a href="https://basescan.org/tx/${hash}" target="_blank" style="color:var(--mauve-light);font-size:11px;font-family:'JetBrains Mono',monospace;">${hash.slice(0,18)}… →</a>`;
          },
          onError: m => { if (el) el.textContent = `❌ Payment failed: ${m}`; },
        }
      );
    }
  },
};

window.WALLEXA_MCP = WALLEXA_MCP;

// Reset permission when wallet disconnects
window.addEventListener('wallexa:disconnect', () => WALLEXA_MCP.resetPermission());
window.addEventListener('wallexa:accountsChanged', () => WALLEXA_MCP.resetPermission());
