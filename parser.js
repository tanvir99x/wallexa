/**
 * WALLEXA Pure Command Parser (FIXED v2)
 */

function parseAICommand(raw) {
  if (!raw || typeof raw !== "string") {
    return { intent: { action: "none", params: {} }, raw };
  }

  const lower = raw.toLowerCase().trim();

  const ETH_ADDRESS = /(0x[a-fA-F0-9]{40})/;
  const NUMBER = /(\d+(?:\.\d+)?)/;

  // ─────────────────────────────
  // 1. SWAP (NEW 🔥 IMPORTANT)
  // swap 0.001 eth to usdc
  // ─────────────────────────────
  const swapMatch = lower.match(
    /swap\s+(\d+(?:\.\d+)?)\s*([a-z0-9]+)\s+(to|for)\s+([a-z0-9]+)/i
  );

  if (swapMatch) {
    return {
      intent: {
        action: "swap",
        amount: swapMatch[1],
        fromToken: swapMatch[2].toUpperCase(),
        toToken: swapMatch[4].toUpperCase()
      },
      raw
    };
  }

  // ─────────────────────────────
  // 2. SEND
  // send 0.1 eth to 0xabc
  // ─────────────────────────────
  const sendMatch = lower.match(
    /send\s+(\d+(?:\.\d+)?)\s+([a-z0-9]+)\s+to\s+(0x[a-fA-F0-9]{40})/i
  );

  if (sendMatch) {
    return {
      intent: {
        action: "send",
        amount: sendMatch[1],
        token: sendMatch[2].toUpperCase(),
        to: sendMatch[3]
      },
      raw
    };
  }

  // ─────────────────────────────
  // 3. PAY USDC
  // pay 5 usdc to 0xabc
  // ─────────────────────────────
  const payMatch = lower.match(
    /pay\s+(\d+(?:\.\d+)?)\s+usdc\s+to\s+(0x[a-fA-F0-9]{40})/i
  );

  if (payMatch) {
    return {
      intent: {
        action: "pay",
        amount: payMatch[1],
        to: payMatch[2]
      },
      raw
    };
  }

  // ─────────────────────────────
  // 4. SEND MAX
  // ─────────────────────────────
  if (lower.startsWith("send max")) {
    const addr = raw.match(ETH_ADDRESS)?.[1];
    return {
      intent: {
        action: "send_max",
        params: { to: addr || null }
      },
      raw
    };
  }

  // ─────────────────────────────
  // 5. OTHER EXISTING COMMANDS
  // ─────────────────────────────
  if (/recent.*tx|transactions|activity/i.test(lower)) {
    return { intent: { action: "recent_txs", params: { limit: 10 } }, raw };
  }

  if (/explain|who\s+is|inspect|info/i.test(lower) && ETH_ADDRESS.test(raw)) {
    return {
      intent: {
        action: "explain_address",
        params: { address: raw.match(ETH_ADDRESS)[1], txLimit: 5 }
      },
      raw
    };
  }

  if (/gas.*forecast|forecast.*gas/i.test(lower)) {
    return { intent: { action: "gas_forecast", params: { horizon: 3 } }, raw };
  }

  if (/send\s+all\s+tokens/i.test(lower)) {
    const addr = raw.match(ETH_ADDRESS)?.[1] || null;
    return {
      intent: {
        action: "send_all_tokens",
        params: { to: addr, confirmList: true }
      },
      raw
    };
  }

  if (/estimate\s+gas/i.test(lower)) {
    return {
      intent: { action: "estimate_gas", params: { original: raw } },
      raw
    };
  }

  if (/fix|correct|help.*syntax/i.test(lower)) {
    return {
      intent: { action: "autocorrect", params: { original: raw } },
      raw
    };
  }

  return { intent: { action: "none", params: {} }, raw };
}

// export
if (typeof module !== "undefined") module.exports = { parseAICommand };
else window.parseAICommand = parseAICommand;