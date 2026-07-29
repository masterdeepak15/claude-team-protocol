# @masterdeepak15/teamhub-client

The client-only counterpart to
[`@masterdeepak15/teamhub-cli`](https://www.npmjs.com/package/@masterdeepak15/teamhub-cli).
Install this on a Developer's or Tester's machine when it only needs to
**connect to** a TeamHub server running elsewhere — not host one.

No server code, and critically, **no native dependencies** —
`better-sqlite3` (the thing that actually causes Windows build failures —
missing prebuilds, V8 API mismatches on new Node versions, `node-gyp`
requiring Visual Studio Build Tools) never gets installed, since this
package never touches SQLite at all. It only spawns `claude` and talks to
a remote TeamHub over HTTP.

(One honest caveat: `@modelcontextprotocol/sdk` — needed for the `--mode
auto` interrupt watchdog — bundles both client and server transport code,
so it transitively pulls in `express`/`cors` regardless of which parts you
actually import. That's pure JS with no compilation step, so it doesn't
cause the native-module problems above; it's just a bit of unused bundle
weight.)

## Install

```bash
npm install -g @masterdeepak15/teamhub-client
```

## Usage

```bash
# One-time: point at the TeamHub server (checks reachability, saves either way)
teamhub-client connect 172.16.10.32:8787

# Check connectivity anytime
teamhub-client status

# From the project directory you'll be working in:
teamhub-client install --skills --mcp

# Headless session — run FROM the project directory:
teamhub-client agent --role developer --project bts-project --handle dev-A --master-handle master-1
```

See `docs/CLI.md` in the
[claude-team-protocol](https://github.com/masterdeepak15/claude-team-protocol)
repo — the client's commands (`connect`, `status`, `install`, `agent`,
`help`) work the same way as the server package's equivalents, minus
anything related to running the server itself (`start`/`stop`/`upgrade`/
`uninstall`/`--autostart`/`--port`/`--db` — none of that applies here).

## License

MIT — see `LICENSE`.
