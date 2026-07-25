# Homebridge Innova Local

A local-network Homebridge platform for Innova `..2.0` air conditioners and
AirLeaf fancoils that expose Innova's `/api/v/1` HTTP interface.

It supports multiple units, power, heating/cooling mode, target and current
temperature, and fan speed. Control stays on the LAN and does not require an
Innova cloud login.

For AirLeaf units, Apple Home's fan-speed slider is limited to three positions:
`0%` selects **Auto**, `50%` selects **1 (slow)**, and `100%` selects
**2 (fast)**. Apple Home always labels this standard HomeKit control as a
percentage; HomeKit does not support custom labels for its slider positions.

Status is polled in the background and cached, so HomeKit reads return
immediately even if a fancoil briefly drops off Wi-Fi. Local requests are
retried automatically.

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

On a server with more than one active network interface, bind Homebridge to
the stable wired interface and use the `ciao` mDNS advertiser:

```sh
node scripts/harden-homebridge.js ~/.homebridge/config.json en0
```

Restart Homebridge after changing its network configuration.

For an always-on macOS Homebridge server, disable automatic system sleep while
allowing the display to sleep:

```sh
sudo pmset -a sleep 0 autorestart 1 womp 1
```

This does not prevent the display from turning off.

## Development

```sh
npm test
npm run check
```

This project is independent and is not affiliated with INNOVA S.r.l.
