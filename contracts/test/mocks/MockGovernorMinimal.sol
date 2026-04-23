// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal governor mock exposing the surface consumed by
///         GuardianRegistry: `getActiveProposal(address)` for owner-unstake
///         gating, and `getProposal(uint256)` returning the review-window
///         timestamps consumed by `openReview` / `voteOnProposal` /
///         `resolveReview`. The returned struct matches the shape of
///         `IGovernorMinimal.ProposalView` defined inside GuardianRegistry.
contract MockGovernorMinimal {
    struct ProposalView {
        uint256 voteEnd;
        uint256 reviewEnd;
        address vault;
    }

    mapping(address => uint256) public activeProposal;
    mapping(uint256 => ProposalView) internal _proposals;
    /// @dev Mirrors the per-vault open-proposal counter added in PR #229 Fix 2.
    mapping(address => uint256) public openProposalCount;

    function setActiveProposal(address vault, uint256 proposalId) external {
        activeProposal[vault] = proposalId;
    }

    /// @dev Test helper — mirrors `SyndicateGovernor.openProposalCount(vault)`
    ///      which the registry now consults in `requestUnstakeOwner`.
    function setOpenProposalCount(address vault, uint256 n) external {
        openProposalCount[vault] = n;
    }

    function getActiveProposal(address vault) external view returns (uint256) {
        return activeProposal[vault];
    }

    /// @dev Sets a proposal with no associated vault. Used by tests that only
    ///      exercise the non-emergency review path.
    function setProposal(uint256 proposalId, uint256 voteEnd, uint256 reviewEnd) external {
        _proposals[proposalId] = ProposalView({voteEnd: voteEnd, reviewEnd: reviewEnd, vault: address(0)});
    }

    /// @dev Sets a proposal with an associated vault for emergency-review tests
    ///      that need `_slashOwner` to resolve the vault address.
    function setProposalWithVault(uint256 proposalId, uint256 voteEnd, uint256 reviewEnd, address vault) external {
        _proposals[proposalId] = ProposalView({voteEnd: voteEnd, reviewEnd: reviewEnd, vault: vault});
    }

    function getProposal(uint256 proposalId) external view returns (ProposalView memory) {
        return _proposals[proposalId];
    }

    /// @dev Mirrors `GuardianRegistry.IGovernorMinimal.getProposalView` (Task 25).
    ///      Registry calls this via the `IGovernorMinimal` interface to read the
    ///      narrow review-window struct without pulling in the full governor ABI.
    function getProposalView(uint256 proposalId) external view returns (ProposalView memory) {
        return _proposals[proposalId];
    }
}
