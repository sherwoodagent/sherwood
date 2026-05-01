// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {GuardianRegistry} from "../../src/GuardianRegistry.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";

import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";
import {MockL2Registrar} from "../mocks/MockL2Registrar.sol";

/// @title SyndicateFactory_rotateOwner_proposalGuard — MS-H8 regression
/// @notice Confirms that `SyndicateFactory.rotateOwner` reverts while a
///         proposal still binds the vault. Without the guard, a factory owner
///         could hot-swap the vault owner mid-execution; the new owner would
///         inherit `pause()` and other owner-only powers in the middle of a
///         live proposal lifecycle.
///
///         The natural happy-path of `rotateOwner` requires the prior owner to
///         have fully unstaked, and `GuardianRegistry.requestUnstakeOwner`
///         already rejects unstake while a proposal is open. To reach the new
///         guard in isolation, these tests use `vm.mockCall` to simulate the
///         governor reporting an open / active proposal *after* the prior
///         owner unstaked (e.g. via a reentrancy edge case, a governor
///         upgrade, or an off-by-one in the unstake check). The guard must
///         hold even under those conditions.
contract SyndicateFactory_rotateOwner_proposalGuard is Test {
    SyndicateFactory public factory;
    SyndicateGovernor public governor;
    SyndicateVault public vaultImpl;
    GuardianRegistry public registry;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    ERC20Mock public wood;
    MockAgentRegistry public agentRegistry;
    MockL2Registrar public ensRegistrar;

    address public owner = makeAddr("factoryOwner");
    address public creator = makeAddr("creator");
    address public newOwner = makeAddr("newOwner");
    uint256 public creatorAgentId;
    uint256 public newOwnerAgentId;

    uint256 constant MIN_GUARDIAN_STAKE = 10_000e18;
    uint256 constant MIN_OWNER_STAKE = 10_000e18;
    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant BLOCK_QUORUM_BPS = 3000;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        executorLib = new BatchExecutorLib();
        vaultImpl = new SyndicateVault();
        agentRegistry = new MockAgentRegistry();
        ensRegistrar = new MockL2Registrar();

        creatorAgentId = agentRegistry.mint(creator);
        newOwnerAgentId = agentRegistry.mint(newOwner);

        // Same nonce-prediction triangle as factory/OwnerStakeAtCreation.t.sol
        uint256 baseNonce = vm.getNonce(address(this));
        address predictedRegistryProxy = vm.computeCreateAddress(address(this), baseNonce + 4);
        address predictedFactoryProxy = vm.computeCreateAddress(address(this), baseNonce + 5);

        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (
                ISyndicateGovernor.InitParams({
                    owner: owner,
                    votingPeriod: 1 days,
                    executionWindow: 1 days,
                    vetoThresholdBps: 4000,
                    maxPerformanceFeeBps: 3000,
                    cooldownPeriod: 1 days,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 hours,
                    maxStrategyDuration: 30 days,
                    protocolFeeBps: 0,
                    protocolFeeRecipient: address(0),
                    guardianFeeBps: 0
                }),
                predictedRegistryProxy
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        SyndicateFactory factoryImpl = new SyndicateFactory();
        GuardianRegistry regImpl = new GuardianRegistry();
        bytes memory regInit = abi.encodeCall(
            GuardianRegistry.initialize,
            (
                owner,
                address(governor),
                predictedFactoryProxy,
                address(wood),
                MIN_GUARDIAN_STAKE,
                MIN_OWNER_STAKE,
                7 days,
                REVIEW_PERIOD,
                BLOCK_QUORUM_BPS
            )
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(regImpl), regInit)));
        require(address(registry) == predictedRegistryProxy, "registry address prediction mismatch");

        bytes memory factoryInit = abi.encodeCall(
            SyndicateFactory.initialize,
            (SyndicateFactory.InitParams({
                    owner: owner,
                    executorImpl: address(executorLib),
                    vaultImpl: address(vaultImpl),
                    ensRegistrar: address(ensRegistrar),
                    agentRegistry: address(agentRegistry),
                    governor: address(governor),
                    managementFeeBps: 50,
                    guardianRegistry: address(registry)
                }))
        );
        factory = SyndicateFactory(address(new ERC1967Proxy(address(factoryImpl), factoryInit)));
        require(address(factory) == predictedFactoryProxy, "factory address prediction mismatch");

        vm.prank(owner);
        governor.setFactory(address(factory));

        wood.mint(creator, 100_000e18);
        wood.mint(newOwner, 100_000e18);
    }

    function _prepareStake(address who) internal {
        vm.prank(who);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(who);
        registry.prepareOwnerStake(MIN_OWNER_STAKE);
    }

    /// @dev Creates a vault, then unstakes so `hasOwnerStake == false` — the
    ///      preexisting `rotateOwner` happy-path precondition.
    function _createAndUnstake() internal returns (address vault) {
        _prepareStake(creator);
        vm.prank(creator);
        SyndicateFactory.SyndicateConfig memory cfg = SyndicateFactory.SyndicateConfig({
            metadataURI: "ipfs://test",
            asset: usdc,
            name: "Test Vault",
            symbol: "tVault",
            openDeposits: false,
            subdomain: "rotate-fund"
        });
        (, vault) = factory.createSyndicate(creatorAgentId, cfg);

        vm.prank(creator);
        registry.requestUnstakeOwner(vault);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(creator);
        registry.claimUnstakeOwner(vault);
        assertFalse(registry.hasOwnerStake(vault));
    }

    // ──────────────────────────────────────────────────────────────
    // MS-H8 — proposal guard on rotateOwner
    // ──────────────────────────────────────────────────────────────

    /// @notice Happy path: rotation succeeds when no proposal binds the vault.
    ///         Acts as a regression sentinel — confirms the new guard does not
    ///         block the legitimate use case.
    function test_rotateOwner_succeedsWhenNoProposals() public {
        address vault = _createAndUnstake();
        _prepareStake(newOwner);

        // Sanity: governor reports no live or open proposals.
        assertEq(governor.getActiveProposal(vault), 0);
        assertEq(governor.openProposalCount(vault), 0);

        vm.prank(owner);
        factory.rotateOwner(vault, newOwner);

        assertEq(SyndicateVault(payable(vault)).owner(), newOwner, "vault rotated");
        assertTrue(registry.hasOwnerStake(vault), "new owner stake bound");
    }

    /// @notice Reverts with `ProposalActive` when `getActiveProposal != 0`.
    ///         Even if the prior owner has unstaked (which the registry
    ///         normally prevents while a proposal is open), the factory must
    ///         not rotate while a strategy is mid-execution.
    function test_rotateOwner_revertsWhenActiveProposal() public {
        address vault = _createAndUnstake();
        _prepareStake(newOwner);

        // Force the governor to report an active proposal on this vault.
        vm.mockCall(
            address(governor),
            abi.encodeWithSelector(ISyndicateGovernor.getActiveProposal.selector, vault),
            abi.encode(uint256(42))
        );
        // openProposalCount stays zero so we hit the ProposalActive branch first.
        vm.mockCall(
            address(governor),
            abi.encodeWithSelector(ISyndicateGovernor.openProposalCount.selector, vault),
            abi.encode(uint256(0))
        );

        vm.prank(owner);
        vm.expectRevert(SyndicateFactory.ProposalActive.selector);
        factory.rotateOwner(vault, newOwner);

        // Vault owner unchanged.
        assertEq(SyndicateVault(payable(vault)).owner(), creator, "rotation did not occur");
    }

    /// @notice Reverts with `ProposalsOpen` when `openProposalCount > 0` but
    ///         `getActiveProposal == 0` (Pending / GuardianReview / Approved
    ///         states, pre-execute).
    function test_rotateOwner_revertsWhenOpenProposalCount() public {
        address vault = _createAndUnstake();
        _prepareStake(newOwner);

        // No live execution, but a Pending / GuardianReview proposal exists.
        vm.mockCall(
            address(governor),
            abi.encodeWithSelector(ISyndicateGovernor.getActiveProposal.selector, vault),
            abi.encode(uint256(0))
        );
        vm.mockCall(
            address(governor),
            abi.encodeWithSelector(ISyndicateGovernor.openProposalCount.selector, vault),
            abi.encode(uint256(1))
        );

        vm.prank(owner);
        vm.expectRevert(SyndicateFactory.ProposalsOpen.selector);
        factory.rotateOwner(vault, newOwner);

        assertEq(SyndicateVault(payable(vault)).owner(), creator, "rotation did not occur");
    }

    /// @notice Regression: existing `!hasOwnerStake` precondition still fires
    ///         and takes precedence over the new proposal guard. The original
    ///         behavior should not change for the staked-owner branch.
    function test_rotateOwner_vaultStillStakedTakesPrecedence() public {
        _prepareStake(creator);
        vm.prank(creator);
        SyndicateFactory.SyndicateConfig memory cfg = SyndicateFactory.SyndicateConfig({
            metadataURI: "ipfs://test",
            asset: usdc,
            name: "Test Vault",
            symbol: "tVault",
            openDeposits: false,
            subdomain: "still-staked"
        });
        (, address vault) = factory.createSyndicate(creatorAgentId, cfg);

        _prepareStake(newOwner);
        // Mock an active proposal as well — the VaultStillStaked check fires
        // first, so neither ProposalActive nor ProposalsOpen should surface.
        vm.mockCall(
            address(governor),
            abi.encodeWithSelector(ISyndicateGovernor.getActiveProposal.selector, vault),
            abi.encode(uint256(99))
        );

        vm.prank(owner);
        vm.expectRevert(SyndicateFactory.VaultStillStaked.selector);
        factory.rotateOwner(vault, newOwner);
    }
}

