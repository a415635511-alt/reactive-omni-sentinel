# DoraHacks 提交材料（直接复制粘贴即可，Reactive Omni Buildathon — Every Second Counts 赛道）

## 1. Project Name
OmniSentinel — 1-Second Autonomous Cross-Chain Stop-Loss & Trailing-Stop Engine

## 2. Tagline / Short Description (<= 140 chars)
Keeper-free cross-chain Stop-Loss, Take-Profit & stateful Trailing-Stop running live at 1–2s E2E latency on Base Sepolia ↔ Reactive Lasna.

## 3. Track Selection
**Track 1 — Every Second Counts** ($2,000 1st Place)

## 4. GitHub Repository URL
https://github.com/a415635511-alt/reactive-omni-sentinel

## 5. Full Project Description (直接粘贴进 DoraHacks 详情框)

### Problem
On-chain stop-loss and trailing-stop mechanisms traditionally force traders into an ugly trade-off:
- **Centralized off-chain keeper bots** create single points of failure, rate limits, and missed triggers during flash crashes.
- **Legacy cross-chain relays** take 10–30+ seconds to finalize and deliver callbacks — long enough for a fast wick to blow past stop levels before protection executes.

### Solution: What 1-Second Finality Unlocks
**OmniSentinel** pairs **Reactive Omni / Lasna (~1s CometBFT finality)** with **Base Sepolia (200ms Flashblocks)** to deliver **100% autonomous, keeper-free cross-chain risk protection** with live-measured **1–2 second end-to-end execution latency**:

1. **Zero-Bot Order Auto-Registration (`OrderOpened` subscription):** When a trader opens a protected order in `SentinelExecutionVault` on Base Sepolia, `OmniSentinelReactive` automatically intercepts the `OrderOpened` log and arms the protection rule on Reactive Lasna within ~1–2 seconds — zero off-chain relayers.
2. **Stateful On-Chain Trailing-Stop Engine (`PriceUpdated` subscription):** Every price tick from `FastPriceOraclePool` updates the trailing `highWaterPriceE8` natively inside Reactive Network storage and computes dynamic drawdown thresholds (`peak * (10000 - trailingBps) / 10000`) on-chain.
3. **200ms Block-Time Safety:** All expiries and latency telemetry use strict `block.timestamp` math rather than block-number assumptions, ensuring exact timing on Base Sepolia's 200ms cadence.
4. **Defense-in-Depth Callback Security & Idempotency:** `SentinelExecutionVault` verifies BOTH `msg.sender == CallbackProxy` (`0x476F44b11F5C942c58f4c8E3d0300E5710743585`) AND overwritten `callbackSender == authorizedWatcher`, re-validates price conditions on destination, and prevents replay via `receiptKey = keccak256(chainId, source, txHash, logIndex, orderId)`.
5. **On-Chain Latency Telemetry:** Every settled order records `originEventTimestamp`, `callbackExecutedAt`, and `endToEndLatencySec` directly in storage and events.

### Live Deployed Contracts (Verified Nov 22, 2026)
- **Origin Oracle (`FastPriceOraclePool`, Base Sepolia `84532`)**: `0x6b1CD0358E05257c2B352B1Ac94489057edaeDd9`
- **Destination Vault (`SentinelExecutionVault`, Base Sepolia `84532`)**: `0x5946893aB70a4a140a9b5aEAF12e61A515e2CF21`
- **Reactive Engine (`OmniSentinelReactive`, Reactive Lasna `5318007`)**: `0xAFE1f520B2970728235856b8C99157184518C45a`

### Live Full-Loop Benchmarks & Transaction Proofs
- **Activate Dual Subscriptions (Lasna)**: `0xa202edd8f934b876da17e95a72811f67b35a5a1d023eb4121765ac6e31b3021c`
- **Auto-Register Order #1 (Stop-Loss $2,900 / TP $3,400)**: Origin `0x4d1a921d41fd0390d48bf29e78c248a6966eb9712dee1ef4e9e0a4c7e1641780` → Lasna `0x7fa2456a9a3dfd6539474cf13191c4698487263b9857654dd9da197d1625b2fc`
- **Auto-Register Order #2 (5% Trailing-Stop)**: Origin `0xabcbb59f857faa9c267327fea18a2a8025c3361df258e8770f0fc9047a5ee26d` → Lasna `0xda459446cec5d1223a08ec89bfc425e8ff40ad4baf9dc6512ed94455e870e67a`
- **High-Water Mark Ratchet ($3,200 → Dynamic Stop $3,040)**: Origin `0xdc6414e932a72916828005596a0ad6ffae73e2844fa4ee5daaaa489c10f65b9b` → Lasna `0xae89e65f077ce8e43017cd81aec46e48b02fe92455512f4a44d06c676d48feb9`
- **Live Trailing-Stop Settlement @ $3,000 (2s E2E Latency)**:
  - Origin Event (Base Sepolia): `0x9cd5b81d23cd664651f51b752fbddc14720b29d4a524f14f1bc0a05dd47695c9` (`ts=1795382899`)
  - Reactive Dispatch (Lasna): `0x4208c43ba2ef5acf49b2430e2ff6b6721cb4b92b8bc97d4f9fb15671a7175b8d`
  - Callback Settlement (Base Sepolia): `0x4513766adccdf63e91ad7e825a0f6ae18c60394b07512a1cfb9d1b8fed44acd2` (`ts=1795382901`, **E2E = 2s**)
- **Live Stop-Loss Settlement @ $2,850 (1s E2E Latency)**:
  - Origin Event (Base Sepolia): `0xd4225eaedd367b48e18ebb4fdf640af9dbd19c1c7c209071b0ff72823c3ed080` (`ts=1795382901`)
  - Reactive Dispatch (Lasna): `0x177671cbcc09d4afa4b3341a50b5e829bbc4a0830770178c11ddc31ecba4eb69`
  - Callback Settlement (Base Sepolia): `0xac2baf24d27925db7eb80abc6fdbb925d6f52548358aff7318f64de335806055` (`ts=1795382902`, **E2E = 1s**)

### Interactive Verifier & Local Tests
- Run `npm test` for full Anvil lifecycle verification (dual subscriptions, auto-registration, Trailing-Stop, Stop-Loss, unauthorized caller rejection, replay protection).
- Open `dashboard/index.html` to query live Base Sepolia & Reactive Lasna RPC state directly from the browser.
