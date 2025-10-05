#!/usr/bin/env node
/**
 * CrazyOctagon Smart Bot (REWRITTEN)
 * - Anti-dump push logic (rise→instant, fall→delay+stability)
 * - Random buy/sell trading (7 buy variants, 6 sell variants)
 * - PancakeSwap only price source
 * - FIXED: strict sequential TX queue with centralized nonce tracker
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const fs = require('fs');
const { ethers } = require('ethers');

// ===== CONFIG =====
const RPC_URL = 'https://testnet-rpc.monad.xyz';
const NFT_COLLECTION = '0x4bcd4aff190d715fa7201cce2e69dd72c0549b07'.toLowerCase();
const CRAA_TOKEN = '0x7D7F4BDd43292f9E7Aae44707a7EEEB5655ca465'.toLowerCase();
const OCTA_TOKEN = '0xB4832932D819361e0d250c338eBf87f0757ed800'.toLowerCase();
const WMON_TOKEN = '0x760AfE86e5de5fa0Ee542fc7b7b713e1c5425701'.toLowerCase();
const CRAA_WMON_POOL = '0x5d5c70b9ce487b07b57fbfb6da083aa60d03fc28'.toLowerCase();
const OCTA_WMON_POOL = '0xa4ddfdeb408e37199a3784584d174c670591cb42'.toLowerCase();
const PANCAKE_FACTORY = '0x82438CE666d9403e488bA720c7424434e8Aa47CD'.toLowerCase();
const RES_BASE = 'https://api-monad-testnet.reservoir.tools';
const CORE_PROXY = '0xb8Fee974031de01411656F908E13De4Ad9c74A9B'.toLowerCase();
const ROUTER = '0x3a3eBAe0Eec80852FBC7B9E824C6756969cc8dc1'.toLowerCase();

console.log('DEBUG: NFT_COLLECTION=', NFT_COLLECTION);
console.log('DEBUG: RPC_URL=', RPC_URL);

// Push config (anti-dump)
const ORACLE_PK = process.env.ORACLE_PK || '';
const MIN_CHANGE_PCT = parseFloat(process.env.MIN_CHANGE_PCT || '0.05'); // 5%
const DECREASE_DELAY_MS = parseInt(process.env.DECREASE_DELAY_MS || '3600000', 10); // 1 hour
const PENDING_TOL_PCT = parseFloat(process.env.PENDING_TOL_PCT || '0.05'); // 5%
const MAX_STEP_DOWN_PCT = parseFloat(process.env.MAX_STEP_DOWN_PCT || '0.15'); // 15%
const GAS_LIMIT = parseInt(process.env.GAS_LIMIT || '500000');

// Trading config
const TRADE_MODE = process.env.TRADE_MODE || 'off'; // off | on
const BASE_TRADE_MON = parseFloat(process.env.BASE_TRADE_MON || '0.01');
const TRADE_SLIPPAGE_BPS = parseInt(process.env.TRADE_SLIPPAGE_BPS || '500'); // 5%
const TRADER_PK = process.env.TRADER_PK || ORACLE_PK;

// Buy: 7 variants (10-70% of BASE_TRADE_MON)
const BUY_VARIANTS_PCT = [10, 20, 30, 40, 50, 60, 70];
// Sell: 6 variants (10-50% of bought amount)
const SELL_VARIANTS_PCT = [10, 20, 30, 40, 50, 60];

const PairAbi = require('./abis/UniswapV2Pair.json');
const ERC20Abi = require('./abis/ERC20.json');

const SCALE = 10n ** 18n;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const statePath = path.join(__dirname, '..', 'data', 'bot_state.json');
const errPath = path.join(__dirname, '..', 'data', 'error_state.json');

// Rate limiting: randomized delay between RPC calls
const RATE_LIMIT_MIN_MS = parseInt(process.env.RATE_LIMIT_MIN_MS || '500', 10);
const RATE_LIMIT_MAX_MS = parseInt(process.env.RATE_LIMIT_MAX_MS || '1200', 10);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay() {
  const min = Math.min(RATE_LIMIT_MIN_MS, RATE_LIMIT_MAX_MS);
  const max = Math.max(RATE_LIMIT_MIN_MS, RATE_LIMIT_MAX_MS);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Simple retry helper with exponential backoff
async function retryAsync(fn, attempts = 3, baseDelay = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const backoff = baseDelay * 2 ** i;
      console.warn(`Retry ${i + 1}/${attempts} failed: ${e && e.message ? e.message : String(e)} - backoff ${backoff}ms`);
      if (i < attempts - 1) await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// ===== CENTRALIZED TX QUEUE (strict sequential, single nonce tracker per wallet) =====
class TxQueue {
  constructor(wallet, provider) {
    this.wallet = wallet;
    this.provider = provider;
    this.queue = [];
    this.processing = false;
    this.currentNonce = null; // will be fetched on first use
  }

  async init() {
    if (this.currentNonce === null) {
      const addr = await this.wallet.getAddress();
      this.currentNonce = await this.provider.getTransactionCount(addr, 'pending');
      console.log(`TxQueue initialized for ${addr}, starting nonce: ${this.currentNonce}`);
    }
  }

  async enqueue(txFn, description = 'tx') {
    return new Promise((resolve, reject) => {
      this.queue.push({ txFn, description, resolve, reject });
      this._process();
    });
  }

  async _process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const { txFn, description, resolve, reject } = this.queue.shift();
      try {
        await this.init(); // ensure nonce is fetched
        const nonce = this.currentNonce;
        console.log(`  [TxQueue] Sending ${description} with nonce ${nonce}...`);
        
        // Execute tx function (should return a tx request or call a contract method)
        await sleep(randomDelay()); // rate-limit delay
        const tx = await txFn(nonce);
        
        // Wait for confirmation (with timeout)
        try {
          await this.provider.waitForTransaction(tx.hash, 1, 120000); // 2 min timeout
          console.log(`  [TxQueue] ✅ ${description} confirmed: ${tx.hash}`);
        } catch (waitErr) {
          console.warn(`  [TxQueue] waitForTransaction warning for ${description}:`, waitErr && waitErr.message ? waitErr.message : String(waitErr));
        }
        
        // Increment nonce for next tx
        this.currentNonce += 1;
        resolve(tx);
      } catch (err) {
        console.error(`  [TxQueue] ❌ ${description} failed:`, err && err.message ? err.message : String(err));
        // Do NOT increment nonce on failure — will retry with same nonce or let user handle
        reject(err);
      }
    }

    this.processing = false;
  }
}

// Global TX queues (one per wallet/private key)
let oracleQueue = null;
let traderQueue = null;

function getOracleQueue() {
  if (!oracleQueue && ORACLE_PK) {
    const wallet = new ethers.Wallet(ORACLE_PK, provider);
    oracleQueue = new TxQueue(wallet, provider);
  }
  return oracleQueue;
}

function getTraderQueue() {
  if (!traderQueue && TRADER_PK) {
    const wallet = new ethers.Wallet(TRADER_PK, provider);
    traderQueue = new TxQueue(wallet, provider);
  }
  return traderQueue;
}

function isValidAddress(a){ return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a); }
function randomChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ===== STATE =====
function readState() {
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeState(obj) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(obj, null, 2));
}

function readErrorState() {
  try {
    const raw = fs.readFileSync(errPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { consecutive: 0, lastErrorAt: 0, stoppedUntil: 0 };
  }
}

function writeErrorState(obj) {
  fs.mkdirSync(path.dirname(errPath), { recursive: true });
  fs.writeFileSync(errPath, JSON.stringify(obj, null, 2));
}

function recordError() {
  const s = readErrorState();
  s.consecutive = (s.consecutive || 0) + 1;
  s.lastErrorAt = Date.now();
  if (s.consecutive >= 3) {
    s.stoppedUntil = Date.now() + 60 * 60 * 1000; // 1 hour
    console.error('‼️ Too many consecutive errors — stopping until', new Date(s.stoppedUntil).toISOString());
  }
  writeErrorState(s);
}

function clearErrors() {
  writeErrorState({ consecutive: 0, lastErrorAt: 0, stoppedUntil: 0 });
}

function shouldStopForErrors() {
  const s = readErrorState();
  if (!s || !s.stoppedUntil) return false;
  if (Date.now() < s.stoppedUntil) return true;
  clearErrors();
  return false;
}

// ===== PANCAKESWAP PRICE =====
async function findPancakePair(tokenAddr) {
  if (!PANCAKE_FACTORY || !WMON_TOKEN) throw new Error('PANCAKE_FACTORY or WMON_TOKEN missing');
  const factoryAbi = ['function getPair(address,address) view returns (address)'];
  const factory = new ethers.Contract(PANCAKE_FACTORY, factoryAbi, provider);
  await sleep(randomDelay());
  const rawPair = await retryAsync(() => factory.getPair(tokenAddr, WMON_TOKEN));
  const zero = '0x0000000000000000000000000000000000000000';
  if (!rawPair || rawPair.toLowerCase() === zero) {
    if (tokenAddr === CRAA_TOKEN && CRAA_WMON_POOL) return CRAA_WMON_POOL;
    if (tokenAddr === OCTA_TOKEN && OCTA_WMON_POOL) return OCTA_WMON_POOL;
    throw new Error(`No pair for ${tokenAddr}`);
  }

  const pair = rawPair.toLowerCase();
  try {
    console.log(`Factory returned pair address for token ${tokenAddr}: ${pair}`);
    await sleep(randomDelay());
    const code = await retryAsync(() => provider.getCode(pair));
    console.log(`Pair code size (hex): ${code.length} for ${pair}`);
    if (!code || code === '0x') {
      throw new Error(`No contract code at pair address ${pair}`);
    }
    const pairContract = new ethers.Contract(pair, ['function token0() view returns (address)'], provider);
    await sleep(randomDelay());
    await retryAsync(() => pairContract.token0());
    return pair;
  } catch (err) {
    console.error(`Pair at ${pair} failed token0() call:`, err?.message ?? String(err));
    if (tokenAddr === CRAA_TOKEN && CRAA_WMON_POOL) return CRAA_WMON_POOL;
    if (tokenAddr === OCTA_TOKEN && OCTA_WMON_POOL) return OCTA_WMON_POOL;
    throw new Error(`Pair at ${pair} is not a valid Pancake pair: ${err?.message ?? String(err)}`);
  }
}

async function priceTokenInMON(pairAddr, tokenAddr) {
  const pair = new ethers.Contract(pairAddr, PairAbi, provider);
  await sleep(randomDelay());
  const t0 = await retryAsync(() => pair.token0());
  await sleep(randomDelay());
  const t1 = await retryAsync(() => pair.token1());
  await sleep(randomDelay());
  const reserves = await retryAsync(() => pair.getReserves());
  const [r0, r1] = reserves;
  const token0 = t0.toLowerCase();
  const token1 = t1.toLowerCase();
  if (tokenAddr !== token0 && tokenAddr !== token1) throw new Error('token not in pair');
  const other = tokenAddr === token0 ? token1 : token0;
  const ercToken = new ethers.Contract(tokenAddr, ERC20Abi, provider);
  const ercOther = new ethers.Contract(other, ERC20Abi, provider);
  const [decT, decO] = await Promise.all([
    ercToken.decimals().catch(()=>18),
    ercOther.decimals().catch(()=>18)
  ]);

  const reserveTokenRaw = tokenAddr === token0 ? BigInt(r0) : BigInt(r1);
  const reserveOtherRaw = tokenAddr === token0 ? BigInt(r1) : BigInt(r0);
  if (reserveTokenRaw === 0n || reserveOtherRaw === 0n) throw new Error('empty reserves');

  const diff = BigInt(decT) - BigInt(decO);
  let numerator = reserveOtherRaw;
  let denominator = reserveTokenRaw;
  if (diff > 0n) {
    numerator *= 10n ** diff;
  } else if (diff < 0n) {
    denominator *= 10n ** (-diff);
  }

  const priceScaled = numerator * SCALE / denominator;
  const tokensPerOtherScaled = denominator * SCALE / numerator;

  return {
    priceScaled,
    tokensPerOtherScaled,
    decToken: Number(decT),
    decOther: Number(decO),
    reserveToken: reserveTokenRaw,
    reserveOther: reserveOtherRaw
  };
}

async function fetchFloorMON() {
  const url = `${RES_BASE}/stats/v2?collection=${NFT_COLLECTION}`;
  try {
    await sleep(randomDelay());
    const { data } = await retryAsync(() => axios.get(url, { timeout: 15000 }));
    const native = data?.stats?.market?.floorAsk?.value?.native || data?.stats?.floor?.native;
    if (native && typeof native === 'number') return native;
  } catch (e) { /* ignore */ }
  const url2 = `${RES_BASE}/tokens/floor/v1?contract=${NFT_COLLECTION}&limit=100`;
  await sleep(randomDelay());
  const { data: d2 } = await retryAsync(() => axios.get(url2, { timeout: 15000 }));
  const rawTokens = d2?.tokens;
  let prices = [];
  if (Array.isArray(rawTokens)) {
    prices = rawTokens.map(t => t?.market?.floorAsk?.price?.native ?? t?.market?.floorAsk?.value?.native).filter(v => typeof v === 'number');
  } else if (rawTokens && typeof rawTokens === 'object') {
    const entries = Object.entries(rawTokens);
    if (entries.length && typeof entries[0][1] === 'number') {
      prices = entries.map(e => Number(e[1])).filter(v => typeof v === 'number');
    } else {
      prices = Object.values(rawTokens).map(t => t?.market?.floorAsk?.price?.native).filter(v => typeof v === 'number');
    }
  }
  if (prices.length) return Math.min(...prices);
  throw new Error('floor not found');
}

