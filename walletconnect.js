// wallet-connect.js
// WALLEXA — Production Wallet Connector (REAL Web3 usage)

class WalletConnector {
  constructor() {
    this.provider = null;
    this.address = null;
    this.chainId = null;
    this.connected = false;
    this._listenersSetup = false;
    this.walletType = null;
    this.coinbaseProvider = null;
    this.walletConnectProvider = null;
  }

  // -----------------------------
  // Check wallet availability
  // -----------------------------
  isInstalled() {
    return typeof window !== "undefined" && typeof window.ethereum !== "undefined";
  }

  getShortAddress(addr) {
    if (!addr) return "";
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  }

  async _getCoinbaseSmartWalletProvider() {
    if (this.coinbaseProvider) return this.coinbaseProvider;
    const { createCoinbaseWalletSDK } = await import("./vendor/coinbase-wallet-sdk.js");
    const sdk = createCoinbaseWalletSDK({
      appName: "WALLEXA",
      appLogoUrl: null,
      appChainIds: [8453],
      // Base Smart Wallet app account mode. After the user grants a spend
      // permission, requests from this app account can be signed locally by
      // the SDK instead of showing a wallet popup every time.
      subAccounts: {
        enableAutoSubAccounts: true,
      },
      preference: {
        options: "smartWalletOnly",
        keysUrl: "https://keys.coinbase.com/connect",
      },
    });
    this.coinbaseProvider = sdk.getProvider();
    return this.coinbaseProvider;
  }

  async _getWalletConnectProvider() {
    if (this.walletConnectProvider) return this.walletConnectProvider;
    const projectId = window.WALLETCONNECT_PROJECT_ID || localStorage.getItem("WALLEXA_WC_PROJECT_ID");
    if (!projectId) {
      throw new Error("WalletConnect needs WALLETCONNECT_PROJECT_ID or localStorage WALLEXA_WC_PROJECT_ID.");
    }
    const { EthereumProvider } = await import("./vendor/walletconnect-ethereum-provider.js");
    this.walletConnectProvider = await EthereumProvider.init({
      projectId,
      chains: [8453],
      optionalChains: [8453],
      showQrModal: true,
      metadata: {
        name: "WALLEXA",
        description: "WALLEXA Base wallet",
        url: window.location.origin,
        icons: [`${window.location.origin}/favicon.ico`],
      },
    });
    return this.walletConnectProvider;
  }

  _getInjectedProvider(kind) {
    const eth = window.ethereum;
    if (!eth) return null;
    const providers = Array.isArray(eth.providers) ? eth.providers : [eth];

    if (kind === "metamask") {
      return providers.find((p) => p.isMetaMask && !p.isCoinbaseWallet) || null;
    }

    if (kind === "coinbase") {
      return providers.find((p) => p.isCoinbaseWallet) || null;
    }

    if (kind === "trust") {
      return providers.find((p) => p.isTrust || p.isTrustWallet) || null;
    }

    if (kind === "bitget") {
      return providers.find((p) => p.isBitgetWallet || p.isBitKeep) || null;
    }

    return eth;
  }

