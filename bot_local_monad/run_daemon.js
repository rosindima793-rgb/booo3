#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const INTERVAL_MS = 25 * 60 * 1000; // 25 minutes
const LOCK_FILE = path.join(__dirname, 'daemon.lock');
const LOG_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(LOG_DIR, `daemon_${Date.now()}.log`);

if (fs.existsSync(LOCK_FILE)) {
  console.error('Daemon already running (lock present). Exiting.');
  process.exit(1);
}

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(LOCK_FILE, process.pid.toString());

function runOnce() {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const cmd = process.execPath; // node
    const args = ['-r', 'hardhat/register', path.join(__dirname, 'push_prices.js'), '--apply'];
    const p = spawn(cmd, args, { cwd: path.join(__dirname), env: process.env });
    out.write('\n----- Run at ' + new Date().toISOString() + ' -----\n');
    p.stdout.on('data', d => out.write(d));
    p.stderr.on('data', d => out.write(d));
    p.on('close', (code) => {
      out.write('\n----- Exit code ' + code + ' -----\n');
      out.end();
      resolve(code);
    });
  });
}

async function mainLoop() {
  try {
    while (true) {
      await runOnce();
      await new Promise(r => setTimeout(r, INTERVAL_MS));
    }
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch(e){}
  }
}

mainLoop().catch(e => { console.error(e); try{ fs.unlinkSync(LOCK_FILE)}catch{}; process.exit(1); });
