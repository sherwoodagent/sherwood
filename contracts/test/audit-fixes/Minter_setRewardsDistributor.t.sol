// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WoodToken} from "../../src/WoodToken.sol";
import {VotingEscrow} from "../../src/VotingEscrow.sol";
import {Voter} from "../../src/Voter.sol";
import {Minter} from "../../src/Minter.sol";
import {MockLzEndpoint} from "../mocks/MockLzEndpoint.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Smallest possible deployable contract — its only purpose is to have non-empty
///         code so it passes the `code.length > 0` gate on `setRewardsDistributor`.
contract DummyDistributor {}

/// @title Minter_setRewardsDistributor
/// @notice Regression tests for MS-H7 (audit 2026-05-01): `Minter.setRewardsDistributor`
///         must reject `address(0)` and EOAs and emit a transparent change event.
contract Minter_setRewardsDistributor is Test {
    WoodToken internal wood;
    VotingEscrow internal votingEscrow;
    Voter internal voter;
    Minter internal minter;

    address internal owner = address(0x1111);
    address internal stranger = address(0x2222);
    address internal treasury = address(0x4444);
    address internal mockSyndicateFactory = address(0x5555);

    event RewardsDistributorChanged(address indexed oldDistributor, address indexed newDistributor);

    function setUp() public {
        vm.startPrank(owner);

        MockLzEndpoint lzEndpoint = new MockLzEndpoint();
        // CREATE order: WoodToken(+0), VotingEscrow(+1), Voter(+2), Minter(+3)
        uint64 nonce = vm.getNonce(owner);
        address predictedMinter = vm.computeCreateAddress(owner, nonce + 3);

        wood = new WoodToken(address(lzEndpoint), owner, predictedMinter);
        votingEscrow = new VotingEscrow(address(wood), owner);
        voter = new Voter(
            address(votingEscrow), mockSyndicateFactory, block.timestamp, address(wood), predictedMinter, owner
        );
        minter = new Minter(address(wood), address(voter), address(votingEscrow), treasury, owner);

        voter.startVoting();
        vm.stopPrank();
    }

    // ------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------

    function test_revertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(Minter.ZeroAddress.selector);
        minter.setRewardsDistributor(address(0));
    }

    function test_revertsOnEoaRecipient() public {
        // EOA = no code at the address
        address eoa = address(0xDEAD);
        assertEq(eoa.code.length, 0, "precondition: target must be EOA");

        vm.prank(owner);
        vm.expectRevert(Minter.NotAContract.selector);
        minter.setRewardsDistributor(eoa);
    }

    function test_revertsOnNonOwner() public {
        DummyDistributor distributor = new DummyDistributor();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        minter.setRewardsDistributor(address(distributor));
    }

    // ------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------

    function test_setsDistributorAndEmitsEvent() public {
        DummyDistributor distributor = new DummyDistributor();

        vm.expectEmit(true, true, false, false, address(minter));
        emit RewardsDistributorChanged(address(0), address(distributor));

        vm.prank(owner);
        minter.setRewardsDistributor(address(distributor));

        assertEq(minter.rewardsDistributor(), address(distributor));
    }

    function test_replacingDistributorEmitsOldAddress() public {
        DummyDistributor first = new DummyDistributor();
        DummyDistributor second = new DummyDistributor();

        vm.prank(owner);
        minter.setRewardsDistributor(address(first));

        vm.expectEmit(true, true, false, false, address(minter));
        emit RewardsDistributorChanged(address(first), address(second));

        vm.prank(owner);
        minter.setRewardsDistributor(address(second));

        assertEq(minter.rewardsDistributor(), address(second));
    }

    // ------------------------------------------------------------
    // Fuzz: any contract address with bytecode is acceptable; any EOA is not.
    // ------------------------------------------------------------

    function testFuzz_rejectsArbitraryEoa(address candidate) public {
        // Restrict to EOAs only
        vm.assume(candidate != address(0));
        vm.assume(candidate.code.length == 0);

        vm.prank(owner);
        vm.expectRevert(Minter.NotAContract.selector);
        minter.setRewardsDistributor(candidate);
    }
}
