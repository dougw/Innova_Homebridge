'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InnovaClient, normalizeStatus } = require('../src/innova-client');

test('normalizes an AirLeaf response', () => {
  const status = normalizeStatus({
    success: true,
    deviceType: '002',
    UID: 'aa:bb',
    setup: { name: 'Living room', serial: '123' },
    sw: { V: '1.0.3' },
    RESULT: { sp: 225, ta: 211, wm: 5, fn: 4, ps: 1 },
  });
  assert.equal(status.currentTemperature, 21.1);
  assert.equal(status.targetTemperature, 22.5);
  assert.equal(status.mode, 'cooling');
  assert.equal(status.fanPercent, 100);
});

test('normalizes a legacy Innova response', () => {
  const status = normalizeStatus({
    success: true,
    deviceType: '001',
    RESULT: { sp: 24, t: 20, wm: 0, fs: 2, ps: 1 },
  });
  assert.equal(status.active, true);
  assert.equal(status.currentTemperature, 20);
  assert.equal(status.targetTemperature, 24);
  assert.equal(status.mode, 'heating');
  assert.equal(status.fanPercent, 50);
});

test('uses AirLeaf JSON temperature encoding', async () => {
  let request;
  const client = new InnovaClient('192.0.2.1', {
    deviceType: '002',
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ success: true }) };
    },
  });
  await client.setTemperature(23.5);
  assert.equal(request.url, 'http://192.0.2.1/api/v/1/set/setpoint');
  assert.deepEqual(JSON.parse(request.options.body), { temp: 235 });
});

test('retries a transient network failure', async () => {
  let attempts = 0;
  const client = new InnovaClient('192.0.2.1', {
    retries: 2,
    fetch: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('temporary failure');
      return {
        ok: true,
        json: async () => ({
          success: true,
          deviceType: '002',
          RESULT: { sp: 220, ta: 210, wm: 3, fn: 1, ps: 1 },
        }),
      };
    },
  });
  const status = await client.status();
  assert.equal(attempts, 2);
  assert.equal(status.currentTemperature, 21);
});
