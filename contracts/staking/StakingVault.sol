// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title StakingVault
/// @author Dang Truong Minh Le
/// @notice Stake `stakingToken` and earn `rewardsToken`, streamed linearly over a reward
///         period and distributed pro-rata to stake in O(1) gas per user action using the
///         "reward per token" accumulator.
/// @dev    Withdrawals made within `lockDuration` of the user's last stake pay
///         `earlyWithdrawFeeBps` (sent to `feeRecipient`), discouraging reward sniping.
contract StakingVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant PRECISION = 1e18;
    uint256 public constant MAX_FEE_BPS = 1_000; // 10 %

    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardsToken;

    uint256 public periodFinish;
    uint256 public rewardRate; // rewards per second
    uint256 public rewardsDuration = 7 days;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    uint256 public lockDuration = 3 days;
    uint256 public earlyWithdrawFeeBps = 200; // 2 %
    address public feeRecipient;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    mapping(address => uint256) public lastStakeTime;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount, uint256 fee);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward, uint256 periodFinish);
    event RewardsDurationUpdated(uint256 newDuration);
    event LockParamsUpdated(uint256 lockDuration, uint256 feeBps, address feeRecipient);
    event Recovered(address token, uint256 amount);

    error ZeroAmount();
    error InsufficientBalance();
    error RewardTooHigh();
    error PeriodNotFinished();
    error FeeTooHigh();
    error ZeroAddress();
    error CannotRecoverStakingToken();

    constructor(address owner_, IERC20 stakingToken_, IERC20 rewardsToken_) Ownable(owner_) {
        if (address(stakingToken_) == address(0) || address(rewardsToken_) == address(0)) revert ZeroAddress();
        stakingToken = stakingToken_;
        rewardsToken = rewardsToken_;
        feeRecipient = owner_;
    }

    // ----------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalSupply == 0) {
            return rewardPerTokenStored;
        }
        return rewardPerTokenStored
            + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * PRECISION) / totalSupply;
    }

    function earned(address account) public view returns (uint256) {
        return (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / PRECISION
            + rewards[account];
    }

    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }

    /// @notice Fee (in staking tokens) that `account` would pay to withdraw `amount` now.
    function withdrawFee(address account, uint256 amount) public view returns (uint256) {
        if (block.timestamp >= lastStakeTime[account] + lockDuration) return 0;
        return (amount * earlyWithdrawFeeBps) / 10_000;
    }

    // ----------------------------------------------------------------------------------
    // User actions
    // ----------------------------------------------------------------------------------

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        // Support fee-on-transfer tokens by crediting the amount actually received.
        uint256 before = stakingToken.balanceOf(address(this));
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = stakingToken.balanceOf(address(this)) - before;
        totalSupply += received;
        balanceOf[msg.sender] += received;
        lastStakeTime[msg.sender] = block.timestamp;
        emit Staked(msg.sender, received);
    }

    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (amount > balanceOf[msg.sender]) revert InsufficientBalance();
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        uint256 fee = withdrawFee(msg.sender, amount);
        if (fee > 0) {
            stakingToken.safeTransfer(feeRecipient, fee);
        }
        stakingToken.safeTransfer(msg.sender, amount - fee);
        emit Withdrawn(msg.sender, amount, fee);
    }

    function getReward() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardsToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    function exit() external {
        withdraw(balanceOf[msg.sender]);
        getReward();
    }

    // ----------------------------------------------------------------------------------
    // Admin
    // ----------------------------------------------------------------------------------

    /// @notice Start or extend a reward period. Rewards must be transferred to the vault first.
    function notifyRewardAmount(uint256 reward) external onlyOwner updateReward(address(0)) {
        if (block.timestamp >= periodFinish) {
            rewardRate = reward / rewardsDuration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (reward + leftover) / rewardsDuration;
        }
        // Guard against promising more than the vault holds (would make claims revert).
        uint256 balance = rewardsToken.balanceOf(address(this));
        if (address(rewardsToken) == address(stakingToken)) {
            balance -= totalSupply;
        }
        if (rewardRate > balance / rewardsDuration) revert RewardTooHigh();

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(reward, periodFinish);
    }

    function setRewardsDuration(uint256 duration) external onlyOwner {
        if (block.timestamp <= periodFinish) revert PeriodNotFinished();
        if (duration == 0) revert ZeroAmount();
        rewardsDuration = duration;
        emit RewardsDurationUpdated(duration);
    }

    function setLockParams(uint256 lockDuration_, uint256 feeBps, address recipient) external onlyOwner {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (recipient == address(0)) revert ZeroAddress();
        lockDuration = lockDuration_;
        earlyWithdrawFeeBps = feeBps;
        feeRecipient = recipient;
        emit LockParamsUpdated(lockDuration_, feeBps, recipient);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens sent to the vault by mistake (never the staked token).
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        if (token == address(stakingToken)) revert CannotRecoverStakingToken();
        IERC20(token).safeTransfer(owner(), amount);
        emit Recovered(token, amount);
    }
}
