# muse-mcp

MCP server (stdio) that drives your logged-in Chrome to talk to Muse (muse.ai). Built to be plugged into omp, Claude Code or Codex as a delegation tool.

## Requirements
- Node.js 18+
- Google Chrome installed (Microsoft Edge works with `MUSE_CHANNEL=msedge`)
- A Meta account that can use Muse

## Install
No clone needed. Sign in once (opens Chrome, close it or wait for it to close by itself):

    npx -y @santaclone/muse-mcp --login

The Meta session is saved in `~/.muse-mcp/profile` (override with `MUSE_PROFILE_DIR`). Use the same
`MUSE_PROFILE_DIR` for login and for the client. Close the login Chrome before starting a client;
see the one-instance limit under Status.

From source instead: `git clone https://github.com/degokisss/muse-mcp.git && cd muse-mcp &&
npm install && npm run build && npm run login`, and use `node /abs/path/muse-mcp/dist/server.js`
in place of `npx -y @santaclone/muse-mcp` below.

## Connect a client
### omp
Project: `.omp/mcp.json`. All projects: `~/.omp/agent/mcp.json`. Then run `/mcp reload` or restart omp.

    {
      "mcpServers": {
        "muse": {
          "command": "npx",
          "args": ["-y", "@santaclone/muse-mcp"],
          "env": { "MUSE_HEADLESS": "1" }
        }
      }
    }

Tools appear as `mcp__muse_chat`, `mcp__muse_status`, `mcp__muse_read_last`, `mcp__muse_new_chat`,
`mcp__muse_login`, `mcp__muse_close`.

### Claude Code
    claude mcp add muse -e MUSE_HEADLESS=1 -- npx -y @santaclone/muse-mcp

### Codex (~/.codex/config.toml)
    [mcp_servers.muse]
    command = "npx"
    args = ["-y", "@santaclone/muse-mcp"]
    env = { MUSE_HEADLESS = "1" }

## Verify
Ask the client to call `muse_status`. Expected: `loggedIn: true` and `composerReady: true`.
If `loggedIn` is false, re-run the login command with the same `MUSE_PROFILE_DIR`.
Then call `muse_chat` with a short prompt such as "Reply with exactly: pong".

## Tools
muse_status, muse_login, muse_chat, muse_read_last, muse_new_chat, muse_close

Muse is a single persistent thread: `muse_new_chat` and `new_thread` only reload the home page and do
not clear history.

### Images and video
Ask `muse_chat` for media (e.g. "Generate an image of ...", "Generate a 5 second video of ...") with
`text_only: false`; the default `text_only: true` tells Muse not to use tools. `reply` holds all text
Muse wrote for that turn.

- Images come back as MCP `image` content (base64, usually `image/webp`) after the JSON text result,
  which reports `imageCount`. A video bubble may also yield a poster image.
- Videos are too large to send inline (about 2 MB for 5 s at 720p). They are written to
  `MUSE_OUTPUT_DIR` (default: `muse-mcp` under the OS temp dir) and listed in `videos` as
  `{ path, mimeType, bytes }`. Move or copy files you want to keep; the temp dir is not permanent.
- Media that cannot be read out of the page is listed in `warnings`.

`muse_read_last` returns text only.

## Env
MUSE_PROFILE_DIR (default ~/.muse-mcp/profile), MUSE_CDP (attach to Chrome at e.g. http://127.0.0.1:9222), MUSE_HEADLESS=1,
MUSE_QUIET_MS (default 1200), MUSE_CHAT_TIMEOUT_MS (default 240000), MUSE_CHANNEL (chrome|msedge),
MUSE_OUTPUT_DIR (where generated videos are saved)

## Status
Tested against a live Muse session (headed and `MUSE_HEADLESS=1`): all tools work
(muse_status, muse_login, muse_chat, muse_read_last, muse_new_chat, muse_close).

A profile dir can be used by only one Chrome instance. Do not run `npm run login`, another
Chrome, or a second MCP client on the same `MUSE_PROFILE_DIR` at once, or launch fails with
"Failed to create a ProcessSingleton". Use a different `MUSE_PROFILE_DIR` or `MUSE_CDP` for that.

If Muse changes its UI, update the selectors in src/selectors.ts.
