// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategy} from "../interfaces/IStrategy.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Chainlink Data Streams verifier proxy interface
interface IVerifierProxy {
    function verify(bytes calldata signedReport) external payable returns (bytes memory verifierResponse);
}

/// @notice Decoded Chainlink Data Streams V3 report
struct ChainlinkReport {
    bytes32 feedId;
    uint32 validFromTimestamp;
    uint32 observationsTimestamp;
    uint192 nativeFee;
    uint192 linkFee;
    uint32 expiresAt;
    int192 price;
    int192 bid;
    int192 ask;
}

/**
 * @title PortfolioStrategy
 * @notice Manages a weighted basket of tokens (e.g., tokenized stocks on Robinhood Chain).
 *         Buys tokens at target weights on execute, sells everything on settle.
 *         Supports rebalancing by the proposer — either sell-all/re-buy or
 *         delta-based using Chainlink Data Streams prices.
 *
 *   Execute: pull asset → swap to basket tokens at target weights
 *   Settle:  swap all basket tokens → push asset back to vault
 *
 *   Batch calls from governor:
 *     Execute: [asset.approve(strategy, totalAmount), strategy.execute()]
 *     Settle:  [strategy.settle()]
 *
 *   Tunable params (proposer, Executed state):
 *     - targetWeightBps per token
 *     - maxSlippageBps
 *     - swapExtraData per token
 *
 *   Rebalancing (proposer, Executed state):
 *     - rebalance(): sell all, re-buy at current weights (simple)
 *     - rebalanceDelta(reports): use Chainlink prices, only swap deltas (gas efficient)
 */
