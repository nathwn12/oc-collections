<h1 align="center">oc-phone-link</h1>

<p align="center"><strong>Drive OpenCode from an Android phone on the same Wi-Fi: in-server beacon, pinned TLS, one PIN, no tray, no QR.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/oc-phone-link"><img src="https://img.shields.io/npm/v/oc-phone-link" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-windows--linux-2b3137" alt="platform">
  <a href="https://github.com/nathwn12/oc-collections/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

## Install

Add the plugin to `~/.config/opencode/opencode.jsonc` and restart OpenCode:

```json
{ "plugins": ["oc-phone-link"] }
```

The plugin starts the beacon during setup and stops it when the session disposes. There is no tray app, no separate service and no QR code: the beacon is a keyed reverse proxy in front of the OpenCode server your PC already runs.

## Pair a phone

1. Open `https://localhost:41338` on the PC. That page is the beacon's own control panel.
2. Set an 8-digit PIN there. The phone enters it once, and only after the fingerprint check below.
3. Open the phone app. It finds the beacon over UDP port 41337 on the local network and shows a short TLS fingerprint.
4. Compare that short fingerprint with the Verify line on the PC page, then enter the PIN.
5. The phone receives a device key: valid for 90 days, rotated after 45, and one of at most 16 keys the beacon will hold.

The PC page also lists paired devices with issue date, last use and last IP, and can revoke one device, revoke all of them, or reset the PIN.

## Use it

Once paired, the phone sends its requests to the beacon on port 41340, which checks the device key and forwards to OpenCode on its own port (28894 by default). The beacon also keeps a loopback port on 41339 for the PC itself and an exposed port on 41341 for setup actions, which it refuses when the request did not come from the local machine.

The phone drives the same server session the PC does. Nothing is uploaded anywhere: discovery, pairing and proxying all stay on your network.

## Security

- **PIN**: exactly 8 digits, stretched with PBKDF2-SHA256 at 600,000 iterations and stored salted and hashed. Only the owner's own networks may claim the first PIN.
- **TLS**: a self-signed certificate is generated on first start and pinned by the phone on first use. The PC page prints the full fingerprint and a short form for comparison.
- **Keys**: per-device, tagged with the device that minted them. A targeted revoke fails closed and drops only that device's keys; revoke all drops every key.
- **Lockout**: five failed PIN attempts from one address in ten minutes locks that address out for ten minutes.
- **Limits**: ten requests per minute per address, request bodies capped at 4 KB, upstream calls time out after five seconds.
- **Local only**: no telemetry, no cloud relay, no analytics.

## Configuration

The beacon reads these environment variables and nothing else:

- `OC_PHONE_LINK_PORT_BASE` - shift the fixed port block (41337 to 41341) by an offset, for when a port is taken.
- `OC_PHONE_LINK_BIND_HOST` - address to bind, default all interfaces.
- `OC_PHONE_LINK_DATA_DIR` - where state, TLS material and the agent log live.
- `OC_PHONE_LINK_NO_UDP` - set to 1 to disable UDP discovery and pair by address instead.
- `OC_PHONE_LINK_PASSWORD` (or `OPENCODE_SERVER_PASSWORD`) - upstream password the proxy presents when OpenCode asks for one.
- `OC_PHONE_LINK_UPSTREAM` - upstream port override when OpenCode is not on 28894.
- `OC_PHONE_LINK_TRANSPORT` - set to `tunnel` to use the tunnel transport instead of the local network.

## Development

```text
node --test packages/oc-phone-link/beacon.test.mjs
node packages/oc-phone-link/probe-bench.mjs
```

The test file covers PIN derivation, key revoke and rotation, discovery and the proxy gate. The bench script measures UDP discovery and the first proxied response on loopback through the public startBeacon seam.

## Requirements

- OpenCode V2.
- Node 22 or newer.
- An Android phone on the same Wi-Fi, or the tunnel transport.

## Status

**Unverified** - as-is, use at your own risk.

## Links

- [Issues](https://github.com/nathwn12/oc-collections/issues)
- [Releases](https://github.com/nathwn12/oc-collections/releases)
- [Package source](https://github.com/nathwn12/oc-collections/tree/main/packages/oc-phone-link)
- [MIT licence](https://github.com/nathwn12/oc-collections/blob/main/LICENSE)
