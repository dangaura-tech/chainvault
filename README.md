<div align="center">

# ChainVault

**ERC-20 governance token, reward-streaming staking vault and token vesting - written in Solidity 0.8 on OpenZeppelin v5.**

[![CI](https://github.com/dangaura-tech/chainvault/actions/workflows/ci.yml/badge.svg)](https://github.com/dangaura-tech/chainvault/actions/workflows/ci.yml)
![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636?logo=solidity)
![Hardhat](https://img.shields.io/badge/Hardhat-2.x-f0d50c)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

ChainVault is the on-chain core of a small DeFi protocol. It contains three contracts:

| Contract | Description |
|---|---|
| [`VaultToken`](contracts/token/VaultToken.sol) | Capped ERC-20 (`VLT`) with role-based minting, burning, EIP-2612 `permit` and ERC20Votes delegation for on-chain governance |
| [`StakingVault`](contracts/staking/StakingVault.sol) | Stake any ERC-20 and earn rewards streamed linearly over a period, distributed pro-rata in O(1) gas; early-withdrawal fee, pause switch, fee-on-transfer support |
| [`TokenVesting`](contracts/vesting/TokenVesting.sol) | Cliff + linear vesting for many beneficiaries, with optional revocation that pays out the vested part and refunds the rest |

## How the reward accounting works

The vault keeps a global accumulator `rewardPerTokenStored` - the reward earned by one
staked token since the start. Every user action first brings it up to date:

```
rewardPerToken = rewardPerTokenStored + (min(now, periodFinish) - lastUpdateTime) * rewardRate * 1e18 / totalSupply
earned(user)   = balance(user) * (rewardPerToken - userRewardPerTokenPaid[user]) / 1e18 + rewards[user]
```

Because each user only stores a snapshot of the accumulator, staking, withdrawing and
claiming all cost **O(1) gas**, regardless of the number of stakers. When a new reward
amount is notified while a period is running, the leftover rewards are rolled into the
new period. The vault also refuses to promise more rewards than it holds.

## Security considerations

- `ReentrancyGuard` on every state-changing user function, checks-effects-interactions ordering
- `SafeERC20` for all token transfers; staking credits the **received** amount (fee-on-transfer tokens)
- `Pausable` blocks new stakes only - users can **always** withdraw and claim
- The early-withdrawal fee is capped at 10 % (`MAX_FEE_BPS`)
- The owner cannot recover the staking token; note that the owner *can* recover reward
  tokens, so in production the owner should be a timelock / multisig
- Custom errors instead of revert strings (cheaper and easier to test)

> This code has not been audited. Do not use it with real funds without an independent audit.

## Getting started

```bash
git clone https://github.com/dangaura-tech/chainvault.git
cd chainvault
npm install
npm run compile
npm test             # 21 tests
npm run coverage     # solidity-coverage report
npm run gas          # gas usage per function
npm run lint         # solhint
```

### Local deployment

```bash
npx hardhat node          # terminal 1: local chain with funded accounts
npm run deploy:local      # terminal 2: deploy token, vault and vesting; start a reward period
```

### Testnet deployment (Sepolia)

```bash
cp .env.example .env      # fill PRIVATE_KEY, SEPOLIA_RPC_URL, ETHERSCAN_API_KEY
npm run deploy:sepolia
npx hardhat verify --network sepolia <address> <constructor args...>
```

## Usage example (ethers v6)

```ts
const vault = await ethers.getContractAt("StakingVault", VAULT_ADDRESS);
await token.approve(vault, ethers.parseEther("100"));
await vault.stake(ethers.parseEther("100"));

console.log("pending:", ethers.formatEther(await vault.earned(me)));
await vault.getReward();   // claim rewards
await vault.exit();        // withdraw everything + claim
```

## Project structure

```
contracts/
├── token/VaultToken.sol
├── staking/StakingVault.sol
├── vesting/TokenVesting.sol
└── mocks/MockERC20.sol        # test token with optional transfer fee
scripts/deploy.ts
test/                          # Hardhat + chai + network-helpers (time travel)
docs/design.md
```

## License

MIT © Dang Truong Minh Le
