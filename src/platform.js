'use strict';

const { InnovaClient } = require('./innova-client');
const { InnovaAccessory } = require('./accessory');
const {
  DEFAULT_POLL_INTERVAL_MS,
  PLUGIN_NAME,
  PLATFORM_NAME,
} = require('./settings');

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
    const pollInterval = Math.max(
      5000,
      this.config.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
    );
    for (const [deviceIndex, device] of devices.entries()) {
      if (!device.host) {
        this.log.warn('Skipping an Innova entry without a host.');
        continue;
      }
      try {
        const client = new InnovaClient(device.host, {
          timeoutMs: this.config.timeoutMs,
          retries: this.config.retries,
          commandRetries: 0,
          log: this.log,
        });
        const state = await client.status();
        const identity = state.uid || state.serial || device.host;
        const uuid = this.api.hap.uuid.generate(`innova:${identity}`);
        const configuredName = device.name || state.name || `Innova ${device.host}`;
        activeUuids.add(uuid);
        let accessory = this.accessories.find((item) => item.UUID === uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(configuredName, uuid);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }
        const nameChanged = accessory.displayName !== configuredName;
        if (nameChanged) {
          accessory.updateDisplayName(configuredName);
          accessory.getService(this.api.hap.Service.AccessoryInformation)
            .updateCharacteristic(this.api.hap.Characteristic.Name, configuredName);
        }
        accessory.context.device = { ...device, identity };
        new InnovaAccessory(this, accessory, client, state, {
          pollOffsetMs: pollOffsetFor(deviceIndex, devices.length, pollInterval),
        });
        if (nameChanged) {
          this.api.updatePlatformAccessories([accessory]);
        }
        this.log.info(`Connected to ${configuredName} at ${device.host} (type ${state.deviceType})`);
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

function pollOffsetFor(deviceIndex, deviceCount, pollInterval) {
  if (deviceCount <= 1) return 0;
  return Math.floor((pollInterval * deviceIndex) / deviceCount);
}

module.exports = { InnovaPlatform, pollOffsetFor };