  // -----------------------------
  // Connect Wallet (REAL FLOW)
  // -----------------------------
  async connect(kind = "injected") {
    let provider = null;

    if (kind === "base") {
      provider = await this._getCoinbaseSmartWalletProvider();
      this.walletType = "base-smart-wallet";
    } else if (kind === "metamask") {
      provider = this._getInjectedProvider("metamask");
      this.walletType = "metamask";
    } else if (kind === "coinbase") {
      provider = this._getInjectedProvider("coinbase") || await this._getCoinbaseSmartWalletProvider();
      this.walletType = "coinbase";
    } else if (kind === "walletconnect") {
      provider = await this._getWalletConnectProvider();
      this.walletType = "walletconnect";
    } else if (kind === "trust") {
      provider = this._getInjectedProvider("trust") || await this._getWalletConnectProvider();
      this.walletType = "trust";
    } else if (kind === "bitget") {
      provider = this._getInjectedProvider("bitget") || this._getInjectedProvider("any");
      this.walletType = "bitget";
    } else {
      provider = this._getInjectedProvider("any");
      this.walletType = "injected";
    }

    if (!provider) {
      throw new Error(kind === "metamask" ? "MetaMask extension not found." : "No wallet provider found.");
    }

    try {
      this.provider = provider;

      // Request accounts (user approval popup)
      const accounts = await this.provider.request({
        method: "eth_requestAccounts"
      });

      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts returned from wallet.");
      }

      let resolvedAccounts = accounts;
      let appAccountAddress = null;
      if (kind === "base") {
        try {
          const subAccounts = await this.provider.request({ method: "wallet_getSubAccounts" });
          appAccountAddress = subAccounts?.subAccounts?.[0]?.address || null;
        } catch (err) {
          console.warn("Base app account lookup failed:", err);
        }
      }

      this.accounts = resolvedAccounts;
      this.address = resolvedAccounts[0];
      this.primaryAddress = resolvedAccounts[0];
      this.appAccountAddress = appAccountAddress || (kind === "base" ? this.address : null);
      this.chainId = await this.provider.request({ method: "eth_chainId" });
      this.connected = true;

      this._setupListeners();

      // Persist session (lightweight flag only)
      localStorage.setItem("wallexa_wallet_connected", "1");

      window.dispatchEvent(
        new CustomEvent("wallexa:connect", {
          detail: {
            address: this.address,
            primaryAddress: this.primaryAddress,
            appAccountAddress: this.appAccountAddress,
            chainId: this.chainId
          }
        })
      );

      return {
        address: this.address,
        primaryAddress: this.primaryAddress,
        appAccountAddress: this.appAccountAddress,
        chainId: this.chainId,
        walletType: this.walletType
      };

    } catch (err) {
      console.error("Wallet connect error:", err);
      throw err;
    }
  }

  // -----------------------------
  // Disconnect (UI only reset)
  // -----------------------------
  async disconnect() {
    this.provider = null;
    this.address = null;
    this.primaryAddress = null;
    this.appAccountAddress = null;
    this.accounts = null;
    this.chainId = null;
    this.connected = false;
    this._listenersSetup = false;

    localStorage.removeItem("wallexa_wallet_connected");

    window.dispatchEvent(
      new CustomEvent("wallexa:disconnect")
    );
  }

  // -----------------------------
  // Switch to Base Network (REAL)
  // -----------------------------
  async switchToBase() {
    if (!this.provider) throw new Error("No wallet connected.");

    const BASE_CHAIN_ID = "0x2105"; // 8453

    try {
      await this.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_ID }]
      });

      this.chainId = BASE_CHAIN_ID;

    } catch (err) {
      // If network not added, add it
      if (err.code === 4902) {
        await this.provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: BASE_CHAIN_ID,
              chainName: "Base Mainnet",
              nativeCurrency: {
                name: "Ether",
                symbol: "ETH",
                decimals: 18
              },
              rpcUrls: ["https://mainnet.base.org"],
              blockExplorerUrls: ["https://basescan.org"]
            }
          ]
        });

        this.chainId = BASE_CHAIN_ID;
      } else {
        throw err;
      }
    }
  }

  // -----------------------------
  // Listen to wallet changes
  // -----------------------------
  _setupListeners() {
    if (!this.provider || this._listenersSetup) return;

    // Account change
    this.provider.on("accountsChanged", (accounts) => {
      if (!accounts || accounts.length === 0) {
        this.disconnect();
      } else {
        const resolvedAccounts = accounts;
        this.address = resolvedAccounts[0];
        this.accounts = resolvedAccounts;
        this.primaryAddress = resolvedAccounts[0];

        window.dispatchEvent(
          new CustomEvent("wallexa:accountsChanged", {
            detail: { address: this.address, primaryAddress: this.primaryAddress, appAccountAddress: this.appAccountAddress }
          })
        );
      }
    });

    // Chain change
    this.provider.on("chainChanged", (chainId) => {
      this.chainId = chainId;

      window.dispatchEvent(
        new CustomEvent("wallexa:chainChanged", {
          detail: { chainId }
        })
      );
    });

    this._listenersSetup = true;
  }

  // -----------------------------
  // Get current state
  // -----------------------------
  getState() {
    return {
      connected: this.connected,
      address: this.address,
      primaryAddress: this.primaryAddress,
      appAccountAddress: this.appAccountAddress,
      accounts: this.accounts || [],
      chainId: this.chainId,
      walletType: this.walletType,
      provider: this.provider
    };
  }
}

// -----------------------------
// Singleton Export (GLOBAL)
// -----------------------------
const WalletStore = {
  instance: null
};

function initWalletConnector() {
  if (!WalletStore.instance) {
    WalletStore.instance = new WalletConnector();
  }
  return WalletStore.instance;
}

function getWalletConnector() {
  return WalletStore.instance || initWalletConnector();
}

// Attach to window (for your UI)
if (typeof window !== "undefined") {
  window.WALLEXA_WALLET = {
    init: initWalletConnector,
    getInstance: getWalletConnector
  };
}

// Node support (optional)
if (typeof module !== "undefined") {
  module.exports = {
    initWalletConnector,
    getWalletConnector
  };
}
