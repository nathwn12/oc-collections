<p align="center">
  <img src="assets/icon.svg" width="120" height="120" alt="puppet icon" />
</p>

# puppet

Screenshots, lists, and drives Windows windows for agents over MCP stdio. Background-safe by default: no stolen focus, pointer, or keyboard.

## Install

Needs Windows 10/11 x64 with Node 22.14 or newer. Add the server to the OpenCode config, then save; OpenCode reloads config on save, no restart:

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

Confirm the launcher and its pin:

```powershell
npx -y puppet-mcp@latest --doctor
```

The first real call provisions the pinned server binary from the tagged GitHub Release, sha256-verified before and after extraction.

## Usage

Ask the agent to list the visible windows. Expected output: one entry per window with `hwnd`, `pid`, `exe`, `title`, and rects.

The server runs at its own integrity level. Input aimed at an elevated window is refused with a typed error instead of failing silently.

## Configuration

Every tool, option, and environment variable: [docs/GUIDE.md](docs/GUIDE.md).

## Development

```sh
cargo check --locked
cargo test --locked
```

`cargo fmt --all --check` and `cargo clippy --all-targets --locked -- -D warnings` are the static gate.

## License

MIT — see [LICENSE](LICENSE).