async function fetchPrices() {
  if (!NFT_COLLECTION) throw new Error('NFT_COLLECTION empty');
  if (!CRAA_TOKEN || !OCTA_TOKEN) throw new Error('Token addresses missing');

  console.log('🔍 Fetching prices (PancakeSwap only)...');
  const floorMon = await fetchFloorMON();

  const floorMonWei = ethers.parseUnits(floorMon.toString(), 18);

  const craaPair = await findPancakePair(CRAA_TOKEN);
  const craaInfo = await priceTokenInMON(craaPair, CRAA_TOKEN);
  const octaPair = await findPancakePair(OCTA_TOKEN);
  const octaInfo = await priceTokenInMON(octaPair, OCTA_TOKEN);

  const craaAmountWei = floorMonWei * craaInfo.tokensPerOtherScaled / SCALE;
  const octaAmountWei = floorMonWei * octaInfo.tokensPerOtherScaled / SCALE;

  const craaAmount = parseFloat(ethers.formatUnits(craaAmountWei, craaInfo.decToken));
  const octaAmount = parseFloat(ethers.formatUnits(octaAmountWei, octaInfo.decToken));

  const craPerOctaRateScaled = craaInfo.tokensPerOtherScaled * SCALE / octaInfo.tokensPerOtherScaled;
  const craPerOctaRate = parseFloat(ethers.formatUnits(craPerOctaRateScaled, 18));

  console.log(`  Floor: ${floorMon.toFixed(6)} MON`);
  console.log(`  CRAA: ${craaAmount.toFixed(6)} CRAA`);
  console.log(`  OCTA: ${octaAmount.toFixed(6)} OCTA`);

  return {
    floorMon,
    floorMonWei,
    craaAmount,
    craaAmountWei,
    octaAmount,
    octaAmountWei,
    craPerOctaRate,
    craPerOctaRateScaled,
    craaInfo,
    octaInfo
  };
}

