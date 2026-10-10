'use strict';

const { DEFAULT_POLL_INTERVAL_MS } = require('./settings');

const CONTROLLED_FIELDS = ['active', 'mode', 'targetTemperature', 'fanPercent'];
const WRITE_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000, 60000];
const WRITE_DEBOUNCE_MS = 200;
const POST_WRITE_REFRESH_MS = 300;

class InnovaAccessory {
  constructor(platform, accessory, client, initialState, options = {}) {
    this.platform = platform;
    this.accessory = accessory;
    this.client = client;
    this.state = initialState;
    this.confirmedState = { ...initialState };
    this.desiredState = { ...initialState };
    this.refreshPromise = undefined;
    this.consecutiveFailures = 0;
    this.pendingWrites = new Map();
    this.inFlightWrites = undefined;
    this.writePromise = undefined;
    this.writeTimer = undefined;
    this.refreshTimer = undefined;
    this.writeFailureCount = 0;

    const { Service, Characteristic } = platform.api.hap;
    this.Service = Service;
    this.Characteristic = Characteristic;
    const name = accessory.context.device.name || initialState.name || accessory.displayName;

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'INNOVA')
      .setCharacteristic(Characteristic.Model, initialState.deviceType === '002' ? 'AirLeaf' : 'Innova ..2.0')
      .setCharacteristic(Characteristic.SerialNumber, initialState.serial || initialState.uid || client.host)
      .setCharacteristic(Characteristic.FirmwareRevision, initialState.firmware || 'unknown');

