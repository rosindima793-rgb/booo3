#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || process.env.MONAD_RPC || 'https://testnet-rpc.monad.xyz';
const CRAA_TOKEN = (process.env.CRAA_TOKEN || '').toLowerCase();
const OCTA_TOKEN = (process.env.OCTA_TOKEN || '').toLowerCase();

const PairAbi = require('./abis/UniswapV2Pair.json');
const ERC20Abi = require('./abis/ERC20.json');

const provider = new ethers.JsonRpcProvider(RPC_URL);

async function analyzePair(pairAddr, tokenAddr, tokenName) {
  console.log(`\n=== Analyzing ${tokenName} pair: ${pairAddr} ===`);
  
  const pair = new ethers.Contract(pairAddr, PairAbi, provider);
  const token = new ethers.Contract(tokenAddr, ERC20Abi, provider);
  
  const [t0, t1, reserves, decimalsToken] = await Promise.all([
    pair.token0(),
    pair.token1(),
    pair.getReserves(),
    token.decimals().catch(() => 18)
  ]);
  
  const token0 = t0.toLowerCase();
  const token1 = t1.toLowerCase();
  const [r0, r1, blockTimestamp] = reserves;
  
  console.log('token0:', token0);
  console.log('token1:', token1);
  console.log('target token:', tokenAddr);
  console.log('reserve0:', r0.toString());
  console.log('reserve1:', r1.toString());
  
  const isToken0 = tokenAddr === token0;
  const otherToken = isToken0 ? token1 : token0;
  const reserveToken = isToken0 ? r0 : r1;
  const reserveOther = isToken0 ? r1 : r0;
  
  const otherContract = new ethers.Contract(otherToken, ERC20Abi, provider);
  const decimalsOther = await otherContract.decimals().catch(() => 18);
  
  console.log(`\n${tokenName} is token${isToken0 ? '0' : '1'}`);
  console.log(`Other token (${otherToken.slice(0,10)}...) is token${isToken0 ? '1' : '0'}`);
  console.log(`reserve${tokenName}:`, reserveToken.toString());
  console.log(`reserveOther:`, reserveOther.toString());
  console.log(`decimals${tokenName}:`, decimalsToken);
  console.log(`decimalsOther:`, decimalsOther);
  
  // Current formula in smart-runner.js
  const price = Number(reserveOther) / Math.max(1, Number(reserveToken)) * (10 ** (Number(decimalsToken) - Number(decimalsOther)));
  console.log(`\nPrice (current formula): ${price}`);
  console.log(`Price (scientific): ${price.toExponential()}`);
  
  // Alternative: using ethers formatUnits for clarity
  const reserveTokenFormatted = Number(ethers.formatUnits(reserveToken, decimalsToken));
  const reserveOtherFormatted = Number(ethers.formatUnits(reserveOther, decimalsOther));
  const priceAlt = reserveOtherFormatted / reserveTokenFormatted;
  console.log(`\nAlternative calc (formatted units):`);
  console.log(`  reserve${tokenName} formatted: ${reserveTokenFormatted}`);
  console.log(`  reserveOther formatted: ${reserveOtherFormatted}`);
  console.log(`  price = ${priceAlt}`);
  console.log(`  price scientific: ${priceAlt.toExponential()}`);
  
  // Inverse price (token per MON instead of MON per token)
  const inversePrice = 1 / price;
  console.log(`\nInverse (${tokenName} per OTHER): ${inversePrice}`);
  console.log(`Inverse scientific: ${inversePrice.toExponential()}`);
  
  return { price, inversePrice, reserveToken, reserveOther, decimalsToken, decimalsOther };
}

async function main() {
  const addrs = require('../addresses.json');
  
  // Get factory and find pairs
  const routerAddr = process.env.ROUTER || addrs.ROUTER;
  const router = new ethers.Contract(routerAddr, ['function factory() view returns (address)'], provider);
  const factoryAddr = await router.factory();
  console.log('Factory:', factoryAddr);
  
  const factory = new ethers.Contract(factoryAddr, ['function getPair(address,address) view returns (address)'], provider);
  const pairTokenAddr = addrs.PAIR_TOKEN.toLowerCase();
  
  const craaPair = await factory.getPair(CRAA_TOKEN, pairTokenAddr);
  const octaPair = await factory.getPair(OCTA_TOKEN, pairTokenAddr);
  
  console.log('CRAA-WMON pair:', craaPair);
  console.log('OCTA-WMON pair:', octaPair);
  
  const craaResult = await analyzePair(craaPair, CRAA_TOKEN, 'CRAA');
  const octaResult = await analyzePair(octaPair, OCTA_TOKEN, 'OCTA');
  
  console.log('\n=== SUMMARY ===');
  console.log('CRAA price in MON:', craaResult.price);
  console.log('CRAA per MON:', craaResult.inversePrice);
  console.log('OCTA price in MON:', octaResult.price);
  console.log('OCTA per MON:', octaResult.inversePrice);
  
  console.log('\n=== FLOOR CALCULATION (0.52 MON) ===');
  const floor = 0.52;
  console.log('CRAA at floor:', floor * craaResult.inversePrice);
  console.log('OCTA at floor:', floor * octaResult.inversePrice);
}

main().then(() => console.log('\nDone')).catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
