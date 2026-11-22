import { readFileSync, writeFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther, id, parseEther, parseUnits } from 'ethers';
import solc from 'solc';

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const LASNA_RPC = process.env.LASNA_RPC || 'https://lasna-rpc.rnk.dev/';
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_CALLBACK_PROXY = '0x476F44b11F5C942c58f4c8E3d0300E5710743585';

// Already deployed on Base Sepolia in previous step (reuse to save testnet ETH!)
const ORACLE_ADDR = '0x6b1CD0358E05257c2B352B1Ac94489057edaeDd9';
const ORACLE_TX = '0xf3d60b55e16e01d85ff6bfc8c21e8d509b55fa7b3a256e85c3c91dfd1f3125fc';
const VAULT_ADDR = '0x5946893aB70a4a140a9b5aEAF12e61A515e2CF21';
const VAULT_TX = '0x66404a42c5a87764e9eaa91c7361e89676a74474351e3799ed53ce8dc6b68831';
const FAUCET_TX = '0xdbca93c5db52cceeb729f5049dd20401d1ac7387fccebc264a0f7c1ad6aa4e50';

function compileContracts() {
    const src = readFileSync(new URL('../contracts/OmniSentinel.sol', import.meta.url), 'utf8');
    const out = JSON.parse(
        solc.compile(
            JSON.stringify({
                language: 'Solidity',
                sources: { 'OmniSentinel.sol': { content: src } },
                settings: {
                    optimizer: { enabled: true, runs: 200 },
                    viaIR: true,
                    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
                },
            }),
        ),
    );
    const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
    if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
    return out.contracts['OmniSentinel.sol'];
}

