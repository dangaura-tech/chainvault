/**
 * Build a MerkleDistributor allocation tree from a CSV of `address,amount` rows
 * (amount in whole tokens, 18 decimals) and write the root and every proof to JSON.
 *
 *   npx ts-node scripts/build-merkle.ts allocations.csv distribution.json
 */
import { readFileSync, writeFileSync } from "fs";
import { getAddress, parseEther } from "ethers";
import { AllocationTree } from "./lib/merkle";

function main() {
  const [input, output = "distribution.json"] = process.argv.slice(2);
  if (!input) throw new Error("usage: build-merkle.ts <allocations.csv> [out.json]");
  const seen = new Set<string>();
  const allocations = readFileSync(input, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !/^address\s*,/i.test(l))
    .map((line, n) => {
      const [addr, amount] = line.split(",").map((s) => s.trim());
      const account = getAddress(addr); // validates the checksum / format
      if (seen.has(account)) throw new Error(`duplicate address on data line ${n + 1}: ${account}`);
      seen.add(account);
      return { account, amount: parseEther(amount) };
    });
  const tree = new AllocationTree(allocations);
  writeFileSync(output, JSON.stringify(tree.toJSON(), null, 2));
  console.log(`${allocations.length} recipients, total ${tree.total()} wei, root ${tree.root} -> ${output}`);
}

main();
