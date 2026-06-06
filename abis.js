// abis.js
// WALLEXA — Contract ABIs

const ABIS = {
  ERC20: [
    { type:"function", name:"name",        inputs:[], outputs:[{type:"string"}],  stateMutability:"view" },
    { type:"function", name:"symbol",      inputs:[], outputs:[{type:"string"}],  stateMutability:"view" },
    { type:"function", name:"decimals",    inputs:[], outputs:[{type:"uint8"}],   stateMutability:"view" },
    { type:"function", name:"totalSupply", inputs:[], outputs:[{type:"uint256"}], stateMutability:"view" },
    { type:"function", name:"balanceOf",   inputs:[{name:"account",type:"address"}], outputs:[{type:"uint256"}], stateMutability:"view" },
    { type:"function", name:"transfer",    inputs:[{name:"to",type:"address"},{name:"amount",type:"uint256"}], outputs:[{type:"bool"}], stateMutability:"nonpayable" },
    { type:"function", name:"approve",     inputs:[{name:"spender",type:"address"},{name:"amount",type:"uint256"}], outputs:[{type:"bool"}], stateMutability:"nonpayable" },
    { type:"function", name:"allowance",   inputs:[{name:"owner",type:"address"},{name:"spender",type:"address"}], outputs:[{type:"uint256"}], stateMutability:"view" },
    { type:"event",    name:"Transfer",    inputs:[{indexed:true,name:"from",type:"address"},{indexed:true,name:"to",type:"address"},{indexed:false,name:"value",type:"uint256"}] },
    { type:"event",    name:"Approval",    inputs:[{indexed:true,name:"owner",type:"address"},{indexed:true,name:"spender",type:"address"},{indexed:false,name:"value",type:"uint256"}] },
  ],

  ERC721: [
    { type:"function", name:"name",         inputs:[], outputs:[{type:"string"}],  stateMutability:"view" },
    { type:"function", name:"symbol",       inputs:[], outputs:[{type:"string"}],  stateMutability:"view" },
    { type:"function", name:"totalSupply",  inputs:[], outputs:[{type:"uint256"}], stateMutability:"view" },
    { type:"function", name:"ownerOf",      inputs:[{name:"tokenId",type:"uint256"}], outputs:[{type:"address"}], stateMutability:"view" },
    { type:"function", name:"balanceOf",    inputs:[{name:"owner",type:"address"}],   outputs:[{type:"uint256"}], stateMutability:"view" },
    { type:"function", name:"mint",         inputs:[{name:"to",type:"address"}], outputs:[], stateMutability:"nonpayable" },
    { type:"function", name:"tokenURI",     inputs:[{name:"tokenId",type:"uint256"}], outputs:[{type:"string"}], stateMutability:"view" },
    { type:"function", name:"safeTransferFrom", inputs:[{name:"from",type:"address"},{name:"to",type:"address"},{name:"tokenId",type:"uint256"}], outputs:[], stateMutability:"nonpayable" },
    { type:"function", name:"approve",      inputs:[{name:"to",type:"address"},{name:"tokenId",type:"uint256"}], outputs:[], stateMutability:"nonpayable" },
    { type:"event",    name:"Transfer",     inputs:[{indexed:true,name:"from",type:"address"},{indexed:true,name:"to",type:"address"},{indexed:true,name:"tokenId",type:"uint256"}] },
  ],

  COUNTER: [
    { type:"function", name:"number",    inputs:[], outputs:[{name:"",type:"uint256"}], stateMutability:"view" },
    { type:"function", name:"increment", inputs:[], outputs:[], stateMutability:"nonpayable" },
  ],

  STAKING: [
    { type:"function", name:"stake",    inputs:[{name:"amount",type:"uint256"}], outputs:[], stateMutability:"nonpayable" },
    { type:"function", name:"unstake",  inputs:[{name:"amount",type:"uint256"}], outputs:[], stateMutability:"nonpayable" },
    { type:"function", name:"claim",    inputs:[], outputs:[], stateMutability:"nonpayable" },
    { type:"function", name:"earned",   inputs:[{name:"account",type:"address"}], outputs:[{type:"uint256"}], stateMutability:"view" },
    { type:"function", name:"balanceOf",inputs:[{name:"account",type:"address"}], outputs:[{type:"uint256"}], stateMutability:"view" },
  ],

};

if (typeof module !== "undefined") module.exports = ABIS;
else window.WALLEXA_ABIS = ABIS;