    this.service = accessory.getService(Service.HeaterCooler)
      || accessory.addService(Service.HeaterCooler, name);
    this.service.displayName = name;
    this.service.updateCharacteristic(Characteristic.Name, name);

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((value) => this.setActive(value));
    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.state.currentTemperature);
    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.getCurrentState());
    this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .onGet(() => this.getTargetState())
      .onSet((value) => this.setTargetState(value));
    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .updateValue(initialState.targetTemperature)
      .setProps({ minValue: 5, maxValue: 40, minStep: 0.5 })
      .onGet(() => this.state.targetTemperature)
      .onSet((value) => this.setTemperature(Number(value)));
    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .updateValue(initialState.targetTemperature)
      .setProps({ minValue: 5, maxValue: 40, minStep: 0.5 })
      .onGet(() => this.state.targetTemperature)
      .onSet((value) => this.setTemperature(Number(value)));
    const fanProps = initialState.deviceType === '002'
      ? { minValue: 0, maxValue: 100, minStep: 50, validValues: [0, 50, 100] }
      : { minValue: 0, maxValue: 100, minStep: 25 };
    this.service.getCharacteristic(Characteristic.RotationSpeed)
      .setProps(fanProps)
      .onGet(() => this.state.fanPercent)
      .onSet((value) => this.setFan(Number(value)));

    if (initialState.deviceType === '002') {
      this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
        .updateValue(initialState.mode === 'cooling'
          ? Characteristic.TargetHeaterCoolerState.COOL
          : Characteristic.TargetHeaterCoolerState.HEAT)
        .setProps({ validValues: [
          Characteristic.TargetHeaterCoolerState.HEAT,
          Characteristic.TargetHeaterCoolerState.COOL,
        ] });
    }

    this.updateCharacteristics(initialState);
    const pollInterval = Math.max(
      5000,
      this.platform.config.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
    );
    const pollOffsetMs = Math.max(
      0,
      Math.min(pollInterval - 1, Number(options.pollOffsetMs) || 0),
    );
    this.pollStartTimer = setTimeout(() => {
      this.pollStartTimer = undefined;
      void this.refresh();
      this.pollTimer = setInterval(() => this.refresh(), pollInterval);
      this.pollTimer.unref?.();
    }, pollInterval + pollOffsetMs);
    this.pollStartTimer.unref?.();
    this.platform.api.on('shutdown', () => {
      clearTimeout(this.pollStartTimer);
      clearInterval(this.pollTimer);
      clearTimeout(this.writeTimer);
      clearTimeout(this.refreshTimer);
    });
  }

  refresh() {
    if (this.hasOutstandingWrites()) {
      return Promise.resolve(this.state);
    }
    if (!this.refreshPromise) {
      // A failed background read is retried by the next scheduled poll. Immediate
      // retries can overwhelm the single-request web server in an AirLeaf unit.
      this.refreshPromise = this.client.status({ retries: 0 })
        .then((state) => {
          this.confirmedState = { ...state };
          if (this.hasOutstandingWrites()) {
            this.state = this.mergeDesiredState(state);
          } else {
            this.state = state;
            this.desiredState = { ...state };
          }
          if (this.consecutiveFailures > 0) {
            this.platform.log.info(`Innova at ${this.client.host} is reachable again.`);
          }
          this.consecutiveFailures = 0;
          this.updateCharacteristics(state);
          return state;
        })
        .catch((error) => {
          this.consecutiveFailures += 1;
          if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
            this.platform.log.warn(
              `Cannot refresh Innova at ${this.client.host}; retaining cached state: ${error.message}`,
            );
          }
          return this.state;
        })
        .finally(() => {
          this.refreshPromise = undefined;
        });
    }
    return this.refreshPromise;
  }

  hasOutstandingWrites() {
    return this.pendingWrites.size > 0 || Boolean(this.inFlightWrites);
  }

  mergeDesiredState(state) {
    const merged = { ...state };
    for (const field of CONTROLLED_FIELDS) {
      merged[field] = this.desiredState[field];
    }
    return merged;
  }

  setDesiredValue(field, value) {
    if (sameValue(this.desiredState[field], value)) {
      return;
    }

    this.desiredState[field] = value;
    this.state = { ...this.state, [field]: value };

    const inFlightHasField = this.inFlightWrites?.has(field) ?? false;
    const inFlightValue = this.inFlightWrites?.get(field);
    if (
      (!inFlightHasField && sameValue(this.confirmedState[field], value))
      || (inFlightHasField && sameValue(inFlightValue, value))
    ) {
      this.pendingWrites.delete(field);
    } else {
      this.pendingWrites.set(field, value);
    }

    this.updateCharacteristics(this.state);
    if (this.pendingWrites.size > 0) {
      this.scheduleWrite(WRITE_DEBOUNCE_MS);
    }
  }

  scheduleWrite(delayMs) {
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.flushWrites();
    }, delayMs);
    this.writeTimer.unref?.();
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, POST_WRITE_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  reconcilePendingWrites() {
    for (const field of CONTROLLED_FIELDS) {
      const desiredValue = this.desiredState[field];
      if (sameValue(this.confirmedState[field], desiredValue)) {
        this.pendingWrites.delete(field);
      } else {
        this.pendingWrites.set(field, desiredValue);
      }
    }
  }

  orderedWrites(writes) {
    const ordered = [];
    const add = (field) => {
      if (writes.has(field)) ordered.push([field, writes.get(field)]);
    };

    if (writes.get('active') === true) add('active');
    add('mode');
    add('targetTemperature');
    add('fanPercent');
    if (writes.get('active') === false) add('active');
    return ordered;
  }

  async executeWrite(field, value) {
    switch (field) {
      case 'active':
        return this.client.setPower(value);
      case 'mode':
        return this.client.setMode(value);
      case 'targetTemperature':
        return this.client.setTemperature(value);
      case 'fanPercent':
        return this.client.setFan(value);
      default:
        throw new Error(`Unsupported desired-state field: ${field}`);
    }
  }

  flushWrites() {
    if (this.writePromise) {
      return this.writePromise;
    }

    clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    this.reconcilePendingWrites();
    if (this.pendingWrites.size === 0) {
      return Promise.resolve();
    }

    const writes = this.orderedWrites(new Map(this.pendingWrites));
    this.inFlightWrites = new Map(writes);
    for (const [field] of writes) {
      this.pendingWrites.delete(field);
    }

    let failed = false;
    let failedField;
    let retryDelay = 0;
    this.writePromise = (async () => {
      for (const [field, value] of writes) {
        failedField = field;
        await this.executeWrite(field, value);
        this.confirmedState = { ...this.confirmedState, [field]: value };
      }
    })()
      .then(() => {
        if (this.writeFailureCount > 0) {
          this.platform.log.info(`Pending changes for Innova at ${this.client.host} were applied.`);
        }
        this.writeFailureCount = 0;
      })
      .catch((error) => {
        failed = true;
        this.writeFailureCount += 1;
        retryDelay = WRITE_RETRY_DELAYS_MS[
          Math.min(this.writeFailureCount - 1, WRITE_RETRY_DELAYS_MS.length - 1)
        ];
        if (this.writeFailureCount === 1 || this.writeFailureCount % 5 === 0) {
          this.platform.log.warn(
            `Cannot apply ${writeLabel(failedField)} to Innova at ${this.client.host}; `
            + `will retry in ${retryDelay / 1000}s: ${error.message}`,
          );
        }
      })
      .finally(() => {
        this.inFlightWrites = undefined;
        this.writePromise = undefined;
        this.reconcilePendingWrites();
        if (this.pendingWrites.size > 0) {
          this.scheduleWrite(failed ? retryDelay : 0);
        } else {
          this.scheduleRefresh();
        }
      });

    return this.writePromise;
  }

  updateCharacteristics(state) {
    const { Characteristic } = this;
    this.service.updateCharacteristic(
      Characteristic.Active,
      state.active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
    );
    this.service.updateCharacteristic(
      Characteristic.CurrentTemperature,
      state.currentTemperature,
    );
    this.service.updateCharacteristic(
      Characteristic.CurrentHeaterCoolerState,
      this.currentStateValue(state),
    );
    this.service.updateCharacteristic(
      Characteristic.TargetHeaterCoolerState,
      this.targetStateValue(state),
    );
    this.service.updateCharacteristic(
      Characteristic.CoolingThresholdTemperature,
      state.targetTemperature,
    );
    this.service.updateCharacteristic(
      Characteristic.HeatingThresholdTemperature,
      state.targetTemperature,
    );
    this.service.updateCharacteristic(Characteristic.RotationSpeed, state.fanPercent);
  }

  getActive() {
    return this.state.active
      ? this.Characteristic.Active.ACTIVE
      : this.Characteristic.Active.INACTIVE;
  }

  setActive(value) {
    const active = value === this.Characteristic.Active.ACTIVE;
    this.setDesiredValue('active', active);
  }

  currentStateValue(state) {
    if (!state.active) return this.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    if (state.mode === 'heating') return this.Characteristic.CurrentHeaterCoolerState.HEATING;
    if (state.mode === 'cooling') return this.Characteristic.CurrentHeaterCoolerState.COOLING;
    return this.Characteristic.CurrentHeaterCoolerState.IDLE;
  }

  getCurrentState() {
    return this.currentStateValue(this.state);
  }

  targetStateValue(state) {
    if (state.mode === 'heating') return this.Characteristic.TargetHeaterCoolerState.HEAT;
    if (state.mode === 'cooling') return this.Characteristic.TargetHeaterCoolerState.COOL;
    return this.Characteristic.TargetHeaterCoolerState.AUTO;
  }

  getTargetState() {
    return this.targetStateValue(this.state);
  }

  setTargetState(value) {
    const modes = {
      [this.Characteristic.TargetHeaterCoolerState.AUTO]: 'auto',
      [this.Characteristic.TargetHeaterCoolerState.HEAT]: 'heating',
      [this.Characteristic.TargetHeaterCoolerState.COOL]: 'cooling',
    };
    const mode = modes[value];
    if (mode) {
      this.setDesiredValue('mode', mode);
    }
  }

  setTemperature(value) {
    this.setDesiredValue('targetTemperature', value);
  }

  setFan(value) {
    const fanPercent = this.client.normalizeFanPercent(value);
    this.setDesiredValue('fanPercent', fanPercent);
  }
}

function sameValue(left, right) {
  return typeof left === 'number' && typeof right === 'number'
    ? Math.abs(left - right) < 0.001
    : left === right;
}

function writeLabel(field) {
  return ({
    active: 'power',
    mode: 'mode',
    targetTemperature: 'temperature',
    fanPercent: 'fan speed',
  })[field] ?? field ?? 'state';
}

module.exports = { InnovaAccessory };
