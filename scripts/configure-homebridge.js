#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const configPath = process.argv[2];
const hosts = process.argv.slice(3);
if (!configPath || hosts.length === 0) {
  process.stderr.write(
    'Usage: node scripts/configure-homebridge.js /path/to/config.json IP_ADDRESS [IP_ADDRESS...]\n',
  );
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.platforms ??= [];

const platform = {
  platform: 'InnovaLocal',
  name: 'Innova Local',
  devices: hosts.map((host, index) => ({
    host,
    name: `Innova ${index + 1}`,
  })),
};

const index = config.platforms.findIndex((item) => item.platform === platform.platform);
if (index === -1) config.platforms.push(platform);
else config.platforms[index] = platform;

const backupPath = `${configPath}.before-innova`;
if (!fs.existsSync(backupPath)) fs.copyFileSync(configPath, backupPath);
const temporaryPath = path.join(path.dirname(configPath), `.${path.basename(configPath)}.innova-tmp`);
fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
fs.renameSync(temporaryPath, configPath);
process.stdout.write(`Configured ${hosts.length} Innova device(s) in ${configPath}\nBackup: ${backupPath}\n`);
