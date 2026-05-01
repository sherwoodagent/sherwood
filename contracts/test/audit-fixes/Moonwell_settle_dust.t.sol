// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {BaseStrategy} from "../../src/strategies/BaseStrategy.sol";
import {MoonwellSupplyStrategy} from "../../src/strategies/MoonwellSupplyStrategy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Mock cToken for non-native (USDC-style) market. Pays underlying
///         via ERC20 transfer on redeem — never sends native ETH.
contract MockCTokenERC20 {
    IERC20 public underlying;
    mapping(address => uint256) public balanceOf;

    constructor(address underlying_) {
        underlying = IERC20(underlying_);
    }

    function exchangeRateStored() external pure returns (uint256) {
        return 1e18;
    }

    function mint(uint256 mintAmount) external returns (uint256) {
        underlying.transferFrom(msg.sender, address(this), mintAmount);
        balanceOf[msg.sender] += mintAmount;
        return 0;
    }

    function redeem(uint256 redeemTokens) external returns (uint256) {
        require(balanceOf[msg.sender] >= redeemTokens, "insufficient");
        balanceOf[msg.sender] -= redeemTokens;
        underlying.transfer(msg.sender, redeemTokens);
        return 0;
    }
}

/// @notice Mock cToken for native-ETH market. Holds wrapped WETH but on
///         redeem it sends *native* ETH to the strategy (Moonwell mWETH
///         behaviour). Used to verify the native-market clone still works.
contract MockCTokenNative {
    MockWETH public wethToken;
    mapping(address => uint256) public balanceOf;

    constructor(address weth_) {
        wethToken = MockWETH(payable(weth_));
    }

    function exchangeRateStored() external pure returns (uint256) {
        return 1e18;
    }

    function mint(uint256 mintAmount) external returns (uint256) {
        IERC20(address(wethToken)).transferFrom(msg.sender, address(this), mintAmount);
        // Convert WETH to ETH so we can pay native on redeem
        wethToken.withdraw(mintAmount);
        balanceOf[msg.sender] += mintAmount;
        return 0;
    }

    function redeem(uint256 redeemTokens) external returns (uint256) {
        require(balanceOf[msg.sender] >= redeemTokens, "insufficient");
        balanceOf[msg.sender] -= redeemTokens;
        // Send native ETH (mWETH-style behaviour)
        (bool ok,) = msg.sender.call{value: redeemTokens}("");
        require(ok, "ETH send failed");
        return 0;
    }

    receive() external payable {}
}

/// @notice WETH9-style mock with deposit / withdraw / ERC20 transfer support.
contract MockWETH is ERC20Mock {
    constructor() ERC20Mock("Wrapped Ether", "WETH", 18) {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH withdraw failed");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// @title Moonwell_settle_dust — MS-C4 regression
/// @notice Verifies that the conditional `receive()` on MoonwellSupplyStrategy
///         blocks dust ETH transfers on non-native-market clones (preventing
///         a 1-wei brick of `_settle`) while still allowing the native-ETH
///         path to function on mWETH-style clones.
contract MoonwellSettleDustTest is Test {
    MoonwellSupplyStrategy public template;
    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");
    address public attacker = makeAddr("attacker");

    function setUp() public {
        template = new MoonwellSupplyStrategy();
    }

    // ── Non-native market: dust attack must revert at receive() ──

    function test_nonNativeClone_rejectsDustTransfer() public {
        ERC20Mock usdc = new ERC20Mock("USDC", "USDC", 6);
        MockCTokenERC20 mUsdc = new MockCTokenERC20(address(usdc));

        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData = abi.encode(address(usdc), address(mUsdc), uint256(1_000e6), uint256(0), false);
        MoonwellSupplyStrategy(clone).initialize(vault, proposer, initData);

        // Attacker tries to send 1 wei to brick settlement
        vm.deal(attacker, 1);
        vm.prank(attacker);
        (bool sent,) = clone.call{value: 1}("");
        assertFalse(sent, "non-native clone must reject ETH at receive()");

        // Confirm balance is still 0 — dust was rejected at the receive() guard
        assertEq(clone.balance, 0, "dust must not stick to non-native clone");
    }

    function test_nonNativeClone_settleSurvivesAfterAttack() public {
        ERC20Mock usdc = new ERC20Mock("USDC", "USDC", 6);
        MockCTokenERC20 mUsdc = new MockCTokenERC20(address(usdc));

        // Fund vault + cToken pool
        usdc.mint(vault, 100_000e6);
        usdc.mint(address(mUsdc), 200_000e6);

        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData = abi.encode(address(usdc), address(mUsdc), uint256(50_000e6), uint256(49_900e6), false);
        MoonwellSupplyStrategy(clone).initialize(vault, proposer, initData);

        // Attacker tries dust attack
        vm.deal(attacker, 1);
        vm.prank(attacker);
        (bool sent,) = clone.call{value: 1}("");
        assertFalse(sent);

        // Execute
        vm.prank(vault);
        usdc.approve(clone, 50_000e6);
        vm.prank(vault);
        MoonwellSupplyStrategy(clone).execute();

        // Settle works because no dust ever stuck
        vm.prank(vault);
        MoonwellSupplyStrategy(clone).settle();
        assertEq(uint256(MoonwellSupplyStrategy(clone).state()), uint256(BaseStrategy.State.Settled));
    }

    // ── Native-ETH market: receive() accepts ETH and settle wraps it ──

    function test_nativeClone_acceptsEthAndSettles() public {
        MockWETH weth = new MockWETH();
        MockCTokenNative mWeth = new MockCTokenNative(address(weth));

        // Fund vault with WETH (deposit native -> WETH)
        vm.deal(address(this), 100 ether);
        weth.deposit{value: 100 ether}();
        IERC20(address(weth)).transfer(vault, 100 ether);

        address payable clone = payable(Clones.clone(address(template)));
        // isNativeEthMarket = true
        bytes memory initData = abi.encode(address(weth), address(mWeth), uint256(50 ether), uint256(50 ether), true);
        MoonwellSupplyStrategy(clone).initialize(vault, proposer, initData);

        // Sanity: native clone *can* receive ETH directly (this is needed for the
        // mWETH redeem path, which sends native ETH to msg.sender = the strategy).
        vm.deal(address(this), 1);
        (bool sent,) = clone.call{value: 1}("");
        assertTrue(sent, "native clone must accept ETH at receive()");
        assertEq(clone.balance, 1);

        // Drain the stray 1 wei before execute so test math stays clean. (In
        // production, no dust path matters for native — _settle wraps any ETH
        // balance unconditionally. We just want a clean assertion below.)
        // Actually, the strategy's _settle will wrap whatever ETH it holds —
        // so leaving the 1 wei is fine and keeps the test honest about the
        // wrap-on-settle behaviour.

        // Execute: pull WETH from vault, mint mWETH
        vm.prank(vault);
        IERC20(address(weth)).approve(clone, 50 ether);
        vm.prank(vault);
        MoonwellSupplyStrategy(clone).execute();

        // Settle: redeem mWETH (returns native ETH), wrap back to WETH, push to vault
        vm.prank(vault);
        MoonwellSupplyStrategy(clone).settle();

        assertEq(uint256(MoonwellSupplyStrategy(clone).state()), uint256(BaseStrategy.State.Settled));
        // Vault received the redeemed WETH (50 ether) plus the 1-wei dust we sent
        // (which got wrapped into WETH during _settle).
        assertEq(IERC20(address(weth)).balanceOf(vault), 100 ether + 1);
        assertEq(clone.balance, 0, "all native ETH must be wrapped during settle");
    }
}
