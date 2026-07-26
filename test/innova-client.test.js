'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InnovaClient,
  normalizeStatus,
  snapAirLeafFanPercent,
} = require('../src/innova-client');

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

test('maps AirLeaf fan functions to the three HomeKit positions', () => {
  const fanPercent = (fn) => normalizeStatus({
    success: true,
    deviceType: '002',
    RESULT: { sp: 225, ta: 211, wm: 5, fn, ps: 1 },
  }).fanPercent;

  assert.equal(fanPercent(1), 0);
  assert.equal(fanPercent(2), 50);
  assert.equal(fanPercent(3), 50);
  assert.equal(fanPercent(4), 100);
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

test('snaps AirLeaf fan values to Auto, 1, and 2', () => {
  assert.equal(snapAirLeafFanPercent(0), 0);
  assert.equal(snapAirLeafFanPercent(24), 0);
  assert.equal(snapAirLeafFanPercent(25), 50);
  assert.equal(snapAirLeafFanPercent(74), 50);
  assert.equal(snapAirLeafFanPercent(75), 100);
  assert.equal(snapAirLeafFanPercent(100), 100);
});

test('uses AirLeaf fan-function endpoints for the three positions', async () => {
  const requests = [];
  const client = new InnovaClient('192.0.2.1', {
    deviceType: '002',
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ success: true }) };
    },
  });

  await client.setFan(0);
  await client.setFan(50);
  await client.setFan(100);

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      'http://192.0.2.1/api/v/1/set/function/auto',
      'http://192.0.2.1/api/v/1/set/function/min',
      'http://192.0.2.1/api/v/1/set/function/max',
    ],
  );
  assert.deepEqual(
    requests.map(({ options }) => JSON.parse(options.body)),
    [{ value: 1 }, { value: 1 }, { value: 1 }],
  );
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

test('serializes requests to protect the thermostat web server', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const client = new InnovaClient('192.0.2.1', {
    retries: 0,
    fetch: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setImmediate(resolve));
      concurrent -= 1;
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

  await Promise.all([client.status(), client.status(), client.status()]);
  assert.equal(maxConcurrent, 1);
});

test('allows command retries to be delegated to the desired-state queue', async () => {
  let attempts = 0;
  const client = new InnovaClient('192.0.2.1', {
    retries: 2,
    commandRetries: 0,
    fetch: async () => {
      attempts += 1;
      throw new Error('offline');
    },
  });

  await assert.rejects(client.setPower(true), /offline/);
  assert.equal(attempts, 1);
});
