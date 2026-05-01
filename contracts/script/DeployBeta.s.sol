// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Create3Factory} from "../src/Create3Factory.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../src/SyndicateFactory.sol";
import {SyndicateGovernor} from "../src/SyndicateGovernor.sol";
import {MinimalGuardianRegistry} from "../src/MinimalGuardianRegistry.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {ScriptBase} from "./ScriptBase.sol";

/**
 * @notice Beta deployment of the Sherwood protocol — used while WOOD has not
 *         yet been deployed and the guardian network is intentionally
 *         disabled.
 *
 *         Differences vs. `Deploy.s.sol`:
 *           1. Deploys `MinimalGuardianRegistry` (no proxy, no WOOD) instead
 *              of the full UUPS `GuardianRegistry`. `reviewPeriod = 0`
 *              collapses GuardianReview to a 0-second window so proposals
 *              advance Pending -> Approved as soon as voting ends.
 *           2. Governor `votingPeriod = 1 hours`.
 *           3. `guardianFeeBps = 0` so `_distributeFees` never calls into the
 *              registry.
 *           4. Owner of all proxies is the deployer EOA (no multisig handoff).
 *
 *         Beta vaults must be created with `openDeposits = false` (allowlist-
 *         only) — that is enforced at the syndicate-creator layer (CLI
 *         default), not here.
 *
 *   Environment variables:
 *     ENS_REGISTRAR     — L2 Registrar address (default: 0x0)
 *     AGENT_REGISTRY    — ERC-8004 Identity Registry (default: 0x0)
 *     MANAGEMENT_FEE    — Management fee in bps (default: 50 = 0.5%)
 *     PROTOCOL_FEE      — Protocol fee in bps (default: 200 = 2%)
 *     MAX_STRATEGY_DAYS — Max strategy duration in days (default: 14)
 *
 *   Usage:
 *     forge script script/DeployBeta.s.sol:DeploySherwoodBeta \
 *       --rpc-url <chain> --account <acct> --sender <addr> --broadcast --slow
 */
