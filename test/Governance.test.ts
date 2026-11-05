import { loadFixture, mine, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

const e = (n: number) => ethers.parseEther(n.toString());
const DAY = 24 * 3600;
const VOTING_DELAY = 1; // blocks
const VOTING_PERIOD = 50; // blocks
const MIN_DELAY = 2 * DAY; // timelock delay (seconds)

enum ProposalState {
  Pending,
  Active,
  Canceled,
  Defeated,
  Succeeded,
  Queued,
  Expired,
  Executed,
}

describe("Governance (VaultGovernor + VaultTimelock)", () => {
  async function deploy() {
    const [deployer, alice, bob, carol, treasury] = await ethers.getSigners();
    const token = await ethers.deployContract("VaultToken", [deployer.address, e(100_000_000), e(10_000_000)]);
    const timelock = await ethers.deployContract("VaultTimelock", [MIN_DELAY, [], [ethers.ZeroAddress], deployer.address]);
    const governor = await ethers.deployContract("VaultGovernor", [
      token,
      timelock,
      VOTING_DELAY,
      VOTING_PERIOD,
      e(100_000), // proposal threshold
      10, // quorum: 10 % of the circulating supply at the snapshot
    ]);
    // wire roles: only the governor proposes/cancels, anyone executes, deployer gives up admin
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), governor);
    await timelock.grantRole(await timelock.CANCELLER_ROLE(), governor);
    await timelock.renounceRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

    const vault = await ethers.deployContract("StakingVault", [deployer.address, token, token]);
    await vault.transferOwnership(timelock);

    // distribute voting power (10 M circulating): alice 30 %, bob 20 %, carol 5 %
    for (const [who, amount] of [[alice, 3_000_000], [bob, 2_000_000], [carol, 500_000]] as const) {
      await token.transfer(who.address, e(amount));
      await token.connect(who).delegate(who.address);
    }
    await mine(1); // checkpoints must be in the past for the proposal snapshot
    return { deployer, alice, bob, carol, treasury, token, timelock, governor, vault };
  }

  async function proposeLockChange(governor: any, vault: any, proposer: any, recipient: string) {
    const calldata = vault.interface.encodeFunctionData("setLockParams", [DAY, 100, recipient]);
    const description = "Proposal #1: shorten the lock to 1 day and lower the early-withdrawal fee to 1 %";
    const tx = await governor.connect(proposer).propose([await vault.getAddress()], [0], [calldata], description);
    const receipt = await tx.wait();
    const event = receipt.logs.map((l: any) => governor.interface.parseLog(l)).find((l: any) => l?.name === "ProposalCreated");
    return { id: event.args.proposalId, calldata, descriptionHash: ethers.id(description) };
  }

  it("wires ownership and roles correctly", async () => {
    const { deployer, timelock, governor, vault } = await loadFixture(deploy);
    expect(await vault.owner()).to.equal(await timelock.getAddress());
    expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), governor)).to.equal(true);
    expect(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(false);
    expect(await governor.votingDelay()).to.equal(VOTING_DELAY);
    expect(await governor.votingPeriod()).to.equal(VOTING_PERIOD);
    expect(await governor.quorum((await ethers.provider.getBlockNumber()) - 1)).to.equal(e(1_000_000));
  });

  it("executes a passed proposal through the timelock: propose -> vote -> queue -> execute", async () => {
    const { alice, bob, carol, treasury, governor, vault } = await loadFixture(deploy);
    const { id, calldata, descriptionHash } = await proposeLockChange(governor, vault, alice, treasury.address);
    expect(await governor.state(id)).to.equal(ProposalState.Pending);

    await mine(VOTING_DELAY + 1);
    expect(await governor.state(id)).to.equal(ProposalState.Active);
    await governor.connect(alice).castVote(id, 1); // for
    await governor.connect(bob).castVoteWithReason(id, 1, "fees are too high");
    await governor.connect(carol).castVote(id, 0); // against
    const votes = await governor.proposalVotes(id);
    expect(votes.forVotes).to.equal(e(5_000_000));
    expect(votes.againstVotes).to.equal(e(500_000));

    await mine(VOTING_PERIOD);
    expect(await governor.state(id)).to.equal(ProposalState.Succeeded);
    const target = [await vault.getAddress()];
    await governor.queue(target, [0], [calldata], descriptionHash);
    expect(await governor.state(id)).to.equal(ProposalState.Queued);

    // cannot execute before the timelock delay
    await expect(governor.execute(target, [0], [calldata], descriptionHash)).to.be.reverted;
    await time.increase(MIN_DELAY);
    await governor.execute(target, [0], [calldata], descriptionHash);
    expect(await governor.state(id)).to.equal(ProposalState.Executed);
    expect(await vault.lockDuration()).to.equal(DAY);
    expect(await vault.earlyWithdrawFeeBps()).to.equal(100);
    expect(await vault.feeRecipient()).to.equal(treasury.address);
  });

  it("defeats proposals that miss the quorum", async () => {
    const { alice, carol, treasury, governor, vault } = await loadFixture(deploy);
    const { id } = await proposeLockChange(governor, vault, alice, treasury.address);
    await mine(VOTING_DELAY + 1);
    await governor.connect(carol).castVote(id, 1); // 5 % < 10 % quorum
    await mine(VOTING_PERIOD);
    expect(await governor.state(id)).to.equal(ProposalState.Defeated);
  });

  it("defeats proposals with more votes against", async () => {
    const { alice, bob, treasury, governor, vault } = await loadFixture(deploy);
    const { id } = await proposeLockChange(governor, vault, bob, treasury.address);
    await mine(VOTING_DELAY + 1);
    await governor.connect(alice).castVote(id, 0);
    await governor.connect(bob).castVote(id, 1);
    await mine(VOTING_PERIOD);
    expect(await governor.state(id)).to.equal(ProposalState.Defeated);
  });

  it("enforces the proposal threshold and one vote per account", async () => {
    const { alice, treasury, governor, vault } = await loadFixture(deploy);
    const [, , , , , dave] = await ethers.getSigners();
    const calldata = vault.interface.encodeFunctionData("setLockParams", [DAY, 100, treasury.address]);
    await expect(
      governor.connect(dave).propose([await vault.getAddress()], [0], [calldata], "no voting power"),
    ).to.be.revertedWithCustomError(governor, "GovernorInsufficientProposerVotes");

    const { id } = await proposeLockChange(governor, vault, alice, treasury.address);
    await mine(VOTING_DELAY + 1);
    await governor.connect(alice).castVote(id, 1);
    await expect(governor.connect(alice).castVote(id, 1)).to.be.revertedWithCustomError(governor, "GovernorAlreadyCastVote");
  });

  it("uses voting power at the snapshot, so tokens received after it do not count", async () => {
    const { deployer, alice, carol, treasury, token, governor, vault } = await loadFixture(deploy);
    const { id } = await proposeLockChange(governor, vault, alice, treasury.address);
    await mine(VOTING_DELAY + 1); // snapshot = proposal block + voting delay, now in the past
    await token.connect(deployer).transfer(carol.address, e(4_000_000));
    expect(await token.getVotes(carol.address)).to.equal(e(4_500_000));
    await governor.connect(carol).castVote(id, 1);
    expect((await governor.proposalVotes(id)).forVotes).to.equal(e(500_000));
  });

  it("protocol parameters can no longer be changed directly by the deployer", async () => {
    const { deployer, treasury, vault } = await loadFixture(deploy);
    await expect(vault.connect(deployer).setLockParams(0, 0, treasury.address)).to.be.revertedWithCustomError(
      vault,
      "OwnableUnauthorizedAccount",
    );
  });
});