// ===== PUSH TO CONTRACT (using TxQueue) =====
async function pushToContract(prices, dryRun = true) {
  if (!ORACLE_PK) {
    console.log('⚠️  No ORACLE_PK - skipping push');
    return null;
  }

  if (shouldStopForErrors()) {
    console.error('⛔ Skipping push: recent errors triggered cooldown');
    return null;
  }

  const { octaAmountWei, craPerOctaRate, craPerOctaRateScaled } = prices;

  const wallet = new ethers.Wallet(ORACLE_PK, provider);
  const coreAbi = [
    'function setManualFloor(uint256 floor1e18) external',
    'function setCRARateManual(uint256 rate1e18) external'
  ];
  const core = new ethers.Contract(CORE_PROXY, coreAbi, wallet);

  const floor1e18 = octaAmountWei;
  const craRate1e18 = craPerOctaRateScaled;

  console.log(`\n📤 Push (${dryRun ? 'DRY' : 'LIVE'}):`);
  console.log(`  setManualFloor(${floor1e18}) // ${ethers.formatUnits(floor1e18, 18)} OCTA`);
  console.log(`  setCRARateManual(${craRate1e18}) // CRAA per OCTA = ${craPerOctaRate.toFixed(6)}`);

  if (dryRun) return null;

  const queue = getOracleQueue();
  let txHash = null;
  let ok = true;

  try {
    const tx1 = await queue.enqueue(
      async (nonce) => core.setManualFloor(floor1e18, { gasLimit: GAS_LIMIT, nonce }),
      'setManualFloor'
    );
    txHash = tx1.hash;
    await sleep(1200); // small delay before second tx
  } catch (e) {
    ok = false;
    console.error(`  ❌ Floor failed:`, e.message || e);
    recordError();
  }

  try {
    await queue.enqueue(
      async (nonce) => core.setCRARateManual(craRate1e18, { gasLimit: GAS_LIMIT, nonce }),
      'setCRARateManual'
    );
  } catch (e) {
    ok = false;
    console.error(`  ❌ CRAA failed:`, e.message || e);
    recordError();
  }

  if (ok) {
    clearErrors();
  }

  return txHash;
}

