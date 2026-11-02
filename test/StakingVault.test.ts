import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

const e = (n: string | number) => ethers.parseEther(n.toString());
const WEEK = 7 * 24 * 3600;
const DAY = 24 * 3600;

describe("StakingVault", () => {
  async function deploy() {
    const [owner, alice, bob, treasury] = await ethers.getSigners();
    const stake = await ethers.deployContract("MockERC20", ["Stake", "STK"]);
    const reward = await ethers.deployContract("MockERC20", ["Reward", "RWD"]);
    const vault = await ethers.deployContract("StakingVault", [owner.address, stake, reward]);
    for (const u of [alice, bob]) {
      await stake.mint(u.address, e(1000));
      await stake.connect(u).approve(vault, ethers.MaxUint256);
    }
    await vault.setLockParams(0, 0, treasury.address); // most tests ignore the lock
    return { owner, alice, bob, treasury, stake, reward, vault };
  }

  async function fund(reward: any, vault: any, amount: bigint) {
    await reward.mint(await vault.getAddress(), amount);
    await vault.notifyRewardAmount(amount);
  }

  it("streams the whole reward to a single staker", async () => {
    const { alice, reward, vault } = await loadFixture(deploy);
    await vault.connect(alice).stake(e(100));
    await fund(reward, vault, e(7000));
    await time.increase(WEEK + 10);
    const earned = await vault.earned(alice.address);
    expect(earned).to.be.closeTo(e(7000), e(0.1));
    await vault.connect(alice).getReward();
    expect(await reward.balanceOf(alice.address)).to.equal(earned);
  });

  it("splits rewards pro-rata to stake and time", async () => {
    const { alice, bob, reward, vault } = await loadFixture(deploy);
    await vault.connect(alice).stake(e(100));
    await fund(reward, vault, e(7000)); // 1000 / day
    await time.increase(DAY - 1);
    await vault.connect(bob).stake(e(300)); // from day 1, alice 25 %, bob 75 %
    await time.increase(6 * DAY + 10);
    const a = await vault.earned(alice.address);
    const b = await vault.earned(bob.address);
    expect(a).to.be.closeTo(e(1000 + 6000 * 0.25), e(1));
    expect(b).to.be.closeTo(e(6000 * 0.75), e(1));
    expect(a + b).to.be.lte(e(7000));
  });

  it("extends a running period with the leftover rewards", async () => {
    const { alice, reward, vault } = await loadFixture(deploy);
    await vault.connect(alice).stake(e(10));
    await fund(reward, vault, e(700));
    await time.increase(WEEK / 2);
    await fund(reward, vault, e(700));
    // remaining 350 + new 700 spread over a fresh week
    expect(await vault.getRewardForDuration()).to.be.closeTo(e(1050), e(0.01));
    await time.increase(WEEK + 10);
    expect(await vault.earned(alice.address)).to.be.closeTo(e(1400), e(0.1));
  });

  it("refuses to promise more rewards than it holds", async () => {
    const { reward, vault } = await loadFixture(deploy);
    await reward.mint(await vault.getAddress(), e(100));
    await expect(vault.notifyRewardAmount(e(101))).to.be.revertedWithCustomError(vault, "RewardTooHigh");
  });

  it("exit returns stake and rewards", async () => {
    const { alice, stake, reward, vault } = await loadFixture(deploy);
    await vault.connect(alice).stake(e(50));
    await fund(reward, vault, e(70));
    await time.increase(WEEK);
    await vault.connect(alice).exit();
    expect(await stake.balanceOf(alice.address)).to.equal(e(1000));
    expect(await reward.balanceOf(alice.address)).to.be.closeTo(e(70), e(0.001));
    expect(await vault.totalSupply()).to.equal(0n);
  });

  it("charges the early-withdrawal fee only inside the lock window", async () => {
    const { alice, stake, vault, treasury } = await loadFixture(deploy);
    await vault.setLockParams(3 * DAY, 200, treasury.address); // 2 %
    await vault.connect(alice).stake(e(100));
    await expect(vault.connect(alice).withdraw(e(50)))
      .to.emit(vault, "Withdrawn")
      .withArgs(alice.address, e(50), e(1));
    expect(await stake.balanceOf(treasury.address)).to.equal(e(1));
    await time.increase(3 * DAY);
    await vault.connect(alice).withdraw(e(50));
    expect(await stake.balanceOf(alice.address)).to.equal(e(1000) - e(1));
  });

  it("credits only the received amount for fee-on-transfer tokens", async () => {
    const { alice, stake, vault } = await loadFixture(deploy);
    await stake.setFeeBps(100); // 1 % transfer fee
    await expect(vault.connect(alice).stake(e(100))).to.emit(vault, "Staked").withArgs(alice.address, e(99));
    expect(await vault.balanceOf(alice.address)).to.equal(e(99));
  });

  it("validates inputs and permissions", async () => {
    const { alice, vault, stake } = await loadFixture(deploy);
    await expect(vault.connect(alice).stake(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.connect(alice).withdraw(e(1))).to.be.revertedWithCustomError(vault, "InsufficientBalance");
    await expect(vault.connect(alice).notifyRewardAmount(1)).to.be.revertedWithCustomError(
      vault,
      "OwnableUnauthorizedAccount",
    );
    await expect(vault.setLockParams(0, 1001, alice.address)).to.be.revertedWithCustomError(vault, "FeeTooHigh");
    await expect(vault.recoverERC20(stake, 1)).to.be.revertedWithCustomError(vault, "CannotRecoverStakingToken");
  });

  it("can be paused for new stakes but never blocks withdrawals", async () => {
    const { alice, vault } = await loadFixture(deploy);
    await vault.connect(alice).stake(e(10));
    await vault.pause();
    await expect(vault.connect(alice).stake(e(1))).to.be.revertedWithCustomError(vault, "EnforcedPause");
    await vault.connect(alice).withdraw(e(10));
  });

  it("only allows changing the duration after the period ends", async () => {
    const { reward, vault } = await loadFixture(deploy);
    await fund(reward, vault, e(70));
    await expect(vault.setRewardsDuration(DAY)).to.be.revertedWithCustomError(vault, "PeriodNotFinished");
    await time.increase(WEEK + 1);
    await expect(vault.setRewardsDuration(DAY)).to.emit(vault, "RewardsDurationUpdated").withArgs(DAY);
  });
});
