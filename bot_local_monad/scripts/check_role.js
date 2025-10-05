#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ethers } = require('ethers');

// Usage: node check_role.js <ROLE> <ADDRESS>
// Example: node check_role.js PRICER_ROLE 0x7557...

const RPC_URL = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz';
const CORE_PROXY = process.env.CORE_PROXY || '0xb8Fee974031de01411656F908E13De4Ad9c74A9B';

if (process.argv.length < 4) {
  console.log('Usage: node check_role.js <ROLE> <ADDRESS>');
  process.exit(1);
}

const roleName = process.argv[2];
const target = process.argv[3].toLowerCase();

// Use explicit network info to avoid ENS resolution errors on custom chain
const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: 10143, name: 'monad' });
const coreAbi = ['function hasRole(bytes32 role, address account) view returns (bool)'];
const iface = new ethers.Interface(coreAbi);


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
  console.log('Checking role', roleName, 'for', target);
  try {
    const data = iface.encodeFunctionData('hasRole', [roleHash, target]);
    const resRaw = await provider.call({ to: CORE_PROXY, data });
    const [res] = iface.decodeFunctionResult('hasRole', resRaw);
    console.log(`${target} has ${roleName}? ->`, res);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
