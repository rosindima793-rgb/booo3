const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const axios = require('axios');
const fs = require('fs');
const { ethers } = require('ethers');

// minimal local runner adapted from bot_monad/smart-runner.js
const RPC_URL = process.env.RPC_URL || process.env.MONAD_RPC || 'https://testnet-rpc.monad.xyz';
const NFT_COLLECTION = (process.env.NFT_COLLECTION || '').toLowerCase();
const CRAA_TOKEN = (process.env.CRAA_TOKEN || '').toLowerCase();
const OCTA_TOKEN = (process.env.OCTA_TOKEN || '').toLowerCase();
const PAIR_TOKEN = (process.env.PAIR_TOKEN || process.env.WMON_TOKEN || '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701').toLowerCase();
const CRAA_WMON_POOL = (process.env.CRAA_WMON_POOL || '').toLowerCase();
const OCTA_WMON_POOL = (process.env.OCTA_WMON_POOL || '').toLowerCase();
const PANCAKE_FACTORY = (process.env.PANCAKE_FACTORY || '').toLowerCase();
const ROUTER = (process.env.ROUTER || '').toLowerCase();
const FACTORY = (process.env.FACTORY || PANCAKE_FACTORY || '').toLowerCase();
const RES_BASE = process.env.RES_BASE || 'https://api-monad-testnet.reservoir.tools';

const PairAbi = require('./abis/UniswapV2Pair.json');
const ERC20Abi = require('./abis/ERC20.json');

const provider = new ethers.JsonRpcProvider(RPC_URL);

function isValidAddress(a){ return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a); }

async function priceTokenInMON(pairAddr, tokenAddr) {
  const pair = new ethers.Contract(pairAddr, PairAbi, provider);
  const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
  const [r0, r1] = await pair.getReserves();
  const token0 = t0.toLowerCase();
  const token1 = t1.toLowerCase();
  if (tokenAddr !== token0 && tokenAddr !== token1) throw new Error('token not in pair');
  const other = tokenAddr === token0 ? token1 : token0;
  const ercToken = new ethers.Contract(tokenAddr, ERC20Abi, provider);
  const ercOther = new ethers.Contract(other, ERC20Abi, provider);
  const [decT, decO] = await Promise.all([ercToken.decimals().catch(()=>18), ercOther.decimals().catch(()=>18)]);
  const [reserveToken, reserveOther] = tokenAddr === token0 ? [r0, r1] : [r1, r0];
  const price = Number(reserveOther) / Math.max(1, Number(reserveToken)) * (10 ** (Number(decT) - Number(decO)));
  return { priceInOther: price, otherAddress: other, decToken: Number(decT), decOther: Number(decO) };
}

async function findPairFor(tokenAddr) {
  // Priority 1: PancakeSwap factory
  try {
    if (PANCAKE_FACTORY && isValidAddress(PANCAKE_FACTORY)) {
      const factory = new ethers.Contract(PANCAKE_FACTORY, ['function getPair(address,address) view returns (address)'], provider);
      const pair = await factory.getPair(tokenAddr, PAIR_TOKEN);
      if (isValidAddress(pair)) {
        console.log(`Found ${tokenAddr === CRAA_TOKEN ? 'CRAA' : 'OCTA'} pair on PancakeSwap: ${pair}`);
        return pair.toLowerCase();
      }
    }
  } catch (e) {
    console.warn('PancakeSwap factory lookup failed:', e.message);
  }
  
  // Priority 2: Explicit fallback pools from env
  if (tokenAddr === CRAA_TOKEN && isValidAddress(CRAA_WMON_POOL)) {
    console.log('Using fallback CRAA pool:', CRAA_WMON_POOL);
    return CRAA_WMON_POOL;
  }
  if (tokenAddr === OCTA_TOKEN && isValidAddress(OCTA_WMON_POOL)) {
    console.log('Using fallback OCTA pool:', OCTA_WMON_POOL);
    return OCTA_WMON_POOL;
  }
  
  // Priority 3: Try factory from addresses.json or env FACTORY/ROUTER
  try {
    const addrs = require('../addresses.json');
    let factoryAddr = FACTORY;
    if (!factoryAddr) {
      const routerAddr = ROUTER || (addrs && addrs.ROUTER);
      if (routerAddr && isValidAddress(routerAddr)) {
        const r = new ethers.Contract(routerAddr, ['function factory() view returns (address)'], provider);
        factoryAddr = (await r.factory()).toLowerCase();
      }
    }
    if (!factoryAddr && addrs && addrs.FACTORY) factoryAddr = addrs.FACTORY.toLowerCase();
    if (factoryAddr && isValidAddress(factoryAddr)) {
      const factory = new ethers.Contract(factoryAddr, ['function getPair(address,address) view returns (address)'], provider);
      const pair = await factory.getPair(tokenAddr, PAIR_TOKEN);
      if (isValidAddress(pair)) return pair.toLowerCase();
    }
  } catch (e) {
    // ignore
  }
  
  throw new Error(`pair not found for token ${tokenAddr}`);
}

