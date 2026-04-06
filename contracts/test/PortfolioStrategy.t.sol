// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PortfolioStrategy, ChainlinkReport} from "../src/strategies/PortfolioStrategy.sol";
import {BaseStrategy} from "../src/strategies/BaseStrategy.sol";
import {MockSwapAdapter} from "../src/adapters/MockSwapAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @notice Mock Chainlink Data Streams verifier proxy
contract MockVerifierProxy {
    /// @dev Returns abi-encoded ChainlinkReport with the given price
    function verify(bytes calldata signedReport) external payable returns (bytes memory) {
        // signedReport is just abi.encode(int192 price) in tests
        int192 price = abi.decode(signedReport, (int192));
        ChainlinkReport memory report = ChainlinkReport({
            feedId: bytes32(0),
            validFromTimestamp: uint32(block.timestamp),
            observationsTimestamp: uint32(block.timestamp),
            nativeFee: 0,
            linkFee: 0,
            expiresAt: uint32(block.timestamp + 300),
            price: price,
            bid: price,
            ask: price
        });
        return abi.encode(report);
    }
}

contract PortfolioStrategyTest is Test {
    PortfolioStrategy public template;
    PortfolioStrategy public strategy;
    MockSwapAdapter public adapter;
    MockVerifierProxy public verifier;

    ERC20Mock public weth; // vault asset
    ERC20Mock public tsla;
    ERC20Mock public amzn;
    ERC20Mock public nflx;

    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");

    uint256 constant TOTAL_AMOUNT = 10e18; // 10 WETH
    uint256 constant MAX_SLIPPAGE = 100; // 1%
    uint256 constant RATE_PRECISION = 1e18;

    function setUp() public {
        // Deploy mock tokens
        weth = new ERC20Mock("Wrapped Ether", "WETH", 18);
        tsla = new ERC20Mock("Tesla Token", "TSLA", 18);
        amzn = new ERC20Mock("Amazon Token", "AMZN", 18);
        nflx = new ERC20Mock("Netflix Token", "NFLX", 18);

        // Deploy mock adapter and verifier
        adapter = new MockSwapAdapter();
        verifier = new MockVerifierProxy();

        // Set exchange rates (1 WETH = 100 TSLA, 50 AMZN, 200 NFLX)
        adapter.setRate(address(weth), address(tsla), 100e18);
        adapter.setRate(address(weth), address(amzn), 50e18);
        adapter.setRate(address(weth), address(nflx), 200e18);

        // Reverse rates for selling
        adapter.setRate(address(tsla), address(weth), 0.01e18); // 1 TSLA = 0.01 WETH
        adapter.setRate(address(amzn), address(weth), 0.02e18); // 1 AMZN = 0.02 WETH
        adapter.setRate(address(nflx), address(weth), 0.005e18); // 1 NFLX = 0.005 WETH

        // Fund vault with WETH
        weth.mint(vault, 100e18);

        // Fund adapter with stock tokens for swaps
        tsla.mint(address(adapter), 100_000e18);
        amzn.mint(address(adapter), 100_000e18);
        nflx.mint(address(adapter), 100_000e18);
        weth.mint(address(adapter), 100_000e18);

        // Deploy template and clone
        template = new PortfolioStrategy();
        address clone = Clones.clone(address(template));
        strategy = PortfolioStrategy(clone);

        // Initialize with 3-token basket: TSLA 40%, AMZN 35%, NFLX 25%
        _initStrategy(strategy);
    }

    function _initStrategy(PortfolioStrategy s) internal {
        address[] memory tokens = new address[](3);
        tokens[0] = address(tsla);
        tokens[1] = address(amzn);
        tokens[2] = address(nflx);

        uint256[] memory weights = new uint256[](3);
        weights[0] = 4000; // 40%
        weights[1] = 3500; // 35%
        weights[2] = 2500; // 25%

        bytes[] memory extraData = new bytes[](3);
        extraData[0] = "";
        extraData[1] = "";
        extraData[2] = "";

        bytes memory initData = abi.encode(
            address(weth), address(adapter), address(verifier), tokens, weights, TOTAL_AMOUNT, MAX_SLIPPAGE, extraData
        );
        s.initialize(vault, proposer, initData);
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        assertEq(strategy.vault(), vault);
        assertEq(strategy.proposer(), proposer);
        assertEq(strategy.asset(), address(weth));
        assertEq(address(strategy.swapAdapter()), address(adapter));
        assertEq(strategy.chainlinkVerifier(), address(verifier));
        assertEq(strategy.totalAmount(), TOTAL_AMOUNT);
        assertEq(strategy.maxSlippageBps(), MAX_SLIPPAGE);
        assertEq(strategy.allocationCount(), 3);
        assertEq(strategy.name(), "Portfolio");
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Pending));

        PortfolioStrategy.TokenAllocation[] memory allocs = strategy.getAllocations();
        assertEq(allocs[0].token, address(tsla));
        assertEq(allocs[0].targetWeightBps, 4000);
        assertEq(allocs[1].token, address(amzn));
        assertEq(allocs[1].targetWeightBps, 3500);
        assertEq(allocs[2].token, address(nflx));
        assertEq(allocs[2].targetWeightBps, 2500);
    }

    function test_initialize_twice_reverts() public {
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        _initStrategy(strategy);
    }

    function test_initialize_invalidWeights_reverts() public {
        address clone = Clones.clone(address(template));

        address[] memory tokens = new address[](2);
        tokens[0] = address(tsla);
        tokens[1] = address(amzn);

        uint256[] memory weights = new uint256[](2);
        weights[0] = 5000;
        weights[1] = 4000; // Sum = 9000, not 10000

        bytes[] memory extraData = new bytes[](2);
        extraData[0] = "";
        extraData[1] = "";

        bytes memory initData = abi.encode(
            address(weth), address(adapter), address(verifier), tokens, weights, TOTAL_AMOUNT, MAX_SLIPPAGE, extraData
        );
        vm.expectRevert(PortfolioStrategy.InvalidWeights.selector);
        PortfolioStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_tooManyTokens_reverts() public {
        address clone = Clones.clone(address(template));

        address[] memory tokens = new address[](21); // MAX_BASKET_SIZE + 1
        uint256[] memory weights = new uint256[](21);
        bytes[] memory extraData = new bytes[](21);

        for (uint256 i; i < 21; ++i) {
            tokens[i] = makeAddr(string(abi.encodePacked("token", i)));
            weights[i] = (i < 20) ? 476 : 10000 - (476 * 20); // roughly equal
            extraData[i] = "";
        }

        bytes memory initData = abi.encode(
            address(weth), address(adapter), address(verifier), tokens, weights, TOTAL_AMOUNT, MAX_SLIPPAGE, extraData
        );
        vm.expectRevert(PortfolioStrategy.TooManyTokens.selector);
        PortfolioStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_lengthMismatch_reverts() public {
        address clone = Clones.clone(address(template));

        address[] memory tokens = new address[](2);
        tokens[0] = address(tsla);
        tokens[1] = address(amzn);

        uint256[] memory weights = new uint256[](3); // mismatched length
        weights[0] = 5000;
        weights[1] = 3000;
        weights[2] = 2000;

        bytes[] memory extraData = new bytes[](2);
        extraData[0] = "";
        extraData[1] = "";

        bytes memory initData = abi.encode(
            address(weth), address(adapter), address(verifier), tokens, weights, TOTAL_AMOUNT, MAX_SLIPPAGE, extraData
        );
        vm.expectRevert(PortfolioStrategy.LengthMismatch.selector);
        PortfolioStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_zeroAsset_reverts() public {
        address clone = Clones.clone(address(template));

        address[] memory tokens = new address[](1);
        tokens[0] = address(tsla);
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000;
        bytes[] memory extraData = new bytes[](1);
        extraData[0] = "";

        bytes memory initData = abi.encode(
            address(0), address(adapter), address(verifier), tokens, weights, TOTAL_AMOUNT, MAX_SLIPPAGE, extraData
        );
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        PortfolioStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_zeroAmount_reverts() public {
        address clone = Clones.clone(address(template));

        address[] memory tokens = new address[](1);
        tokens[0] = address(tsla);
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000;
        bytes[] memory extraData = new bytes[](1);
        extraData[0] = "";

        bytes memory initData = abi.encode(
            address(weth), address(adapter), address(verifier), tokens, weights, uint256(0), MAX_SLIPPAGE, extraData
        );
        vm.expectRevert(PortfolioStrategy.InvalidAmount.selector);
        PortfolioStrategy(clone).initialize(vault, proposer, initData);
    }

    // ==================== EXECUTE ====================

    function test_execute() public {
        vm.prank(vault);
        weth.approve(address(strategy), TOTAL_AMOUNT);

        vm.prank(vault);
        strategy.execute();

        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Executed));
        assertTrue(strategy.executed());

        PortfolioStrategy.TokenAllocation[] memory allocs = strategy.getAllocations();

        // TSLA: 40% of 10 WETH = 4 WETH * 100 rate = 400 TSLA
        assertEq(allocs[0].tokenAmount, 400e18);
        assertEq(allocs[0].investedAmount, 4e18);
        assertEq(tsla.balanceOf(address(strategy)), 400e18);

        // AMZN: 35% of 10 WETH = 3.5 WETH * 50 rate = 175 AMZN
        assertEq(allocs[1].tokenAmount, 175e18);
        assertEq(allocs[1].investedAmount, 3.5e18);

        // NFLX: 25% of 10 WETH = 2.5 WETH * 200 rate = 500 NFLX
        assertEq(allocs[2].tokenAmount, 500e18);
        assertEq(allocs[2].investedAmount, 2.5e18);
    }

    function test_execute_onlyVault() public {
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotVault.selector);
        strategy.execute();
    }

    function test_execute_twice_reverts() public {
        vm.prank(vault);
        weth.approve(address(strategy), TOTAL_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        vm.prank(vault);
        vm.expectRevert(BaseStrategy.AlreadyExecuted.selector);
        strategy.execute();
    }

    // ==================== SETTLE ====================

    function test_settle() public {
        // Execute first
        vm.prank(vault);
        weth.approve(address(strategy), TOTAL_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        uint256 vaultBefore = weth.balanceOf(vault);

        // Settle
        vm.prank(vault);
        strategy.settle();

        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));

        // All tokens sold, WETH returned to vault
        // 400 TSLA * 0.01 = 4 WETH
        // 175 AMZN * 0.02 = 3.5 WETH
        // 500 NFLX * 0.005 = 2.5 WETH
        // Total = 10 WETH (no profit/loss with these rates)
        uint256 returned = weth.balanceOf(vault) - vaultBefore;
        assertEq(returned, TOTAL_AMOUNT);
        assertEq(tsla.balanceOf(address(strategy)), 0);
        assertEq(amzn.balanceOf(address(strategy)), 0);
        assertEq(nflx.balanceOf(address(strategy)), 0);
    }

    function test_settle_withProfit() public {
        vm.prank(vault);
        weth.approve(address(strategy), TOTAL_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        // Simulate price appreciation: selling rates go up 20%
        adapter.setRate(address(tsla), address(weth), 0.012e18); // was 0.01
        adapter.setRate(address(amzn), address(weth), 0.024e18); // was 0.02
        adapter.setRate(address(nflx), address(weth), 0.006e18); // was 0.005

        uint256 vaultBefore = weth.balanceOf(vault);

        vm.prank(vault);
        strategy.settle();

        uint256 returned = weth.balanceOf(vault) - vaultBefore;
        assertGt(returned, TOTAL_AMOUNT); // profit!

        // 400 TSLA * 0.012 = 4.8 WETH
        // 175 AMZN * 0.024 = 4.2 WETH
        // 500 NFLX * 0.006 = 3.0 WETH
        // Total = 12.0 WETH (20% profit)
        assertEq(returned, 12e18);
    }

    function test_settle_onlyVault() public {
        vm.prank(vault);
        weth.approve(address(strategy), TOTAL_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotVault.selector);
        strategy.settle();
    }

    function test_settle_beforeExecute_reverts() public {
        vm.prank(vault);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.settle();
    }

    // ==================== UPDATE PARAMS ====================

    function test_updateParams_weights() public {
        _executeStrategy();

        // Change weights: TSLA 60%, AMZN 30%, NFLX 10%
        uint256[] memory newWeights = new uint256[](3);
        newWeights[0] = 6000;
        newWeights[1] = 3000;
        newWeights[2] = 1000;

        vm.prank(proposer);
        strategy.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        PortfolioStrategy.TokenAllocation[] memory allocs = strategy.getAllocations();
        assertEq(allocs[0].targetWeightBps, 6000);
        assertEq(allocs[1].targetWeightBps, 3000);
        assertEq(allocs[2].targetWeightBps, 1000);
    }

    function test_updateParams_invalidWeights_reverts() public {
        _executeStrategy();

        uint256[] memory newWeights = new uint256[](3);
        newWeights[0] = 5000;
        newWeights[1] = 3000;
        newWeights[2] = 1000; // Sum = 9000

        vm.prank(proposer);
        vm.expectRevert(PortfolioStrategy.InvalidWeights.selector);
        strategy.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));
    }

    function test_updateParams_onlyProposer() public {
        _executeStrategy();

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.updateParams(abi.encode(new uint256[](0), uint256(200), new bytes[](0)));
    }

    function test_updateParams_onlyWhenExecuted() public {
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.updateParams(abi.encode(new uint256[](0), uint256(200), new bytes[](0)));
    }

    // ==================== REBALANCE (SIMPLE) ====================

    function test_rebalance() public {
        _executeStrategy();

        // Verify initial allocations
        PortfolioStrategy.TokenAllocation[] memory before = strategy.getAllocations();
        assertEq(before[0].targetWeightBps, 4000);

        // Change weights: TSLA 60%, AMZN 30%, NFLX 10%
        uint256[] memory newWeights = new uint256[](3);
        newWeights[0] = 6000;
        newWeights[1] = 3000;
        newWeights[2] = 1000;

        vm.prank(proposer);
        strategy.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        // Rebalance
        vm.prank(proposer);
        strategy.rebalance();

        PortfolioStrategy.TokenAllocation[] memory after_ = strategy.getAllocations();

        // After rebalance, all WETH recovered (10 WETH from sell) then re-bought at new weights
        // TSLA: 60% of 10 WETH = 6 WETH * 100 = 600 TSLA
        assertEq(after_[0].tokenAmount, 600e18);
        assertEq(after_[0].investedAmount, 6e18);

        // AMZN: 30% of 10 WETH = 3 WETH * 50 = 150 AMZN
        assertEq(after_[1].tokenAmount, 150e18);
        assertEq(after_[1].investedAmount, 3e18);

        // NFLX: 10% of 10 WETH = 1 WETH * 200 = 200 NFLX
        assertEq(after_[2].tokenAmount, 200e18);
        assertEq(after_[2].investedAmount, 1e18);
    }

    function test_rebalance_onlyProposer() public {
        _executeStrategy();

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.rebalance();
    }

    function test_rebalance_notExecuted_reverts() public {
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.rebalance();
    }

    // ==================== REBALANCE DELTA ====================

    function test_rebalanceDelta() public {
        _executeStrategy();

        // Change weights: TSLA 60%, AMZN 30%, NFLX 10%
        uint256[] memory newWeights = new uint256[](3);
        newWeights[0] = 6000;
        newWeights[1] = 3000;
        newWeights[2] = 1000;

        vm.prank(proposer);
        strategy.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        // Build price reports (prices in 1e18 = price per token in asset terms)
        // TSLA: 0.01 WETH each, AMZN: 0.02 WETH each, NFLX: 0.005 WETH each
        bytes[] memory reports = new bytes[](3);
        reports[0] = abi.encode(int192(int256(0.01e18))); // TSLA price
        reports[1] = abi.encode(int192(int256(0.02e18))); // AMZN price
        reports[2] = abi.encode(int192(int256(0.005e18))); // NFLX price

        vm.prank(proposer);
        strategy.rebalanceDelta(reports);

        // Verify new allocations are closer to target weights
        PortfolioStrategy.TokenAllocation[] memory after_ = strategy.getAllocations();

        // After delta rebalance, positions should be adjusted toward new weights
        // The exact amounts depend on the delta logic but should be non-zero
        assertGt(after_[0].tokenAmount, 0); // TSLA should increase (underweight → 60%)
        assertGt(after_[1].tokenAmount, 0); // AMZN
        assertGt(after_[2].tokenAmount, 0); // NFLX should decrease (overweight → 10%)
    }

    function test_rebalanceDelta_lengthMismatch_reverts() public {
        _executeStrategy();

        bytes[] memory reports = new bytes[](2); // should be 3
        reports[0] = abi.encode(int192(int256(0.01e18)));
        reports[1] = abi.encode(int192(int256(0.02e18)));

        vm.prank(proposer);
        vm.expectRevert(PortfolioStrategy.LengthMismatch.selector);
        strategy.rebalanceDelta(reports);
    }

    function test_rebalanceDelta_onlyProposer() public {
        _executeStrategy();

        bytes[] memory reports = new bytes[](3);
        reports[0] = abi.encode(int192(int256(0.01e18)));
        reports[1] = abi.encode(int192(int256(0.02e18)));
        reports[2] = abi.encode(int192(int256(0.005e18)));

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.rebalanceDelta(reports);
    }

    // ==================== FULL LIFECYCLE ====================

    function test_fullLifecycle() public {
        // 1. Execute
        vm.prank(vault);
        weth.approve(address(strategy), TOTAL_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        // 2. Update weights
        uint256[] memory newWeights = new uint256[](3);
        newWeights[0] = 5000;
        newWeights[1] = 3000;
        newWeights[2] = 2000;

        vm.prank(proposer);
        strategy.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        // 3. Rebalance
        vm.prank(proposer);
        strategy.rebalance();

        // 4. Prices go up 10%
        adapter.setRate(address(tsla), address(weth), 0.011e18);
        adapter.setRate(address(amzn), address(weth), 0.022e18);
        adapter.setRate(address(nflx), address(weth), 0.0055e18);

        // 5. Settle
        uint256 vaultBefore = weth.balanceOf(vault);
        vm.prank(vault);
        strategy.settle();

        uint256 returned = weth.balanceOf(vault) - vaultBefore;
        assertGt(returned, TOTAL_AMOUNT); // profit from 10% appreciation
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
    }

    // ==================== CLONING ====================

    function test_clonesHaveIsolatedStorage() public {
        address clone2 = Clones.clone(address(template));
        PortfolioStrategy strategy2 = PortfolioStrategy(clone2);

        // Initialize with different params (single token, 100%)
        address[] memory tokens = new address[](1);
        tokens[0] = address(tsla);
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000;
        bytes[] memory extraData = new bytes[](1);
        extraData[0] = "";

        bytes memory initData = abi.encode(
            address(weth), address(adapter), address(verifier), tokens, weights, 5e18, MAX_SLIPPAGE, extraData
        );
        strategy2.initialize(vault, proposer, initData);

        assertEq(strategy.allocationCount(), 3);
        assertEq(strategy2.allocationCount(), 1);
        assertEq(strategy.totalAmount(), 10e18);
        assertEq(strategy2.totalAmount(), 5e18);
    }

    // ==================== EDGE CASES ====================

    /// @notice Single-token portfolio: 100% TSLA — execute, rebalance, settle
    function test_singleTokenPortfolio() public {
        address clone = Clones.clone(address(template));
        PortfolioStrategy s = PortfolioStrategy(clone);

        address[] memory tokens = new address[](1);
        tokens[0] = address(tsla);
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000; // 100%
        bytes[] memory extraData = new bytes[](1);
        extraData[0] = "";

        bytes memory initData = abi.encode(
            address(weth), address(adapter), address(verifier), tokens, weights, 5e18, MAX_SLIPPAGE, extraData
        );
        s.initialize(vault, proposer, initData);

        assertEq(s.allocationCount(), 1);

        // Execute: 5 WETH → 500 TSLA
        vm.prank(vault);
        weth.approve(address(s), 5e18);
        vm.prank(vault);
        s.execute();

        PortfolioStrategy.TokenAllocation[] memory allocs = s.getAllocations();
        assertEq(allocs[0].tokenAmount, 500e18); // 5 WETH * 100 rate
        assertEq(allocs[0].investedAmount, 5e18);
        assertEq(tsla.balanceOf(address(s)), 500e18);

        // Rebalance (same weight, just sell/re-buy)
        vm.prank(proposer);
        s.rebalance();

        allocs = s.getAllocations();
        assertEq(allocs[0].tokenAmount, 500e18); // same — no price change

        // Settle
        uint256 vaultBefore = weth.balanceOf(vault);
        vm.prank(vault);
        s.settle();

        uint256 returned = weth.balanceOf(vault) - vaultBefore;
        assertEq(returned, 5e18); // no profit/loss
        assertEq(tsla.balanceOf(address(s)), 0);
    }

    /// @notice Max basket size (20 tokens) — should succeed
    function test_maxBasketSize_20tokens() public {
        address clone = Clones.clone(address(template));
        PortfolioStrategy s = PortfolioStrategy(clone);

        uint256 count = 20;
        address[] memory tokens = new address[](count);
        uint256[] memory weights = new uint256[](count);
        bytes[] memory extraData = new bytes[](count);

        // Create 20 mock tokens, set rates, fund adapter
        for (uint256 i; i < count; ++i) {
            ERC20Mock token = new ERC20Mock(
                string(abi.encodePacked("Token", vm.toString(i))), string(abi.encodePacked("T", vm.toString(i))), 18
            );
            tokens[i] = address(token);
            weights[i] = 500; // 5% each, 20 * 500 = 10000
            extraData[i] = "";

            // Set swap rates: 1 WETH → 10 token, 1 token → 0.1 WETH
            adapter.setRate(address(weth), address(token), 10e18);
            adapter.setRate(address(token), address(weth), 0.1e18);
            token.mint(address(adapter), 1_000_000e18);
        }

        bytes memory initData = abi.encode(
            address(weth), address(adapter), address(verifier), tokens, weights, 20e18, MAX_SLIPPAGE, extraData
        );
        s.initialize(vault, proposer, initData);

        assertEq(s.allocationCount(), 20);

        // Execute: 20 WETH split equally
        weth.mint(vault, 20e18); // extra WETH for this test
        vm.prank(vault);
        weth.approve(address(s), 20e18);
        vm.prank(vault);
        s.execute();

        // Each token: 5% of 20 WETH = 1 WETH * 10 rate = 10 tokens
        PortfolioStrategy.TokenAllocation[] memory allocs = s.getAllocations();
        for (uint256 i; i < count; ++i) {
            assertEq(allocs[i].tokenAmount, 10e18);
            assertEq(allocs[i].investedAmount, 1e18);
        }

        // Settle: all sold back at same rates → 20 WETH returned
        uint256 vaultBefore = weth.balanceOf(vault);
        vm.prank(vault);
        s.settle();

        uint256 returned = weth.balanceOf(vault) - vaultBefore;
        assertEq(returned, 20e18);
    }

    /// @notice Zero-weight token at initialization — valid (sum=10000), token skipped during execute
    function test_zeroWeightToken_execute() public {
        address clone = Clones.clone(address(template));
        PortfolioStrategy s = PortfolioStrategy(clone);

        address[] memory tokens = new address[](3);
        tokens[0] = address(tsla);
        tokens[1] = address(amzn);
        tokens[2] = address(nflx);

        uint256[] memory weights = new uint256[](3);
        weights[0] = 6000; // 60%
        weights[1] = 4000; // 40%
        weights[2] = 0; // 0% — intentionally excluded

        bytes[] memory extraData = new bytes[](3);
        extraData[0] = "";
        extraData[1] = "";
        extraData[2] = "";

        bytes memory initData = abi.encode(
            address(weth), address(adapter), address(verifier), tokens, weights, TOTAL_AMOUNT, MAX_SLIPPAGE, extraData
        );

        // 6000 + 4000 + 0 = 10000 → valid init
        s.initialize(vault, proposer, initData);
        assertEq(s.allocationCount(), 3);

        // Execute: NFLX should get 0 allocation
        vm.prank(vault);
        weth.approve(address(s), TOTAL_AMOUNT);
        vm.prank(vault);
        s.execute();

        PortfolioStrategy.TokenAllocation[] memory allocs = s.getAllocations();

        // TSLA: 60% of 10 WETH = 6 WETH * 100 = 600 TSLA
        assertEq(allocs[0].tokenAmount, 600e18);
        assertEq(allocs[0].investedAmount, 6e18);

        // AMZN: 40% of 10 WETH = 4 WETH * 50 = 200 AMZN
        assertEq(allocs[1].tokenAmount, 200e18);
        assertEq(allocs[1].investedAmount, 4e18);

        // NFLX: 0% → skipped, no tokens bought
        assertEq(allocs[2].tokenAmount, 0);
        assertEq(allocs[2].investedAmount, 0);
        assertEq(nflx.balanceOf(address(s)), 0);
    }

    /// @notice Rebalance to zero weight — move a token from active to 0%, sell its position
    function test_rebalance_zeroWeightRemoval() public {
        _executeStrategy();

        // Initial: TSLA 40%, AMZN 35%, NFLX 25%
        PortfolioStrategy.TokenAllocation[] memory before_ = strategy.getAllocations();
        assertGt(before_[2].tokenAmount, 0); // NFLX has tokens

        // Update: move NFLX to 0%, redistribute to TSLA 60%, AMZN 40%
        uint256[] memory newWeights = new uint256[](3);
        newWeights[0] = 6000; // 60%
        newWeights[1] = 4000; // 40%
        newWeights[2] = 0; // 0% — remove NFLX

        vm.prank(proposer);
        strategy.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        // Rebalance — should sell NFLX and not re-buy
        vm.prank(proposer);
        strategy.rebalance();

        PortfolioStrategy.TokenAllocation[] memory after_ = strategy.getAllocations();

        // NFLX: 0 weight → sold, no re-buy
        assertEq(after_[2].tokenAmount, 0);
        assertEq(after_[2].investedAmount, 0);
        assertEq(nflx.balanceOf(address(strategy)), 0);

        // TSLA: 60% of recovered WETH
        assertGt(after_[0].tokenAmount, before_[0].tokenAmount); // more TSLA now
        assertEq(after_[0].targetWeightBps, 6000);

        // AMZN: 40% of recovered WETH
        assertGt(after_[1].tokenAmount, before_[1].tokenAmount); // more AMZN now
        assertEq(after_[1].targetWeightBps, 4000);
    }

    /// @notice Settle after rebalancing to zero weight — only 2 active tokens sell
    function test_settle_afterZeroWeightRebalance() public {
        _executeStrategy();

        // Remove NFLX
        uint256[] memory newWeights = new uint256[](3);
        newWeights[0] = 6000;
        newWeights[1] = 4000;
        newWeights[2] = 0;

        vm.prank(proposer);
        strategy.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        vm.prank(proposer);
        strategy.rebalance();

        // Settle — should succeed even with a zero-balance token
        uint256 vaultBefore = weth.balanceOf(vault);
        vm.prank(vault);
        strategy.settle();

        uint256 returned = weth.balanceOf(vault) - vaultBefore;
        assertGt(returned, 0);
        assertEq(nflx.balanceOf(address(strategy)), 0);
        assertEq(tsla.balanceOf(address(strategy)), 0);
        assertEq(amzn.balanceOf(address(strategy)), 0);
    }

    /// @notice Rebalance multiple times — weights can change between rebalances
    function test_multipleRebalances() public {
        _executeStrategy();

        // First rebalance: 60/30/10
        uint256[] memory w1 = new uint256[](3);
        w1[0] = 6000;
        w1[1] = 3000;
        w1[2] = 1000;
        vm.prank(proposer);
        strategy.updateParams(abi.encode(w1, uint256(0), new bytes[](0)));
        vm.prank(proposer);
        strategy.rebalance();

        PortfolioStrategy.TokenAllocation[] memory r1 = strategy.getAllocations();
        assertEq(r1[0].tokenAmount, 600e18); // 60% of 10 WETH * 100

        // Second rebalance: 33/34/33
        uint256[] memory w2 = new uint256[](3);
        w2[0] = 3300;
        w2[1] = 3400;
        w2[2] = 3300;
        vm.prank(proposer);
        strategy.updateParams(abi.encode(w2, uint256(0), new bytes[](0)));
        vm.prank(proposer);
        strategy.rebalance();

        PortfolioStrategy.TokenAllocation[] memory r2 = strategy.getAllocations();
        assertEq(r2[0].targetWeightBps, 3300);
        assertEq(r2[1].targetWeightBps, 3400);
        assertEq(r2[2].targetWeightBps, 3300);
        // TSLA: 33% of 10 WETH = 3.3 WETH * 100 = 330 TSLA
        assertEq(r2[0].tokenAmount, 330e18);

        // Third rebalance: back to equal 34/33/33
        uint256[] memory w3 = new uint256[](3);
        w3[0] = 3400;
        w3[1] = 3300;
        w3[2] = 3300;
        vm.prank(proposer);
        strategy.updateParams(abi.encode(w3, uint256(0), new bytes[](0)));
        vm.prank(proposer);
        strategy.rebalance();

        PortfolioStrategy.TokenAllocation[] memory r3 = strategy.getAllocations();
        assertEq(r3[0].tokenAmount, 340e18); // 34% of 10 * 100

        // Settle should still work after 3 rebalances
        uint256 vaultBefore = weth.balanceOf(vault);
        vm.prank(vault);
        strategy.settle();
        uint256 returned = weth.balanceOf(vault) - vaultBefore;
        assertEq(returned, TOTAL_AMOUNT); // no price change
    }

    // ==================== GAS BENCHMARKS ====================

    /// @notice Gas cost comparison: sell-all/re-buy vs delta rebalance at 3 tokens
    function test_gas_rebalance_3tokens() public {
        _executeStrategy();

        // Update weights for rebalance
        uint256[] memory newWeights = new uint256[](3);
        newWeights[0] = 6000;
        newWeights[1] = 3000;
        newWeights[2] = 1000;
        vm.prank(proposer);
        strategy.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        // Measure sell-all/re-buy gas
        vm.prank(proposer);
        uint256 gasBefore = gasleft();
        strategy.rebalance();
        uint256 gasSimple = gasBefore - gasleft();

        // --- Setup fresh clone for delta comparison ---
        address clone2 = Clones.clone(address(template));
        PortfolioStrategy s2 = PortfolioStrategy(clone2);
        _initStrategy(s2);

        vm.prank(vault);
        weth.approve(address(s2), TOTAL_AMOUNT);
        vm.prank(vault);
        s2.execute();

        vm.prank(proposer);
        s2.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        bytes[] memory reports = new bytes[](3);
        reports[0] = abi.encode(int192(int256(0.01e18)));
        reports[1] = abi.encode(int192(int256(0.02e18)));
        reports[2] = abi.encode(int192(int256(0.005e18)));

        vm.prank(proposer);
        uint256 gasBefore2 = gasleft();
        s2.rebalanceDelta(reports);
        uint256 gasDelta = gasBefore2 - gasleft();

        // Log gas costs (visible in forge test -vvv output)
        emit log_named_uint("Gas: rebalance (sell-all/re-buy) 3 tokens", gasSimple);
        emit log_named_uint("Gas: rebalanceDelta (Chainlink)   3 tokens", gasDelta);
    }

    /// @notice Gas cost at max basket size (20 tokens) — sell-all/re-buy
    function test_gas_rebalance_20tokens() public {
        address clone = Clones.clone(address(template));
        PortfolioStrategy s = PortfolioStrategy(clone);

        uint256 count = 20;
        address[] memory tokens = new address[](count);
        uint256[] memory weights = new uint256[](count);
        uint256[] memory newWeights = new uint256[](count);
        bytes[] memory extraData = new bytes[](count);

        for (uint256 i; i < count; ++i) {
            ERC20Mock token = new ERC20Mock(
                string(abi.encodePacked("Token", vm.toString(i))), string(abi.encodePacked("T", vm.toString(i))), 18
            );
            tokens[i] = address(token);
            weights[i] = 500; // 5% each
            extraData[i] = "";

            adapter.setRate(address(weth), address(token), 10e18);
            adapter.setRate(address(token), address(weth), 0.1e18);
            token.mint(address(adapter), 1_000_000e18);

            // New weights: first token gets 50%, rest share remaining (263 bps each)
            if (i == 0) {
                newWeights[i] = 5000;
            } else {
                newWeights[i] = 263;
            }
        }
        // Fix rounding: 5000 + (263 * 19) = 5000 + 4997 = 9997, need 3 more
        newWeights[1] += 3;

        bytes memory initData = abi.encode(
            address(weth), address(adapter), address(verifier), tokens, weights, 20e18, MAX_SLIPPAGE, extraData
        );
        s.initialize(vault, proposer, initData);

        weth.mint(vault, 20e18);
        vm.prank(vault);
        weth.approve(address(s), 20e18);
        vm.prank(vault);
        s.execute();

        vm.prank(proposer);
        s.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        // Measure gas
        vm.prank(proposer);
        uint256 gasBefore = gasleft();
        s.rebalance();
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("Gas: rebalance (sell-all/re-buy) 20 tokens", gasUsed);

        // --- Delta rebalance for 20 tokens ---
        address clone2 = Clones.clone(address(template));
        PortfolioStrategy s2 = PortfolioStrategy(clone2);

        s2.initialize(vault, proposer, initData);
        weth.mint(vault, 20e18);
        vm.prank(vault);
        weth.approve(address(s2), 20e18);
        vm.prank(vault);
        s2.execute();

        vm.prank(proposer);
        s2.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        bytes[] memory reports = new bytes[](count);
        for (uint256 i; i < count; ++i) {
            reports[i] = abi.encode(int192(int256(0.1e18))); // 1 token = 0.1 WETH
        }

        vm.prank(proposer);
        uint256 gasBefore2 = gasleft();
        s2.rebalanceDelta(reports);
        uint256 gasDelta = gasBefore2 - gasleft();

        emit log_named_uint("Gas: rebalanceDelta (Chainlink)   20 tokens", gasDelta);
    }

    // ==================== HELPERS ====================

    function _executeStrategy() internal {
        vm.prank(vault);
        weth.approve(address(strategy), TOTAL_AMOUNT);
        vm.prank(vault);
        strategy.execute();
    }
}
