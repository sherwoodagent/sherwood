// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {GuardianRegistry} from "../../src/GuardianRegistry.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {DeploySherwood} from "../../script/Deploy.s.sol";
import {DeployTemplates} from "../../script/DeployTemplates.s.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/**
 * @title HyperEVMIntegrationTest
 * @notice Abstract base for fork-based integration tests on HyperEVM mainnet.
 *         Deploys protocol contracts fresh on the fork via the existing deploy
 *         scripts, funds LPs with HyperEVM-native USDC, and provides helpers
 *         for the full proposal lifecycle.
 *
 * @dev Skips if HYPEREVM_RPC_URL is not set. Run with:
 *      forge test --fork-url $HYPEREVM_RPC_URL --match-path "test/integration/HyperliquidGridFork.t.sol"
 *
 * @dev Owner of the deployed protocol contracts is `deployer` (the address of
 *      `DeploySherwood` script instance), NOT `owner`. This is because nested
 *      calls inside `deployCore` execute as the script address, and the script
 *      writes `d.deployer = msg.sender`. Subclasses needing owner-gated calls
 *      (e.g., setProtocolFeeRecipient) must `vm.prank(deployer)` not `vm.prank(owner)`.
 */
abstract contract HyperEVMIntegrationTest is Test {
    // ── HyperEVM mainnet addresses ──
    address constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;

    // Hyperliquid perp asset indices (current as of 2026-04)
    uint32 constant HL_BTC = 3;
    uint32 constant HL_ETH = 4;
    uint32 constant HL_SOL = 5;

    // ── Test actors ──
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address lp1 = makeAddr("lp1");
    address lp2 = makeAddr("lp2");

    // ── Deployed protocol (fresh on fork) ──
    SyndicateGovernor governor;
    SyndicateFactory factory;
    GuardianRegistry registry;
    ERC20Mock wood;
    address vaultImpl;
    address executorLib;
    address hyperliquidGridTemplate;
    address deployer;

    // Matches Deploy.s.sol DEFAULT_MIN_OWNER_STAKE
    uint256 constant MIN_OWNER_STAKE = 10_000e18;

    // ── Per-test syndicate ──
    SyndicateVault vault;
    uint256 agentNftId = 42;

    // ── Setup ──

    function setUp() public virtual {
        string memory rpc = vm.envOr("HYPEREVM_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        _deployWood();
        _deployProtocol();
        _deployTemplates();
        _bondOwnerStake();

        // Fund LPs with HyperEVM-native USDC via deal()
        deal(USDC, lp1, 60_000e6);
        deal(USDC, lp2, 40_000e6);
    }

    function _deployWood() internal {
        wood = new ERC20Mock("Wood", "WOOD", 18);
    }

    // ── Protocol deployment via the existing scripts ──

    function _deployProtocol() internal {
        DeploySherwood deployScript = new DeploySherwood();
        DeploySherwood.Config memory cfg = DeploySherwood.Config({
            ensRegistrar: address(0),
            agentRegistry: address(0),
            managementFeeBps: 50,
            protocolFeeBps: 200,
            maxStrategyDays: 14,
            votingPeriod: 1 days,
            woodToken: address(wood),
            slashAppealSeed: 0,
            epochZeroSeed: 0,
            betaMode: false
        });
        // `deployCore` constructs a Create3Factory owned by `msg.sender` and
        // then calls `c3.deploy(...)` from inside itself — so the owner must be
        // `address(deployScript)`. `vm.startBroadcast` only changes msg.sender
        // for *direct* external calls from the test contract; nested calls
        // inside the script still use the script's address. Pranking as the
        // script gives consistent ownership across the full deploy chain.
        // The resulting governor/factory/registry owners are also the script,
        // which is fine: these tests only exercise permissionless paths
        // (`createSyndicate`, voting, settlement) and never owner-gated ones.
        vm.prank(address(deployScript));
        DeploySherwood.Deployed memory d = deployScript.deployCore(cfg);

        governor = SyndicateGovernor(d.governorProxy);
        factory = SyndicateFactory(d.factoryProxy);
        registry = GuardianRegistry(d.registryProxy);
        vaultImpl = d.vaultImpl;
        executorLib = d.executorLib;
        deployer = d.deployer; // address(deployScript) — owner of factory/governor/registry
    }

    function _deployTemplates() internal {
        DeployTemplates t = new DeployTemplates();
        // Same reason as _deployProtocol: prank as the script so internal
        // c3.deploy calls match the Create3Factory owner.
        vm.prank(address(t));
        hyperliquidGridTemplate = t.deployHyperliquidGridTemplate();
    }

    /// @dev Mints WOOD to the syndicate owner and prepares the owner stake so that
    ///      `SyndicateFactory.createSyndicate` can bind it atomically. Without this
    ///      the factory reverts on the missing prepared stake.
    function _bondOwnerStake() internal {
        wood.mint(owner, MIN_OWNER_STAKE);
        vm.startPrank(owner);
        wood.approve(address(registry), type(uint256).max);
        registry.prepareOwnerStake(MIN_OWNER_STAKE);
        vm.stopPrank();
        // Factory binds the prepared stake atomically when createSyndicate is called.
    }

    // ── Test syndicate creation ──

    function _createSyndicate() internal returns (SyndicateVault) {
        SyndicateFactory.SyndicateConfig memory config = SyndicateFactory.SyndicateConfig({
            metadataURI: "ipfs://hyperliquid-fork-test",
            asset: IERC20(USDC),
            name: "HyperEVM Fork Test Vault",
            symbol: "hfUSDC",
            openDeposits: true,
            subdomain: "hyperliquid-fork-test"
        });

        vm.prank(owner);
        (, address vaultAddr) = factory.createSyndicate(agentNftId, config);
        SyndicateVault v = SyndicateVault(payable(vaultAddr));

        vm.prank(owner);
        v.registerAgent(43, agent);

        return v;
    }

    // ── Fund LPs and deposit ──

    function _fundAndDeposit(SyndicateVault v, uint256 lp1Amount, uint256 lp2Amount) internal {
        vm.startPrank(lp1);
        IERC20(USDC).approve(address(v), lp1Amount);
        v.deposit(lp1Amount, lp1);
        vm.stopPrank();

        vm.startPrank(lp2);
        IERC20(USDC).approve(address(v), lp2Amount);
        v.deposit(lp2Amount, lp2);
        vm.stopPrank();
    }

    // ── Clone and initialize a strategy template ──

    function _cloneAndInit(address template, bytes memory initData) internal returns (address clone) {
        clone = Clones.clone(template);
        (bool success,) =
            clone.call(abi.encodeWithSignature("initialize(address,address,bytes)", address(vault), agent, initData));
        require(success, "Strategy initialization failed");
    }

    // ── Propose, vote, advance to executable ──

    function _proposeVoteApprove(
        BatchExecutorLib.Call[] memory execCalls,
        BatchExecutorLib.Call[] memory settleCalls,
        uint256 feeBps,
        uint256 duration
    ) internal returns (uint256 proposalId) {
        vm.prank(agent);
        proposalId = governor.propose(
            address(vault), "ipfs://test", feeBps, duration, execCalls, settleCalls, _emptyCoProposers()
        );

        vm.warp(block.timestamp + 1);
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        // Warp past voting period
        ISyndicateGovernor.GovernorParams memory params = governor.getGovernorParams();
        vm.warp(block.timestamp + params.votingPeriod + 1);

        // Open guardian review (permissionless)
        registry.openReview(proposalId);

        // Warp past review period
        uint256 reviewPeriod = registry.reviewPeriod();
        vm.warp(block.timestamp + reviewPeriod + 1);

        // Resolve review (cohortTooSmall short-circuit if no guardians staked)
        registry.resolveReview(proposalId);

        // Now executable
        governor.executeProposal(proposalId);
    }

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }
}
