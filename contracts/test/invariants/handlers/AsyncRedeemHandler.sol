// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../../../src/SyndicateVault.sol";
import {VaultWithdrawalQueue} from "../../../src/queue/VaultWithdrawalQueue.sol";
import {IVaultWithdrawalQueue} from "../../../src/interfaces/IVaultWithdrawalQueue.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Drives random LP deposit / requestRedeem / claim / cancel sequences
///         while toggling the lock state. Bound to the AsyncRedeemInvariants
///         harness via `targetContract`.
contract AsyncRedeemHandler is Test {
    SyndicateVault public vault;
    VaultWithdrawalQueue public queue;
    IERC20 public asset;
    address public mockGovernor;

    address[] public actors;
    uint256[] public openRequestIds;
    mapping(uint256 => bool) public idIsOpen;

    uint256 public expectedPending; // tracked by handler, matched against queue
    uint256 public depositCalls;
    uint256 public requestCalls;
    uint256 public claimCalls;
    uint256 public cancelCalls;
    uint256 public lockToggleCalls;

    constructor(SyndicateVault vault_, VaultWithdrawalQueue queue_, IERC20 asset_, address mockGovernor_) {
        vault = vault_;
        queue = queue_;
        asset = asset_;
        mockGovernor = mockGovernor_;
        // 4 fixed actors keeps the state space small and bounded
        actors.push(makeAddr("actor0"));
        actors.push(makeAddr("actor1"));
        actors.push(makeAddr("actor2"));
        actors.push(makeAddr("actor3"));
        for (uint256 i; i < actors.length; i++) {
            deal(address(asset), actors[i], 1_000_000e6);
            vm.prank(actors[i]);
            asset.approve(address(vault), type(uint256).max);
        }
    }

    function setLocked(bool locked) external {
        lockToggleCalls++;
        vm.mockCall(
            mockGovernor,
            abi.encodeWithSignature("getActiveProposal(address)"),
            abi.encode(locked ? uint256(1) : uint256(0))
        );
        // MS-H4: deposits are also gated by `openProposalCount` — mirror lock state.
        vm.mockCall(
            mockGovernor,
            abi.encodeWithSignature("openProposalCount(address)"),
            abi.encode(locked ? uint256(1) : uint256(0))
        );
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        depositCalls++;
        if (vault.redemptionsLocked()) return; // deposits blocked while locked
        if (vault.paused()) return;
        address a = actors[actorSeed % actors.length];
        amount = bound(amount, 1e6, 100_000e6);
        if (asset.balanceOf(a) < amount) return;
        vm.prank(a);
        try vault.deposit(amount, a) {}
            catch {
            // ignore: e.g. revert from a deposit cap or paused state
        }
    }

    function requestRedeem(uint256 actorSeed, uint256 sharesSeed) external {
        requestCalls++;
        if (!vault.redemptionsLocked()) return; // can only queue while locked
        address a = actors[actorSeed % actors.length];
        uint256 bal = vault.balanceOf(a);
        if (bal == 0) return;
        uint256 s = bound(sharesSeed, 1, bal);
        vm.prank(a);
        try vault.requestRedeem(s, a) returns (uint256 reqId) {
            openRequestIds.push(reqId);
            idIsOpen[reqId] = true;
            expectedPending += s;
        } catch {
            // ignore — should not happen given preconditions, but be permissive
        }
    }

    function claimRandom(uint256 idSeed) external {
        claimCalls++;
        if (vault.redemptionsLocked()) return; // queue claim blocked while locked
        if (openRequestIds.length == 0) return;
        // pick a random ID
        uint256 idx = idSeed % openRequestIds.length;
        uint256 reqId = openRequestIds[idx];
        if (!idIsOpen[reqId]) return;
        uint256 shares = uint256(queue.getRequest(reqId).shares);
        try queue.claim(reqId) returns (uint256) {
            expectedPending -= shares;
            idIsOpen[reqId] = false;
        } catch {
            // ignore — possible if the float is insufficient (shouldn't happen
            // because of reserve, but defensive)
        }
    }

    function cancelRandom(uint256 idSeed) external {
        cancelCalls++;
        if (openRequestIds.length == 0) return;
        uint256 idx = idSeed % openRequestIds.length;
        uint256 reqId = openRequestIds[idx];
        if (!idIsOpen[reqId]) return;
        IVaultWithdrawalQueue.Request memory r = queue.getRequest(reqId);
        if (r.claimed || r.cancelled) {
            idIsOpen[reqId] = false;
            return;
        }
        vm.prank(r.owner);
        try queue.cancel(reqId) {
            expectedPending -= uint256(r.shares);
            idIsOpen[reqId] = false;
        } catch {}
    }

    // Views for invariant assertions
    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }
}