async function fetchFloorMON() {
  const url = `${RES_BASE}/stats/v2?collection=${NFT_COLLECTION}`;
  try {
    const { data } = await axios.get(url, { timeout: 15000 });
    const native = data?.stats?.market?.floorAsk?.value?.native || data?.stats?.floorAsk?.value?.native || data?.stats?.floor?.native;
    if (native && typeof native === 'number') return native;
  } catch (e) { /* ignore */ }
  const url2 = `${RES_BASE}/tokens/floor/v1?contract=${NFT_COLLECTION}&limit=100`;
  const { data: d2 } = await axios.get(url2, { timeout: 15000 });
  const rawTokens = d2?.tokens;
  let prices = [];
  if (Array.isArray(rawTokens)) {
    prices = rawTokens.map(t => t?.market?.floorAsk?.price?.native ?? t?.market?.floorAsk?.value?.native).filter(v => typeof v === 'number');
  } else if (rawTokens && typeof rawTokens === 'object') {
    // sometimes tokens is an object map tokenId -> numeric floor
    const entries = Object.entries(rawTokens);
    if (entries.length && typeof entries[0][1] === 'number') {
      prices = entries.map(e => Number(e[1])).filter(v => typeof v === 'number');
    } else {
      // fallback: values may be objects
      prices = Object.values(rawTokens).map(t => t?.market?.floorAsk?.price?.native ?? t?.market?.floorAsk?.value?.native).filter(v => typeof v === 'number');
    }
  }
  if (prices.length) return Math.min(...prices);
  throw new Error('floor not found');
}

async function runLocal() {
  if (!NFT_COLLECTION) throw new Error('NFT_COLLECTION empty');
  console.log('RPC:', RPC_URL);
  const floorMon = await fetchFloorMON();
  console.log('floor (MON):', floorMon);
  if (!CRAA_TOKEN || !CRAA_TOKEN.startsWith('0x')) throw new Error('CRAA_TOKEN env missing or invalid');
  if (!OCTA_TOKEN || !OCTA_TOKEN.startsWith('0x')) throw new Error('OCTA_TOKEN env missing or invalid');

  let craaPair;
  try {
  if (isValidAddress(CRAA_WMON_POOL)) craaPair = CRAA_WMON_POOL;
  else craaPair = await findPairFor(CRAA_TOKEN);
  } catch (e) {
    throw new Error(`failed to find CRAA pair: ${e.message}`);
  }
  const craaInfo = await priceTokenInMON(craaPair, CRAA_TOKEN);
  const craaPerMon = 1 / craaInfo.priceInOther;
  const craaAmount = floorMon * craaPerMon;
  console.log('CRAA per MON:', craaPerMon, 'CRAA at floor:', craaAmount);

  let octaPair;
  try {
  if (isValidAddress(OCTA_WMON_POOL)) octaPair = OCTA_WMON_POOL;
  else octaPair = await findPairFor(OCTA_TOKEN);
  } catch (e) {
    throw new Error(`failed to find OCTA pair: ${e.message}`);
  }
  const octaInfo = await priceTokenInMON(octaPair, OCTA_TOKEN);
  const octaPerMon = 1 / octaInfo.priceInOther;
  const octaAmount = floorMon * octaPerMon;
  console.log('OCTA per MON:', octaPerMon, 'OCTA at floor:', octaAmount);

  const out = { ts: new Date().toISOString(), floorMon, craaAmount, octaAmount, craaInfo, octaInfo };
  const outPath = path.join(__dirname, '..', 'data', `bot_local_price_${NFT_COLLECTION}_${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
}

if (require.main === module) {
  runLocal().then(()=>console.log('done')).catch(e=>{ console.error('Error:', e.message); process.exit(1); });
}

module.exports = { runLocal };
