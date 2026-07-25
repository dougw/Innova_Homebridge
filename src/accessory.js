'use strict';

class InnovaAccessory {
  constructor(platform, accessory, client, initialState) {
    this.platform = platform;
    this.accessory = accessory;
    this.client = client;
    this.state = initialState;
    this.refreshPromise = undefined;
    this.lastRefresh = 0;

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

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((value) => this.setActive(value));
    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.getState().then((state) => state.currentTemperature));
    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.getCurrentState());
    this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .onGet(() => this.getTargetState())
      .onSet((value) => this.setTargetState(value));
    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .updateValue(initialState.targetTemperature)
      .setProps({ minValue: 5, maxValue: 40, minStep: 0.5 })
      .onGet(() => this.getState().then((state) => state.targetTemperature))
      .onSet((value) => this.setTemperature(Number(value)));
    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .updateValue(initialState.targetTemperature)
      .setProps({ minValue: 5, maxValue: 40, minStep: 0.5 })
      .onGet(() => this.getState().then((state) => state.targetTemperature))
      .onSet((value) => this.setTemperature(Number(value)));
    this.service.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
      .onGet(() => this.getState().then((state) => state.fanPercent))
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
  }

  async getState(force = false) {
    const cacheMs = this.platform.config.pollInterval ?? 5000;
    if (!force && Date.now() - this.lastRefresh < cacheMs) return this.state;
    if (!this.refreshPromise) {
      this.refreshPromise = this.client.status()
        .then((state) => {
          this.state = state;
          this.lastRefresh = Date.now();
          return state;
        })
        .finally(() => {
          this.refreshPromise = undefined;
        });
    }
    return this.refreshPromise;
  }

  async getActive() {
    const state = await this.getState();
    return state.active
      ? this.Characteristic.Active.ACTIVE
      : this.Characteristic.Active.INACTIVE;
  }

  async setActive(value) {
    const active = value === this.Characteristic.Active.ACTIVE;
    await this.client.setPower(active);
    this.state.active = active;
  }

  async getCurrentState() {
    const state = await this.getState();
    if (!state.active) return this.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    if (state.mode === 'heating') return this.Characteristic.CurrentHeaterCoolerState.HEATING;
    if (state.mode === 'cooling') return this.Characteristic.CurrentHeaterCoolerState.COOLING;
    return this.Characteristic.CurrentHeaterCoolerState.IDLE;
  }

  async getTargetState() {
    const state = await this.getState();
    if (state.mode === 'heating') return this.Characteristic.TargetHeaterCoolerState.HEAT;
    if (state.mode === 'cooling') return this.Characteristic.TargetHeaterCoolerState.COOL;
    return this.Characteristic.TargetHeaterCoolerState.AUTO;
  }

  async setTargetState(value) {
    const modes = {
      [this.Characteristic.TargetHeaterCoolerState.AUTO]: 'auto',
      [this.Characteristic.TargetHeaterCoolerState.HEAT]: 'heating',
      [this.Characteristic.TargetHeaterCoolerState.COOL]: 'cooling',
    };
    const mode = modes[value];
    await this.client.setMode(mode);
    this.state.mode = mode;
  }

  async setTemperature(value) {
    await this.client.setTemperature(value);
    this.state.targetTemperature = value;
  }

  async setFan(value) {
    await this.client.setFan(value);
    this.state.fanPercent = value;
  }
}

module.exports = { InnovaAccessory };
