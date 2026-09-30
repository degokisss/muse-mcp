# muse-mcp

MCP server (stdio) that drives your logged-in Chrome to talk to Muse (muse.ai). Built to be plugged into omp, Claude Code or Codex as a delegation tool.

## Requirements
- Node.js 18+
- Google Chrome installed (Microsoft Edge works with `MUSE_CHANNEL=msedge`)
- A Meta account that can use Muse

## Install
    git clone https://github.com/degokisss/muse-mcp.git && cd muse-mcp
    npm install && npm run build
    npm run login        # opens Chrome, sign in to Meta once, window closes when done

The session is saved in `.muse-profile` (relative to the directory the server is started from).
Clients may start the server from another directory, which would use an empty profile and report
`loggedIn: false`. Set an absolute `MUSE_PROFILE_DIR` in the client config, and use the same value
when running `npm run login`:

    MUSE_PROFILE_DIR=/abs/path/muse-mcp/.muse-profile npm run login

Close the login window's Chrome before starting any client; see the one-instance limit under Status.

## Connect a client
Replace `/abs/path/muse-mcp` with the real path in each snippet.

### omp
Project: `.omp/mcp.json`. All projects: `~/.omp/agent/mcp.json`. Then run `/mcp reload` or restart omp.

    {
      "mcpServers": {
        "muse": {
          "command": "node",
          "args": ["/abs/path/muse-mcp/dist/server.js"],
          "env": {
            "MUSE_HEADLESS": "1",
            "MUSE_PROFILE_DIR": "/abs/path/muse-mcp/.muse-profile"
          }
        }
      }
    }

Tools appear as `mcp__muse_chat`, `mcp__muse_status`, `mcp__muse_read_last`, `mcp__muse_new_chat`,
`mcp__muse_login`, `mcp__muse_close`.

### Claude Code
    claude mcp add muse -e MUSE_HEADLESS=1 -e MUSE_PROFILE_DIR=/abs/path/muse-mcp/.muse-profile -- node /abs/path/muse-mcp/dist/server.js

### Codex (~/.codex/config.toml)
    [mcp_servers.muse]
    command = "node"
    args = ["/abs/path/muse-mcp/dist/server.js"]
    env = { MUSE_HEADLESS = "1", MUSE_PROFILE_DIR = "/abs/path/muse-mcp/.muse-profile" }

## Verify
Ask the client to call `muse_status`. Expected: `loggedIn: true` and `composerReady: true`.
If `loggedIn` is false, re-run `npm run login` with the same `MUSE_PROFILE_DIR`.
Then call `muse_chat` with a short prompt such as "Reply with exactly: pong".

## Tools
muse_status, muse_login, muse_chat, muse_read_last, muse_new_chat, muse_close

## Env
MUSE_PROFILE_DIR, MUSE_CDP (attach to Chrome at e.g. http://127.0.0.1:9222), MUSE_HEADLESS=1,
MUSE_QUIET_MS (default 1200), MUSE_CHAT_TIMEOUT_MS (default 240000), MUSE_CHANNEL (chrome|msedge)

## Status
Tested against a live Muse session (headed and `MUSE_HEADLESS=1`): all tools work
(muse_status, muse_login, muse_chat, muse_read_last, muse_new_chat, muse_close).

A profile dir can be used by only one Chrome instance. Do not run `npm run login`, another
Chrome, or a second MCP client on the same `MUSE_PROFILE_DIR` at once, or launch fails with
"Failed to create a ProcessSingleton". Use a different `MUSE_PROFILE_DIR` or `MUSE_CDP` for that.

If Muse changes its UI, update the selectors in src/selectors.ts.
