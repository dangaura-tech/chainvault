import { AbiCoder, concat, keccak256 } from "ethers";

/** One allocation of a MerkleDistributor. */
export interface Allocation {
  account: string;
  amount: bigint;
}

const coder = AbiCoder.defaultAbiCoder();

/** Same double-hashed leaf as MerkleDistributor.leaf(index, account, amount). */
export function leafHash(index: number, account: string, amount: bigint): string {
  return keccak256(keccak256(coder.encode(["uint256", "address", "uint256"], [index, account, amount])));
}

/** Commutative pair hash used by OpenZeppelin's MerkleProof (sorted children). */
function hashPair(a: string, b: string): string {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * Binary Merkle tree over the allocation leaves. Odd nodes are promoted to the next level
 * unchanged, which MerkleProof verifies correctly because proofs simply omit that level.
 */
export class AllocationTree {
  readonly leaves: string[];
  readonly layers: string[][];

  constructor(readonly allocations: Allocation[]) {
    if (allocations.length === 0) throw new Error("empty allocation list");
    this.leaves = allocations.map((a, i) => leafHash(i, a.account, a.amount));
    this.layers = [this.leaves];
    while (this.layers[this.layers.length - 1].length > 1) {
      const prev = this.layers[this.layers.length - 1];
      const next: string[] = [];
      for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
      this.layers.push(next);
    }
  }

  get root(): string {
    return this.layers[this.layers.length - 1][0];
  }

  proof(index: number): string[] {
    const out: string[] = [];
    let i = index;
    for (const layer of this.layers.slice(0, -1)) {
      const sibling = i ^ 1;
      if (sibling < layer.length) out.push(layer[sibling]);
      i >>= 1;
    }
    return out;
  }

  total(): bigint {
    return this.allocations.reduce((s, a) => s + a.amount, 0n);
  }

  /** JSON a frontend can serve: root plus every recipient's index, amount and proof. */
  toJSON() {
    return {
      root: this.root,
      total: this.total().toString(),
      claims: Object.fromEntries(
        this.allocations.map((a, i) => [a.account, { index: i, amount: a.amount.toString(), proof: this.proof(i) }]),
      ),
    };
  }
}
