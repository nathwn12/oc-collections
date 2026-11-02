# puppet

A native-Rust MCP server over stdio that screenshots, lists and drives Windows windows — background-safe by default, so your agent works without stealing your focus, your pointer or your keyboard.

## Install

Add the server to your OpenCode config — `~/.config/opencode/opencode.jsonc` for every project, or `./opencode.jsonc` for this one — and save; OpenCode reloads config on save, no restart:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "puppet": {
        "type": "local",
        "command": ["cmd", "/c", "npx", "-y", "puppet-mcp@latest"]
      }
    }
  }
}
```

Then confirm the launcher and its pin — prints the manifest and the resolved engine cache path, downloads and provisions nothing:

```powershell
npx -y puppet-mcp@latest --doctor
```

The first real call provisions the pinned server binary from the tagged GitHub Release, sha256-verified before and after extraction.

## What it does

- `screenshot`: whole desktop, one monitor, a region, or one window without activating it, plus the map from image pixels back to screen pixels. A window that moves mid-capture is flagged; a window whose UI thread stops answering returns the typed `capture_timeout` inside 10 s.
- `list_windows`: every visible top-level window with `hwnd`, `pid`, `exe`, `title`, rects, DPI and elevation. Pass `include_app_ids:true` to add each window's AppUserModelID.
- `window`: focus, move, resize, minimize, maximize, restore, close or topmost by selector; every verb except an explicit `focus` is no-steal.
- `do`: one ordered batch of up to 256 actions / 300 s against one locked target - click, drag, scroll, type, keys, waits, UIA `invoke`/`set_value`, clipboard. One burst reports a call-level `ok`/`failed` verdict; over either budget returns `burst_budget_exceeded`; a UIA call past 5 s fails that action with `uia_timeout`.
- `cursor`: read-only cursor position plus monitor rectangles.
- `elements`: read-only UIA control tree with stable `ref`/`fp` identities, paging and an `offscreen` flag. The walk is bounded at 5 s; a provider that stops answering returns `uia_timeout` and the Win32 fallback still fills the page.

Every acting call takes one `target` selector and locks exactly one window; there is no fallback to the foreground window, ever.

## Requirements

Windows 10/11 x64 with Node 22.14 or newer — the server runs at your own integrity level, so input aimed at an elevated window is refused with a typed error rather than failing silently, and nothing takes focus, raises a window or moves your pointer unless a call explicitly passes `allow_foreground` / `allow_cursor`.

The manual — provisioning model, every option and environment variable, every tool and argument, the `do` burst, troubleshooting and limitations: [docs/GUIDE.md](docs/GUIDE.md).

## Development

```sh
cargo check --locked
cargo test --locked
```

`cargo fmt --all --check` and `cargo clippy --all-targets --locked -- -D warnings` are the static gate.

## License

MIT. See [LICENSE](LICENSE).
