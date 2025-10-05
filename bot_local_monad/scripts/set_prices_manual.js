#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz';
const ORACLE_PK = process.env.ORACLE_PK || '';
const CORE_PROXY = process.env.CORE_PROXY || '0xb8Fee974031de01411656F908E13De4Ad9c74A9B';
const GAS_LIMIT = parseInt(process.env.GAS_LIMIT || '500000', 10);

const provider = new ethers.JsonRpcProvider(RPC_URL);

async function main(){
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');
  const floor = parseFloat((args[0] && !args[0].startsWith('--')) ? args[0] : '10000');
  const rate = parseFloat((args[1] && !args[1].startsWith('--')) ? args[1] : '10000');

  console.log(`\nSet manual prices (floor=${floor}, craaPerOcta=${rate}) - ${dryRun ? 'DRY' : 'LIVE'}`);

  if (!ORACLE_PK) {
    console.log('⚠️  ORACLE_PK missing in .env');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(ORACLE_PK, provider);
  const coreAbi = [
    'function setManualFloor(uint256) external',
    'function setCRARateManual(uint256) external'
  ];
  const core = new ethers.Contract(CORE_PROXY, coreAbi, wallet);

  const floor1e18 = ethers.parseEther(floor.toFixed(18));
  const rate1e18 = ethers.parseEther(rate.toFixed(18));

  console.log(`  setManualFloor(${floor1e18})`);
  console.log(`  setCRARateManual(${rate1e18})`);

  if (dryRun) return;

  try {
    const tx1 = await core.setManualFloor(floor1e18, { gasLimit: GAS_LIMIT });
    console.log('  Floor tx:', tx1.hash);
    await tx1.wait();
  } catch(e){ console.error('  Floor failed:', e.message); }

  try {
    const tx2 = await core.setCRARateManual(rate1e18, { gasLimit: GAS_LIMIT });
    console.log('  CRAA tx:', tx2.hash);
    await tx2.wait();
  } catch(e){ console.error('  CRAA failed:', e.message); }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { main };
