// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";

/// @title MerkleDistributor
/// @author Dang Truong Minh Le
/// @notice Gas-efficient token distribution (airdrops, retroactive rewards) to many accounts.
///         Only the Merkle root of the allocation list is stored on-chain; each recipient
///         submits a proof of their (index, account, amount) leaf. Claims are recorded in a
///         bitmap (one storage slot per 256 recipients). After the claim deadline the owner
///         (normally the governance timelock) can sweep unclaimed tokens.
/// @dev Leaves are double-hashed, `keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))`,
///      so a 64-byte internal node can never be passed off as a leaf (second-preimage safety);
///      this matches OpenZeppelin's StandardMerkleTree with types ["uint256", "address", "uint256"].
contract MerkleDistributor is Ownable {
    using SafeERC20 for IERC20;
    using BitMaps for BitMaps.BitMap;

    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    uint64 public immutable claimDeadline;

    BitMaps.BitMap private _claimed;
    uint256 public totalClaimed;

    event Claimed(uint256 indexed index, address indexed account, address indexed to, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    error AlreadyClaimed(uint256 index);
    error InvalidProof();
    error ClaimWindowClosed();
    error ClaimWindowOpen();
    error InvalidDeadline();
    error ZeroAddress();

    constructor(address owner_, IERC20 token_, bytes32 merkleRoot_, uint64 claimDeadline_) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (claimDeadline_ <= block.timestamp) revert InvalidDeadline();
        token = token_;
        merkleRoot = merkleRoot_;
        claimDeadline = claimDeadline_;
    }

    function isClaimed(uint256 index) external view returns (bool) {
        return _claimed.get(index);
    }

    /// @notice Claim `amount` for `account` (anyone may relay the claim; tokens always go to `account`).
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        _claim(index, account, amount, proof, account);
    }

    /// @notice Claim your own allocation to a different address (e.g. a cold wallet).
    function claimTo(uint256 index, uint256 amount, bytes32[] calldata proof, address to) external {
        if (to == address(0)) revert ZeroAddress();
        _claim(index, msg.sender, amount, proof, to);
    }

    /// @notice After the deadline, send every unclaimed token to `to`.
    function sweep(address to) external onlyOwner {
        if (block.timestamp <= claimDeadline) revert ClaimWindowOpen();
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = token.balanceOf(address(this));
        token.safeTransfer(to, amount);
        emit Swept(to, amount);
    }

    function leaf(uint256 index, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
    }

    function _claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof, address to) private {
        if (block.timestamp > claimDeadline) revert ClaimWindowClosed();
        if (_claimed.get(index)) revert AlreadyClaimed(index);
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf(index, account, amount))) revert InvalidProof();
        _claimed.set(index);
        totalClaimed += amount;
        token.safeTransfer(to, amount);
        emit Claimed(index, account, to, amount);
    }
}