async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    const raw = JSON.parse(readFileSync('D:/Hermes/survival-ops/secrets/testnet_wallet.json', 'utf8'));
    const baseProvider = new JsonRpcProvider(BASE_SEPOLIA_RPC);
    const lasnaProvider = new JsonRpcProvider(LASNA_RPC);
    const baseWallet = new Wallet(raw.privateKey, baseProvider);
    const lasnaWallet = new Wallet(raw.privateKey, lasnaProvider);

    console.log('Deployer        :', baseWallet.address);
    console.log('Base Sepolia ETH:', formatEther(await baseProvider.getBalance(baseWallet.address)));
    console.log('Lasna lREACT    :', formatEther(await lasnaProvider.getBalance(lasnaWallet.address)));

    const compiled = compileContracts();
    const oracle = new Contract(ORACLE_ADDR, compiled.FastPriceOraclePool.abi, baseWallet);
    const vault = new Contract(VAULT_ADDR, compiled.SentinelExecutionVault.abi, baseWallet);

    // Lasna requires explicit gas tip >= 1 wei (use legacy gasPrice or EIP-1559 with tip >= 1 gwei)
    const lasnaFee = await lasnaProvider.getFeeData();
    const lasnaOverrides = {
        maxPriorityFeePerGas: parseUnits('1', 'gwei'),
        maxFeePerGas: (lasnaFee.maxFeePerGas && lasnaFee.maxFeePerGas > parseUnits('2', 'gwei'))
            ? lasnaFee.maxFeePerGas * 2n
            : parseUnits('5', 'gwei'),
    };
    console.log('Lasna fee overrides:', {
        maxPriorityFeePerGas: lasnaOverrides.maxPriorityFeePerGas.toString(),
        maxFeePerGas: lasnaOverrides.maxFeePerGas.toString(),
    });

    // 1. Deploy OmniSentinelReactive on Reactive Lasna
    const f = new ContractFactory(
        compiled.OmniSentinelReactive.abi,
        '0x' + compiled.OmniSentinelReactive.evm.bytecode.object,
        lasnaWallet,
    );
    const reactive = await f.deploy(BASE_SEPOLIA_CHAIN_ID, ORACLE_ADDR, BASE_SEPOLIA_CHAIN_ID, {
        value: parseEther('0.5'),
        ...lasnaOverrides,
    });
    const reactiveDeployTx = reactive.deploymentTransaction();
    await reactive.waitForDeployment();
    const reactiveAddr = await reactive.getAddress();
    console.log(`Deployed OmniSentinelReactive @ ${reactiveAddr} (tx=${reactiveDeployTx.hash})`);

    // 2. Bind Vault -> Reactive & Activate Dual Subscriptions
    const bindTx = await (await vault.setAuthorizedWatcher(reactiveAddr)).wait();
    console.log('Vault authorized watcher tx:', bindTx.hash);

    const subTx = await (await reactive.activateSubscriptions(VAULT_ADDR, lasnaOverrides)).wait();
    console.log('Reactive subscriptions activated tx:', subTx.hash);

    await sleep(4000);

    // 3. LIVE Full-Loop Sub-Second Benchmark on Base Sepolia <-> Reactive Lasna
    const ETH_USD = id('ETH-USD');

    console.log('\n[1/5] Opening Stop-Loss Order #1 (SL=$2,900, TP=$3,400, 0.001 ETH)...');
    const open1 = await (
        await vault.openProtectedOrder(ETH_USD, 2900_00000000n, 3400_00000000n, 0, 3600, { value: parseEther('0.001') })
    ).wait();
    console.log('Order #1 opened tx:', open1.hash);

    console.log('[2/5] Opening Trailing-Stop Order #2 (5% trail, 0.001 ETH)...');
    const open2 = await (
        await vault.openProtectedOrder(ETH_USD, 0, 0, 500, 3600, { value: parseEther('0.001') })
    ).wait();
    console.log('Order #2 opened tx:', open2.hash);

    // Poll Reactive Lasna until both OrderOpened rules auto-register on-chain!
    console.log('Waiting for Reactive Lasna to auto-register both OrderOpened rules...');
    for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const r1 = await reactive.rules(1);
        const r2 = await reactive.rules(2);
        if (r1.active && r2.active) {
            console.log(`Both rules auto-registered on Reactive Lasna in ~${(i + 1) * 2}s!`);
            break;
        }
        if (i === 29) console.log('Rule status after 60s:', { r1Active: r1.active, r2Active: r2.active });
    }

    console.log('\n[3/5] Publishing price $3,200 (sets trailing high-water mark = $3,200 -> dynamic stop $3,040)...');
    const p1 = await (await oracle.publishPrice(ETH_USD, 3200_00000000n)).wait();
    console.log('Price $3,200 tx:', p1.hash);
    for (let i = 0; i < 20; i++) {
        await sleep(1500);
        const r2 = await reactive.rules(2);
        if (r2.highWaterPriceE8 === 3200_00000000n) {
            console.log(`High-water mark $3,200 ratcheted on Reactive Lasna in ~${((i + 1) * 1.5).toFixed(1)}s!`);
            break;
        }
    }

    console.log('\n[4/5] Publishing price $3,000 (breaches Order #2 trailing stop @ $3,040)...');
    const tTrigger2 = Date.now();
    const p2 = await (await oracle.publishPrice(ETH_USD, 3000_00000000n)).wait();
    console.log('Trigger #2 origin tx:', p2.hash);

    console.log('[5/5] Publishing price $2,850 (breaches Order #1 stop-loss @ $2,900)...');
    const tTrigger1 = Date.now();
    const p3 = await (await oracle.publishPrice(ETH_USD, 2850_00000000n)).wait();
    console.log('Trigger #1 origin tx:', p3.hash);

    // Poll Base Sepolia Vault for live callback settlements
    let exec1 = null;
    let exec2 = null;
    for (let i = 0; i < 45; i++) {
        await sleep(2000);
        const o1 = await vault.orders(1);
        const o2 = await vault.orders(2);
        if (!exec1 && o1.status === 2n) {
            exec1 = {
                orderId: 1,
                kind: 'STOP_LOSS',
                executedPriceUsd: Number(o1.executedPriceE8) / 1e8,
                originEventTimestamp: Number(o1.originEventTimestamp),
                callbackExecutedAt: Number(o1.callbackExecutedAt),
                endToEndLatencySec: Number(o1.endToEndLatencySec),
                wallClockMs: Date.now() - tTrigger1,
                receiptKey: o1.executionReceiptKey,
            };
            console.log('LIVE CALLBACK SETTLED Order #1 (Stop-Loss):', exec1);
        }
        if (!exec2 && o2.status === 2n) {
            exec2 = {
                orderId: 2,
                kind: 'TRAILING_STOP',
                executedPriceUsd: Number(o2.executedPriceE8) / 1e8,
                originEventTimestamp: Number(o2.originEventTimestamp),
                callbackExecutedAt: Number(o2.callbackExecutedAt),
                endToEndLatencySec: Number(o2.endToEndLatencySec),
                wallClockMs: Date.now() - tTrigger2,
                receiptKey: o2.executionReceiptKey,
            };
            console.log('LIVE CALLBACK SETTLED Order #2 (Trailing-Stop):', exec2);
        }
        if (exec1 && exec2) break;
    }

    const events = await vault.queryFilter(vault.filters.OrderExecuted(), open1.blockNumber, 'latest');
    const callbackTxs = events.map((ev) => ({
        orderId: Number(ev.args.orderId),
        kind: Number(ev.args.kind),
        txHash: ev.transactionHash,
        blockNumber: ev.blockNumber,
        endToEndLatencySec: Number(ev.args.endToEndLatencySec),
    }));

    // Also pull Reactive Lasna TriggerDispatched logs
    const rLogs = await reactive.queryFilter(reactive.filters.TriggerDispatched(), 0, 'latest').catch(() => []);
    const reactiveTxs = rLogs.map((ev) => ({
        orderId: Number(ev.args.orderId),
        kind: Number(ev.args.kind),
        txHash: ev.transactionHash,
        blockNumber: ev.blockNumber,
    }));

    const report = {
        timestamp: new Date().toISOString(),
        deployer: baseWallet.address,
        chains: {
            originAndDestination: {
                name: 'Base Sepolia',
                chainId: BASE_SEPOLIA_CHAIN_ID,
                callbackProxy: BASE_SEPOLIA_CALLBACK_PROXY,
                explorer: 'https://sepolia.basescan.org',
            },
            reactive: {
                name: 'Reactive Lasna',
                chainId: 5318007,
                systemContract: '0x8888888888888888888888888888888888888888',
                explorer: 'https://lasna.reactscan.net',
            },
        },
        deployments: {
            FastPriceOraclePool: { address: ORACLE_ADDR, txHash: ORACLE_TX },
            SentinelExecutionVault: { address: VAULT_ADDR, txHash: VAULT_TX },
            OmniSentinelReactive: { address: reactiveAddr, txHash: reactiveDeployTx.hash },
        },
        transactions: {
            faucetTxHash: FAUCET_TX,
            bindTxHash: bindTx.hash,
            activateSubscriptionsTxHash: subTx.hash,
            openOrder1TxHash: open1.hash,
            openOrder2TxHash: open2.hash,
            pricePeak3200TxHash: p1.hash,
            triggerTrailingStopTxHash: p2.hash,
            triggerStopLossTxHash: p3.hash,
            reactiveDispatchTxs: reactiveTxs,
            destinationCallbackTxs: callbackTxs,
        },
        benchmarks: { order1StopLoss: exec1, order2TrailingStop: exec2 },
    };

    writeFileSync(new URL('../deployment_proof.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8');
    console.log('\nSaved complete live proof to deployment_proof.json');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
