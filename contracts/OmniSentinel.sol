// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title Reactive Omni System Contract Interface (0x8888888888888888888888888888888888888888)
interface IReactiveSystem {
    struct CallbackConfiguration {
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    function subscribe(
        uint256 chainId,
        address source,
        uint256 topic0,
        uint256 topic1,
        uint256 topic2,
        uint256 topic3
    ) external;

    function unsubscribe(
        uint256 chainId,
        address source,
        uint256 topic0,
        uint256 topic1,
        uint256 topic2,
        uint256 topic3
    ) external;

    function requestCallbackV_1_0(CallbackConfiguration calldata config) external;
}

/// @notice Shared Reactive service gas-reimbursement base contract
abstract contract ServiceFunded {
    error Unauthorized();
    error InvalidConfiguration();
    error ServicePaymentFailed();

    address public immutable serviceProvider;

    constructor(address provider) {
        if (provider == address(0)) revert InvalidConfiguration();
        serviceProvider = provider;
    }

    modifier onlyServiceProvider() {
        if (msg.sender != serviceProvider) revert Unauthorized();
        _;
    }

    receive() external payable {}

    function pay(uint256 amount) external onlyServiceProvider {
        if (amount == 0) return;
        (bool ok,) = payable(serviceProvider).call{value: amount}("");
        if (!ok) revert ServicePaymentFailed();
    }
}

/// @title FastPriceOraclePool (Deployed on Origin Chain — Base Sepolia 200ms blocks)
/// @notice Lightweight AMM/Price Feed emitting timestamped PriceUpdated events for deterministic latency benchmarking.
contract FastPriceOraclePool {
    error Unauthorized();
    error InvalidPrice();

    event PriceUpdated(
        bytes32 indexed marketId,
        uint256 indexed roundId,
        uint256 priceE8,
        uint64 originTimestamp,
        uint256 originBlock
    );

    address public immutable owner;
    mapping(bytes32 marketId => uint256) public latestPriceE8;
    mapping(bytes32 marketId => uint256) public roundIds;

    constructor() {
        owner = msg.sender;
    }

    function publishPrice(bytes32 marketId, uint256 priceE8) external returns (uint256 roundId) {
        if (msg.sender != owner) revert Unauthorized();
        if (marketId == bytes32(0) || priceE8 == 0) revert InvalidPrice();
        roundId = ++roundIds[marketId];
        latestPriceE8[marketId] = priceE8;
        emit PriceUpdated(marketId, roundId, priceE8, uint64(block.timestamp), block.number);
    }
}

/// @title SentinelExecutionVault (Deployed on Destination Chain — Base Sepolia / Unichain Sepolia)
/// @notice Holds user stop-loss / take-profit / trailing-stop orders and executes them atomically upon authenticated Reactive callbacks.
/// @dev Uses strictly timestamp-based cooldowns/expiries (Base Sepolia produces 200ms blocks).
contract SentinelExecutionVault is ServiceFunded {
    enum OrderStatus {
        NONE,
        ACTIVE,
        EXECUTED,
        CANCELLED,
        EXPIRED
    }

    enum TriggerKind {
        NONE,
        STOP_LOSS,
        TAKE_PROFIT,
        TRAILING_STOP
    }

    struct ProtectedOrder {
        address trader;
        bytes32 marketId;
        uint256 collateralWei;
        uint256 stopLossPriceE8;       // Trigger if price <= stopLossPriceE8 (0 = disabled)
        uint256 takeProfitPriceE8;     // Trigger if price >= takeProfitPriceE8 (0 = disabled)
        uint256 trailingBps;           // Trailing drawdown in bps from peak (0 = disabled)
        uint64 createdAt;
        uint64 expiresAt;              // Timestamp-based deadline (Base Sepolia 200ms safe)
        uint64 minCooldownSec;         // Timestamp cooldown
        OrderStatus status;
        TriggerKind executedKind;
        uint256 executedPriceE8;
        uint64 originEventTimestamp;
        uint64 callbackExecutedAt;
        uint64 endToEndLatencySec;
        bytes32 executionReceiptKey;
    }

    event OrderOpened(
        uint256 indexed orderId,
        address indexed trader,
        bytes32 indexed marketId,
        uint256 collateralWei,
        uint256 stopLossPriceE8,
        uint256 takeProfitPriceE8,
        uint256 trailingBps,
        uint64 expiresAt
    );

    event OrderExecuted(
        uint256 indexed orderId,
        address indexed trader,
        bytes32 indexed marketId,
        TriggerKind kind,
        uint256 triggerPriceE8,
        uint256 payoutWei,
        uint64 originEventTimestamp,
        uint64 callbackExecutedAt,
        uint64 endToEndLatencySec,
        bytes32 receiptKey
    );

    event OrderCancelled(uint256 indexed orderId, address indexed trader, uint256 refundWei);
    event WatcherAuthorized(address indexed watcher);

    error NotTrader();
    error OrderNotActive();
    error InvalidOrderParams();
    error TransferFailed();

    address public immutable owner;
    address public authorizedWatcher;
    uint256 public nextOrderId = 1;
    uint256 public executedCount;

    mapping(uint256 orderId => ProtectedOrder) public orders;
    mapping(bytes32 receiptKey => bool) public processedReceipts;

    constructor(address callbackProxy, address initialWatcher) payable ServiceFunded(callbackProxy) {
        owner = msg.sender;
        authorizedWatcher = initialWatcher;
    }

    function setAuthorizedWatcher(address watcher) external {
        if (msg.sender != owner) revert Unauthorized();
        if (watcher == address(0)) revert InvalidConfiguration();
        authorizedWatcher = watcher;
        emit WatcherAuthorized(watcher);
    }

    function openProtectedOrder(
        bytes32 marketId,
        uint256 stopLossPriceE8,
        uint256 takeProfitPriceE8,
        uint256 trailingBps,
        uint64 durationSeconds
    ) external payable returns (uint256 orderId) {
        if (marketId == bytes32(0) || msg.value == 0) revert InvalidOrderParams();
        if (stopLossPriceE8 == 0 && takeProfitPriceE8 == 0 && trailingBps == 0) revert InvalidOrderParams();
        if (stopLossPriceE8 > 0 && takeProfitPriceE8 > 0 && stopLossPriceE8 >= takeProfitPriceE8) {
            revert InvalidOrderParams();
        }
        if (trailingBps > 5_000) revert InvalidOrderParams();
        if (durationSeconds < 30 || durationSeconds > 30 days) revert InvalidOrderParams();

        orderId = nextOrderId++;
        uint64 nowTs = uint64(block.timestamp);
        uint64 expTs = nowTs + durationSeconds;

        orders[orderId] = ProtectedOrder({
            trader: msg.sender,
            marketId: marketId,
            collateralWei: msg.value,
            stopLossPriceE8: stopLossPriceE8,
            takeProfitPriceE8: takeProfitPriceE8,
            trailingBps: trailingBps,
            createdAt: nowTs,
            expiresAt: expTs,
            minCooldownSec: 0,
            status: OrderStatus.ACTIVE,
            executedKind: TriggerKind.NONE,
            executedPriceE8: 0,
            originEventTimestamp: 0,
            callbackExecutedAt: 0,
            endToEndLatencySec: 0,
            executionReceiptKey: bytes32(0)
        });

        emit OrderOpened(
            orderId,
            msg.sender,
            marketId,
            msg.value,
            stopLossPriceE8,
            takeProfitPriceE8,
            trailingBps,
            expTs
        );
    }

    function cancelOrder(uint256 orderId) external {
        ProtectedOrder storage ord = orders[orderId];
        if (ord.trader != msg.sender) revert NotTrader();
        if (ord.status != OrderStatus.ACTIVE) revert OrderNotActive();

        ord.status = OrderStatus.CANCELLED;
        uint256 refund = ord.collateralWei;
        (bool ok,) = payable(ord.trader).call{value: refund}("");
        if (!ok) revert TransferFailed();
        emit OrderCancelled(orderId, ord.trader, refund);
    }

    /// @notice Called exclusively by Reactive Network's Callback Proxy.
    /// @dev First argument `callbackSender` is overwritten by Reactive Callback Proxy with the Reactive contract address.
    function executeTriggeredOrder(
        address callbackSender,
        bytes32 receiptKey,
        uint256 orderId,
        TriggerKind kind,
        uint256 triggerPriceE8,
        uint64 originEventTimestamp
    ) external onlyServiceProvider {
        if (callbackSender != authorizedWatcher || authorizedWatcher == address(0)) revert Unauthorized();
        if (receiptKey == bytes32(0) || processedReceipts[receiptKey]) return;

        ProtectedOrder storage ord = orders[orderId];
        if (ord.status != OrderStatus.ACTIVE) return;

        uint64 nowTs = uint64(block.timestamp);
        if (nowTs > ord.expiresAt) {
            ord.status = OrderStatus.EXPIRED;
            return;
        }

        // Defense-in-depth price verification on destination chain
        if (kind == TriggerKind.STOP_LOSS) {
            if (ord.stopLossPriceE8 == 0 || triggerPriceE8 > ord.stopLossPriceE8) return;
        } else if (kind == TriggerKind.TAKE_PROFIT) {
            if (ord.takeProfitPriceE8 == 0 || triggerPriceE8 < ord.takeProfitPriceE8) return;
        } else if (kind == TriggerKind.TRAILING_STOP) {
            if (ord.trailingBps == 0 || triggerPriceE8 == 0) return;
        } else {
            return;
        }

        processedReceipts[receiptKey] = true;
        ord.status = OrderStatus.EXECUTED;
        ord.executedKind = kind;
        ord.executedPriceE8 = triggerPriceE8;
        ord.originEventTimestamp = originEventTimestamp;
        ord.callbackExecutedAt = nowTs;
        ord.endToEndLatencySec = nowTs >= originEventTimestamp ? (nowTs - originEventTimestamp) : 0;
        ord.executionReceiptKey = receiptKey;
        executedCount += 1;

        uint256 payout = ord.collateralWei;
        (bool ok,) = payable(ord.trader).call{value: payout}("");
        if (!ok) revert TransferFailed();

        emit OrderExecuted(
            orderId,
            ord.trader,
            ord.marketId,
            kind,
            triggerPriceE8,
            payout,
            originEventTimestamp,
            nowTs,
            ord.endToEndLatencySec,
            receiptKey
        );
    }
}

/// @title OmniSentinelReactive (Deployed on Reactive Lasna Chain ID 5318007)
/// @notice Autonomous on-chain risk engine subscribing directly to Origin Oracle PriceUpdated logs and Vault OrderOpened logs.
///         Maintains real-time trailing-stop watermarks on Reactive Omni (~1s finality) and fires callbacks the instant a threshold breaches.
contract OmniSentinelReactive is ServiceFunded {
    struct LogRecord {
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
        bytes data;
        uint256 blockNumber;
        uint256 opCode;
        uint256 blockHash;
        uint256 txHash;
        uint256 logIndex;
    }

    struct WatchedRule {
        uint256 orderId;
        bytes32 marketId;
        uint256 stopLossPriceE8;
        uint256 takeProfitPriceE8;
        uint256 trailingBps;
        uint256 highWaterPriceE8;
        uint64 expiresAt;
        bool active;
    }

    event RuleRegistered(
        uint256 indexed orderId,
        bytes32 indexed marketId,
        uint256 stopLossPriceE8,
        uint256 takeProfitPriceE8,
        uint256 trailingBps,
        uint64 expiresAt
    );

    event HighWaterUpdated(uint256 indexed orderId, uint256 newPeakPriceE8, uint256 dynamicStopE8);

    event TriggerDispatched(
        uint256 indexed orderId,
        bytes32 indexed marketId,
        SentinelExecutionVault.TriggerKind kind,
        uint256 triggerPriceE8,
        uint64 originEventTimestamp,
        bytes32 receiptKey
    );

    address private constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 private constant ANY_TOPIC = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;

    uint256 public constant PRICE_UPDATED_TOPIC =
        uint256(keccak256("PriceUpdated(bytes32,uint256,uint256,uint64,uint256)"));
    uint256 public constant ORDER_OPENED_TOPIC =
        uint256(keccak256("OrderOpened(uint256,address,bytes32,uint256,uint256,uint256,uint256,uint64)"));

    uint64 public constant CALLBACK_GAS_LIMIT = 500_000;

    address public immutable owner;
    uint256 public immutable originChainId;
    address public immutable oraclePool;
    uint256 public immutable destinationChainId;
    address public destinationVault;
    bool public subscriptionsActive;

    mapping(uint256 orderId => WatchedRule) public rules;
    mapping(bytes32 marketId => uint256[]) public marketOrderIds;
    uint256 public totalCallbacksRequested;

    constructor(
        uint256 _originChainId,
        address _oraclePool,
        uint256 _destinationChainId
    ) payable ServiceFunded(SYSTEM) {
        if (_originChainId == 0 || _oraclePool == address(0) || _destinationChainId == 0) {
            revert InvalidConfiguration();
        }
        owner = msg.sender;
        originChainId = _originChainId;
        oraclePool = _oraclePool;
        destinationChainId = _destinationChainId;
    }

    function activateSubscriptions(address _destinationVault) external {
        if (msg.sender != owner) revert Unauthorized();
        if (_destinationVault == address(0) || subscriptionsActive) revert InvalidConfiguration();

        destinationVault = _destinationVault;
        subscriptionsActive = true;

        // Subscribe to PriceUpdated on Origin Oracle
        IReactiveSystem(SYSTEM).subscribe(
            originChainId,
            oraclePool,
            PRICE_UPDATED_TOPIC,
            ANY_TOPIC,
            ANY_TOPIC,
            ANY_TOPIC
        );

        // Subscribe to OrderOpened on Destination Vault so new user orders auto-register with zero off-chain bot!
        IReactiveSystem(SYSTEM).subscribe(
            destinationChainId,
            destinationVault,
            ORDER_OPENED_TOPIC,
            ANY_TOPIC,
            ANY_TOPIC,
            ANY_TOPIC
        );
    }

    function react(LogRecord calldata log) external onlyServiceProvider {
        if (!subscriptionsActive) return;

        // 1) Auto-register newly opened protected orders from the Vault
        if (
            log.chainId == destinationChainId &&
            log.contractAddress == destinationVault &&
            log.topic0 == ORDER_OPENED_TOPIC
        ) {
            uint256 orderId = log.topic1;
            bytes32 marketId = bytes32(log.topic3);
            if (rules[orderId].active) return;

            (, uint256 slPrice, uint256 tpPrice, uint256 trailingBps, uint64 expiresAt) =
                abi.decode(log.data, (uint256, uint256, uint256, uint256, uint64));

            rules[orderId] = WatchedRule({
                orderId: orderId,
                marketId: marketId,
                stopLossPriceE8: slPrice,
                takeProfitPriceE8: tpPrice,
                trailingBps: trailingBps,
                highWaterPriceE8: 0,
                expiresAt: expiresAt,
                active: true
            });
            marketOrderIds[marketId].push(orderId);
            emit RuleRegistered(orderId, marketId, slPrice, tpPrice, trailingBps, expiresAt);
            return;
        }

        // 2) Evaluate every active rule for this market on each sub-second PriceUpdated event
        if (
            log.chainId == originChainId &&
            log.contractAddress == oraclePool &&
            log.topic0 == PRICE_UPDATED_TOPIC
        ) {
            bytes32 marketId = bytes32(log.topic1);
            (uint256 priceE8, uint64 originTs,) = abi.decode(log.data, (uint256, uint64, uint256));
            if (priceE8 == 0) return;

            uint256[] storage ids = marketOrderIds[marketId];
            uint256 len = ids.length;
            for (uint256 i = 0; i < len; i++) {
                WatchedRule storage r = rules[ids[i]];
                if (!r.active) continue;

                // Timestamp-based expiry check (safe for Base Sepolia 200ms blocks)
                if (originTs > r.expiresAt) {
                    r.active = false;
                    continue;
                }

                // Update trailing high-water mark if enabled
                if (r.trailingBps > 0 && priceE8 > r.highWaterPriceE8) {
                    r.highWaterPriceE8 = priceE8;
                    uint256 dynStop = (priceE8 * (10_000 - r.trailingBps)) / 10_000;
                    emit HighWaterUpdated(r.orderId, priceE8, dynStop);
                }

                SentinelExecutionVault.TriggerKind kind = SentinelExecutionVault.TriggerKind.NONE;
                if (r.stopLossPriceE8 > 0 && priceE8 <= r.stopLossPriceE8) {
                    kind = SentinelExecutionVault.TriggerKind.STOP_LOSS;
                } else if (r.takeProfitPriceE8 > 0 && priceE8 >= r.takeProfitPriceE8) {
                    kind = SentinelExecutionVault.TriggerKind.TAKE_PROFIT;
                } else if (r.trailingBps > 0 && r.highWaterPriceE8 > 0) {
                    uint256 trailingThreshold = (r.highWaterPriceE8 * (10_000 - r.trailingBps)) / 10_000;
                    if (priceE8 <= trailingThreshold) {
                        kind = SentinelExecutionVault.TriggerKind.TRAILING_STOP;
                    }
                }

                if (kind != SentinelExecutionVault.TriggerKind.NONE) {
                    r.active = false;
                    bytes32 receiptKey = keccak256(
                        abi.encode(log.chainId, log.contractAddress, log.txHash, log.logIndex, r.orderId)
                    );
                    bytes memory payload = abi.encodeCall(
                        SentinelExecutionVault.executeTriggeredOrder,
                        (address(0), receiptKey, r.orderId, kind, priceE8, originTs)
                    );

                    IReactiveSystem(SYSTEM).requestCallbackV_1_0(
                        IReactiveSystem.CallbackConfiguration({
                            chainId: destinationChainId,
                            recipient: destinationVault,
                            gasLimit: CALLBACK_GAS_LIMIT,
                            payload: payload
                        })
                    );
                    totalCallbacksRequested += 1;
                    emit TriggerDispatched(r.orderId, marketId, kind, priceE8, originTs, receiptKey);
                }
            }
        }
    }
}
