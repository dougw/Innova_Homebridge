#!/usr/bin/env node
'use strict';

const os = require('node:os');
const { InnovaClient } = require('../src/innova-client');

async function main() {
  const prefixes = localPrefixes();
  if (prefixes.length === 0) {
    throw new Error('No private IPv4 network interface found');
  }

  process.stdout.write(`Looking for Innova devices on ${prefixes.join(', ')}.0/24...\n`);
  const hosts = prefixes.flatMap((prefix) =>
    Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`));
  const found = [];

  for (let offset = 0; offset < hosts.length; offset += 32) {
    const batch = hosts.slice(offset, offset + 32);
    const results = await Promise.allSettled(batch.map(async (host) => {
      const client = new InnovaClient(host, { timeoutMs: 700 });
      const status = await client.status();
      return { host, status };
    }));
    found.push(...results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value));
  }

  if (found.length === 0) {
    process.stdout.write('No local API devices found.\n');
    process.exitCode = 1;
    return;
  }

  for (const { host, status } of found) {
    process.stdout.write(`${host}  ${status.name || 'Innova'}  type=${status.deviceType}  serial=${status.serial || 'unknown'}\n`);
  }
  process.stdout.write('\nHomebridge configuration:\n');
  process.stdout.write(`${JSON.stringify({
    platform: 'InnovaLocal',
    name: 'Innova Local',
    devices: found.map(({ host, status }) => ({ host, name: status.name || `Innova ${host}` })),
  }, null, 2)}\n`);
}

function localPrefixes() {
  const prefixes = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && address.netmask === '255.255.255.0') {
        prefixes.add(address.address.split('.').slice(0, 3).join('.'));
      }
    }
  }
  return [...prefixes];
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
