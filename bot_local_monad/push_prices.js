#!/usr/bin/env node
/**
 * CrazyOctagon Smart Bot
 * - Anti-dump push logic (rise→instant, fall→delay+stability)
 * - Random buy/sell trading (7 buy variants, 6 sell variants)
 * - PancakeSwap only price source
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const fs = require('fs');
const { ethers } = require('ethers');

// ===== CONFIG =====
// Public contract addresses hardcoded (as requested).
// Secrets (private keys) are still read from env only.
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

// Debug: print resolved runtime config for quick diagnosis in Actions logs
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

// Simple in-memory nonce manager (per wallet) to serialize nonces within this process.
// Not a cross-process lock; prevents nonce races for sequential txs sent from the same Node process.
function createNonceManager(wallet) {
  let nextNoncePromise = null;
  return {
    async init() {
      if (!nextNoncePromise) {
        // Use provider to fetch pending nonce for the wallet address
        nextNoncePromise = provider.getTransactionCount(await wallet.getAddress(), 'pending');
      }
      return nextNoncePromise;
    },
    async take() {
      if (!nextNoncePromise) {
        await this.init();
      }
      const base = await nextNoncePromise;
      // ensure nextNoncePromise is a Promise<number>
      nextNoncePromise = Promise.resolve(Number(base) + 1);
      return Number(base);
    }
  };
}

// Rate limiting: randomized small delay between external calls to avoid RPC throttling
// Bumped defaults to reduce QuickNode / provider throttling (can be tuned via env)
const RATE_LIMIT_MIN_MS = parseInt(process.env.RATE_LIMIT_MIN_MS || '500', 10);
const RATE_LIMIT_MAX_MS = parseInt(process.env.RATE_LIMIT_MAX_MS || '1200', 10);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay() { return Math.floor(Math.random() * (Math.max(RATE_LIMIT_MIN_MS, RATE_LIMIT_MAX_MS) - Math.min(RATE_LIMIT_MIN_MS, RATE_LIMIT_MAX_MS) + 1)) + Math.min(RATE_LIMIT_MIN_MS, RATE_LIMIT_MAX_MS); }


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
  // if too many consecutive errors, set stop cooldown (1 hour)
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
  // cooldown passed — reset
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
  // Validate that the pair address actually implements expected pair methods.
  try {
    console.log(`Factory returned pair address for token ${tokenAddr}: ${pair}`);
  await sleep(randomDelay());
  const code = await retryAsync(() => provider.getCode(pair));
    console.log(`Pair code size (hex): ${code.length} for ${pair}`);
    if (!code || code === '0x') {
      throw new Error(`No contract code at pair address ${pair}`);
    }
    const pairContract = new ethers.Contract(pair, ['function token0() view returns (address)'], provider);
    // call token0() to confirm the contract behaves like a UniswapV2 pair
  await sleep(randomDelay());
  await retryAsync(() => pairContract.token0());
    return pair;
  } catch (err) {
    // invalid pair address / non-pair contract — log and try fallback pools
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

  const priceScaled = numerator * SCALE / denominator; // token price in WMON (1e18 scale)
  const tokensPerOtherScaled = denominator * SCALE / numerator; // tokens per 1 WMON (1e18 scale)

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

// ===== PUSH TO CONTRACT =====
async function pushToContract(prices, dryRun = true) {
  if (!ORACLE_PK) {
    console.log('⚠️  No ORACLE_PK - skipping push');
    return null;
  }

  if (shouldStopForErrors()) {
    console.error('⛔ Skipping push: recent errors triggered cooldown');
    return null;
  }

  // prices contains floorMon (MON), octaAmount (OCTA-equivalent) and craaAmount
  const { octaAmountWei, craPerOctaRate, craPerOctaRateScaled } = prices;

  const wallet = new ethers.Wallet(ORACLE_PK, provider);
  const nonceManager = createNonceManager(wallet);
  const coreAbi = [
    'function setManualFloor(uint256 floor1e18) external',
    'function setCRARateManual(uint256 rate1e18) external'
  ];
  const core = new ethers.Contract(CORE_PROXY, coreAbi, wallet);

  // The contract expects manualFloorPrice in OCTA (18 decimals) and CRA rate scaled 1e18.
  const floor1e18 = octaAmountWei;
  const craRate1e18 = craPerOctaRateScaled;

  console.log(`\n📤 Push (${dryRun ? 'DRY' : 'LIVE'}):`);
  console.log(`  setManualFloor(${floor1e18}) // ${ethers.formatUnits(floor1e18, 18)} OCTA`);
  console.log(`  setCRARateManual(${craRate1e18}) // CRAA per OCTA = ${craPerOctaRate.toFixed(6)}`);

  if (dryRun) return null;

  // helper: send tx with retry + exponential backoff and jitter
  // NOTE: this runs for a single tx; to manage nonce collisions we compute
  // a base nonce and pass explicit nonces for sequential transactions below.
  async function sendWithRetry(fn, args = [], opts = {}, maxAttempts = 6) {
    let attempt = 0;
    let lastErr = null;
    while (attempt < maxAttempts) {
      try {
        // small randomized delay prior to send to avoid thundering bursts
        await sleep(randomDelay());
        const tx = await fn(...args, opts);
        console.log(`  Sent tx (attempt ${attempt+1}): ${tx.hash}`);
        // wait for 1 confirmation (provider may be rate-limited when polling receipts)
        try {
          await provider.waitForTransaction(tx.hash, 1, 120000); // 2min timeout
        } catch (waitErr) {
          // provider.waitForTransaction can itself fail under rate limits; log and continue
          console.warn(`  waitForTransaction warning: ${waitErr && waitErr.message ? waitErr.message : String(waitErr)}`);
        }
        return tx;
      } catch (e) {
        lastErr = e;
        attempt += 1;
        // exponential backoff with jitter
        const base = Math.min(1000 * 2 ** attempt, 16000); // cap backoff
        const jitter = Math.floor(Math.random() * 500);
        const backoff = base + jitter;
        // special handling/log for common provider errors
        const emsg = (e && e.message) ? e.message : String(e);
        if (emsg.includes('25/second request limit')) {
          console.error(`  provider rate-limit hit: ${emsg}. backoff ${backoff}ms`);
        } else if (emsg.includes('Another transaction has higher priority')) {
          console.error(`  nonce/prio error: ${emsg}. backoff ${backoff}ms`);
        } else {
          console.error(`  tx attempt ${attempt} failed: ${emsg}. backoff ${backoff}ms`);
        }
        // record single error and continue
        recordError();
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }

  let txHash = null;
  let ok = true;
  try {
  // Obtain a pending nonce from nonce manager and use explicit nonces for sequential txs
  await nonceManager.init();
  const n1 = await nonceManager.take();
  const opts1 = Object.assign({}, { gasLimit: GAS_LIMIT, nonce: Number(n1) });
  const tx1 = await sendWithRetry(core.setManualFloor.bind(core), [floor1e18], opts1);
  txHash = tx1.hash;
  // small delay before second tx to avoid burst limits
  await new Promise(r => setTimeout(r, 1200));
  } catch (e) {
    ok = false;
    console.error(`  ❌ Floor failed:`, e.message || e);
  }

  try {
    // use next nonce when sending CRAA rate tx
    // if baseNonce not set above (floor failed before nonce fetch), fetch now
    const n2 = await nonceManager.take();
    const opts2 = Object.assign({}, { gasLimit: GAS_LIMIT, nonce: Number(n2) });
    const tx2 = await sendWithRetry(core.setCRARateManual.bind(core), [craRate1e18], opts2);
  } catch (e) {
    ok = false;
    console.error(`  ❌ CRAA failed:`, e.message || e);
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

  // Rise → instant push
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

  // Fall → delay + stability check
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
    
    // Check stability
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
      // Force step-down with cap
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

// ===== RANDOM TRADING =====
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
  const nonceManager = createNonceManager(wallet);
  const state = readState();
  const tradeState = state.trade || { 
    balance: 0, 
    craaBalance: 0, 
    octaBalance: 0,
    lastAction: null  // 'buy' or 'sell'
  };
  
  // Ensure all fields exist (for backward compat)
  tradeState.balance = tradeState.balance || 0;
  tradeState.craaBalance = tradeState.craaBalance || 0;
  tradeState.octaBalance = tradeState.octaBalance || 0;

  console.log(`\n💱 Trade (${wallet.address})`);
  console.log(`  Balance: ${tradeState.balance.toFixed(6)} WMON, ${tradeState.craaBalance.toFixed(6)} CRAA, ${tradeState.octaBalance.toFixed(6)} OCTA`);

  const routerAbi = [
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory)',
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory)',
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)'
  ];
  const router = new ethers.Contract(ROUTER, routerAbi, wallet);

  // Alternate: if last was buy (or null) and we have balance → sell; else buy
  const shouldBuy = tradeState.lastAction !== 'buy' || (tradeState.craaBalance === 0 && tradeState.octaBalance === 0);

  if (shouldBuy) {
    // BUY both CRAA and OCTA
    const errors = [];
    const successes = [];
    const buyPct = randomChoice(BUY_VARIANTS_PCT);
    const buyAmount = BASE_TRADE_MON * (buyPct / 100);
    const buyWei = ethers.parseEther(buyAmount.toFixed(18));

    console.log(`\n🛒 BUY ${buyPct}% of ${BASE_TRADE_MON} = ${buyAmount.toFixed(6)} MON (split CRAA + OCTA)`);

    // Buy CRAA
    try {
      const pathCraa = [WMON_TOKEN, CRAA_TOKEN];
      const amountsCraa = await router.getAmountsOut(buyWei / 2n, pathCraa);
      const minOutCraa = amountsCraa[1] * BigInt(10000 - TRADE_SLIPPAGE_BPS) / 10000n;
      console.log(`  CRAA expected: ${ethers.formatEther(amountsCraa[1])} CRAA`);

      if (!dryRun) {
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const nSwapCraa = await nonceManager.take();
        const txCraa = await router.swapExactETHForTokens(minOutCraa, pathCraa, wallet.address, deadline, {
          value: buyWei / 2n,
          gasLimit: GAS_LIMIT,
          nonce: Number(nSwapCraa)
        });
        console.log(`  CRAA Tx: ${txCraa.hash}`);
        try { await txCraa.wait(); } catch (e) { console.warn('  swap wait warning:', e && e.message ? e.message : String(e)); }
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
        // do not abort; try OCTA buy as well
      }

    // Buy OCTA
    try {
      const pathOcta = [WMON_TOKEN, OCTA_TOKEN];
      const amountsOcta = await router.getAmountsOut(buyWei / 2n, pathOcta);
      const minOutOcta = amountsOcta[1] * BigInt(10000 - TRADE_SLIPPAGE_BPS) / 10000n;
      console.log(`  OCTA expected: ${ethers.formatEther(amountsOcta[1])} OCTA`);

      if (!dryRun) {
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const nSwapOcta = await nonceManager.take();
        const txOcta = await router.swapExactETHForTokens(minOutOcta, pathOcta, wallet.address, deadline, {
          value: buyWei / 2n,
          gasLimit: GAS_LIMIT,
          nonce: Number(nSwapOcta)
        });
        console.log(`  OCTA Tx: ${txOcta.hash}`);
        try { await txOcta.wait(); } catch (e) { console.warn('  swap wait warning:', e && e.message ? e.message : String(e)); }
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
    }
    // summarize buy results
    if (errors.length > 0) {
      console.error('\n⚠️ Trade completed with errors:', errors.join(' ; '));
      recordError();
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

    // Sell CRAA
  const sellErrors = [];
  const sellSuccess = [];
  if (tradeState.craaBalance > 0) {
      const sellCraa = tradeState.craaBalance * (sellPct / 100);
      if (sellCraa >= 0.001) {
        const sellWeiCraa = ethers.parseUnits(sellCraa.toFixed(18), 18);
        console.log(`  CRAA: ${sellCraa.toFixed(6)} CRAA`);

  try {
          const craaContract = new ethers.Contract(CRAA_TOKEN, ERC20Abi, wallet);
          const allowance = await craaContract.allowance(wallet.address, ROUTER);
          if (allowance < sellWeiCraa) {
            console.log('  Approving CRAA...');
            const nApprove = await nonceManager.take();
            const approveTx = await craaContract.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000, nonce: Number(nApprove) });
            try { await approveTx.wait(); } catch (e) { console.warn('  approve wait warning:', e && e.message ? e.message : String(e)); }
          }

          const pathCraa = [CRAA_TOKEN, WMON_TOKEN];
          const amountsCraa = await router.getAmountsOut(sellWeiCraa, pathCraa);
          const minOutCraa = amountsCraa[1] * BigInt(10000 - TRADE_SLIPPAGE_BPS) / 10000n;
          console.log(`  CRAA expected: ${ethers.formatEther(amountsCraa[1])} WMON`);

            if (!dryRun) {
            const deadline = Math.floor(Date.now() / 1000) + 300;
            const nSwapCraa = await nonceManager.take();
            const txCraa = await router.swapExactTokensForETH(sellWeiCraa, minOutCraa, pathCraa, wallet.address, deadline, {
              gasLimit: GAS_LIMIT, nonce: Number(nSwapCraa)
            });
            console.log(`  CRAA Tx: ${txCraa.hash}`);
            try { await txCraa.wait(); } catch (e) { console.warn('  swap wait warning:', e && e.message ? e.message : String(e)); }
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
          const allowance = await octaContract.allowance(wallet.address, ROUTER);
          if (allowance < sellWeiOcta) {
            console.log('  Approving OCTA...');
              const nApprove = await nonceManager.take();
              const approveTx = await octaContract.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000, nonce: Number(nApprove) });
              try { await approveTx.wait(); } catch (e) { console.warn('  approve wait warning:', e && e.message ? e.message : String(e)); }
          }

          const pathOcta = [OCTA_TOKEN, WMON_TOKEN];
          const amountsOcta = await router.getAmountsOut(sellWeiOcta, pathOcta);
          const minOutOcta = amountsOcta[1] * BigInt(10000 - TRADE_SLIPPAGE_BPS) / 10000n;
          console.log(`  OCTA expected: ${ethers.formatEther(amountsOcta[1])} WMON`);

            if (!dryRun) {
            const deadline = Math.floor(Date.now() / 1000) + 300;
            const nSwapOcta = await nonceManager.take();
            const txOcta = await router.swapExactTokensForETH(sellWeiOcta, minOutOcta, pathOcta, wallet.address, deadline, {
              gasLimit: GAS_LIMIT, nonce: Number(nSwapOcta)
            });
            console.log(`  OCTA Tx: ${txOcta.hash}`);
            try { await txOcta.wait(); } catch (e) { console.warn('  swap wait warning:', e && e.message ? e.message : String(e)); }
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
        }
      } else {
        console.log(`  ⚠️  OCTA sell too small`);
      }
    }

    // summarize sell results
    if (sellErrors.length > 0) {
      console.error('\n⚠️ Trade sell completed with errors:', sellErrors.join(' ; '));
      recordError();
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

// ===== MAIN =====
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

  // Use smartPush (anti-dump) logic instead of forcing push every run
  console.log('\n📤 Using smartPush (anti-dump) logic)');
  const smartRes = await smartPush(prices, dryRun);

  // record pushed state
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
      // Log full stack if available — Actions truncates single-line messages sometimes.
      if (e && e.stack) {
        console.error('\n\u274c Unhandled error:\n', e.stack);
      } else {
        console.error('\n\u274c', e && e.message ? e.message : String(e));
      }
      process.exit(1);
    });
  }

if (require.main === module) {
  main().catch(e => {
    console.error('\n❌', e.message);
    process.exit(1);
  });
}

module.exports = { main, fetchPrices };
