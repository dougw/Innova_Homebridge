'use strict';

const { InnovaClient } = require('./innova-client');
const { InnovaAccessory } = require('./accessory');
const { PLUGIN_NAME, PLATFORM_NAME } = require('./settings');

class InnovaPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config ?? {};
    this.api = api;
    this.accessories = [];

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
    if (devices.length === 0) {
      this.log.warn('No devices configured. Run "innova-discover" or add an Innova IP address in the plugin settings.');
      return;
    }

    const activeUuids = new Set();
    for (const device of devices) {
      if (!device.host) {
        this.log.warn('Skipping an Innova entry without a host.');
        continue;
      }
      try {
        const client = new InnovaClient(device.host, {
          timeoutMs: this.config.timeoutMs,
          log: this.log,
        });
        const state = await client.status();
        const identity = state.uid || state.serial || device.host;
        const uuid = this.api.hap.uuid.generate(`innova:${identity}`);
        activeUuids.add(uuid);
        let accessory = this.accessories.find((item) => item.UUID === uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(device.name || state.name || `Innova ${device.host}`, uuid);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }
        accessory.context.device = { ...device, identity };
        new InnovaAccessory(this, accessory, client, state);
        this.log.info(`Connected to ${state.name || device.name || 'Innova'} at ${device.host} (type ${state.deviceType})`);
      } catch (error) {
        this.log.error(`Cannot connect to Innova at ${device.host}: ${error.message}`);
      }
    }

    const stale = this.accessories.filter((accessory) => !activeUuids.has(accessory.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.accessories = this.accessories.filter((accessory) => activeUuids.has(accessory.UUID));
    }
  }
}

module.exports = { InnovaPlatform };
