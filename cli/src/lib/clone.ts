/**
 * ERC-1167 minimal proxy cloning from TypeScript.
 *
 * Mirrors OpenZeppelin's Clones.clone() — constructs the creation
 * bytecode for a minimal proxy and deploys via a raw transaction.
 */

import type { Address, Hex } from "viem";
import { concat } from "viem";
import { getWalletClient, getPublicClient, getAccount } from "./client.js";
import { getChain } from "./network.js";

/**
 * Deploy an ERC-1167 minimal proxy clone of a template contract.
 *
 * @param template - Address of the deployed template (implementation)
 * @returns The clone address and deployment tx hash
 */
export async function cloneTemplate(
  template: Address,
): Promise<{ clone: Address; hash: Hex }> {
  // ERC-1167 creation code (matches OpenZeppelin Clones.sol):
  //   Init code:    3d602d80600a3d3981f3
  //   Runtime code: 363d3d373d3d3d363d73 <address> 5af43d82803e903d91602b57fd5bf3
  const creationCode = concat([
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73",
    template,
    "0x5af43d82803e903d91602b57fd5bf3",
  ]);

  const wallet = getWalletClient();
  const account = getAccount();
  const chain = getChain();

  const hash = await wallet.sendTransaction({
    account,
    chain,
    data: creationCode as Hex,
    value: 0n,
  });

  const receipt = await getPublicClient().waitForTransactionReceipt({ hash });

  if (!receipt.contractAddress) {
    throw new Error(`Clone deployment failed — no contract address in receipt (tx: ${hash})`);
  }

  return { clone: receipt.contractAddress, hash };
}