// ===== ANTI-DUMP LOGIC =====
async function smartPush(prices, dryRun = true) {
  const { floorMon, craaAmount, octaAmount } = prices;
  const state = readState();
  const lastCraa = state.lastCraaAmount || 0;
  const lastOcta = state.lastOctaAmount || 0;
  const now = Date.now();

  const grewNow = (craaAmount > lastCraa * (1 + MIN_CHANGE_PCT)) || 
                  (octaAmount > lastOcta * (1 + MIN_CHANGE_PCT));
  
  if (grewNow) {
    console.log(`\n📈 RISE (>${(MIN_CHANGE_PCT*100).toFixed(1)}%) → instant push`);
    const txHash = await pushToContract(prices, dryRun);
    
    if (!dryRun) {
      const newHistory = (state.history || []).slice(-9);
      newHistory.push({ ts: now, floorMon, craaAmount, octaAmount, txHash, reason: 'rise' });
      delete state.pendingSince;
      delete state.pendingCraa;
      delete state.pendingOcta;
      writeState({ 
        lastCraaAmount: craaAmount, 
        lastOctaAmount: octaAmount, 
        lastPushAt: now, 
        history: newHistory 
      });
    }
    return { pushed: true, reason: 'rise' };
  }

  const lowerNow = (craaAmount < lastCraa * (1 - MIN_CHANGE_PCT)) || 
                   (octaAmount < lastOcta * (1 - MIN_CHANGE_PCT));
  
  if (lowerNow) {
    if (!state.pendingSince) {
      console.log(`\n⏳ FALL → wait ${Math.round(DECREASE_DELAY_MS/60000)}min`);
      state.pendingSince = now;
      state.pendingCraa = craaAmount;
      state.pendingOcta = octaAmount;
      writeState(state);
      return { pushed: false, reason: 'pending_fall' };
    }
    
    const elapsed = now - state.pendingSince;
    if (elapsed < DECREASE_DELAY_MS) {
      console.log(`\n⏳ Waiting... ${Math.round((DECREASE_DELAY_MS - elapsed)/60000)}min left`);
      return { pushed: false, reason: 'pending_fall' };
    }
    
    const stableCraa = Math.abs(craaAmount - state.pendingCraa) / Math.max(state.pendingCraa, 1e-18) <= PENDING_TOL_PCT;
    const stableOcta = Math.abs(octaAmount - state.pendingOcta) / Math.max(state.pendingOcta, 1e-18) <= PENDING_TOL_PCT;
    
    if (stableCraa && stableOcta) {
      console.log(`\n⬇️ STABLE FALL (±${(PENDING_TOL_PCT*100).toFixed(1)}%) → push`);
      const txHash = await pushToContract(prices, dryRun);
      
      if (!dryRun) {
        const newHistory = (state.history || []).slice(-9);
        newHistory.push({ ts: now, floorMon, craaAmount, octaAmount, txHash, reason: 'stable_fall' });
        delete state.pendingSince;
        delete state.pendingCraa;
        delete state.pendingOcta;
        writeState({ 
          lastCraaAmount: craaAmount, 
          lastOctaAmount: octaAmount, 
          lastPushAt: now, 
          history: newHistory 
        });
      }
      return { pushed: true, reason: 'stable_fall' };
    } else {
      const targetCraa = Math.max(craaAmount, state.pendingCraa * (1 - MAX_STEP_DOWN_PCT));
      const targetOcta = Math.max(octaAmount, state.pendingOcta * (1 - MAX_STEP_DOWN_PCT));
      console.log(`\n⬇️ FORCED STEP-DOWN (max ${(MAX_STEP_DOWN_PCT*100).toFixed(0)}%)`);
      const adjustedPrices = { ...prices, craaAmount: targetCraa, octaAmount: targetOcta };
      const txHash = await pushToContract(adjustedPrices, dryRun);
      
      if (!dryRun) {
        const newHistory = (state.history || []).slice(-9);
        newHistory.push({ ts: now, floorMon, craaAmount: targetCraa, octaAmount: targetOcta, txHash, reason: 'forced_down' });
        delete state.pendingSince;
        delete state.pendingCraa;
        delete state.pendingOcta;
        writeState({ 
          lastCraaAmount: targetCraa, 
          lastOctaAmount: targetOcta, 
          lastPushAt: now, 
          history: newHistory 
        });
      }
      return { pushed: true, reason: 'forced_down' };
    }
  }

  console.log(`\n✅ No change (<${(MIN_CHANGE_PCT*100).toFixed(1)}%)`);
  return { pushed: false, reason: 'no_change' };
}

