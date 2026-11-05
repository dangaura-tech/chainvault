import { ethers, network } from "hardhat";

/**
 * Deploys VaultToken, a StakingVault that pays VLT for staking VLT, a TokenVesting contract,
 * and on-chain governance (VaultTimelock + VaultGovernor). Funds and starts a first reward
 * period, then hands ownership of the vault to the timelock so that every later parameter
 * change must go through a governance proposal.
 *
 *   npx hardhat node                       # terminal 1
 *   npm run deploy:local                   # terminal 2
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`network: ${network.name}  deployer: ${deployer.address}`);

  const cap = ethers.parseEther("100000000");
  const initial = ethers.parseEther("20000000");
  const token = await ethers.deployContract("VaultToken", [deployer.address, cap, initial]);
  await token.waitForDeployment();
  console.log(`VaultToken    ${await token.getAddress()}`);

  const vault = await ethers.deployContract("StakingVault", [deployer.address, token, token]);
  await vault.waitForDeployment();
  console.log(`StakingVault  ${await vault.getAddress()}`);

  const vesting = await ethers.deployContract("TokenVesting", [deployer.address, token]);
  await vesting.waitForDeployment();
  console.log(`TokenVesting  ${await vesting.getAddress()}`);

  const rewards = ethers.parseEther("700000");
  await (await token.transfer(await vault.getAddress(), rewards)).wait();
  await (await vault.notifyRewardAmount(rewards)).wait();
  console.log(`started a ${Number(await vault.rewardsDuration()) / 86400}-day reward period of 700,000 VLT`);

  await (await token.transfer(await vesting.getAddress(), ethers.parseEther("5000000"))).wait();
  console.log("funded the vesting contract with 5,000,000 VLT");

  // ---- governance -------------------------------------------------------------------
  const minDelay = 2 * 24 * 3600; // 2 days
  const timelock = await ethers.deployContract("VaultTimelock", [minDelay, [], [ethers.ZeroAddress], deployer.address]);
  await timelock.waitForDeployment();
  const governor = await ethers.deployContract("VaultGovernor", [
    token,
    timelock,
    7200, // voting delay: ~1 day of 12 s blocks
    50400, // voting period: ~1 week
    ethers.parseEther("100000"), // proposal threshold
    4, // quorum: 4 % of supply
  ]);
  await governor.waitForDeployment();
  console.log(`VaultTimelock ${await timelock.getAddress()}`);
  console.log(`VaultGovernor ${await governor.getAddress()}`);

  await (await timelock.grantRole(await timelock.PROPOSER_ROLE(), governor)).wait();
  await (await timelock.grantRole(await timelock.CANCELLER_ROLE(), governor)).wait();
  await (await vault.transferOwnership(timelock)).wait();
  await (await vesting.transferOwnership(timelock)).wait();
  await (await timelock.renounceRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)).wait();
  console.log("vault and vesting are now owned by the timelock; deployer admin renounced");
  // Note: the token's DEFAULT_ADMIN_ROLE / MINTER_ROLE stay with the deployer here; transfer
  // them to the timelock as well once the distribution is final.
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
