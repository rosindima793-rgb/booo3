const { ethers } = require('ethers');

// Quick pair checker for CRAA/OCTA on the configured factory
const RPC = 'https://testnet-rpc.monad.xyz';
const provider = new ethers.JsonRpcProvider(RPC);
const PANCAKE_FACTORY = '0x82438CE666d9403e488bA720c7424434e8Aa47CD'.toLowerCase();
const WMON = '0x760AfE86e5de5fa0Ee542fc7b7b713e1c5425701'.toLowerCase();
const CRAA = '0x7D7F4BDd43292f9E7Aae44707a7EEEB5655ca465'.toLowerCase();
const OCTA = '0xB4832932D819361e0d250c338eBf87f0757ed800'.toLowerCase();

async function check(tokenAddr, name) {
  try {
    const factory = new ethers.Contract(PANCAKE_FACTORY, ['function getPair(address,address) view returns (address)'], provider);
    const pair = await factory.getPair(tokenAddr, WMON);
    console.log(`\n[${name}] factory.getPair ->`, pair);
    if (!pair || pair === '0x0000000000000000000000000000000000000000') {
      console.log(`[${name}] no pair found (0x0)`);
      return;
    }
    const code = await provider.getCode(pair);
    console.log(`[${name}] getCode length:`, code ? code.length : 0, `(hex len)`);
    if (!code || code === '0x') {
      console.log(`[${name}] NO CONTRACT CODE at pair address`);
      return;
    }
    // try token0/token1/getReserves
    const pairAbi = ['function token0() view returns (address)', 'function token1() view returns (address)', 'function getReserves() view returns (uint112,uint112,uint32)'];
    const pc = new ethers.Contract(pair, pairAbi, provider);
    try {
      const t0 = await pc.token0();
      const t1 = await pc.token1();
      console.log(`[${name}] token0: ${t0}`);
      console.log(`[${name}] token1: ${t1}`);
    } catch (e) {
      console.error(`[${name}] token0/token1 call failed:`, e.message || e);
    }
    try {
      const reserves = await pc.getReserves();
      console.log(`[${name}] getReserves ->`, reserves);
    } catch (e) {
      console.error(`[${name}] getReserves failed:`, e.message || e);
    }
  } catch (e) {
    console.error(`[${name}] factory.getPair failed:`, e.message || e);
  }
}

(async () => {
  console.log('Checking pairs on RPC:', RPC);
  await check(CRAA, 'CRAA');
  await check(OCTA, 'OCTA');
  console.log('\nDone');
})();
