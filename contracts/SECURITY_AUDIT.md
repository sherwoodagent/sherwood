# Security Audit Report: Sherwood ve(3,3) Tokenomics System

**Auditor**: Claude Security Auditor
**Date**: 2026-03-31
**Scope**: 8 Solidity contracts in `contracts/src/`
**Target Network**: Base Mainnet

## Executive Summary

This audit reviews Sherwood's ve(3,3) tokenomics system consisting of 8 smart contracts implementing vote-escrow governance, epoch-based voting, and emissions distribution. The system enables users to lock WOOD tokens for veWOOD NFTs with voting power to direct emissions to syndicates.

**Risk Assessment**: MEDIUM-HIGH
**Total Findings**: 18 findings across all severity levels
**Recommendation**: Address all CRITICAL and HIGH severity issues before mainnet deployment.

## Scope

| Contract | Purpose | Lines of Code |
|----------|---------|---------------|
| WoodToken.sol | ERC-20 + LayerZero OFT, 1B cap | 47 |
| VotingEscrow.sol | Lock WOOD → veWOOD NFT voting power | 402 |
| Voter.sol | Epoch voting & gauge management | 403 |
| Minter.sol | 3-phase emissions + WOOD Fed voting | 416 |
| SyndicateGauge.sol | Per-syndicate emission distribution | 252 |
| VaultRewardsDistributor.sol | Vault depositor WOOD claims | 292 |
| VoteIncentive.sol | Bribe marketplace | 343 |
| RewardsDistributor.sol | veWOOD rebase distribution | 315 |

## Findings Summary

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 3 | Funds at risk, immediate exploitation possible |
| HIGH | 5 | Economic exploits, governance manipulation |
| MEDIUM | 6 | Logic issues, spec deviations |
| LOW | 3 | Best practices, minor issues |
| INFORMATIONAL | 1 | Optimization opportunities |

---

## CRITICAL SEVERITY

### [C-1] Missing Access Control in SyndicateGauge.receiveEmission()

**Contract**: SyndicateGauge.sol
**Location**: Lines 125-148

**Description**: The `receiveEmission()` function lacks access control, allowing anyone to call it and potentially drain the Minter's WOOD balance.

**Impact**: An attacker could call `receiveEmission()` with arbitrary amounts, forcing the Minter to transfer WOOD tokens to the gauge contract, potentially draining Minter's balance.

**Proof of Concept**:
```solidity
// Attacker calls directly
syndicateGauge.receiveEmission(1, 1000000e18); // Forces Minter to transfer 1M WOOD
```

**Recommendation**: Add access control to restrict calls to authorized contracts only:
```solidity
address public immutable minter;
modifier onlyMinter() {
    if (msg.sender != minter) revert NotAuthorized();
    _;
}
function receiveEmission(uint256 epoch, uint256 amount) external onlyMinter {
    // existing logic
}
```

### [C-2] Missing Access Control in VaultRewardsDistributor.depositRewards()

**Contract**: VaultRewardsDistributor.sol
**Location**: Lines 116-139

**Description**: The `depositRewards()` function contains a TODO comment indicating missing access control, allowing anyone to deposit rewards and manipulate reward calculations.

**Impact**: Attackers could deposit small amounts to create reward pools for arbitrary epochs, potentially disrupting the reward distribution mechanism or causing accounting issues.

**Proof of Concept**:
```solidity
// Attacker deposits minimal rewards for future epochs
vaultRewardsDistributor.depositRewards(1000, 1); // Epoch 1000, 1 wei
```

**Recommendation**: Implement proper access control to restrict calls to authorized contracts only.

### [C-3] Integer Overflow in Rebase Calculation

**Contract**: Minter.sol
**Location**: Lines 276-282

**Description**: The rebase calculation performs multiplication that could overflow before division, especially with large emission amounts.

**Impact**: Integer overflow could result in incorrect rebase calculations, potentially allowing users to claim more WOOD than intended or causing transaction reverts.

**Proof of Concept**:
```solidity
// If weeklyEmissions = type(uint256).max / 2 and unlockRatioSquared = BASIS_POINTS
// weeklyEmissions * unlockRatioSquared overflows before division
```

**Recommendation**: Use checked arithmetic or restructure the calculation:
```solidity
return (weeklyEmissions * unlockRatioSquared / BASIS_POINTS * REBASE_MULTIPLIER) / BASIS_POINTS;
```

---

