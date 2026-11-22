# OmniSentinel — 1-Second Autonomous Cross-Chain Stop-Loss, Take-Profit & Trailing-Stop Engine

> **Reactive Omni Buildathon — Track 1: *Every Second Counts***  
> **Live Measured End-to-End Loop Latency (Origin Event → Reactive Lasna 1s Finality → Destination Vault Settlement):** **`1 second`** (Stop-Loss) and **`2 seconds`** (Trailing-Stop) on **Base Sepolia (200ms blocks) ↔ Reactive Lasna (5318007)** — with **zero off-chain bots or keepers**.

---

## Live Verified Deployment & On-Chain Proof (Nov 22, 2026)

Every contract below is deployed live and executed end-to-end across **Base Sepolia (`84532`)** and **Reactive Lasna (`5318007`)**:

### Deployed Contracts

| Role | Chain | Contract Address | Deploy Tx |
|---|---|---|---|
| **Origin Oracle** (`FastPriceOraclePool`) | Base Sepolia (`84532`) | [`0x6b1CD0358E05257c2B352B1Ac94489057edaeDd9`](https://sepolia.basescan.org/address/0x6b1CD0358E05257c2B352B1Ac94489057edaeDd9) | [`0xf3d60b55...3125fc`](https://sepolia.basescan.org/tx/0xf3d60b55e16e01d85ff6bfc8c21e8d509b55fa7b3a256e85c3c91dfd1f3125fc) |
| **Destination Vault** (`SentinelExecutionVault`) | Base Sepolia (`84532`) | [`0x5946893aB70a4a140a9b5aEAF12e61A515e2CF21`](https://sepolia.basescan.org/address/0x5946893aB70a4a140a9b5aEAF12e61A515e2CF21) | [`0x66404a42...6b8831`](https://sepolia.basescan.org/tx/0x66404a42c5a87764e9eaa91c7361e89676a74474351e3799ed53ce8dc6b68831) |
| **Reactive Engine** (`OmniSentinelReactive`) | Reactive Lasna (`5318007`) | [`0xAFE1f520B2970728235856b8C99157184518C45a`](https://lasna.reactscan.net/address/0xAFE1f520B2970728235856b8C99157184518C45a) | [`0x68bf4a16...08ace8`](https://lasna.reactscan.net/tx/0x68bf4a16d8f7f2b915e8bf96699111302a8243d4647b109926b5658e7208ace8) |

### Live Full-Loop Transaction Trail & Measured Latency

| Step | Action | Origin / Setup Tx (Base Sepolia) | Reactive Lasna `react()` Tx | Destination Callback Settlement Tx (Base Sepolia) | On-Chain E2E Latency |
|---|---|---|---|---|---|
| 0 | Dual subscriptions activated (`PriceUpdated` + `OrderOpened`) | — | [`0xa202edd8...3021c`](https://lasna.reactscan.net/tx/0xa202edd8f934b876da17e95a72811f67b35a5a1d023eb4121765ac6e31b3021c) | — | — |
| 1 | Open Order #1 (Stop-Loss `$2,900` / Take-Profit `$3,400`, `0.001 ETH`) | [`0x4d1a921d...1780`](https://sepolia.basescan.org/tx/0x4d1a921d41fd0390d48bf29e78c248a6966eb9712dee1ef4e9e0a4c7e1641780) | Auto-registered (`RuleRegistered`): [`0x7fa2456a...5b2fc`](https://lasna.reactscan.net/tx/0x7fa2456a9a3dfd6539474cf13191c4698487263b9857654dd9da197d1625b2fc) | — | ~1s |
| 2 | Open Order #2 (5% Trailing-Stop, `0.001 ETH`) | [`0xabcbb59f...e26d`](https://sepolia.basescan.org/tx/0xabcbb59f857faa9c267327fea18a2a8025c3361df258e8770f0fc9047a5ee26d) | Auto-registered (`RuleRegistered`): [`0xda459446...e67a`](https://lasna.reactscan.net/tx/0xda459446cec5d1223a08ec89bfc425e8ff40ad4baf9dc6512ed94455e870e67a) | — | ~1s |
| 3 | Price pumps to `$3,200` → ratchets Order #2 dynamic stop to `$3,040` | [`0xdc6414e9...5b9b`](https://sepolia.basescan.org/tx/0xdc6414e932a72916828005596a0ad6ffae73e2844fa4ee5daaaa489c10f65b9b) | `HighWaterUpdated`: [`0xae89e65f...feb9`](https://lasna.reactscan.net/tx/0xae89e65f077ce8e43017cd81aec46e48b02fe92455512f4a44d06c676d48feb9) | — | ~1s |
| 4 | **Price drops to `$3,000` → Trailing-Stop fires & refunds trader** | [`0x9cd5b81d...95c9`](https://sepolia.basescan.org/tx/0x9cd5b81d23cd664651f51b752fbddc14720b29d4a524f14f1bc0a05dd47695c9) | `TriggerDispatched`: [`0x4208c43b...5b8d`](https://lasna.reactscan.net/tx/0x4208c43ba2ef5acf49b2430e2ff6b6721cb4b92b8bc97d4f9fb15671a7175b8d) | `OrderExecuted`: [`0x4513766a...acd2`](https://sepolia.basescan.org/tx/0x4513766adccdf63e91ad7e825a0f6ae18c60394b07512a1cfb9d1b8fed44acd2) | **2 sec** (`1795382899 → 1795382901`) |
| 5 | **Price crashes to `$2,850` → Stop-Loss fires & refunds trader** | [`0xd4225eae...d080`](https://sepolia.basescan.org/tx/0xd4225eaedd367b48e18ebb4fdf640af9dbd19c1c7c209071b0ff72823c3ed080) | `TriggerDispatched`: [`0x177671cb...eb69`](https://lasna.reactscan.net/tx/0x177671cbcc09d4afa4b3341a50b5e829bbc4a0830770178c11ddc31ecba4eb69) | `OrderExecuted`: [`0xac2baf24...6055`](https://sepolia.basescan.org/tx/0xac2baf24d27925db7eb80abc6fdbb925d6f52548358aff7318f64de335806055) | **1 sec** (`1795382901 → 1795382902`) |

Full raw JSON proof with all addresses, hashes, receipt keys, and timestamps is committed in [`deployment_proof.json`](./deployment_proof.json).

---

## Architecture: What 1-Second Finality Unlocks

```
 Base Sepolia (200ms blocks)                     Reactive Lasna (1s CometBFT finality)
┌───────────────────────────┐                   ┌─────────────────────────────────────┐
│ SentinelExecutionVault    │──OrderOpened────► │ OmniSentinelReactive                │
│  • openProtectedOrder()   │                   │  • auto-registers SL/TP/Trail rules │
│  • cancelOrder()          │                   │  • ratchets high-water peak on-chain│
│  • executeTriggeredOrder()│◄──Callback Proxy──│  • fires requestCallbackV_1_0()     │
└───────────────────────────┘   (1-2s E2E!)     └──────────────────▲──────────────────┘
                                                                   │ PriceUpdated
┌───────────────────────────┐                                      │
│ FastPriceOraclePool       │──────────────────────────────────────┘
│  • publishPrice()         │
└───────────────────────────┘
```

### Engineering Highlights
1. **100% Keeper-Free Order Lifecycle:** `OmniSentinelReactive` subscribes to BOTH `OrderOpened` (from the destination vault) AND `PriceUpdated` (from the origin oracle). Opening a protected order on Base Sepolia automatically arms the Reactive sentinel within ~1–2 seconds.
2. **Stateful On-Chain Trailing Stop-Loss:** Tracks `highWaterPriceE8` natively inside Reactive Network storage and dynamically recalculates `trailingThreshold = peak * (10_000 - trailingBps) / 10_000` on every sub-second price tick.
3. **200ms Block-Time Safe:** Strictly uses `block.timestamp` (never block-number math) for all expiries and telemetry, directly addressing Base Sepolia's 200ms Flashblocks cadence.
4. **Defense-in-Depth Security & Idempotency:** Destination vault enforces BOTH `msg.sender == CallbackProxy` AND overwritten `callbackSender == authorizedWatcher`, plus deterministic replay protection via `receiptKey`.
5. **Interactive Live Verifier Dashboard:** Open [`dashboard/index.html`](./dashboard/index.html) to query live state from Base Sepolia and Reactive Lasna RPCs.

---

## Reproduce Locally or On Testnet

```bash
npm install
npm test        # Full Anvil local lifecycle test (auto-register, Trailing-Stop, Stop-Loss, auth & replay checks)
npm run deploy  # End-to-end Base Sepolia <-> Reactive Lasna deployment + live latency benchmark
```
