// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface ISyndicateGovernor {
    struct Call {
        address target;
        bytes data;
        uint256 value;
    }

    struct StrategyProposal {
        uint256 id;
        address proposer;
        address vault;
        string metadataURI;
        uint256 performanceFeeBps;
        uint256 splitIndex;
        uint256 strategyDuration;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 snapshotTimestamp;
        uint256 voteEnd;
        uint256 executeBy;
        uint256 executedAt;
        uint8 state;
    }

    function getProposal(uint256 proposalId) external view returns (StrategyProposal memory);
    function getProposalCalls(uint256 proposalId) external view returns (Call[] memory);
    function getCapitalSnapshot(uint256 proposalId) external view returns (uint256);
}

interface ISyndicateVault {
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);
}

/// @title SimulateProposal — Fork-test a governance proposal before it auto-passes
/// @notice Run with env vars: PROPOSAL_ID, GOVERNOR_ADDRESS, VAULT_ADDRESS
/// @dev forge test --fork-url $RPC_URL --match-test test_simulateProposalCalls -vvvv
contract SimulateProposal is Test {
    function test_simulateProposalCalls() public {
        uint256 proposalId = vm.envUint("PROPOSAL_ID");
        address governor = vm.envAddress("GOVERNOR_ADDRESS");
        address vault = vm.envAddress("VAULT_ADDRESS");

        // Fetch proposal metadata
        ISyndicateGovernor.StrategyProposal memory proposal =
            ISyndicateGovernor(governor).getProposal(proposalId);

        emit log_named_address("Proposer", proposal.proposer);
        emit log_named_address("Vault", proposal.vault);
        emit log_named_string("Metadata URI", proposal.metadataURI);
        emit log_named_uint("Performance Fee (bps)", proposal.performanceFeeBps);
        emit log_named_uint("Strategy Duration (s)", proposal.strategyDuration);
        emit log_named_uint("State", uint256(proposal.state));

        // Fetch proposal calls
        ISyndicateGovernor.Call[] memory calls =
            ISyndicateGovernor(governor).getProposalCalls(proposalId);

        emit log_named_uint("Number of calls", calls.length);

        // Log each call target and selector
        for (uint256 i = 0; i < calls.length; i++) {
            emit log_string("---");
            emit log_named_uint("Call index", i);
            emit log_named_address("Target", calls[i].target);
            emit log_named_uint("Value", calls[i].value);
            emit log_named_bytes("Data", calls[i].data);

            // Log the 4-byte selector for quick identification
            if (calls[i].data.length >= 4) {
                bytes4 selector;
                assembly {
                    selector := mload(add(mload(add(calls, mul(add(i, 1), 0x20))), 0x60))
                }
                emit log_named_bytes4("Selector", selector);
            }
        }

        // Record vault balance before
        address asset = ISyndicateVault(vault).asset();
        uint256 balanceBefore = IERC20(asset).balanceOf(vault);
        emit log_string("===");
        emit log_named_address("Vault asset", asset);
        emit log_named_uint("Vault balance BEFORE", balanceBefore);

        // Simulate each call as the vault (governor executes via vault)
        vm.startPrank(vault);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory ret) =
                calls[i].target.call{value: calls[i].value}(calls[i].data);
            assertTrue(
                success,
                string(abi.encodePacked("Call ", vm.toString(i), " FAILED"))
            );
            emit log_named_uint("Call succeeded", i);
            emit log_named_bytes("Return data", ret);
        }
        vm.stopPrank();

        // Record vault balance after
        uint256 balanceAfter = IERC20(asset).balanceOf(vault);
        emit log_string("===");
        emit log_named_uint("Vault balance AFTER", balanceAfter);

        if (balanceAfter >= balanceBefore) {
            emit log_named_uint("Balance INCREASE", balanceAfter - balanceBefore);
        } else {
            emit log_named_uint("Balance DECREASE", balanceBefore - balanceAfter);
        }
    }

    function test_simulateSettlement() public {
        uint256 proposalId = vm.envUint("PROPOSAL_ID");
        address governor = vm.envAddress("GOVERNOR_ADDRESS");
        address vault = vm.envAddress("VAULT_ADDRESS");

        // Get capital snapshot for P&L comparison
        uint256 capitalSnapshot =
            ISyndicateGovernor(governor).getCapitalSnapshot(proposalId);
        emit log_named_uint("Capital snapshot", capitalSnapshot);

        address asset = ISyndicateVault(vault).asset();
        uint256 currentBalance = IERC20(asset).balanceOf(vault);
        emit log_named_uint("Current balance", currentBalance);

        if (currentBalance >= capitalSnapshot) {
            emit log_named_uint("Profit", currentBalance - capitalSnapshot);
        } else {
            emit log_named_uint("Loss", capitalSnapshot - currentBalance);
        }

        // Settlement simulation: try calling settleProposal
        // This verifies the proposal CAN be settled without reverting
        (bool success,) = governor.call(
            abi.encodeWithSignature("settleProposal(uint256)", proposalId)
        );
        assertTrue(success, "settleProposal would revert — needs emergency settle");
    }
}
