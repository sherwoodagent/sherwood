#!/usr/bin/env python3
"""
Enable big blocks (30M gas limit) on HyperEVM for contract deployments.

HyperEVM defaults to small blocks (2M gas), which is too low for deploying
large contracts like SyndicateGovernor (~5M gas). This script sends an L1
action to switch your account to big blocks.

Usage:
  pip install hyperliquid-python-sdk
  PRIVATE_KEY=0x... python scripts/enable-big-blocks.py

To disable after deployment:
  PRIVATE_KEY=0x... python scripts/enable-big-blocks.py --disable
"""

import os
import sys
from eth_account import Account
from hyperliquid.utils import constants
from hyperliquid.exchange import Exchange


def main():
    private_key = os.environ.get("PRIVATE_KEY")
    if not private_key:
        print("Error: PRIVATE_KEY env var is required")
        print("Usage: PRIVATE_KEY=0x... python scripts/enable-big-blocks.py")
        sys.exit(1)

    disable = "--disable" in sys.argv
    enable = not disable

    account = Account.from_key(private_key)
    print(f"Account: {account.address}")
    print(f"Action:  {'ENABLE' if enable else 'DISABLE'} big blocks")

    exchange = Exchange(account, constants.MAINNET_API_URL)
    result = exchange.use_big_blocks(enable)

    print(f"Result:  {result}")

    if result.get("status") == "err":
        print(f"\nFailed: {result.get('response', 'unknown error')}")
        print("If 'User does not exist': deposit any amount on https://app.hyperliquid.xyz first.")
        sys.exit(1)

    if enable:
        print("\nBig blocks enabled (30M gas limit).")
        print("You can now deploy large contracts on HyperEVM.")
        print("\nRun deployment:")
        print("  cd contracts")
        print("  forge script script/hyperevm/Deploy.s.sol:DeployHyperEVM \\")
        print("    --rpc-url hyperevm --account sherwood-deployer \\")
        print("    --sender <your_address> --broadcast")
        print("\nAfter deployment, disable big blocks:")
        print("  PRIVATE_KEY=0x... python scripts/enable-big-blocks.py --disable")
    else:
        print("\nBig blocks disabled. Back to standard 2M gas limit.")


if __name__ == "__main__":
    main()