// ===== RANDOM TRADING (using TxQueue) =====
async function executeTrade(dryRun = true) {
  if (shouldStopForErrors()) {
    console.error('⛔ Skipping trading: recent errors triggered cooldown');
    return;
  }
  if (TRADE_MODE !== 'on') return;
  if (!TRADER_PK) {
    console.log('⚠️  No TRADER_PK - skip trade');
    return;
  }

  const wallet = new ethers.Wallet(TRADER_PK, provider);
  const queue = getTraderQueue();
  const state = readState();
  const tradeState = state.trade || { 
    balance: 0, 
    craaBalance: 0, 
    octaBalance: 0,
    lastAction: null
  };
  
  tradeState.balance = tradeState.balance || 0;
  tradeState.craaBalance = tradeState.craaBalance || 0;
  tradeState.octaBalance = tradeState.octaBalance || 0;

  console.log(`\n💱 Trade (${await wallet.getAddress()})`);
  console.log(`  Balance: ${tradeState.balance.toFixed(6)} WMON, ${tradeState.craaBalance.toFixed(6)} CRAA, ${tradeState.octaBalance.toFixed(6)} OCTA`);

  const routerAbi = [
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory)',
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory)',
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)'
  ];
  const router = new ethers.Contract(ROUTER, routerAbi, wallet);

  const shouldBuy = tradeState.lastAction !== 'buy' || (tradeState.craaBalance === 0 && tradeState.octaBalance === 0);

  if (shouldBuy) {
    const buyPct = randomChoice(BUY_VARIANTS_PCT);
    const buyAmount = BASE_TRADE_MON * (buyPct / 100);
    const buyWei = ethers.parseEther(buyAmount.toFixed(18));

    console.log(`\n🛒 BUY ${buyPct}% of ${BASE_TRADE_MON} = ${buyAmount.toFixed(6)} MON (split CRAA + OCTA)`);

    const errors = [];

    // Buy CRAA
    try {
      const pathCraa = [WMON_TOKEN, CRAA_TOKEN];
      const amountsCraa = await router.getAmountsOut(buyWei / 2n, pathCraa);
      const minOutCraa = amountsCraa[1] * BigInt(10000 - TRADE_SLIPPAGE_BPS) / 10000n;
      console.log(`  CRAA expected: ${ethers.formatEther(amountsCraa[1])} CRAA`);

      if (!dryRun) {
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const txCraa = await queue.enqueue(
          async (nonce) => router.swapExactETHForTokens(minOutCraa, pathCraa, await wallet.getAddress(), deadline, {
            value: buyWei / 2n,
            gasLimit: GAS_LIMIT,
            nonce
          }),
          'BUY CRAA'
        );
        console.log(`  ✅ CRAA bought`);
        const boughtCraa = parseFloat(ethers.formatEther(amountsCraa[1]));
        tradeState.craaBalance += boughtCraa;
      } else {
        console.log(`  🔍 DRY RUN (CRAA)`);
      }
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      console.error(`  ❌ CRAA buy failed:`, msg);
      errors.push(`CRAA buy failed: ${msg}`);
      recordError();
    }

    // Buy OCTA
    try {
      const pathOcta = [WMON_TOKEN, OCTA_TOKEN];
      const amountsOcta = await router.getAmountsOut(buyWei / 2n, pathOcta);
      const minOutOcta = amountsOcta[1] * BigInt(10000 - TRADE_SLIPPAGE_BPS) / 10000n;
      console.log(`  OCTA expected: ${ethers.formatEther(amountsOcta[1])} OCTA`);

      if (!dryRun) {
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const txOcta = await queue.enqueue(
          async (nonce) => router.swapExactETHForTokens(minOutOcta, pathOcta, await wallet.getAddress(), deadline, {
            value: buyWei / 2n,
            gasLimit: GAS_LIMIT,
            nonce
          }),
          'BUY OCTA'
        );
        console.log(`  ✅ OCTA bought`);
        const boughtOcta = parseFloat(ethers.formatEther(amountsOcta[1]));
        tradeState.octaBalance += boughtOcta;
      } else {
        console.log(`  🔍 DRY RUN (OCTA)`);
      }
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      console.error(`  ❌ OCTA buy failed:`, msg);
      errors.push(`OCTA buy failed: ${msg}`);
      recordError();
    }

    if (errors.length > 0) {
      console.error('\n⚠️ Trade completed with errors:', errors.join(' ; '));
    } else {
      console.log('\n✅ Trade buy completed successfully');
      clearErrors();
    }

    tradeState.balance += buyAmount;
    tradeState.lastAction = 'buy';
    tradeState.lastActionAt = Date.now();
    state.trade = tradeState;
    writeState(state);

  } else {
    // SELL both CRAA and OCTA
    if (tradeState.craaBalance === 0 && tradeState.octaBalance === 0) {
      console.log('  ⚠️  Nothing to sell');
      return;
    }

    const sellPct = randomChoice(SELL_VARIANTS_PCT);
    console.log(`\n💰 SELL ${sellPct}% of balances (CRAA + OCTA)`);

    const sellErrors = [];

    // Sell CRAA
    if (tradeState.craaBalance > 0) {
      const sellCraa = tradeState.craaBalance * (sellPct / 100);
      if (sellCraa >= 0.001) {
        const sellWeiCraa = ethers.parseUnits(sellCraa.toFixed(18), 18);
        console.log(`  CRAA: ${sellCraa.toFixed(6)} CRAA`);

        try {
          const craaContract = new ethers.Contract(CRAA_TOKEN, ERC20Abi, wallet);
          const allowance = await craaContract.allowance(await wallet.getAddress(), ROUTER);
          if (allowance < sellWeiCraa) {
            console.log('  Approving CRAA...');
            await queue.enqueue(
              async (nonce) => craaContract.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000, nonce }),
              'APPROVE CRAA'
            );
          }

          const pathCraa = [CRAA_TOKEN, WMON_TOKEN];
          const amountsCraa = await router.getAmountsOut(sellWeiCraa, pathCraa);
          const minOutCraa = amountsCraa[1] * BigInt(10000 - TRADE_SLIPPAGE_BPS) / 10000n;
          console.log(`  CRAA expected: ${ethers.formatEther(amountsCraa[1])} WMON`);

          if (!dryRun) {
            const deadline = Math.floor(Date.now() / 1000) + 300;
            await queue.enqueue(
              async (nonce) => router.swapExactTokensForETH(sellWeiCraa, minOutCraa, pathCraa, await wallet.getAddress(), deadline, {
                gasLimit: GAS_LIMIT,
                nonce
              }),
              'SELL CRAA'
            );
            console.log(`  ✅ CRAA sold`);
            const receivedMon = parseFloat(ethers.formatEther(amountsCraa[1]));
            tradeState.balance -= receivedMon;
            tradeState.craaBalance -= sellCraa;
          } else {
            console.log(`  🔍 DRY RUN (CRAA)`);
          }
        } catch (e) {
          const msg = (e && e.message) ? e.message : String(e);
          console.error(`  ❌ CRAA sell failed:`, msg);
          sellErrors.push(`CRAA sell failed: ${msg}`);
          recordError();
        }
      } else {
        console.log(`  ⚠️  CRAA sell too small`);
      }
    }

    // Sell OCTA
    if (tradeState.octaBalance > 0) {
      const sellOcta = tradeState.octaBalance * (sellPct / 100);
      if (sellOcta >= 0.001) {
        const sellWeiOcta = ethers.parseUnits(sellOcta.toFixed(18), 18);
        console.log(`  OCTA: ${sellOcta.toFixed(6)} OCTA`);

        try {
          const octaContract = new ethers.Contract(OCTA_TOKEN, ERC20Abi, wallet);
          const allowance = await octaContract.allowance(await wallet.getAddress(), ROUTER);
          if (allowance < sellWeiOcta) {
            console.log('  Approving OCTA...');
            await queue.enqueue(
              async (nonce) => octaContract.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000, nonce }),
              'APPROVE OCTA'
            );
          }

          const pathOcta = [OCTA_TOKEN, WMON_TOKEN];
          const amountsOcta = await router.getAmountsOut(sellWeiOcta, pathOcta);
          const minOutOcta = amountsOcta[1] * BigInt(10000 - TRADE_SLIPPAGE_BPS) / 10000n;
          console.log(`  OCTA expected: ${ethers.formatEther(amountsOcta[1])} WMON`);

          if (!dryRun) {
            const deadline = Math.floor(Date.now() / 1000) + 300;
            await queue.enqueue(
              async (nonce) => router.swapExactTokensForETH(sellWeiOcta, minOutOcta, pathOcta, await wallet.getAddress(), deadline, {
                gasLimit: GAS_LIMIT,
                nonce
              }),
              'SELL OCTA'
            );
            console.log(`  ✅ OCTA sold`);
            const receivedMon = parseFloat(ethers.formatEther(amountsOcta[1]));
            tradeState.balance -= receivedMon;
            tradeState.octaBalance -= sellOcta;
          } else {
            console.log(`  🔍 DRY RUN (OCTA)`);
          }
        } catch (e) {
          const msg = (e && e.message) ? e.message : String(e);
          console.error(`  ❌ OCTA sell failed:`, msg);
          sellErrors.push(`OCTA sell failed: ${msg}`);
          recordError();
        }
      } else {
        console.log(`  ⚠️  OCTA sell too small`);
      }
    }

    if (sellErrors.length > 0) {
      console.error('\n⚠️ Trade sell completed with errors:', sellErrors.join(' ; '));
    } else {
      console.log('\n✅ Trade sell completed successfully');
      clearErrors();
    }

    tradeState.lastAction = 'sell';
    tradeState.lastActionAt = Date.now();
    state.trade = tradeState;
    writeState(state);
  }
}

