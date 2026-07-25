'use strict';

class InnovaAccessory {
  constructor(platform, accessory, client, initialState) {
    this.platform = platform;
    this.accessory = accessory;
    this.client = client;
    this.state = initialState;
    this.refreshPromise = undefined;
    this.consecutiveFailures = 0;

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
    this.service.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
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
    const pollInterval = Math.max(5000, this.platform.config.pollInterval ?? 10000);
    this.pollTimer = setInterval(() => this.refresh(), pollInterval);
    this.pollTimer.unref?.();
    this.platform.api.on('shutdown', () => clearInterval(this.pollTimer));
  }

  refresh() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.client.status()
        .then((state) => {
          this.state = state;
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

  async setActive(value) {
    const active = value === this.Characteristic.Active.ACTIVE;
    await this.client.setPower(active);
    this.state.active = active;
    this.updateCharacteristics(this.state);
    void this.refresh();
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

  async setTargetState(value) {
    const modes = {
      [this.Characteristic.TargetHeaterCoolerState.AUTO]: 'auto',
      [this.Characteristic.TargetHeaterCoolerState.HEAT]: 'heating',
      [this.Characteristic.TargetHeaterCoolerState.COOL]: 'cooling',
    };
    const mode = modes[value];
    await this.client.setMode(mode);
    this.state.mode = mode;
    this.updateCharacteristics(this.state);
    void this.refresh();
  }

  async setTemperature(value) {
    await this.client.setTemperature(value);
    this.state.targetTemperature = value;
    this.updateCharacteristics(this.state);
    void this.refresh();
  }

  async setFan(value) {
    await this.client.setFan(value);
    this.state.fanPercent = value;
    this.updateCharacteristics(this.state);
    void this.refresh();
  }
}

module.exports = { InnovaAccessory };
