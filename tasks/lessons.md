# Lessons Learned

## 2026-04-08 — Hyperliquid Strategy Review

### Access control on public settlement functions
When a strategy has multi-phase settlement with async transfers, any external-facing function that moves funds MUST have access control (onlyProposer/onlyVault). Without it, MEV bots can front-run and cause partial sweeps that permanently lock funds. Always check: "can a third party call this at the wrong time?"

### Advisory values must be enforced or removed
If a contract stores a `minReturnAmount` that governance voters see when approving a proposal, it MUST be enforced on-chain during settlement. Otherwise it's misleading. Either enforce it in `sweepToVault()` or remove it entirely.

### Version bump direction matters
When branching from main, the branch version must be HIGHER than main. A downgrade (0.24.0 -> 0.23.0) will cause npm publish confusion. Always check `git show main:cli/package.json | grep version` before setting the version.

### Null-safety guards for optional infrastructure
On UUPS upgradeable contracts, removing null-safety checks (e.g., for ENS registrar or agent registry) breaks existing proxies that were initialized with address(0). Always keep optional-infrastructure guards unless you're certain all existing proxies have non-zero addresses.

### Shared utilities prevent drift
When the same utility function (like `clamp()`) is copy-pasted into 9 files, bugs or signature changes only get fixed in some of them. Extract to a shared module immediately.

### Risk config needs bounds
CLI tools that persist risk parameters to disk must validate bounds before writing. Otherwise a single bad `--set` command can silently disable all safety guardrails.