## HIGH SEVERITY

### [H-1] Epoch Manipulation Through Block Timestamp Dependence

**Contract**: Voter.sol
**Location**: Lines 189-193, 247-253

**Description**: The `flipEpoch()` function relies on `block.timestamp` for epoch boundaries, which miners can manipulate within a ~15 second window.

**Impact**: Miners could manipulate epoch timing to influence vote outcomes, especially for close votes or to extend/shorten voting windows.

**Recommendation**: Implement a buffer period around epoch boundaries and consider using block numbers instead of timestamps for critical logic.

### [H-2] Vote Power Calculation Uses Current Balance Instead of Epoch Snapshot

**Contract**: Voter.sol
**Location**: Lines 150-151, 391-401

**Description**: The voting system uses `votingEscrow.balanceOfNFT(tokenId)` which returns current voting power, not the power at epoch start.

**Impact**: Users could lock additional WOOD after seeing vote results but before voting closes, manipulating their voting power retroactively.

**Recommendation**: Use historical voting power at epoch start:
```solidity
uint256 votingPower = votingEscrow.balanceOfNFTAt(tokenId, getEpochStart(currentEpoch));
```

### [H-3] Gauge Cap Redistribution Logic Can Be Gamed

**Contract**: Voter.sol
**Location**: Lines 322-374

**Description**: The 25% cap redistribution algorithm redistributes excess votes proportionally to uncapped gauges, which could be exploited by creating many small syndicates to capture redistributed votes.

**Impact**: An attacker controlling multiple small syndicates could receive a disproportionate share of redistributed votes when large syndicates hit the cap.

**Recommendation**: Implement a minimum threshold for redistribution or use a different redistribution mechanism that's harder to game.

### [H-4] Missing Slashing Protection in VotingEscrow

**Contract**: VotingEscrow.sol
**Location**: Lines 202-230

**Description**: Users can withdraw immediately after lock expiry without any cooldown period, potentially enabling flash loan attacks for temporary voting power.

**Impact**: Users could take flash loans, create locks, vote, and potentially withdraw in the same transaction for some attack vectors.

**Recommendation**: Implement a minimum cooldown period between lock creation/extension and withdrawal.

### [H-5] Unclaimed Incentive Tokens Can Be Drained

**Contract**: VoteIncentive.sol
**Location**: Lines 271-305

**Description**: The `_claimSingleIncentive()` function doesn't validate that the calculated amount doesn't exceed available pool balance, potentially allowing over-claiming due to rounding errors.

**Impact**: Rounding errors in pro-rata calculations could lead to the total claimable amount exceeding the deposited pool amount, causing later claimers to receive nothing.

**Recommendation**: Add validation to ensure total claims don't exceed pool amount:
```solidity
require(pool.totalClaimed + amount <= pool.amount, "Insufficient pool balance");
```

---

## MEDIUM SEVERITY

### [M-1] Auto-Max-Lock Cannot Be Withdrawn

**Contract**: VotingEscrow.sol
**Location**: Lines 207-209

**Description**: Auto-max-lock positions can never be withdrawn as the check `lock.autoMaxLock || block.timestamp < lock.end` always prevents withdrawal.

**Impact**: Users with auto-max-lock enabled will have their WOOD permanently locked, which may not be the intended behavior and could lead to user fund loss.

**Recommendation**: Clarify the intended behavior in documentation or allow disabling auto-max-lock before withdrawal.

### [M-2] Missing Quorum Fallback Implementation

**Contract**: Voter.sol
**Location**: Lines 274-282

**Description**: While the code checks for quorum, there's no implementation of the fallback behavior mentioned in the spec (carry forward previous epoch's allocation).

**Impact**: If quorum isn't met, the system behavior is undefined, potentially leading to zero emissions or system halt.

**Recommendation**: Implement the fallback logic to carry forward the previous epoch's valid vote allocation.

### [M-3] Circuit Breaker Implementation Incomplete

**Contract**: Minter.sol
**Location**: Lines 237-246

**Description**: The circuit breaker only has manual triggers and lacks the automated price/lock rate checks mentioned in comments.

**Impact**: The system may not respond quickly enough to market conditions without automated circuit breaker triggers.

**Recommendation**: Implement price oracles and automated trigger conditions for the circuit breaker.

### [M-4] LP Reward Calculation Not Implemented

**Contract**: SyndicateGauge.sol
**Location**: Lines 242-251

