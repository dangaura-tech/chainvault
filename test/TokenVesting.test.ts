import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

const e = (n: number) => ethers.parseEther(n.toString());
const MONTH = 30 * 24 * 3600;

describe("TokenVesting", () => {
  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();
    const token = await ethers.deployContract("MockERC20", ["Token", "TKN"]);
    const vesting = await ethers.deployContract("TokenVesting", [owner.address, token]);
    await token.mint(await vesting.getAddress(), e(1_000_000));
    const start = BigInt(await time.latest()) + 10n;
    return { owner, alice, bob, token, vesting, start };
  }

  it("releases nothing before the cliff and everything after the end", async () => {
    const { alice, token, vesting, start } = await loadFixture(deploy);
    await vesting.createSchedule(alice.address, e(1200), start, 3 * MONTH, 12 * MONTH, false);
    const id = await vesting.computeId(alice.address, 0);
    await time.increaseTo(start + BigInt(3 * MONTH) - 2n);
    expect(await vesting.releasable(id)).to.equal(0n);
    await expect(vesting.release(alice.address, 0)).to.be.revertedWithCustomError(vesting, "NothingToRelease");

    await time.increaseTo(start + BigInt(6 * MONTH));
    // one block = one second of linear vesting, hence the small tolerance
    expect(await vesting.releasable(id)).to.be.closeTo(e(600), e(0.001));
    await vesting.release(alice.address, 0);
    expect(await token.balanceOf(alice.address)).to.be.closeTo(e(600), e(0.001));

    await time.increaseTo(start + BigInt(24 * MONTH));
    await vesting.release(alice.address, 0);
    expect(await token.balanceOf(alice.address)).to.equal(e(1200));
    expect(await vesting.totalAllocated()).to.equal(0n);
  });

  it("cannot allocate more than the unallocated balance", async () => {
    const { alice, bob, vesting, start } = await loadFixture(deploy);
    await vesting.createSchedule(alice.address, e(900_000), start, 0, MONTH, false);
    await expect(
      vesting.createSchedule(bob.address, e(100_001), start, 0, MONTH, false),
    ).to.be.revertedWithCustomError(vesting, "InsufficientUnallocated");
  });

  it("revocation pays vested tokens and refunds the rest", async () => {
    const { owner, alice, token, vesting, start } = await loadFixture(deploy);
    await vesting.createSchedule(alice.address, e(1000), start, 0, 10 * MONTH, true);
    await time.increaseTo(start + BigInt(4 * MONTH));
    const ownerBefore = await token.balanceOf(owner.address);
    await vesting.revoke(alice.address, 0);
    const paid = await token.balanceOf(alice.address);
    const refunded = (await token.balanceOf(owner.address)) - ownerBefore;
    expect(paid).to.be.closeTo(e(400), e(0.01));
    expect(paid + refunded).to.equal(e(1000));
    await time.increase(12 * MONTH);
    await expect(vesting.release(alice.address, 0)).to.be.revertedWithCustomError(vesting, "NothingToRelease");
    await expect(vesting.revoke(alice.address, 0)).to.be.revertedWithCustomError(vesting, "AlreadyRevoked");
  });

  it("rejects revoking irrevocable or unknown schedules", async () => {
    const { alice, bob, vesting, start } = await loadFixture(deploy);
    await vesting.createSchedule(alice.address, e(10), start, 0, MONTH, false);
    await expect(vesting.revoke(alice.address, 0)).to.be.revertedWithCustomError(vesting, "NotRevocable");
    await expect(vesting.revoke(bob.address, 0)).to.be.revertedWithCustomError(vesting, "UnknownSchedule");
  });

  it("validates schedule parameters", async () => {
    const { alice, vesting, start } = await loadFixture(deploy);
    await expect(
      vesting.createSchedule(alice.address, e(1), start, MONTH + 1, MONTH, false),
    ).to.be.revertedWithCustomError(vesting, "InvalidSchedule");
    await expect(
      vesting.createSchedule(ethers.ZeroAddress, e(1), start, 0, MONTH, false),
    ).to.be.revertedWithCustomError(vesting, "InvalidSchedule");
  });

  it("supports several schedules per beneficiary", async () => {
    const { alice, vesting, start } = await loadFixture(deploy);
    await vesting.createSchedule(alice.address, e(10), start, 0, MONTH, false);
    await vesting.createSchedule(alice.address, e(20), start, 0, MONTH, false);
    expect(await vesting.scheduleCount(alice.address)).to.equal(2n);
    expect(await vesting.totalAllocated()).to.equal(e(30));
  });
});
