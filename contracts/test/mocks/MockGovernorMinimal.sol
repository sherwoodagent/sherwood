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
    }

    mapping(address => uint256) public activeProposal;
    mapping(uint256 => ProposalView) internal _proposals;

    function setActiveProposal(address vault, uint256 proposalId) external {
        activeProposal[vault] = proposalId;
    }

    function getActiveProposal(address vault) external view returns (uint256) {
        return activeProposal[vault];
    }

    function setProposal(uint256 proposalId, uint256 voteEnd, uint256 reviewEnd) external {
        _proposals[proposalId] = ProposalView({voteEnd: voteEnd, reviewEnd: reviewEnd});
    }

    function getProposal(uint256 proposalId) external view returns (ProposalView memory) {
        return _proposals[proposalId];
    }
}
