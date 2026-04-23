// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";

/**
 * @title RobinhoodIntegrationTest
 * @notice Abstract base for fork-based integration tests against Robinhood L2 testnet.
 *         Reads deployed Sherwood addresses from chains/46630.json and creates a test
 *         syndicate with funded LPs for each test.
 *
 *         Key differences from BaseIntegrationTest (Base mainnet):
 *           - WETH is the vault asset (no USDC on Robinhood)
 *           - No ENS or ERC-8004 mocking needed — deployed factory has address(0) for both
 *           - Stock tokens (TSLA, AMZN, etc.) available via Synthra DEX
 *
 * @dev Run with: forge test --fork-url https://rpc.testnet.chain.robinhood.com --match-path test/integration/**
 */
abstract contract RobinhoodIntegrationTest is Test {
    // ── Robinhood L2 token addresses ──

    address constant WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    // Synthra uses its own WETH — pools are denominated in this token
    address constant SYNTHRA_WETH = 0x33e4191705c386532ba27cBF171Db86919200B94;
    address constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address constant AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address constant PLTR = 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0;
    address constant NFLX = 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93;
    address constant AMD = 0x71178BAc73cBeb415514eB542a8995b82669778d;

    // ── Synthra DEX ──

    address constant SYNTHRA_ROUTER = 0x3Ce954107b1A675826B33bF23060Dd655e3758fE;
    address constant SYNTHRA_QUOTER = 0x231606c321A99DE81e28fE48B07a93F1ba49e713;

    // ── Sherwood infrastructure ──

    address constant SYNTHRA_SWAP_ADAPTER = 0xD875EF9467DbC8B30Dcad38C46bB863EC6a74b43;
    address constant PORTFOLIO_TEMPLATE = 0x5C3F9F1498f86Ac148dF95bAA69C6c1EB1a5bF5F;
    address constant CHAINLINK_VERIFIER = 0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64;

    // ── Test actors ──

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address lp1 = makeAddr("lp1");
    address lp2 = makeAddr("lp2");

    // ── State ──

    SyndicateGovernor governor;
    SyndicateFactory factory;
    SyndicateVault vault;

    // ── Setup ──

    function setUp() public virtual {
        factory = SyndicateFactory(_readAddress("SYNDICATE_FACTORY"));
        governor = SyndicateGovernor(_readAddress("SYNDICATE_GOVERNOR"));

        // Governor needs factory authorized to call addVault().
        // On a fresh deployment this may not be set yet — set it via the
        // deployer/owner. V1.5: setFactory applies immediately.
        address govOwner = governor.owner();
        if (governor.factory() != address(factory)) {
            vm.prank(govOwner);
            governor.setFactory(address(factory));
        }

        _createTestSyndicate();
        _fundAndDeposit(10e18, 10e18); // 10 WETH each

        // Warp 1 second so snapshot block is in the past for voting
        vm.warp(block.timestamp + 1);
    }

    // ── Address reader ──

    function _readAddress(string memory key) internal view returns (address) {
        string memory path = string.concat(vm.projectRoot(), "/chains/46630.json");
        string memory json = vm.readFile(path);
        return vm.parseJsonAddress(json, string.concat(".", key));
    }

    // ── Test syndicate creation ──
    // The deployed factory on Robinhood has the modified bytecode that skips
    // ENS and ERC-8004 checks when those are address(0).

    function _createTestSyndicate() internal {
        SyndicateFactory.SyndicateConfig memory config = SyndicateFactory.SyndicateConfig({
            metadataURI: "ipfs://robinhood-integration-test",
            asset: IERC20(SYNTHRA_WETH),
            name: "Robinhood Test Vault",
            symbol: "rtWETH",
            openDeposits: true,
            subdomain: "rh-integration-test"
        });

        vm.prank(owner);
        (, address vaultAddr) = factory.createSyndicate(0, config);
        vault = SyndicateVault(payable(vaultAddr));

        // Register agent on the vault (identity check skipped when agentRegistry == address(0))
        vm.prank(owner);
        vault.registerAgent(0, agent);
    }

    // ── Fund LPs and deposit ──

    function _fundAndDeposit(uint256 lp1Amount, uint256 lp2Amount) internal {
        deal(SYNTHRA_WETH, lp1, lp1Amount);
        deal(SYNTHRA_WETH, lp2, lp2Amount);

        vm.startPrank(lp1);
        IERC20(SYNTHRA_WETH).approve(address(vault), lp1Amount);
        vault.deposit(lp1Amount, lp1);
        vm.stopPrank();

        vm.startPrank(lp2);
        IERC20(SYNTHRA_WETH).approve(address(vault), lp2Amount);
        vault.deposit(lp2Amount, lp2);
        vm.stopPrank();
    }

    // ── Clone and initialize a strategy template ──

    function _cloneAndInit(address template, bytes memory initData) internal returns (address clone) {
        clone = Clones.clone(template);
        (bool success,) =
            clone.call(abi.encodeWithSignature("initialize(address,address,bytes)", address(vault), agent, initData));
        require(success, "Strategy initialization failed");
    }

    // ── Propose, vote, and execute in one call ──

    function _proposeVoteExecute(
        BatchExecutorLib.Call[] memory execCalls,
        BatchExecutorLib.Call[] memory settleCalls,
        uint256 feeBps,
        uint256 duration
    ) internal returns (uint256 proposalId) {
        vm.prank(agent);
        proposalId = governor.propose(
            address(vault), "ipfs://rh-test", feeBps, duration, execCalls, settleCalls, _emptyCoProposers()
        );

        vm.warp(block.timestamp + 1);

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        ISyndicateGovernor.GovernorParams memory params = governor.getGovernorParams();
        vm.warp(block.timestamp + params.votingPeriod + 1);

        governor.executeProposal(proposalId);
    }

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }
}
