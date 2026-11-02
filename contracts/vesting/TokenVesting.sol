// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TokenVesting
/// @author Dang Truong Minh Le
/// @notice Holds tokens for many beneficiaries and releases them on a cliff + linear
///         schedule. Schedules can optionally be revoked by the owner, in which case the
///         vested-but-unreleased part stays claimable and the rest returns to the owner.
contract TokenVesting is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Schedule {
        uint128 total;
        uint128 released;
        uint64 start;
        uint64 cliff; // absolute timestamp
        uint64 duration;
        bool revocable;
        bool revoked;
    }

    IERC20 public immutable token;
    uint256 public totalAllocated; // sum of (total - released) over active schedules
    mapping(bytes32 => Schedule) public schedules;
    mapping(address => uint256) public scheduleCount;

    event ScheduleCreated(bytes32 indexed id, address indexed beneficiary, uint256 amount);
    event Released(bytes32 indexed id, address indexed beneficiary, uint256 amount);
    event Revoked(bytes32 indexed id, uint256 refunded);

    error InvalidSchedule();
    error InsufficientUnallocated();
    error NotRevocable();
    error AlreadyRevoked();
    error NothingToRelease();
    error UnknownSchedule();

    constructor(address owner_, IERC20 token_) Ownable(owner_) {
        token = token_;
    }

    function computeId(address beneficiary, uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(beneficiary, index));
    }

    /// @notice Tokens held by the contract that are not promised to anyone.
    function unallocated() public view returns (uint256) {
        return token.balanceOf(address(this)) - totalAllocated;
    }

    function createSchedule(
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 cliffDuration,
        uint64 duration,
        bool revocable
    ) external onlyOwner returns (bytes32 id) {
        if (beneficiary == address(0) || amount == 0 || duration == 0 || cliffDuration > duration) {
            revert InvalidSchedule();
        }
        if (amount > type(uint128).max) revert InvalidSchedule();
        if (amount > unallocated()) revert InsufficientUnallocated();
        id = computeId(beneficiary, scheduleCount[beneficiary]++);
        schedules[id] = Schedule({
            total: uint128(amount),
            released: 0,
            start: start,
            cliff: start + cliffDuration,
            duration: duration,
            revocable: revocable,
            revoked: false
        });
        totalAllocated += amount;
        emit ScheduleCreated(id, beneficiary, amount);
    }

    function vestedAmount(bytes32 id, uint256 timestamp) public view returns (uint256) {
        Schedule memory s = schedules[id];
        if (s.duration == 0) revert UnknownSchedule();
        if (s.revoked) return s.released; // frozen at revocation (see revoke)
        if (timestamp < s.cliff) return 0;
        if (timestamp >= s.start + s.duration) return s.total;
        return (uint256(s.total) * (timestamp - s.start)) / s.duration;
    }

    function releasable(bytes32 id) public view returns (uint256) {
        return vestedAmount(id, block.timestamp) - schedules[id].released;
    }

    /// @notice Release vested tokens of schedule `index` to `beneficiary` (anyone may call).
    function release(address beneficiary, uint256 index) external nonReentrant {
        bytes32 id = computeId(beneficiary, index);
        uint256 amount = releasable(id);
        if (amount == 0) revert NothingToRelease();
        schedules[id].released += uint128(amount);
        totalAllocated -= amount;
        token.safeTransfer(beneficiary, amount);
        emit Released(id, beneficiary, amount);
    }

    /// @notice Revoke a schedule: vested tokens are paid out immediately, the unvested
    ///         remainder becomes unallocated and is returned to the owner.
    function revoke(address beneficiary, uint256 index) external onlyOwner nonReentrant {
        bytes32 id = computeId(beneficiary, index);
        Schedule storage s = schedules[id];
        if (s.duration == 0) revert UnknownSchedule();
        if (!s.revocable) revert NotRevocable();
        if (s.revoked) revert AlreadyRevoked();

        uint256 vested = vestedAmount(id, block.timestamp);
        uint256 payout = vested - s.released;
        uint256 refund = s.total - vested;
        s.released = uint128(vested);
        s.revoked = true;
        totalAllocated -= payout + refund;
        if (payout > 0) {
            token.safeTransfer(beneficiary, payout);
            emit Released(id, beneficiary, payout);
        }
        if (refund > 0) {
            token.safeTransfer(owner(), refund);
        }
        emit Revoked(id, refund);
    }
}