**Description**: The `_calculateLPReward()` function is a stub that always returns 0, meaning LP rewards are never distributed.

**Impact**: LPs during the bootstrapping period (epochs 1-12) will not receive their promised emissions share, breaking the tokenomics model.

**Recommendation**: Implement proper Uniswap V3 position querying and pro-rata LP reward calculation.

### [M-5] Voting Power Decay Calculation Edge Cases

**Contract**: VotingEscrow.sol
**Location**: Lines 302-303

**Description**: The linear decay calculation `(lock.amount * timeLeft) / MAX_LOCK_DURATION` could result in incorrect voting power for locks shorter than the maximum duration.

**Impact**: Users with shorter locks may receive disproportionate voting power compared to the intended linear relationship.

**Recommendation**: Use the actual lock duration in the denominator:
```solidity
uint256 lockDuration = lock.end - lockCreationTime;
return (lock.amount * timeLeft) / lockDuration;
```

### [M-6] Reward Expiry Logic Allows Permanent Fund Lock

**Contract**: VaultRewardsDistributor.sol
**Location**: Lines 205-220

**Description**: Expired rewards are only returned when `returnExpiredRewards()` is called, which requires manual intervention.

**Impact**: Rewards could remain locked in the contract indefinitely if nobody calls the function, effectively removing WOOD from circulation.

**Recommendation**: Implement automatic return of expired rewards or add a background job to handle this.

---

## LOW SEVERITY

### [L-1] Missing Event for Critical Parameter Changes

**Contract**: Multiple contracts
**Location**: Various

**Description**: Several critical functions lack events for transparency and monitoring.

**Impact**: Reduced transparency and difficulty in monitoring system state changes.

**Recommendation**: Add events for all state-changing functions.

### [L-2] Inconsistent Error Messages

**Contract**: Multiple contracts
**Location**: Various

**Description**: Error messages use inconsistent naming and don't always clearly indicate the failure reason.

**Impact**: Poor developer experience and debugging difficulty.

**Recommendation**: Standardize error messages across all contracts.

### [L-3] Unbounded Loop in VaultRewardsDistributor.getClaimableEpochs()

**Contract**: VaultRewardsDistributor.sol
**Location**: Lines 259-263

**Description**: The function iterates through all epochs which could cause gas issues as the system ages.

**Impact**: Function may become unusable due to gas limits as the number of epochs grows.

**Recommendation**: Add pagination or limit the search range:
```solidity
function getClaimableEpochs(address depositor, uint256 fromEpoch, uint256 toEpoch) external view returns (uint256[] memory epochs)
```

---

## INFORMATIONAL

### [I-1] Gas Optimization Opportunities

**Contract**: Multiple contracts

**Description**: Several functions could be optimized for gas usage:
- Voter.sol vote distribution calculation could cache array lengths
- VotingEscrow.sol could use packed structs
- Loop optimizations in various functions

**Recommendation**: Implement gas optimizations before mainnet deployment.

---

## Recommendations by Priority

### Immediate (Before Mainnet)
1. Fix all CRITICAL access control issues (C-1, C-2)
2. Address integer overflow in rebase calculation (C-3)
3. Implement voting power snapshots (H-2)
4. Add slashing protection (H-4)

### High Priority
1. Fix epoch manipulation vulnerability (H-1)
2. Implement LP reward calculation (M-4)
3. Add missing quorum fallback logic (M-2)
4. Fix auto-max-lock withdrawal issue (M-1)

### Medium Priority
1. Complete circuit breaker implementation (M-3)
2. Fix voting power decay edge cases (M-5)
3. Implement automatic reward expiry handling (M-6)
4. Add gauge cap redistribution safeguards (H-3)

### Low Priority
1. Add missing events (L-1)
2. Standardize error messages (L-2)
3. Implement pagination for long-running views (L-3)
4. Gas optimizations (I-1)

## Conclusion

The Sherwood ve(3,3) tokenomics system implements a complex but well-architected governance and emissions system. However, several critical security issues must be addressed before mainnet deployment, particularly around access control and economic attack vectors.

The system shows good use of established patterns (ReentrancyGuard, SafeERC20, etc.) but needs additional hardening around edge cases and potential manipulation vectors. With proper fixes, this system can provide a robust foundation for decentralized governance and emissions distribution.

**Overall Risk**: MEDIUM-HIGH
**Recommendation**: Complete security fixes and conduct additional testing before mainnet launch.