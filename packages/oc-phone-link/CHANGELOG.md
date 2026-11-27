# Changelog — server plugin

This file records the beacon's server-side changes. APK and app release notes
live in `../../CHANGELOG.md`; the `version` fields in `whitelist.json` are APK
release digests, not the server version.

## [Unreleased]

- The V2 plugin context has no `port` or `server` members. `portFrom` now reads `ctx.options.upstreamPort` first, then `OC_PHONE_LINK_UPSTREAM`, and leaves the port unconfigured when neither is present.
- Unconfigured port discovery (self-inspection, service status, hardcoded 28894) is labeled `fallback:*` in the log, `/info` (`portSource`) and `/health`. The README names the option, the env override and the fallback policy.

## 2.0.11

- A targeted `revoke(id)` fails closed. Keys with no device association,
  including pre-2.0.10 bare hash strings, are dropped with the revoked device;
  a tagged key for another device is kept. Trade-off: revoking one device also
  invalidates pre-2.0.10 keys on other devices, which re-enter the PIN once and
  get a tagged key in return.
- Rotation never mints an unassociated key. An associated key rotates into a
  replacement that keeps its device tag; a legacy untagged key stays valid but
  is not re-minted.
- `beacon.test.mjs` adds the legacy-key revoke and rotation regression checks.
  The earlier single-device revoke test now asserts the fail-closed result.

Proof: `node --test test/*.mjs plugin/oc-phone-link/beacon.test.mjs` EXIT 0 —
41 tests, 41 pass, 0 fail. Local test candidate only; nothing was pushed.

## 2.0.10

- Per-device revoke now drops that device's keys as well as its device row.
  Keys record the issuing device id at mint, including on rotation, and
  `revoke(id)` deletes only those keys. Revoke All still drops every key.
- The key cookie gets a fresh 90-day `Expires` from the server clock on each
  use, so a key used at day 80 still has a live cookie at day 91. `Max-Age`
  stays at 90 days. The phone sends its device id with the PIN so minted keys
  carry the association.

## 2.0.9

The canonical app repo now carries the server lens work as well as the app work.
`beacon.mjs` keeps the app repo's narration purge and gains the harness copy's
server changes in full:

- Device keys are persistent credentials. Cookies carry `Max-Age` (90 days)
  with `Secure`, `HttpOnly` and `SameSite=Strict`, and are renewed on use. A
  stored key keeps working across a fresh browser session. Revoked keys still
  return `401 pin`.
- Keys record `issued` and `lastUsed`. A key expires after 90 days idle and
  rotates at 45 days of age on next use. Rotation mints a new key into the
  browser cookie and keeps the old key valid, so an app holding the old key is
  not broken. Legacy hash-string keys in `state.json` are upgraded on load.
- Proxy requests to a killed or hung upstream now return a JSON `502` within
  one second instead of hanging. `GET /health` still answers `200` and reports
  `upstream: "up" | "down"`.
- The server version has one source: `package.json`. Both `/health` and the
  loopback panel print it.
- The focused lens tests (`beacon.test.mjs`) and the probe benchmark
  (`probe-bench.mjs`) live beside the beacon, so the plugin and its proof move
  together.

No APK change ships with this version from the server side; the phone app keeps
using the same key and header it already has. See `../../CHANGELOG.md` for the
2.0.9 app changes.

## 2.0.8

Server-side reliability and credential persistence. No APK change shipped with
this version; the phone app kept using the same key and header it already had.

- Device keys are now persistent credentials. Cookies carry `Max-Age` (90 days)
  with `Secure`, `HttpOnly` and `SameSite=Strict`, and are renewed on use. A
  stored key keeps working across a fresh browser session. Revoked keys still
  return `401 pin`.
- Keys record `issued` and `lastUsed`. A key expires after 90 days idle and
  rotates at 45 days of age on next use. Rotation mints a new key into the
  browser cookie and keeps the old key valid, so an app holding the old key is
  not broken. Legacy hash-string keys in `state.json` are upgraded on load.
- Proxy requests to a killed or hung upstream now return a JSON `502` within
  one second instead of hanging. `GET /health` still answers `200` and reports
  `upstream: "up" | "down"`.
- The `PROBE -> payload` and first proxied response paths were measured on
  loopback before and after the change. They were already far below the 200 ms
  target, so no hot-path work was removed. Measurement stays in `probe-bench.mjs`.
- The server version now has one source: `package.json`. Both `/health` and the
  loopback panel print it. The `version` fields in `whitelist.json` are APK
  release digests, not the server version, and are unchanged.

The APK signing-certificate and digest check remains log-only. A phone that
pairs from the same Wi-Fi is auto-paired; its digest is recorded in `agent.log`
as `digest-match` or `digest-unlisted`. Turning that check into a hard gate
needs the owner's explicit approval.

## 2.0.7

Previous release. APK whitelist digests recorded in `whitelist.json`.