// ===== MAIN (sequential, single execution) =====
async function main() {
  if (shouldStopForErrors()) {
    console.error('⛔ Global stop: recent errors triggered cooldown. Exiting.');
    return;
  }
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');

  console.log('═══════════════════════════════════════');
  console.log('  🐙 CrazyOctagon Smart Bot');
  console.log(`  ${dryRun ? '🔍 DRY RUN' : '🚀 LIVE'}`);
  console.log('═══════════════════════════════════════');

  const prices = await fetchPrices();

  console.log('\n📤 Using smartPush (anti-dump) logic)');
  const smartRes = await smartPush(prices, dryRun);

  const outPath = path.join(__dirname, '..', 'data', `bot_price_${NFT_COLLECTION}_${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const snapshot = {
    ts: new Date().toISOString(),
    floorMon: prices.floorMon,
    floorMonWei: prices.floorMonWei.toString(),
    craaAmount: prices.craaAmount,
    craaAmountWei: prices.craaAmountWei.toString(),
    octaAmount: prices.octaAmount,
    octaAmountWei: prices.octaAmountWei.toString(),
    craPerOctaRate: prices.craPerOctaRate,
    craPerOctaRateScaled: prices.craPerOctaRateScaled.toString(),
    pushed: smartRes
  };
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n💾 ${path.basename(outPath)}`);

  await executeTrade(dryRun);

  console.log('\n✅ Done\n');
}

if (require.main === module) {
  main().catch(e => {
    if (e && e.stack) {
      console.error('\n❌ Unhandled error:\n', e.stack);
    } else {
      console.error('\n❌', e && e.message ? e.message : String(e));
    }
    process.exit(1);
  });
}

module.exports = { main, fetchPrices };
