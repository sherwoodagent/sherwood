// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal guardian-registry mock exposing the read surface consumed by
///         SyndicateGovernor: `reviewPeriod()` (called during `propose` /
///         `settleProposal` to compute `reviewEnd`), `resolveReview()` (called
///         on the Approved edge after the review window elapses), and
///         `getReviewState()` (consulted by `getProposalState`).
///
///         Defaults model a "no review" cohort so governor unit tests that
///         pre-date the guardian-review lifecycle keep their previous
///         semantics: `reviewPeriod == 0` (no review window), `resolveReview`
///         returns `false` (never blocks), and `getReviewState` returns
///         `resolved = true, blocked = false` so `_resolveAfterVote` maps a
///         passing vote straight to Approved once the vote window closes.
///
///         Used by governor unit tests that exercise the optimistic path and
///         don't need a full `GuardianRegistry` + WOOD + staking setup. Tests
///         that drive the guardian-review lifecycle (open/resolve/slash) must
///         use a real `GuardianRegistry` proxy.
contract MockRegistryMinimal {
    uint256 public reviewPeriod;

    function setReviewPeriod(uint256 r) external {
        reviewPeriod = r;
    }

    function resolveReview(uint256) external pure returns (bool blocked) {
        return false;
    }

    function getReviewState(uint256)
        external
        pure
        returns (bool opened, bool resolved, bool blocked, bool cohortTooSmall)
    {
        // `resolved = true` so _resolveAfterVote skips straight to Approved
        // when reviewPeriod == 0. `blocked = false` so the vote outcome sticks.
        return (true, true, false, false);
    }
}
