# claude-provider-switch

A Claude Code mod that adds a `/provider` command to switch Claude Code between **Anthropic** and a
local **GitHub Copilot gateway** ([caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api)).

Nothing is persisted: `settings.json` and your shell environment are never touched. The gateway
variables are handed only to the new Claude Code window the command opens.

## Commands

| Command | What it does |
| --- | --- |
| `/provider` | Shows the current provider and whether the gateway answers at `http://localhost:4141`. |
| `/provider copilot [--new]` | Checks that the gateway **already running** at the default port answers `/v1/models`. If it does, opens a new window on Copilot (default model: Sonnet 5.5). If not, it stops with an error and opens nothing. |
| `/provider copilot local [--new]` | Same, but starts the gateway first when nothing is running (pinned version, detached, log in `~/.claude/provider-switch/gateway.log`). |
| `/provider anthropic [--new]` | Opens a new window on Anthropic (gateway variables cleared). |
| `/provider stop` | Stops the gateway listening on port 4141, only if its command line names `copilot-api`. |

The new window runs `claude --continue` (the last conversation in the current folder); `--new` starts
fresh. `/model` in the Copilot window lists the gateway's models.

## Why a new window

Claude Code reads `ANTHROPIC_BASE_URL` and fetches the gateway model list at startup, so changing
environment variables inside a running session does not change the model picker. A mod also cannot
restart the CLI or take over its terminal, and Claude Code refuses plugin writes to `settings.json`.
Opening a new window with the right environment is what a mod can do.

## Setup

1. Sign in to Copilot once: `npx @jeffreycao/copilot-api@2.9.16 auth login`
2. Load the mod: `claude --plugin-dir D:\Repos\claude-provider-switch`
3. Run `/provider copilot` (gateway already running) or `/provider copilot local`.

The gateway version is pinned in `hooks/register.ts` (`PACKAGE`). Bump it deliberately, after reading
the release, rather than running `@latest`.

## Request rewriter

While Claude Code talks to the gateway, `hooks/thinking.ts` removes the `thinking` blocks of earlier
assistant turns from each `/v1/messages` request. Those blocks carry a signature only the model that
wrote them can verify.

Measured against the gateway, replaying a Gemini tool turn on each Claude model returned
`400 Invalid signature in thinking block`; with the blocks removed, a tool turn from any model was
accepted by every model (91 of 92 combinations; the one failure was a transient upstream error).
Through the real CLI (a Gemini tool turn continued with `--continue` on Sonnet 5.5) the 400 did **not**
reproduce, so treat this layer as a precaution rather than a proven requirement.

## Known limits

- Default port only (`4141`); the reachability check cannot tell copilot-api from another service, nor
  whether you are signed in to Copilot.
- Which models work depends on your Copilot plan and policy. The gateway occasionally returns
  `500 fetch failed` for a model (upstream connection), which is intermittent.
- Windows only (PowerShell / `cmd.exe`).
- No `LICENSE` yet: choose one before publishing.
