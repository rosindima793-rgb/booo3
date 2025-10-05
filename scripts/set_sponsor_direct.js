#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

async function main(){
  const addresses = require('../addresses.json');
  const CORE = process.env.CORE_PROXY || addresses.CORE_PROXY;
  const RPC_URL = process.env.RPC_URL || process.env.MONAD_RPC || 'https://testnet-rpc.monad.xyz';
  const PK = process.env.ADMIN_PK || process.env.PRIVATE_KEY || process.env.ORACLE_PK || process.env.TRADER_PK;
  if (!CORE) throw new Error('CORE_PROXY not set');
  if (!PK) throw new Error('No private key in env (ADMIN_PK or PRIVATE_KEY)');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PK, provider);
  const coreAbi = [
    'function sponsorBps() view returns (uint16)',
    'function sponsorTreasury() view returns (address)',
    'function setSponsor(address treasury, uint16 bps) external'
  ];
  const core = new ethers.Contract(CORE, coreAbi, wallet);

  const treasury = await core.sponsorTreasury();
  const current = await core.sponsorBps();
  console.log('Core:', CORE);
  console.log('Current sponsorBps:', current.toString());
  console.log('sponsorTreasury:', treasury);

  if (Number(current) === 0) {
    console.log('sponsorBps already 0 - nothing to do');
    return;
  }

  console.log('Sending setSponsor(treasury, 0) ...');
  const tx = await core.setSponsor(treasury, 0);
  console.log('tx hash:', tx.hash);
  await tx.wait();
  const after = await core.sponsorBps();
  console.log('New sponsorBps:', after.toString());
}

main().catch(e=>{ console.error(e); process.exit(1); });
