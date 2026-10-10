'use strict';

const { DEFAULT_TIMEOUT_MS } = require('./settings');

const MODE = Object.freeze({
  TWO_HEATING: 0,
  TWO_COOLING: 1,
  TWO_DEHUMIDIFICATION: 3,
  TWO_FAN_ONLY: 4,
  TWO_AUTO: 5,
  AIRLEAF_HEATING: 3,
  AIRLEAF_COOLING: 5,
});

class InnovaClient {
  constructor(host, options = {}) {
    this.host = host;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? 2;
    this.commandRetries = options.commandRetries ?? this.retries;
    this.log = options.log;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.deviceType = options.deviceType;
    this.requestTail = Promise.resolve();
  }

  get baseUrl() {
    return `http://${this.host}/api/v/1`;
  }

  request(path, options = {}) {
    const operation = this.requestTail.then(() => this.performRequest(path, options));
    this.requestTail = operation.catch(() => undefined);
    return operation;
  }

  async performRequest(path, options = {}) {
    const url = `${this.baseUrl}/${path.replace(/^\//, '')}`;
    const retries = options.retries ?? this.retries;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.log?.debug?.(`${options.method ?? 'GET'} ${url}${attempt ? ` (retry ${attempt})` : ''}`);
        const response = await this.fetch(url, {
          method: options.method ?? 'GET',
          headers: options.body ? { 'content-type': 'application/json' } : undefined,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} from ${url}`);
        }
        const payload = await response.json();
        if (payload.success !== true) {
          throw new Error(`Innova rejected ${path}`);
        }
        return payload;
      } catch (error) {
        lastError = error.name === 'AbortError'
          ? new Error(`Timed out contacting Innova at ${this.host}`)
          : error;
        if (attempt < retries) {
          await delay(200 * (attempt + 1));
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError;
  }

  async status(options = {}) {
    const payload = await this.request('status', options);
    this.deviceType = String(payload.deviceType ?? this.deviceType ?? '');
    return normalizeStatus(payload);
  }

  command(path, body) {
    return this.request(path, {
      method: 'POST',
      body,
      retries: this.commandRetries,
    });
  }

  setPower(on) {
    return this.command(`power/${on ? 'on' : 'off'}`);
  }

  setMode(mode) {
    if (!['heating', 'cooling', 'auto'].includes(mode)) {
      throw new Error(`Unsupported Innova mode: ${mode}`);
    }
    if (this.deviceType === '002' && mode === 'auto') {
      throw new Error('AirLeaf does not expose an automatic heat/cool mode');
    }
    return this.command(`set/mode/${mode}`);
  }

  setTemperature(celsius) {
    const body = this.deviceType === '002'
      ? { temp: Math.round(celsius * 10) }
      : { p_temp: celsius };
    return this.command('set/setpoint', body);
  }

  normalizeFanPercent(percent) {
    if (this.deviceType !== '002') {
      return Math.max(0, Math.min(100, Number(percent)));
    }
    return snapAirLeafFanPercent(percent);
  }

  setFan(percent) {
    if (this.deviceType === '002') {
      const fanPercent = snapAirLeafFanPercent(percent);
      const fn = fanPercent === 0 ? 'auto' : fanPercent === 50 ? 'min' : 'max';
      return this.command(`set/function/${fn}`, { value: 1 });
    }
    const speed = percent <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(percent / 25)));
    return this.command('set/fan', { value: speed });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function snapAirLeafFanPercent(percent) {
  const value = Math.max(0, Math.min(100, Number(percent)));
  if (value < 25) return 0;
  if (value < 75) return 50;
  return 100;
}

function normalizeStatus(payload) {
  const result = payload.RESULT ?? {};
  const airLeaf = String(payload.deviceType) === '002';
  const divisor = airLeaf ? 10 : 1;
  const currentTemperature = Number(airLeaf ? result.ta : result.t) / divisor;
  const targetTemperature = Number(result.sp) / divisor;
  const mode = airLeaf
    ? result.wm === MODE.AIRLEAF_COOLING ? 'cooling' : 'heating'
    : ({
        [MODE.TWO_HEATING]: 'heating',
        [MODE.TWO_COOLING]: 'cooling',
        [MODE.TWO_DEHUMIDIFICATION]: 'dehumidification',
        [MODE.TWO_FAN_ONLY]: 'fan',
        [MODE.TWO_AUTO]: 'auto',
      })[result.wm] ?? 'unknown';
  const fanPercent = airLeaf
    ? ({ 1: 0, 2: 50, 3: 50, 4: 100 })[result.fn] ?? 0
    : Math.max(0, Math.min(100, Number(result.fs ?? 0) * 25));

  if (!Number.isFinite(currentTemperature) || !Number.isFinite(targetTemperature)) {
    throw new Error('Innova returned an invalid temperature');
  }

  return {
    active: result.ps === 1,
    currentTemperature,
    targetTemperature,
    mode,
    fanPercent,
    deviceType: String(payload.deviceType ?? ''),
    uid: payload.UID,
    name: payload.setup?.name,
    serial: payload.setup?.serial,
    firmware: payload.sw?.V,
    raw: payload,
  };
}

module.exports = { InnovaClient, normalizeStatus, snapAirLeafFanPercent };
