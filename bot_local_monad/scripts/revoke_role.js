#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');

// Usage: node revoke_role.js <ROLE> <ADDRESS> [--apply]

const RPC_URL = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz';
const CORE_PROXY = process.env.CORE_PROXY || '0xb8Fee974031de01411656F908E13De4Ad9c74A9B';
const ADMIN_PK = process.env.ADMIN_PK || '';

if (process.argv.length < 4) {
  console.log('Usage: node revoke_role.js <ROLE> <ADDRESS> [--apply]');
  process.exit(1);
}

const roleName = process.argv[2];
const target = process.argv[3].toLowerCase();
const doApply = process.argv.includes('--apply');

const roleMap = {
  ADMIN_ROLE: ethers.keccak256(ethers.toUtf8Bytes('ADMIN_ROLE')),
  PRICER_ROLE: ethers.keccak256(ethers.toUtf8Bytes('PRICER_ROLE')),
  CONFIGURATOR_ROLE: ethers.keccak256(ethers.toUtf8Bytes('CONFIGURATOR_ROLE')),
  FUND_ROLE: ethers.keccak256(ethers.toUtf8Bytes('FUND_ROLE'))
};

(async function(){
  if (!roleMap[roleName]) {
    console.error('Unknown role. Use one of:', Object.keys(roleMap).join(', '));
    process.exit(1);
  }

  const roleHash = roleMap[roleName];
  console.log('Role:', roleName, 'Target:', target, 'Apply:', doApply);

  if (!doApply) {
    console.log('\nDRY RUN: add --apply to actually send revoke transaction');
    process.exit(0);
  }

  if (!ADMIN_PK) {
    console.error('ADMIN_PK not set in .env');
    process.exit(1);
  }

  // Use explicit network info to avoid ENS resolution errors on custom chain
  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: 10143, name: 'monad' });
  const adminWallet = new ethers.Wallet(ADMIN_PK, provider);
  const core = new ethers.Contract(CORE_PROXY, ['function revokeRole(bytes32 role, address account) external'], adminWallet);

  try {
    const tx = await core.revokeRole(roleHash, target, { gasLimit: 200000 });
    console.log('tx sent:', tx.hash);
    await tx.wait();
    console.log('Role revoked');
  } catch (e) {
    console.error('Revoke failed:', e.message);
    process.exit(1);
  }
})();
