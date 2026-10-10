'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InnovaAccessory } = require('../src/accessory');

const Characteristic = {
  Name: {},
  Manufacturer: {},
  Model: {},
  SerialNumber: {},
  FirmwareRevision: {},
  TemperatureDisplayUnits: { CELSIUS: 0 },
  Active: { INACTIVE: 0, ACTIVE: 1 },
  CurrentTemperature: {},
  CurrentHeaterCoolerState: {
    INACTIVE: 0,
    IDLE: 1,
    HEATING: 2,
    COOLING: 3,
  },
  TargetHeaterCoolerState: {
    AUTO: 0,
    HEAT: 1,
    COOL: 2,
  },
  CoolingThresholdTemperature: {},
  HeatingThresholdTemperature: {},
  RotationSpeed: {},
};

const Service = {
  AccessoryInformation: {},
  HeaterCooler: {},
};

class FakeCharacteristic {
  setProps() {
    return this;
  }

  onGet(handler) {
    this.getHandler = handler;
    return this;
  }

  onSet(handler) {
    this.setHandler = handler;
    return this;
  }

  updateValue(value) {
    this.value = value;
    return this;
  }
}

class FakeService {
  constructor(displayName) {
    this.displayName = displayName;
    this.characteristics = new Map();
  }

  getCharacteristic(type) {
    if (!this.characteristics.has(type)) {
      this.characteristics.set(type, new FakeCharacteristic());
    }
    return this.characteristics.get(type);
  }

  setCharacteristic(type, value) {
    this.getCharacteristic(type).value = value;
    return this;
  }

  updateCharacteristic(type, value) {
    this.getCharacteristic(type).value = value;
    return this;
  }
}

function createAccessory(clientOverrides = {}, initialOverrides = {}) {
  const shutdownHandlers = [];
  const logs = { info: [], warn: [] };
  const platform = {
    config: { pollInterval: 1000000 },
    log: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    api: {
      hap: { Characteristic, Service },
      on: (event, handler) => {
        if (event === 'shutdown') shutdownHandlers.push(handler);
      },
    },
  };
  const services = new Map([
    [Service.AccessoryInformation, new FakeService('Information')],
  ]);
  const accessory = {
    context: { device: { name: 'Test Fancoil' } },
    displayName: 'Test Fancoil',
    getService: (type) => services.get(type),
    addService: (type, name) => {
      const service = new FakeService(name);
      services.set(type, service);
      return service;
    },
  };
  const calls = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const call = async (name, value) => {
    calls.push([name, value]);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setImmediate(resolve));
    concurrent -= 1;
  };
  const initialState = {
    active: false,
    currentTemperature: 21,
    targetTemperature: 22,
    mode: 'heating',
    fanPercent: 0,
    deviceType: '002',
    serial: 'test-serial',
    firmware: '1.0.0',
    ...initialOverrides,
  };
  const client = {
    host: '192.0.2.1',
    normalizeFanPercent: (value) => value,
    status: async () => ({ ...initialState }),
    setPower: (value) => call('power', value),
    setMode: (value) => call('mode', value),
    setTemperature: (value) => call('temperature', value),
    setFan: (value) => call('fan', value),
    ...clientOverrides,
  };
  const instance = new InnovaAccessory(platform, accessory, client, initialState);

  return {
    instance,
    calls,
    logs,
    maxConcurrent: () => maxConcurrent,
    shutdown: () => shutdownHandlers.forEach((handler) => handler()),
  };
}

test('acknowledges duplicate HomeKit temperature writes immediately and coalesces them', async () => {
  const fixture = createAccessory();

  assert.equal(fixture.instance.setTemperature(23), undefined);
  assert.equal(fixture.instance.setTemperature(23), undefined);
  assert.deepEqual(fixture.calls, []);

  await fixture.instance.flushWrites();
  assert.deepEqual(fixture.calls, [['temperature', 23]]);
  fixture.shutdown();
});

test('does not immediately retry a failed background status poll', async () => {
  let statusOptions;
  const fixture = createAccessory({
    status: async (options) => {
      statusOptions = options;
      throw new Error('temporarily busy');
    },
  });

  await fixture.instance.refresh();

  assert.deepEqual(statusOptions, { retries: 0 });
  assert.equal(fixture.logs.warn.length, 1);
  fixture.shutdown();
});

test('applies scene writes sequentially in a thermostat-safe order', async () => {
  const fixture = createAccessory();

  fixture.instance.setActive(Characteristic.Active.ACTIVE);
  fixture.instance.setTargetState(Characteristic.TargetHeaterCoolerState.COOL);
  fixture.instance.setTemperature(23);
  fixture.instance.setFan(100);
  await fixture.instance.flushWrites();

  assert.deepEqual(fixture.calls, [
    ['power', true],
    ['mode', 'cooling'],
    ['temperature', 23],
    ['fan', 100],
  ]);
  assert.equal(fixture.maxConcurrent(), 1);
  fixture.shutdown();
});

test('ignores scene values that already match the desired state', async () => {
  const fixture = createAccessory();

  fixture.instance.setActive(Characteristic.Active.INACTIVE);
  fixture.instance.setTargetState(Characteristic.TargetHeaterCoolerState.HEAT);
  fixture.instance.setTemperature(22);
  fixture.instance.setFan(0);
  await fixture.instance.flushWrites();

  assert.deepEqual(fixture.calls, []);
  fixture.shutdown();
});

test('retains a failed desired-state write and succeeds on a later retry', async () => {
  let attempts = 0;
  const fixture = createAccessory({
    setTemperature: async (value) => {
      fixture.calls.push(['temperature', value]);
      attempts += 1;
      if (attempts === 1) throw new Error('temporary failure');
    },
  });

  fixture.instance.setTemperature(23);
  await fixture.instance.flushWrites();
  assert.equal(fixture.instance.pendingWrites.get('targetTemperature'), 23);
  assert.equal(fixture.logs.warn.length, 1);

  clearTimeout(fixture.instance.writeTimer);
  fixture.instance.writeTimer = undefined;
  await fixture.instance.flushWrites();
  assert.equal(fixture.instance.pendingWrites.size, 0);
  assert.equal(attempts, 2);
  fixture.shutdown();
});

test('applies the newest scene value after an older value is already in flight', async () => {
  let releaseFirstWrite;
  let firstWrite = true;
  const fixture = createAccessory({
    setTemperature: async (value) => {
      fixture.calls.push(['temperature', value]);
      if (firstWrite) {
        firstWrite = false;
        await new Promise((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
    },
  });

  fixture.instance.setTemperature(23);
  const firstFlush = fixture.instance.flushWrites();
  fixture.instance.setTemperature(24);
  releaseFirstWrite();
  await firstFlush;

  clearTimeout(fixture.instance.writeTimer);
  fixture.instance.writeTimer = undefined;
  await fixture.instance.flushWrites();

  assert.deepEqual(fixture.calls, [
    ['temperature', 23],
    ['temperature', 24],
  ]);
  assert.equal(fixture.instance.confirmedState.targetTemperature, 24);
  fixture.shutdown();
});
