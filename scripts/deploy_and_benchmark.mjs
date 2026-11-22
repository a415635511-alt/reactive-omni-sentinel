import { readFileSync, writeFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther, id, parseEther } from 'ethers';
import solc from 'solc';

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const LASNA_RPC = process.env.LASNA_RPC || 'https://lasna-rpc.rnk.dev/';
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_CALLBACK_PROXY = '0x476F44b11F5C942c58f4c8E3d0300E5710743585';
const BASE_SEPOLIA_REACTIVE_FAUCET = '0x2afaFD298b23b62760711756088F75B7409f5967';

function loadKey() {
    if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY;
    const raw = JSON.parse(readFileSync('D:/Hermes/survival-ops/secrets/testnet_wallet.json', 'utf8'));
    return raw.privateKey;
}

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
    const pk = loadKey();
    const baseProvider = new JsonRpcProvider(BASE_SEPOLIA_RPC);
    const lasnaProvider = new JsonRpcProvider(LASNA_RPC);
    const baseWallet = new Wallet(pk, baseProvider);
    const lasnaWallet = new Wallet(pk, lasnaProvider);

    const baseBal = await baseProvider.getBalance(baseWallet.address);
    let lasnaBal = await lasnaProvider.getBalance(lasnaWallet.address);

    console.log('Deployer address :', baseWallet.address);
    console.log('Base Sepolia ETH :', formatEther(baseBal));
    console.log('Lasna lREACT     :', formatEther(lasnaBal));

    if (baseBal < parseEther('0.03')) {
        console.error('\nNeed at least 0.03 Base Sepolia ETH on', baseWallet.address);
        console.error('Get free Base Sepolia ETH from Coinbase CDP / Alchemy / QuickNode faucet, then rerun `npm run deploy`.');
        process.exit(1);
    }

    // 1. Auto-convert 0.02 Base Sepolia ETH -> 2 lREACT via official Reactive Faucet if Lasna balance < 0.5 lREACT
    let faucetTxHash = null;
    if (lasnaBal < parseEther('0.5')) {
        console.log('\nRequesting 2 lREACT via Base Sepolia Reactive Faucet (0.02 ETH -> 2 lREACT)...');
        const faucet = new Contract(BASE_SEPOLIA_REACTIVE_FAUCET, ['function request(address) external payable'], baseWallet);
        const ftx = await faucet.request(baseWallet.address, { value: parseEther('0.02') });
        const frec = await ftx.wait();
        faucetTxHash = frec.hash;
        console.log('Faucet tx:', faucetTxHash);
        for (let i = 0; i < 30; i++) {
            await sleep(2000);
            lasnaBal = await lasnaProvider.getBalance(lasnaWallet.address);
            if (lasnaBal >= parseEther('0.5')) break;
        }
        console.log('Updated Lasna lREACT:', formatEther(lasnaBal));
        if (lasnaBal < parseEther('0.1')) {
            throw new Error('lREACT has not arrived yet; wait 30s and rerun `npm run deploy`.');
        }
    }

    const compiled = compileContracts();
    const deployOn = async (wallet, name, args = [], valueWei = 0n) => {
        const f = new ContractFactory(compiled[name].abi, '0x' + compiled[name].evm.bytecode.object, wallet);
        const overrides = valueWei > 0n ? { value: valueWei } : {};
        const c = await f.deploy(...args, overrides);
        const tx = c.deploymentTransaction();
        await c.waitForDeployment();
        const addr = await c.getAddress();
        console.log(`Deployed ${name} @ ${addr} (tx=${tx.hash})`);
        return { contract: c, address: addr, txHash: tx.hash };
    };

    // 2. Deploy Origin Oracle + Destination Vault on Base Sepolia (200ms blocks)
    const oracle = await deployOn(baseWallet, 'FastPriceOraclePool');
    const vault = await deployOn(
        baseWallet,
        'SentinelExecutionVault',
        [BASE_SEPOLIA_CALLBACK_PROXY, baseWallet.address],
        parseEther('0.005'), // callback gas reserve on Base Sepolia
    );

    // 3. Deploy OmniSentinelReactive on Reactive Lasna (1s finality)
    const reactive = await deployOn(
        lasnaWallet,
        'OmniSentinelReactive',
        [BASE_SEPOLIA_CHAIN_ID, oracle.address, BASE_SEPOLIA_CHAIN_ID],
        parseEther('0.5'), // lREACT funding for subscriptions & react()
    );

    // 4. Bind Vault <-> Reactive and activate dual subscriptions
    const bindTx = await (await vault.contract.setAuthorizedWatcher(reactive.address)).wait();
    console.log('Vault authorized watcher tx:', bindTx.hash);

    const subTx = await (await reactive.contract.activateSubscriptions(vault.address)).wait();
    console.log('Reactive subscriptions activated tx:', subTx.hash);

    await sleep(3000);

    // 5. Execute LIVE End-to-End Sub-Second Benchmark: Open Order -> Pump Peak -> Trigger Trailing Stop & Stop-Loss
    const ETH_USD = id('ETH-USD');

    console.log('\n[LIVE BENCHMARK 1] Opening Stop-Loss Order #1 (SL=$2,900, TP=$3,400, 0.001 ETH)...');
    const open1 = await (await vault.contract.openProtectedOrder(ETH_USD, 2900_00000000n, 3400_00000000n, 0, 3600, { value: parseEther('0.001') })).wait();
    console.log('Order #1 opened tx:', open1.hash);

    console.log('[LIVE BENCHMARK 2] Opening Trailing-Stop Order #2 (5% trail, 0.001 ETH)...');
    const open2 = await (await vault.contract.openProtectedOrder(ETH_USD, 0, 0, 500, 3600, { value: parseEther('0.001') })).wait();
    console.log('Order #2 opened tx:', open2.hash);

    // Wait briefly for Reactive Lasna to index both OrderOpened events
    console.log('Waiting 8s for Reactive Lasna auto-registration of OrderOpened logs...');
    await sleep(8000);

    console.log('Publishing price $3,200 (sets trailing high-water mark = $3,200 -> dynamic stop $3,040)...');
    const p1 = await (await oracle.contract.publishPrice(ETH_USD, 3200_00000000n)).wait();
    console.log('Price $3,200 tx:', p1.hash);
    await sleep(5000);

    console.log('Publishing price $3,000 (breaches Order #2 trailing stop @ $3,040)...');
    const tTrigger2 = Date.now();
    const p2 = await (await oracle.contract.publishPrice(ETH_USD, 3000_00000000n)).wait();
    console.log('Trigger #2 origin tx:', p2.hash);

    console.log('Publishing price $2,850 (breaches Order #1 stop-loss @ $2,900)...');
    const tTrigger1 = Date.now();
    const p3 = await (await oracle.contract.publishPrice(ETH_USD, 2850_00000000n)).wait();
    console.log('Trigger #1 origin tx:', p3.hash);

    // Poll Base Sepolia Vault for callback execution receipts
    let exec1 = null;
    let exec2 = null;
    for (let i = 0; i < 45; i++) {
        await sleep(2000);
        const o1 = await vault.contract.orders(1);
        const o2 = await vault.contract.orders(2);
        if (!exec1 && o1.status === 2n) {
            exec1 = {
                orderId: 1,
                kind: Number(o1.executedKind),
                executedPriceE8: o1.executedPriceE8.toString(),
                originEventTimestamp: Number(o1.originEventTimestamp),
                callbackExecutedAt: Number(o1.callbackExecutedAt),
                endToEndLatencySec: Number(o1.endToEndLatencySec),
                wallClockMs: Date.now() - tTrigger1,
                receiptKey: o1.executionReceiptKey,
            };
            console.log('CALLBACK EXECUTED Order #1 (Stop-Loss):', exec1);
        }
        if (!exec2 && o2.status === 2n) {
            exec2 = {
                orderId: 2,
                kind: Number(o2.executedKind),
                executedPriceE8: o2.executedPriceE8.toString(),
                originEventTimestamp: Number(o2.originEventTimestamp),
                callbackExecutedAt: Number(o2.callbackExecutedAt),
                endToEndLatencySec: Number(o2.endToEndLatencySec),
                wallClockMs: Date.now() - tTrigger2,
                receiptKey: o2.executionReceiptKey,
            };
            console.log('CALLBACK EXECUTED Order #2 (Trailing-Stop):', exec2);
        }
        if (exec1 && exec2) break;
    }

    // Fetch callback tx hashes from OrderExecuted events
    const filter = vault.contract.filters.OrderExecuted();
    const events = await vault.contract.queryFilter(filter, open1.blockNumber, 'latest');
    const callbackTxs = events.map((ev) => ({
        orderId: Number(ev.args.orderId),
        kind: Number(ev.args.kind),
        txHash: ev.transactionHash,
        blockNumber: ev.blockNumber,
        endToEndLatencySec: Number(ev.args.endToEndLatencySec),
    }));

    const report = {
        timestamp: new Date().toISOString(),
        deployer: baseWallet.address,
        chains: {
            originAndDestination: { name: 'Base Sepolia', chainId: BASE_SEPOLIA_CHAIN_ID, callbackProxy: BASE_SEPOLIA_CALLBACK_PROXY },
            reactive: { name: 'Reactive Lasna', chainId: 5318007, systemContract: '0x8888888888888888888888888888888888888888' },
        },
        deployments: {
            FastPriceOraclePool: oracle,
            SentinelExecutionVault: vault,
            OmniSentinelReactive: reactive,
        },
        transactions: {
            faucetTxHash,
            bindTxHash: bindTx.hash,
            activateSubscriptionsTxHash: subTx.hash,
            openOrder1TxHash: open1.hash,
            openOrder2TxHash: open2.hash,
            pricePeak3200TxHash: p1.hash,
            triggerTrailingStopTxHash: p2.hash,
            triggerStopLossTxHash: p3.hash,
            callbackTxs,
        },
        benchmarks: { order1StopLoss: exec1, order2TrailingStop: exec2 },
    };

    writeFileSync(new URL('../deployment_proof.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8');
    console.log('\nSaved full deployment & latency proof to deployment_proof.json');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
