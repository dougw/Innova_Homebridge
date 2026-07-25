# Homebridge Innova Local

A local-network Homebridge platform for Innova `..2.0` air conditioners and
AirLeaf fancoils that expose Innova's `/api/v/1` HTTP interface.

It supports multiple units, power, heating/cooling mode, target and current
temperature, and fan speed. Control stays on the LAN and does not require an
Innova cloud login.

## Compatibility check

Run:

```sh
npm run check
node scripts/discover.js
```

If discovery reports a device with type `001` or `002`, this plugin should work.
You can also test a known IP:

```sh
curl http://192.168.1.50/api/v/1/status
```

If the endpoint does not return JSON containing `"success": true`, the device
may be a newer cloud-only model (including current FÄRNA/M7 hardware), which
requires a different integration.

## Install from this folder

```sh
npm link
```

Then add the following platform in Homebridge UI, replacing the IP addresses:

```json
{
  "platform": "InnovaLocal",
  "name": "Innova Local",
  "devices": [
    {
      "name": "Living Room Fancoil",
      "host": "192.168.1.50"
    }
  ]
}
```

Reserve each device's IP address in the router so it does not change.

Alternatively, update an existing Homebridge configuration from the command
line (a backup is created automatically):

```sh
node scripts/configure-homebridge.js ~/.homebridge/config.json 192.168.1.50 192.168.1.51
```

## Development

```sh
npm test
npm run check
```

This project is independent and is not affiliated with INNOVA S.r.l.
