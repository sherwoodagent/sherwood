# Venice Private Inference — Option A: Strategy Contract + EOA Key Provisioning

## Overview

Strategy contract manages VVV staking on behalf of syndicates. Creator's EOA provisions Venice API key (Venice requires sVVV holder to sign). Key shared via XMTP.

## Architecture

```
Vault (any asset)
  │  executeBatch: [swap asset→WETH→VVV (multi-hop), approve VVV to strategy, strategy.deposit()]
  ▼
VeniceStrategy contract
  │  Stakes VVV → holds sVVV on behalf of vaults
  │  Tracks per-vault staked amounts
  │  delegateStake() → transfers sVVV to creator's wallet
  ▼
Creator's EOA (holds sVVV)
  │  Signs Venice validation token (EIP-191)
  │  Generates Venice API key
  │  Posts key to XMTP group (encrypted)
  ▼
All syndicate agents
    Read API key from XMTP → use Venice for private inference
```

## Key Constraint

Venice requires **the signing wallet to hold staked VVV (sVVV)** for API key generation. Contracts can't sign EIP-191. So: strategy contract manages bulk VVV position, delegates sVVV to creator's wallet for key provisioning.

## Contract: VeniceStrategy.sol

```solidity
contract VeniceStrategy {
    IERC20 public immutable vvv;
    address public immutable stakingContract;
    IERC20 public immutable sVVV; // receipt token (verify on BaseScan)

    mapping(address => uint256) public stakedAmount;    // vault → staked
    mapping(address => uint256) public delegatedAmount;  // vault → delegated to creator

    function deposit(address vault, uint256 amount) external {
        vvv.transferFrom(msg.sender, address(this), amount);
        vvv.approve(stakingContract, amount);
        IVeniceStaking(stakingContract).stake(amount);
        stakedAmount[vault] += amount;
    }

    function delegateStake(address vault, address recipient, uint256 amount) external {
        require(msg.sender == Ownable(vault).owner(), "not vault owner");
        require(stakedAmount[vault] - delegatedAmount[vault] >= amount, "insufficient");
        delegatedAmount[vault] += amount;
        sVVV.transfer(recipient, amount);
    }

    function unstakeAndReturn(address vault, uint256 amount) external {
        require(msg.sender == Ownable(vault).owner(), "not vault owner");
        IVeniceStaking(stakingContract).unstake(amount);
        vvv.transfer(vault, amount);
        stakedAmount[vault] -= amount;
    }
}
```

## CLI Commands: `sherwood venice`

### `sherwood venice setup`
- Swaps vault asset → WETH → VVV (multi-hop Uniswap) → deposits into strategy contract
- Options: `--vault`, `--amount`, `--fee`, `--slippage`, `--execute`
- Uses existing executeBatch pattern (like levered-swap)
- `assetAmount` = amount being deployed (vault capital at risk)

### `sherwood venice provision`
- Creator provisions Venice API key + shares via XMTP
- Verifies creator holds sVVV (from delegateStake)
- Web3 flow: GET token → sign → POST → API key
- Posts `VENICE_API_KEY` envelope to syndicate XMTP group

### `sherwood venice status`
- Shows: strategy staking position, creator's sVVV, DIEM earned, API key validity

## Multi-Hop Routing

Vault asset can be anything (USDC, WETH, DAI...). Route: `asset → WETH → VVV`.
- Add `exactInput` (multi-hop) + `quoteExactInput` to Uniswap integration
- Add `encodeSwapPath()` helper for Uniswap V3 packed path encoding
- If asset IS WETH, single-hop WETH→VVV

## Files Changed

| File | Action |
|------|--------|
| `contracts/src/VeniceStrategy.sol` | CREATE |
| `contracts/test/VeniceStrategy.t.sol` | CREATE |
| `cli/src/lib/addresses.ts` | MODIFY — add VENICE() |
| `cli/src/lib/abis.ts` | MODIFY — add staking/strategy/router ABIs |
| `cli/src/lib/quote.ts` | MODIFY — add multi-hop quote |
| `cli/src/lib/config.ts` | MODIFY — add veniceApiKey |
| `cli/src/lib/types.ts` | MODIFY — add VENICE_API_KEY message type |
| `cli/src/lib/venice.ts` | CREATE — API key provisioning |
| `cli/src/strategies/venice-stake.ts` | CREATE — batch builder |
| `cli/src/commands/venice.ts` | CREATE — setup/provision/status |
| `cli/src/index.ts` | MODIFY — wire commands |

## Pros
- Strategy contract isolates VVV from vault (vault owner can't misuse)
- Per-vault tracking of staking positions
- Clean separation: on-chain staking vs off-chain key provisioning

## Cons
- Requires sVVV delegation step (extra tx) before key provisioning
- If Venice doesn't support sVVV transfer (non-standard receipt), delegation breaks
- Creator must interact directly with strategy contract (not just CLI)
- Venice staking contract ABI unknown — must verify on BaseScan first
