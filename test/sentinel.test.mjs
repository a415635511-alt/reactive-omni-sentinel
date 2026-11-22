import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Contract, ContractFactory, Interface, JsonRpcProvider, ZeroAddress, id, parseEther } from 'ethers';
import solc from 'solc';

const SYSTEM_ADDR = '0x8888888888888888888888888888888888888888';

const MOCK_HARNESS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

contract MockReactiveSystem {
    struct CallbackConfiguration {
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    event Subscribed(uint256 indexed chainId, address indexed source, uint256 indexed topic0);
    event CallbackRequested(address indexed sender, uint256 chainId, address recipient, uint64 gasLimit, bytes payload);

    function subscribe(uint256 chainId, address source, uint256 topic0, uint256, uint256, uint256) external {
        emit Subscribed(chainId, source, topic0);
    }

    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external {}

    function requestCallbackV_1_0(CallbackConfiguration calldata config) external {
        emit CallbackRequested(msg.sender, config.chainId, config.recipient, config.gasLimit, config.payload);
    }

    function dispatchReact(address reactiveContract, bytes calldata data) external {
        (bool ok, bytes memory err) = reactiveContract.call(data);
        if (!ok) {
            assembly { revert(add(err, 32), mload(err)) }
        }
    }
}

contract MockCallbackProxy {
    function deliver(address target, address reactiveSender, bytes memory payload) external {
        // Reactive Callback Proxy overwrites the first 32-byte argument (offset 4..36) with reactiveSender
        assembly { mstore(add(payload, 36), reactiveSender) }
        (bool ok, bytes memory err) = target.call(payload);
        if (!ok) {
            assembly { revert(add(err, 32), mload(err)) }
        }
    }
}
`;

function compileAll() {
    const sources = {
        'OmniSentinel.sol': { content: readFileSync(new URL('../contracts/OmniSentinel.sol', import.meta.url), 'utf8') },
        'MockHarness.sol': { content: MOCK_HARNESS },
    };
    const out = JSON.parse(
        solc.compile(
            JSON.stringify({
                language: 'Solidity',
                sources,
                settings: {
                    optimizer: { enabled: true, runs: 200 },
                    viaIR: true,
                    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
                },
            }),
        ),
    );
    const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
    assert.deepEqual(
        errors.map((e) => e.formattedMessage),
        [],
    );
    return Object.assign({}, ...Object.values(out.contracts));
}

async function freePort() {
    const s = createServer();
    await new Promise((r, j) => s.once('error', j).listen(0, '127.0.0.1', r));
    const { port } = s.address();
    await new Promise((r, j) => s.close((e) => (e ? j(e) : r())));
    return port;
}

function toLogRecord(chainId, receipt, logObj) {
    const t = [0n, 0n, 0n, 0n];
    for (let i = 0; i < Math.min(4, logObj.topics.length); i++) t[i] = BigInt(logObj.topics[i]);
    return [
        chainId,
        logObj.address,
        t[0],
        t[1],
        t[2],
        t[3],
        logObj.data,
        receipt.blockNumber,
        0,
        BigInt(receipt.blockHash),
        BigInt(receipt.hash),
        logObj.index,
    ];
}

test('full OmniSentinel lifecycle: auto-register, Stop-Loss, Take-Profit, Trailing-Stop, replay & auth protection', async (t) => {
    const contracts = compileAll();
    const port = await freePort();
    // Reuse anvil binary installed in sibling reactive-invoice or local node_modules
    let anvilBin;
    try {
        anvilBin = fileURLToPath(new URL('../node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe', import.meta.url));
        readFileSync(anvilBin.replace('anvil.exe', 'anvil.exe')).subarray(0, 1);
    } catch {
        anvilBin = fileURLToPath(new URL('../../reactive-invoice/node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe', import.meta.url));
    }

    const anvil = spawn(anvilBin, ['--host', '127.0.0.1', '--port', String(port), '--silent'], { stdio: 'ignore' });
    const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { staticNetwork: true });
    t.after(() => {
        provider.destroy();
        anvil.kill();
    });

    let owner;
    for (let i = 0; i < 60; i++) {
        try {
            owner = await provider.getSigner(0);
            break;
        } catch {
            await delay(100);
        }
    }
    assert.ok(owner, 'Anvil failed to boot');
    const trader = await provider.getSigner(1);
    const attacker = await provider.getSigner(2);

    const deploy = async (name, signer, ...args) => {
        const c = contracts[name];
        const f = new ContractFactory(c.abi, '0x' + c.evm.bytecode.object, signer);
        const inst = await f.deploy(...args);
        return inst.waitForDeployment();
    };

    // Inject mock Reactive System at 0x8888...8888
    await provider.send('anvil_setCode', [SYSTEM_ADDR, '0x' + contracts.MockReactiveSystem.evm.deployedBytecode.object]);
    const system = new Contract(SYSTEM_ADDR, contracts.MockReactiveSystem.abi, owner);
    const sysIface = new Interface(contracts.MockReactiveSystem.abi);

    const CHAIN_ID = 84532; // Base Sepolia
    const oracle = await deploy('FastPriceOraclePool', owner);
    const proxy = await deploy('MockCallbackProxy', owner);
    const reactive = await deploy('OmniSentinelReactive', owner, CHAIN_ID, await oracle.getAddress(), CHAIN_ID);
    const vault = await deploy('SentinelExecutionVault', owner, await proxy.getAddress(), await reactive.getAddress());

    const reactiveAddr = await reactive.getAddress();
    const vaultAddr = await vault.getAddress();

    // Unauthorized activation must revert
    await assert.rejects(reactive.connect(attacker).activateSubscriptions.staticCall(vaultAddr));

    // Activate dual subscriptions (PriceUpdated + OrderOpened)
    const actTx = await (await reactive.activateSubscriptions(vaultAddr)).wait();
    const subs = actTx.logs.map((l) => { try { return sysIface.parseLog(l); } catch { return null; } }).filter((x) => x?.name === 'Subscribed');
    assert.equal(subs.length, 2, 'Expected 2 Reactive subscriptions (Oracle + Vault)');

    const ETH_USD = id('ETH-USD');

    // Helper: feed any receipt's first matching log into Reactive contract via System
    const feedToReactive = async (receipt, logIdx = 0) => {
        const rec = toLogRecord(CHAIN_ID, receipt, receipt.logs[logIdx]);
        const calldata = reactive.interface.encodeFunctionData('react', [rec]);
        return (await system.dispatchReact(reactiveAddr, calldata)).wait();
    };

    // 1. Open Order #1: Stop-Loss @ $2,900, Take-Profit @ $3,400, 0.25 ETH collateral
    const open1 = await (await vault.connect(trader).openProtectedOrder(ETH_USD, 2900_00000000n, 3400_00000000n, 0, 3600, { value: parseEther('0.25') })).wait();
    await feedToReactive(open1, 0);
    const rule1 = await reactive.rules(1);
    assert.equal(rule1.active, true);
    assert.equal(rule1.stopLossPriceE8, 2900_00000000n);
    assert.ok(rule1.expiresAt > 0n, 'expiresAt should be non-zero');

    // 2. Open Order #2: Trailing Stop 5% (500 bps), 0.30 ETH collateral
    const open2 = await (await vault.connect(trader).openProtectedOrder(ETH_USD, 0, 0, 500, 3600, { value: parseEther('0.30') })).wait();
    await feedToReactive(open2, 0);

    // 3. Price moves to $3,200 (safe for Order #1, sets high-water mark = $3,200 on Order #2 -> trailing stop = $3,040)
    const p1 = await (await oracle.publishPrice(ETH_USD, 3200_00000000n)).wait();
    const r1 = await feedToReactive(p1, 0);
    const cbs1 = r1.logs.map((l) => { try { return sysIface.parseLog(l); } catch { return null; } }).filter((x) => x?.name === 'CallbackRequested');
    assert.equal(cbs1.length, 0, 'No trigger at $3,200');
    assert.equal((await reactive.rules(2)).highWaterPriceE8, 3200_00000000n);

    // 4. Price drops to $3,000 -> breaches Order #2 trailing stop ($3,040) but NOT Order #1 stop-loss ($2,900)
    const p2 = await (await oracle.publishPrice(ETH_USD, 3000_00000000n)).wait();
    const r2 = await feedToReactive(p2, 0);
    const cbs2 = r2.logs.map((l) => { try { return sysIface.parseLog(l); } catch { return null; } }).filter((x) => x?.name === 'CallbackRequested');
    assert.equal(cbs2.length, 1, 'Expected exactly 1 callback (Order #2 trailing stop)');

    // Forged sender via proxy must fail; direct call without proxy must fail
    await assert.rejects(proxy.deliver.staticCall(vaultAddr, ZeroAddress, cbs2[0].args.payload));
    await assert.rejects(vault.connect(attacker).executeTriggeredOrder.staticCall(reactiveAddr, id('fake'), 2, 3, 3000_00000000n, 1));

    // Authentic delivery succeeds & returns 0.30 ETH to trader
    const traderAddr = await trader.getAddress();
    const balBefore2 = await provider.getBalance(traderAddr);
    const deliverTx2 = await (await proxy.connect(owner).deliver(vaultAddr, reactiveAddr, cbs2[0].args.payload)).wait();
    const balAfter2 = await provider.getBalance(traderAddr, deliverTx2.blockNumber);
    const ord2 = await vault.orders(2);
    assert.equal(ord2.status, 2n, `Expected EXECUTED(2), got status=${ord2.status}`); // EXECUTED
    assert.equal(ord2.executedKind, 3n); // TRAILING_STOP
    assert.equal(balAfter2 - balBefore2, parseEther('0.30'));

    // Replay delivery is idempotent no-op
    await (await proxy.deliver(vaultAddr, reactiveAddr, cbs2[0].args.payload)).wait();
    assert.equal(await vault.executedCount(), 1n);

    // 5. Price crashes to $2,850 -> breaches Order #1 stop-loss ($2,900)
    const p3 = await (await oracle.publishPrice(ETH_USD, 2850_00000000n)).wait();
    const r3 = await feedToReactive(p3, 0);
    const cbs3 = r3.logs.map((l) => { try { return sysIface.parseLog(l); } catch { return null; } }).filter((x) => x?.name === 'CallbackRequested');
    assert.equal(cbs3.length, 1, 'Expected Stop-Loss callback for Order #1');
    await (await proxy.deliver(vaultAddr, reactiveAddr, cbs3[0].args.payload)).wait();
    const ord1 = await vault.orders(1);
    assert.equal(ord1.status, 2n);
    assert.equal(ord1.executedKind, 1n); // STOP_LOSS
    assert.equal(await vault.executedCount(), 2n);
});
