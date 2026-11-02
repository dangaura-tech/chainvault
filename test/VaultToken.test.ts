import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("VaultToken", () => {
  const CAP = ethers.parseEther("100000000");
  const INITIAL = ethers.parseEther("10000000");

  async function deploy() {
    const [admin, alice, bob] = await ethers.getSigners();
    const token = await ethers.deployContract("VaultToken", [admin.address, CAP, INITIAL]);
    return { token, admin, alice, bob };
  }

  it("has correct metadata and initial supply", async () => {
    const { token, admin } = await loadFixture(deploy);
    expect(await token.name()).to.equal("Vault Token");
    expect(await token.symbol()).to.equal("VLT");
    expect(await token.cap()).to.equal(CAP);
    expect(await token.balanceOf(admin.address)).to.equal(INITIAL);
  });

  it("only minters can mint, and never above the cap", async () => {
    const { token, alice } = await loadFixture(deploy);
    await expect(token.connect(alice).mint(alice.address, 1n))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
      .withArgs(alice.address, await token.MINTER_ROLE());
    await token.mint(alice.address, CAP - INITIAL);
    await expect(token.mint(alice.address, 1n)).to.be.revertedWithCustomError(token, "ERC20ExceededCap");
  });

  it("supports EIP-2612 permit", async () => {
    const { token, admin, alice } = await loadFixture(deploy);
    const value = ethers.parseEther("5");
    const deadline = ethers.MaxUint256;
    const { chainId } = await ethers.provider.getNetwork();
    const signature = await admin.signTypedData(
      { name: "Vault Token", version: "1", chainId, verifyingContract: await token.getAddress() },
      {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { owner: admin.address, spender: alice.address, value, nonce: 0n, deadline },
    );
    const { v, r, s } = ethers.Signature.from(signature);
    await token.connect(alice).permit(admin.address, alice.address, value, deadline, v, r, s);
    expect(await token.allowance(admin.address, alice.address)).to.equal(value);
    expect(await token.nonces(admin.address)).to.equal(1n);
  });

  it("tracks voting power through delegation and transfers", async () => {
    const { token, admin, alice, bob } = await loadFixture(deploy);
    await token.transfer(alice.address, ethers.parseEther("100"));
    expect(await token.getVotes(alice.address)).to.equal(0n); // not delegated yet
    await token.connect(alice).delegate(bob.address);
    expect(await token.getVotes(bob.address)).to.equal(ethers.parseEther("100"));
    await token.connect(alice).transfer(admin.address, ethers.parseEther("40"));
    expect(await token.getVotes(bob.address)).to.equal(ethers.parseEther("60"));
  });

  it("allows holders to burn", async () => {
    const { token, admin } = await loadFixture(deploy);
    await token.burn(ethers.parseEther("1"));
    expect(await token.totalSupply()).to.equal(INITIAL - ethers.parseEther("1"));
    expect(await token.balanceOf(admin.address)).to.equal(INITIAL - ethers.parseEther("1"));
  });
});
