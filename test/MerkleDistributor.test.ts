import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { AllocationTree } from "../scripts/lib/merkle";

const e = (n: number) => ethers.parseEther(n.toString());
const WEEK = 7 * 24 * 3600;

describe("MerkleDistributor", () => {
  async function deploy() {
    const signers = await ethers.getSigners();
    const [owner, alice, bob, carol, mallory] = signers;
    // 7 recipients: an odd count exercises promoted nodes in the tree
    const allocations = signers.slice(1, 8).map((s, i) => ({ account: s.address, amount: e(100 * (i + 1)) }));
    const tree = new AllocationTree(allocations);
    const token = await ethers.deployContract("MockERC20", ["Token", "TKN"]);
    const deadline = BigInt(await time.latest()) + BigInt(4 * WEEK);
    const dist = await ethers.deployContract("MerkleDistributor", [owner.address, token, tree.root, deadline]);
    await token.mint(await dist.getAddress(), tree.total());
    return { owner, alice, bob, carol, mallory, tree, token, dist, deadline };
  }

  it("matches the on-chain leaf encoding", async () => {
    const { dist, tree, alice } = await loadFixture(deploy);
    expect(await dist.leaf(0, alice.address, e(100))).to.equal(tree.leaves[0]);
  });

  it("lets every recipient claim exactly once, relayed or not", async () => {
    const { dist, tree, token, bob, mallory } = await loadFixture(deploy);
    for (const [i, a] of tree.allocations.entries()) {
      // a third party relays the claim, tokens still go to the recipient
      await expect(dist.connect(mallory).claim(i, a.account, a.amount, tree.proof(i)))
        .to.emit(dist, "Claimed")
        .withArgs(i, a.account, a.account, a.amount);
      expect(await token.balanceOf(a.account)).to.equal(a.amount);
      expect(await dist.isClaimed(i)).to.equal(true);
    }
    expect(await dist.totalClaimed()).to.equal(tree.total());
    expect(await token.balanceOf(await dist.getAddress())).to.equal(0n);
    const i = 1;
    await expect(dist.claim(i, bob.address, e(200), tree.proof(i)))
      .to.be.revertedWithCustomError(dist, "AlreadyClaimed")
      .withArgs(i);
  });

  it("rejects wrong amounts, accounts, indices and proofs", async () => {
    const { dist, tree, alice, bob } = await loadFixture(deploy);
    await expect(dist.claim(0, alice.address, e(101), tree.proof(0))).to.be.revertedWithCustomError(dist, "InvalidProof");
    await expect(dist.claim(0, bob.address, e(100), tree.proof(0))).to.be.revertedWithCustomError(dist, "InvalidProof");
    await expect(dist.claim(1, alice.address, e(100), tree.proof(0))).to.be.revertedWithCustomError(dist, "InvalidProof");
    await expect(dist.claim(0, alice.address, e(100), tree.proof(1))).to.be.revertedWithCustomError(dist, "InvalidProof");
    // an internal node is not accepted as a leaf
    await expect(dist.claim(0, alice.address, e(100), [])).to.be.revertedWithCustomError(dist, "InvalidProof");
  });

  it("claimTo sends the caller's allocation elsewhere, but only for the caller's own leaf", async () => {
    const { dist, tree, token, alice, carol, mallory } = await loadFixture(deploy);
    await dist.connect(alice).claimTo(0, e(100), tree.proof(0), carol.address);
    expect(await token.balanceOf(carol.address)).to.equal(e(100));
    await expect(dist.connect(mallory).claimTo(1, e(200), tree.proof(1), mallory.address)).to.be.revertedWithCustomError(
      dist,
      "InvalidProof",
    );
    await expect(dist.connect(alice).claimTo(0, e(100), tree.proof(0), ethers.ZeroAddress)).to.be.revertedWithCustomError(
      dist,
      "ZeroAddress",
    );
  });

  it("closes claims at the deadline and lets only the owner sweep afterwards", async () => {
    const { dist, tree, token, owner, alice, bob, deadline } = await loadFixture(deploy);
    await dist.connect(alice).claim(0, alice.address, e(100), tree.proof(0));
    await expect(dist.sweep(owner.address)).to.be.revertedWithCustomError(dist, "ClaimWindowOpen");
    await time.increaseTo(deadline + 1n);
    await expect(dist.claim(1, bob.address, e(200), tree.proof(1))).to.be.revertedWithCustomError(dist, "ClaimWindowClosed");
    await expect(dist.connect(bob).sweep(bob.address)).to.be.revertedWithCustomError(dist, "OwnableUnauthorizedAccount");
    const left = tree.total() - e(100);
    await expect(dist.sweep(owner.address)).to.emit(dist, "Swept").withArgs(owner.address, left);
    expect(await token.balanceOf(owner.address)).to.equal(left);
  });

  it("validates constructor arguments", async () => {
    const { owner, token, tree } = await loadFixture(deploy);
    const now = BigInt(await time.latest());
    await expect(
      ethers.deployContract("MerkleDistributor", [owner.address, token, tree.root, now]),
    ).to.be.revertedWithCustomError(await ethers.getContractFactory("MerkleDistributor"), "InvalidDeadline");
  });

  it("serialises proofs for a claim frontend", async () => {
    const { tree, alice } = await loadFixture(deploy);
    const json = tree.toJSON();
    expect(json.root).to.equal(tree.root);
    expect(json.claims[alice.address].proof).to.deep.equal(tree.proof(0));
    expect(BigInt(json.total)).to.equal(tree.total());
  });
});
