# Error Handling

Common errors, causes, and fixes when using the Sherwood CLI.

## Setup Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Private key not found` | No key in config | `sherwood config set --private-key 0x...` |
| `Agent identity required` | No agentId saved | `sherwood identity mint --name "..."` |

## Permission Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `NotCreator` | Wallet isn't the syndicate creator | Use the creator wallet |
| `NotAllowedTarget` | Contract not in vault allowlist | `sherwood vault add-target --target 0x...` |
| `DepositorNotApproved` | LP not whitelisted | `sherwood syndicate approve-depositor --depositor 0x...` |

## Execution Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `CapExceeded` | Batch exceeds vault caps | Lower amounts or update caps |
| `Simulation failed` | Batch would revert on-chain | Check caps, allowlist, token balances |
| `ERC721InvalidReceiver` | Vault can't receive NFTs | Vault includes ERC721Holder — redeploy if on old version |
| `Could not read decimals` | Invalid token address | Verify address is a valid ERC20 on Base |
| `Pinata upload failed` | IPFS metadata upload error | Check network; override with `PINATA_API_KEY` env var |
