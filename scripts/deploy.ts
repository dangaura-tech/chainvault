import { ethers, network } from "hardhat";

/**
 * Deploys VaultToken, a StakingVault that pays VLT for staking VLT, and a TokenVesting
 * contract, then funds and starts a first reward period.
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
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