contract DeploySherwoodBeta is ScriptBase {
    // ── CREATE3 salts (distinct from prod so beta + prod can coexist) ──
    bytes32 constant SALT_EXECUTOR = keccak256("sherwood.beta.executor.1");
    bytes32 constant SALT_VAULT_IMPL = keccak256("sherwood.beta.vault-impl.1");
    bytes32 constant SALT_GOVERNOR_IMPL = keccak256("sherwood.beta.governor-impl.1");
    bytes32 constant SALT_GOVERNOR_PROXY = keccak256("sherwood.beta.governor-proxy.1");
    bytes32 constant SALT_FACTORY_IMPL = keccak256("sherwood.beta.factory-impl.1");
    bytes32 constant SALT_FACTORY_PROXY = keccak256("sherwood.beta.factory-proxy.1");

    // ── Beta governor params ──
    uint256 constant BETA_VOTING_PERIOD = 1 hours;
    uint256 constant BETA_EXECUTION_WINDOW = 1 days;
    uint256 constant BETA_VETO_THRESHOLD_BPS = 4000; // 40%
    uint256 constant BETA_MAX_PERFORMANCE_FEE_BPS = 3000; // 30%
    uint256 constant BETA_COOLDOWN = 1 hours;
    uint256 constant BETA_COLLABORATION_WINDOW = 24 hours;
    uint256 constant BETA_MAX_COPROPOSERS = 5;
    uint256 constant BETA_MIN_STRATEGY_DURATION = 30 minutes;

    struct Config {
        address ensRegistrar;
        address agentRegistry;
        uint256 managementFeeBps;
        uint256 protocolFeeBps;
        uint256 maxStrategyDays;
    }

    struct Deployed {
        address deployer;
        address executorLib;
        address vaultImpl;
        address governorProxy;
        address factoryProxy;
        address registry; // MinimalGuardianRegistry (non-upgradeable, no proxy)
    }

    function run() external {
        Config memory cfg = Config({
            ensRegistrar: vm.envOr("ENS_REGISTRAR", address(0)),
            agentRegistry: vm.envOr("AGENT_REGISTRY", address(0)),
            managementFeeBps: vm.envOr("MANAGEMENT_FEE", uint256(50)),
            protocolFeeBps: vm.envOr("PROTOCOL_FEE", uint256(200)),
            maxStrategyDays: vm.envOr("MAX_STRATEGY_DAYS", uint256(14))
        });

        vm.startBroadcast();
        Deployed memory d = _deployCore(cfg);
        vm.stopBroadcast();

        console.log("\n=== Sherwood Beta Deployment ===");
        console.log("Deployer (also protocol owner):", d.deployer);
        console.log("Chain ID:", block.chainid);
        console.log("BatchExecutorLib:", d.executorLib);
        console.log("VaultImpl:", d.vaultImpl);
        console.log("GovernorProxy:", d.governorProxy);
        console.log("FactoryProxy:", d.factoryProxy);
        console.log("MinimalGuardianRegistry (stub):", d.registry);
        console.log("votingPeriod: 1 hour");
        console.log("guardianFeeBps: 0 (registry stubbed)");

        // ── Validate ──
        _validate(d, cfg);

        // ── Persist ──
        _writeAddresses(_chainName(), d.deployer, d.factoryProxy, d.governorProxy, d.executorLib, d.vaultImpl);
        _patchAddress("GUARDIAN_REGISTRY", d.registry);

        console.log("\nBeta deployment complete on %s (chain %s)", _chainName(), block.chainid);
        console.log("Reminder: create syndicates with openDeposits=false (allowlist-only) for beta.");
    }

    function _deployCore(Config memory cfg) internal returns (Deployed memory d) {
        d.deployer = msg.sender;

        Create3Factory c3 = new Create3Factory(d.deployer);

        d.executorLib = c3.deploy(SALT_EXECUTOR, abi.encodePacked(type(BatchExecutorLib).creationCode));
        d.vaultImpl = c3.deploy(SALT_VAULT_IMPL, abi.encodePacked(type(SyndicateVault).creationCode));

        // Stub registry first — governor proxy needs its address at init time.
        d.registry = address(new MinimalGuardianRegistry());

        address govImpl = c3.deploy(SALT_GOVERNOR_IMPL, abi.encodePacked(type(SyndicateGovernor).creationCode));
        d.governorProxy = _deployGovernorProxy(c3, govImpl, d.deployer, d.registry, cfg);

        address factoryImpl = c3.deploy(SALT_FACTORY_IMPL, abi.encodePacked(type(SyndicateFactory).creationCode));
        d.factoryProxy = _deployFactoryProxy(c3, factoryImpl, d, cfg);

        SyndicateGovernor(d.governorProxy).setFactory(d.factoryProxy);
    }

    function _deployGovernorProxy(
        Create3Factory c3,
        address govImpl,
        address deployer,
        address registry,
        Config memory cfg
    ) internal returns (address) {
        bytes memory initData = abi.encodeCall(
            SyndicateGovernor.initialize,
            (
                ISyndicateGovernor.InitParams({
                    owner: deployer,
                    votingPeriod: BETA_VOTING_PERIOD,
                    executionWindow: BETA_EXECUTION_WINDOW,
                    vetoThresholdBps: BETA_VETO_THRESHOLD_BPS,
                    maxPerformanceFeeBps: BETA_MAX_PERFORMANCE_FEE_BPS,
                    cooldownPeriod: BETA_COOLDOWN,
                    collaborationWindow: BETA_COLLABORATION_WINDOW,
                    maxCoProposers: BETA_MAX_COPROPOSERS,
                    minStrategyDuration: BETA_MIN_STRATEGY_DURATION,
                    maxStrategyDuration: cfg.maxStrategyDays * 1 days,
                    protocolFeeBps: cfg.protocolFeeBps,
                    protocolFeeRecipient: deployer,
                    guardianFeeBps: 0
                }),
                registry
            )
        );
        return c3.deploy(
            SALT_GOVERNOR_PROXY, abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(govImpl, initData))
        );
    }

    function _deployFactoryProxy(Create3Factory c3, address factoryImpl, Deployed memory d, Config memory cfg)
        internal
        returns (address)
    {
        bytes memory initData = abi.encodeCall(
            SyndicateFactory.initialize,
            (SyndicateFactory.InitParams({
                    owner: d.deployer,
                    executorImpl: d.executorLib,
                    vaultImpl: d.vaultImpl,
                    ensRegistrar: cfg.ensRegistrar,
                    agentRegistry: cfg.agentRegistry,
                    governor: d.governorProxy,
                    managementFeeBps: cfg.managementFeeBps,
                    guardianRegistry: d.registry
                }))
        );
        return c3.deploy(
            SALT_FACTORY_PROXY, abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(factoryImpl, initData))
        );
    }

    function _chainName() internal view returns (string memory) {
        if (block.chainid == 8453) return "Base";
        if (block.chainid == 84532) return "Base Sepolia";
        if (block.chainid == 999) return "HyperEVM";
        if (block.chainid == 998) return "HyperEVM Testnet";
        if (block.chainid == 46630) return "Robinhood L2 Testnet";
        if (block.chainid == 42161) return "Arbitrum";
        return "Unknown";
    }

    function _validate(Deployed memory d, Config memory cfg) internal view {
        SyndicateGovernor gov = SyndicateGovernor(d.governorProxy);
        ISyndicateGovernor.GovernorParams memory p = gov.getGovernorParams();
        require(p.votingPeriod == BETA_VOTING_PERIOD, "votingPeriod != 1h");
        require(gov.guardianRegistry() == d.registry, "registry mismatch");
        require(gov.factory() == d.factoryProxy, "factory mismatch");
        require(SyndicateGovernor(d.governorProxy).owner() == d.deployer, "governor owner != deployer");
        require(SyndicateFactory(d.factoryProxy).owner() == d.deployer, "factory owner != deployer");
        require(SyndicateFactory(d.factoryProxy).vaultImpl() == d.vaultImpl, "vaultImpl mismatch");
        require(SyndicateFactory(d.factoryProxy).managementFeeBps() == cfg.managementFeeBps, "mgmt fee mismatch");

        // The stub registry has no `owner()` so we don't validate ownership there.
        // It is non-upgradeable; nothing for the deployer to own.
    }
}