contract PortfolioStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Errors ──
    error InvalidAmount();
    error InvalidWeights();
    error LengthMismatch();
    error TooManyTokens();
    error SwapFailed();
    error RebalancingInProgress();
    error StalePrice();

    // ── Constants ──
    uint256 public constant MAX_BASKET_SIZE = 20;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant PRICE_PRECISION = 1e18;
    uint256 public constant MAX_PRICE_AGE = 5 minutes;

    // ── Storage (per-clone) ──

    struct TokenAllocation {
        address token;
        uint256 targetWeightBps;
        uint256 tokenAmount;
        uint256 investedAmount;
    }

    address public asset;
    ISwapAdapter public swapAdapter;
    address public chainlinkVerifier;

    TokenAllocation[] internal _allocations;
    bytes[] internal _swapExtraData;

    uint256 public totalAmount;
    uint256 public maxSlippageBps;

    bool private _rebalancing;

    // ── Events ──
    event Rebalanced(uint256 totalAssetValue);
    event RebalancedDelta(uint256 totalAssetValue, uint256 swapsExecuted);

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "Portfolio";
    }

    // ── Initialization ──

    /// @notice Decode: (address asset, address swapAdapter, address chainlinkVerifier,
    ///         address[] tokens, uint256[] weightsBps, uint256 totalAmount,
    ///         uint256 maxSlippageBps, bytes[] swapExtraData)
    function _initialize(bytes calldata data) internal override {
        (
            address asset_,
            address swapAdapter_,
            address chainlinkVerifier_,
            address[] memory tokens,
            uint256[] memory weightsBps,
            uint256 totalAmount_,
            uint256 maxSlippageBps_,
            bytes[] memory swapExtraData_
        ) = abi.decode(data, (address, address, address, address[], uint256[], uint256, uint256, bytes[]));

        if (asset_ == address(0) || swapAdapter_ == address(0)) revert ZeroAddress();
        if (tokens.length == 0 || tokens.length > MAX_BASKET_SIZE) revert TooManyTokens();
        if (tokens.length != weightsBps.length || tokens.length != swapExtraData_.length) revert LengthMismatch();
        if (totalAmount_ == 0) revert InvalidAmount();

        uint256 weightSum;
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            weightSum += weightsBps[i];
            _allocations.push(
                TokenAllocation({token: tokens[i], targetWeightBps: weightsBps[i], tokenAmount: 0, investedAmount: 0})
            );
            _swapExtraData.push(swapExtraData_[i]);
        }
        if (weightSum != BPS_DENOMINATOR) revert InvalidWeights();

        asset = asset_;
        swapAdapter = ISwapAdapter(swapAdapter_);
        chainlinkVerifier = chainlinkVerifier_;
        totalAmount = totalAmount_;
        maxSlippageBps = maxSlippageBps_;
    }

    // ── Execute: buy basket tokens ──

    function _execute() internal override {
        _pullFromVault(asset, totalAmount);

        uint256 len = _allocations.length;
        for (uint256 i; i < len; ++i) {
            TokenAllocation storage alloc = _allocations[i];
            uint256 allocation = (totalAmount * alloc.targetWeightBps) / BPS_DENOMINATOR;
            if (allocation == 0) continue;

            IERC20(asset).forceApprove(address(swapAdapter), allocation);
            uint256 amountOut = swapAdapter.swap(asset, alloc.token, allocation, 0, _swapExtraData[i]);
            if (amountOut == 0) revert SwapFailed();

            alloc.tokenAmount = amountOut;
            alloc.investedAmount = allocation;
        }

        // Push any residual dust back to vault
        _pushAllToVault(asset);
    }

    // ── Settle: sell all basket tokens ──

    function _settle() internal override {
        uint256 len = _allocations.length;
        for (uint256 i; i < len; ++i) {
            TokenAllocation storage alloc = _allocations[i];
            uint256 bal = IERC20(alloc.token).balanceOf(address(this));
            if (bal == 0) continue;

            IERC20(alloc.token).forceApprove(address(swapAdapter), bal);
            swapAdapter.swap(alloc.token, asset, bal, 0, _swapExtraData[i]);

            alloc.tokenAmount = 0;
        }

        _pushAllToVault(asset);
    }

    // ── Update params ──

    /// @notice Update: (uint256[] newWeightsBps, uint256 newMaxSlippageBps, bytes[] newSwapExtraData)
    /// @dev Pass empty arrays / 0 to keep current values.
    function _updateParams(bytes calldata data) internal override {
        (uint256[] memory newWeightsBps, uint256 newMaxSlippageBps, bytes[] memory newSwapExtraData) =
            abi.decode(data, (uint256[], uint256, bytes[]));

        if (newWeightsBps.length > 0) {
            if (newWeightsBps.length != _allocations.length) revert LengthMismatch();
            uint256 weightSum;
            for (uint256 i; i < newWeightsBps.length; ++i) {
                weightSum += newWeightsBps[i];
                _allocations[i].targetWeightBps = newWeightsBps[i];
            }
            if (weightSum != BPS_DENOMINATOR) revert InvalidWeights();
        }

        if (newMaxSlippageBps > 0) {
            maxSlippageBps = newMaxSlippageBps;
        }

        if (newSwapExtraData.length > 0) {
            if (newSwapExtraData.length != _allocations.length) revert LengthMismatch();
            for (uint256 i; i < newSwapExtraData.length; ++i) {
                _swapExtraData[i] = newSwapExtraData[i];
            }
        }
    }

    // ── Rebalancing ──

    /// @notice Simple rebalance: sell all positions, re-buy at current target weights.
    ///         Proposer-only, Executed state only.
    function rebalance() external onlyProposer {
        if (_state != State.Executed) revert NotExecuted();
        if (_rebalancing) revert RebalancingInProgress();
        _rebalancing = true;

        // 1. Sell all positions back to asset
        uint256 len = _allocations.length;
        for (uint256 i; i < len; ++i) {
            TokenAllocation storage alloc = _allocations[i];
            uint256 bal = IERC20(alloc.token).balanceOf(address(this));
            if (bal == 0) continue;

            IERC20(alloc.token).forceApprove(address(swapAdapter), bal);
            swapAdapter.swap(alloc.token, asset, bal, 0, _swapExtraData[i]);
            alloc.tokenAmount = 0;
        }

        // 2. Re-buy at current target weights
        uint256 assetBalance = IERC20(asset).balanceOf(address(this));
        for (uint256 i; i < len; ++i) {
            TokenAllocation storage alloc = _allocations[i];
            uint256 allocation = (assetBalance * alloc.targetWeightBps) / BPS_DENOMINATOR;
            if (allocation == 0) continue;

            IERC20(asset).forceApprove(address(swapAdapter), allocation);
            uint256 amountOut = swapAdapter.swap(asset, alloc.token, allocation, 0, _swapExtraData[i]);
            if (amountOut == 0) revert SwapFailed();

            alloc.tokenAmount = amountOut;
            alloc.investedAmount = allocation;
        }

        _rebalancing = false;
        emit Rebalanced(assetBalance);
    }

    /// @notice Delta-based rebalance using Chainlink Data Streams prices.
    ///         Only swaps the difference between current and target allocations.
    /// @param priceReports Signed Chainlink Data Streams reports (one per allocation, same order)
    function rebalanceDelta(bytes[] calldata priceReports) external onlyProposer {
        if (_state != State.Executed) revert NotExecuted();
        if (_rebalancing) revert RebalancingInProgress();
        _rebalancing = true;

        uint256 len = _allocations.length;
        if (priceReports.length != len) revert LengthMismatch();

        // 1. Verify prices and compute current portfolio value
        uint256[] memory prices = new uint256[](len);
        uint256[] memory currentValues = new uint256[](len);
        uint256 totalValue;

        for (uint256 i; i < len; ++i) {
            prices[i] = _verifyPrice(priceReports[i]);
            uint256 bal = IERC20(_allocations[i].token).balanceOf(address(this));
            currentValues[i] = (bal * prices[i]) / PRICE_PRECISION;
            totalValue += currentValues[i];
        }

        // Include any asset balance already held (e.g., from previous partial rebalances)
        uint256 assetHeld = IERC20(asset).balanceOf(address(this));
        totalValue += assetHeld;

        // 2. Compute target values and deltas
        uint256 swapsExecuted;
        for (uint256 i; i < len; ++i) {
            uint256 targetValue = (totalValue * _allocations[i].targetWeightBps) / BPS_DENOMINATOR;

            if (currentValues[i] > targetValue) {
                // Overweight: sell the excess
                uint256 excessValue = currentValues[i] - targetValue;
                uint256 tokensToSell = (excessValue * PRICE_PRECISION) / prices[i];
                uint256 bal = IERC20(_allocations[i].token).balanceOf(address(this));
                if (tokensToSell > bal) tokensToSell = bal;
                if (tokensToSell > 0) {
                    IERC20(_allocations[i].token).forceApprove(address(swapAdapter), tokensToSell);
                    swapAdapter.swap(_allocations[i].token, asset, tokensToSell, 0, _swapExtraData[i]);
                    ++swapsExecuted;
                }
            }
        }

        // 3. Buy underweight positions with available asset
        for (uint256 i; i < len; ++i) {
            uint256 targetValue = (totalValue * _allocations[i].targetWeightBps) / BPS_DENOMINATOR;

            if (currentValues[i] < targetValue) {
                // Underweight: buy the deficit
                uint256 deficitValue = targetValue - currentValues[i];
                uint256 available = IERC20(asset).balanceOf(address(this));
                uint256 amountToSpend = deficitValue > available ? available : deficitValue;
                if (amountToSpend > 0) {
                    IERC20(asset).forceApprove(address(swapAdapter), amountToSpend);
                    uint256 amountOut =
                        swapAdapter.swap(asset, _allocations[i].token, amountToSpend, 0, _swapExtraData[i]);
                    if (amountOut == 0) revert SwapFailed();
                    ++swapsExecuted;
                }
            }
        }

        // 4. Update stored token amounts
        for (uint256 i; i < len; ++i) {
            _allocations[i].tokenAmount = IERC20(_allocations[i].token).balanceOf(address(this));
        }

        _rebalancing = false;
        emit RebalancedDelta(totalValue, swapsExecuted);
    }

    // ── Chainlink price verification ──

    function _verifyPrice(bytes calldata signedReport) internal returns (uint256 price) {
        if (chainlinkVerifier == address(0)) revert ZeroAddress();

        bytes memory verifierResponse = IVerifierProxy(chainlinkVerifier).verify(signedReport);
        ChainlinkReport memory report = abi.decode(verifierResponse, (ChainlinkReport));

        if (block.timestamp > report.expiresAt) revert StalePrice();
        if (report.price <= 0) revert InvalidAmount();

        // Chainlink prices are int192 with 18 decimals — convert to uint256
        price = uint256(uint192(report.price));
    }

    // ── View functions ──

    /// @notice Get all token allocations
    function getAllocations() external view returns (TokenAllocation[] memory) {
        return _allocations;
    }

    /// @notice Number of tokens in the basket
    function allocationCount() external view returns (uint256) {
        return _allocations.length;
    }

    /// @notice Get swap extra data for all tokens
    function getSwapExtraData() external view returns (bytes[] memory) {
        return _swapExtraData;
    }
}
