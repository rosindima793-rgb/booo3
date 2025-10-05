#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');

// Usage: node grant_role.js <ROLE> <ADDRESS> [--apply]
// Example: node grant_role.js PRICER_ROLE 0x7557... --apply

const RPC_URL = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz';
const CORE_PROXY = process.env.CORE_PROXY || '0xb8Fee974031de01411656F908E13De4Ad9c74A9B';
const ADMIN_PK = process.env.ADMIN_PK || ''; // Private key with ADMIN_ROLE / DEFAULT_ADMIN_ROLE

if (process.argv.length < 4) {
  console.log('Usage: node grant_role.js <ROLE> <ADDRESS> [--apply]');
  process.exit(1);
}

const roleName = process.argv[2];
const target = process.argv[3].toLowerCase();
const doApply = process.argv.includes('--apply');

if (!/^0x[a-f0-9]{40}$/i.test(target)) {
  console.error('Invalid address:', target);
  process.exit(1);
}

const roleMap = {
  ADMIN_ROLE: ethers.keccak256(ethers.toUtf8Bytes('ADMIN_ROLE')),
  PRICER_ROLE: ethers.keccak256(ethers.toUtf8Bytes('PRICER_ROLE')),
  CONFIGURATOR_ROLE: ethers.keccak256(ethers.toUtf8Bytes('CONFIGURATOR_ROLE')),
  FUND_ROLE: ethers.keccak256(ethers.toUtf8Bytes('FUND_ROLE'))
};

(async function main(){
  if (!roleMap[roleName]) {
    console.error('Unknown role. Use one of:', Object.keys(roleMap).join(', '));
    process.exit(1);
  }

  if (!ADMIN_PK) {
    console.log('ADMIN_PK not set in .env — cannot sign. Dry-run only.');
  }

  console.log('Role:', roleName);
  console.log('Target:', target);
  console.log('Contract:', CORE_PROXY);
  console.log('Apply:', doApply);

  // show encoded role
  const roleHash = roleMap[roleName];
  console.log('roleHash:', roleHash);

  if (!doApply) {
    console.log('\nDRY RUN: no tx will be sent. Add --apply to actually send the transaction.');
    process.exit(0);
  }

  if (!ADMIN_PK) {
    console.error('ADMIN_PK not provided — aborting.');
    process.exit(1);
  }

  // Use explicit network info to avoid ENS resolution errors on custom chain
  const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: 10143, name: 'monad' });
  const adminWallet = new ethers.Wallet(ADMIN_PK, provider);
  const abi = ['function grantRole(bytes32 role, address account) external'];
  const core = new ethers.Contract(CORE_PROXY, abi, adminWallet);

  try {
    const tx = await core.grantRole(roleHash, target, { gasLimit: 200000 });
    console.log('tx sent:', tx.hash);
    await tx.wait();
    console.log('Role granted');
  } catch (e) {
    console.error('Grant failed:', e.message);
    process.exit(1);
  }
})();
