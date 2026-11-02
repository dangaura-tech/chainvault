# Design notes

## StakingVault

### Why an accumulator?
A naive implementation would loop over all stakers whenever rewards are distributed,
which costs O(n) gas and eventually hits the block gas limit. Instead, the vault tracks a
single monotonically increasing value, `rewardPerTokenStored`, and each staker stores the
value they were last settled at. The difference multiplied by their balance is exactly the
reward accrued since their last interaction.

### Rounding
`rewardRate = reward / rewardsDuration` truncates, so up to `rewardsDuration - 1` wei of
each notified amount stays in the contract. This dust is never promised to stakers, which
guarantees that the vault can always pay every claim.

### Same token for staking and rewards
When `stakingToken == rewardsToken`, `notifyRewardAmount` subtracts `totalSupply` from the
balance before checking solvency so that user deposits can never be counted as rewards.

### Early-withdrawal fee
`lastStakeTime` is reset on every stake. Withdrawing within `lockDuration` of the last
stake pays `earlyWithdrawFeeBps` to `feeRecipient`. This discourages "just-in-time"
staking right before a large reward is notified.

## TokenVesting

* Schedules are addressed by `keccak256(beneficiary, index)` so a beneficiary can hold
  several independent grants (e.g. initial grant + refresh grant).
* `totalAllocated` tracks promised but unreleased tokens. `createSchedule` can only use the
  *unallocated* balance, so the contract is always solvent.
* `revoke` freezes the schedule at the current vested amount: vested tokens are paid out
  immediately and the remainder is refunded to the owner.
