#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const configPath = process.argv[2];
const networkInterface = process.argv[3];
if (!configPath || !networkInterface) {
  process.stderr.write(
    'Usage: node scripts/harden-homebridge.js /path/to/config.json NETWORK_INTERFACE\n',
  );
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.bridge ??= {};
config.bridge.advertiser = 'ciao';
config.bridge.bind = [networkInterface];

const backupPath = `${configPath}.before-network-hardening`;
if (!fs.existsSync(backupPath)) fs.copyFileSync(configPath, backupPath);
const temporaryPath = path.join(path.dirname(configPath), `.${path.basename(configPath)}.network-tmp`);
fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
fs.renameSync(temporaryPath, configPath);

process.stdout.write(
  `Configured Homebridge to use ciao on ${networkInterface}.\nBackup: ${backupPath}\n`,
);
