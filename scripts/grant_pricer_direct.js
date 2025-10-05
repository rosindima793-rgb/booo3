#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

async function main(){
  const addresses = require('../addresses.json');
  const CORE = process.env.CORE_PROXY || addresses.CORE_PROXY;
  const PK = process.argv[2] || process.env.ADMIN_PK || process.env.PRIVATE_KEY;
  const PRICER = process.argv[3] || process.env.PRICER_ADDR;

  if (!CORE) throw new Error('CORE_PROXY not set (.env or addresses.json)');
  if (!PK) throw new Error('Provide admin private key as first arg or set ADMIN_PK in .env');
  if (!PRICER) throw new Error('Provide target pricer address as second arg or set PRICER_ADDR in .env');

  const RPC_URL = process.env.RPC_URL || process.env.MONAD_RPC || 'https://testnet-rpc.monad.xyz';
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PK, provider);

  const coreAbi = [
    'function grantRole(bytes32 role, address account) external',
    'function hasRole(bytes32 role, address account) view returns (bool)'
  ];
  const core = new ethers.Contract(CORE, coreAbi, wallet);

  const PRICER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('PRICER_ROLE'));
  console.log('Core:', CORE);
  console.log('Granter:', wallet.address);

  let pricerAddr;
  try {
    pricerAddr = ethers.getAddress(PRICER);
  } catch (e) {
    // If input is not a hex address, attempt to resolve ENS-like name (rare on Monad)
    try {
      pricerAddr = await wallet.resolveName(PRICER);
    } catch (err) {
      throw new Error('Bad PRICER address or name: ' + String(PRICER));
    }
  }

  console.log('Target PRICER:', pricerAddr);
  const already = await core.hasRole(PRICER_ROLE, pricerAddr);
  console.log('Already has PRICER_ROLE?', already);
  if (already) return console.log('Nothing to do.');

  const tx = await core.grantRole(PRICER_ROLE, pricerAddr);
  console.log('tx:', tx.hash);
  await tx.wait();
  const now = await core.hasRole(PRICER_ROLE, PRICER);
  console.log('Granted? ', now);
}

main().catch(e=>{ console.error(e); process.exit(1); });
