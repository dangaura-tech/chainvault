// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title VaultTimelock
/// @author Dang Truong Minh Le
/// @notice TimelockController that owns the protocol contracts. Only the governor may propose
///         (queue) and cancel operations; execution is open to anyone once the delay has passed.
contract VaultTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
