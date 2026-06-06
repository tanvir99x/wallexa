// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DeployOnBaseTask {
    string public taskName = "Deploy On Base";

    address public owner;

    uint256 public deployedAt;

    constructor() {
        owner = msg.sender;
        deployedAt = block.timestamp;
    }

    function getInfo()
        external
        view
        returns (
            address,
            uint256,
            string memory
        )
    {
        return (
            owner,
            deployedAt,
            taskName
        );
    }
}
