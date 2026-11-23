import type { EngineInterface, Register } from 'claude-code'

import { stripThinking } from './thinking'

// Local copilot-api gateway (https://github.com/caozhiyuan/copilot-api).
const DEFAULT_URL = 'http://localhost:4141'
// Pinned on purpose: `@latest` would run whatever was published last, every time.
// Bump it yourself after reviewing a release.
const PACKAGE = '@jeffreycao/copilot-api@2.9.16'
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1):(\d+)$/
// Model requests Claude Code sends to the gateway; only these are rewritten.
const GATEWAY_MESSAGES = /^https?:\/\/(localhost|127\.0\.0\.1):4141\/v1\/messages(\?|$)/
// The model the Copilot window starts on (the alias resolves to claude-sonnet-5-5).
const DEFAULT_MODEL = 'sonnet'

const GATEWAY_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'DISABLE_NON_ESSENTIAL_MODEL_CALLS',
  'ANTHROPIC_MODEL',
]

const HELP = [
  'Usage:',
  '  /provider                       show the current provider',
  '  /provider copilot [--new]        open a new window on the gateway already running at the default port (errors if none)',
  '  /provider copilot local [--new]  same, but start the gateway here first if it is not running',
  '  /provider anthropic [--new]     open a new window on Anthropic',
  '  /provider stop                  stop the Copilot gateway',
  '',
  'The new window runs `claude --continue` (last conversation here); --new starts fresh.',
  'Nothing is saved: your settings.json and shell environment are never changed.',
  'First time only, run once in a terminal: npx ' + PACKAGE + ' auth login',
].join('\n')

type Platform = 'windows' | 'macos' | 'linux'

// WSL counts as Linux: its terminal launchers are the Linux ones.
async function getPlatform($: EngineInterface): Promise<Platform> {
  const { platform } = await $.session.info()
  if (platform === 'windows') return 'windows'
  if (platform === 'macos') return 'macos'
  return 'linux'
}

async function homeDir($: EngineInterface, platform: Platform): Promise<string> {
  return (await $.env.get(platform === 'windows' ? 'USERPROFILE' : 'HOME')) ?? ''
}

// POSIX single-quote escaping, for values written into a shell script.
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function isUp($: EngineInterface, url: string): Promise<boolean> {
  try {
    const res = await $.http.fetch(`${url}/v1/models`, { method: 'GET' })
    if (res.ok) return true
  } catch {
    // fall through to curl
  }
  try {
    const windows = (await getPlatform($)) === 'windows'
    const res = await $.process.run(
      [
        windows ? 'curl.exe' : 'curl',
        '-s',
        '-o',
        windows ? 'NUL' : '/dev/null',
        '-w',
        '%{http_code}',
        '--max-time',
        '3',
        `${url}/v1/models`,
      ],
      { timeoutMs: 8000 },
    )
    return res.stdout.trim() === '200'
  } catch {
    return false
  }
}

async function waitUp($: EngineInterface, url: string, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (await isUp($, url)) return true
    await $.clock.sleep(1000)
  }
  return false
}

// Starts the gateway detached from this session; its output goes to gateway.log.
async function startGateway($: EngineInterface, port: string): Promise<string> {
  const platform = await getPlatform($)
  const home = await homeDir($, platform)
  if (platform === 'windows') {
    const log = `${home}\\.claude\\provider-switch\\gateway.log`
    await $.fs.write(log, '')
    await $.process.run(
      [
        'powershell.exe',
        '-NoProfile',
        '-Command',
        `Start-Process cmd.exe -WindowStyle Hidden -ArgumentList '/c','npx -y ${PACKAGE} start --port ${port} > "${log}" 2>&1'`,
      ],
      { timeoutMs: 20000 },
    )
    return log
  }
  const log = `${home}/.claude/provider-switch/gateway.log`
  await $.fs.write(log, '')
  await $.process.run(
    ['sh', '-c', `nohup npx -y ${PACKAGE} start --port ${port} > ${shq(log)} 2>&1 < /dev/null &`],
    { timeoutMs: 20000 },
  )
  return log
}

// Opens a new window running claude, in the OS's own terminal. `env` reaches only that
// window; `clear` names variables removed from it first.
async function openClaude(
  $: EngineInterface,
  env: Record<string, string>,
  clear: string[],
  isFresh: boolean,
): Promise<void> {
  const platform = await getPlatform($)
  const flags = `${isFresh ? '' : ' --continue'}`

  if (platform === 'windows') {
    // Start-Process uses the default terminal app set in Windows (Terminal, or the classic console).
    const remove = clear.length > 0
      ? `Remove-Item ${clear.map(n => `Env:${n}`).join(',')} -ErrorAction SilentlyContinue; `
      : ''
    // --plugin-dir loads this mod in the new window too: it brings /provider there and the
    // request rewriter below, which a bare `claude` would not have.
    const command = `${remove}claude${flags} --plugin-dir "${$.plugin.root}"`
    await $.process.run(
      [
        'powershell.exe',
        '-NoProfile',
        '-Command',
        `Start-Process powershell.exe -ArgumentList '-NoExit','-Command','${command}'`,
      ],
      { env, timeoutMs: 20000 },
    )
    return
  }

  // macOS / Linux: a terminal emulator may be a long-lived server (or, on macOS, launched by
  // launchd) that does not inherit this process's environment, so the variables, PATH and the
  // command go into a small launcher script that the terminal runs.
  const dir = `${await homeDir($, platform)}/.claude/provider-switch`
  const script = platform === 'macos' ? `${dir}/launch.command` : `${dir}/launch.sh`
  const path = await $.env.get('PATH')
  const lines = [
    '#!/bin/sh',
    ...(path ? [`export PATH=${shq(path)}:"$PATH"`] : []),
    ...Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`),
    ...clear.map(n => `unset ${n}`),
    `claude${flags} --plugin-dir ${shq($.plugin.root)}`,
    // Keep the window open once claude exits, like -NoExit on Windows.
    'exec "${SHELL:-sh}"',
    '',
  ]
  await $.fs.write(script, lines.join('\n'))
  await $.process.run(['chmod', '700', script], { timeoutMs: 5000 })

  if (platform === 'macos') {
    // `open` hands the .command file to the app the user set for it (Terminal by default,
    // or iTerm2 and others when they are the registered handler).
    await $.process.run(['open', script], { timeoutMs: 20000 })
    return
  }

  // Linux: the desktop's default terminal first (xdg-terminal-exec, then Debian's
  // x-terminal-emulator alternative), then the common emulators. Detached so it
  // does not block this call.
  const res = await $.process.run(
    [
      'sh',
      '-c',
      [
        'S="$1"',
        'for t in xdg-terminal-exec x-terminal-emulator gnome-terminal konsole xfce4-terminal kitty alacritty wezterm xterm; do',
        '  command -v "$t" >/dev/null 2>&1 || continue',
        '  case "$t" in',
        '    xdg-terminal-exec) set -- "$t" sh "$S" ;;',
        '    gnome-terminal) set -- "$t" -- sh "$S" ;;',
        '    xfce4-terminal) set -- "$t" -x sh "$S" ;;',
        '    wezterm) set -- "$t" start -- sh "$S" ;;',
        '    *) set -- "$t" -e sh "$S" ;;',
        '  esac',
        '  nohup "$@" >/dev/null 2>&1 < /dev/null &',
        '  echo "$t"; exit 0',
        'done',
        'exit 1',
      ].join('\n'),
      'sh',
      script,
    ],
    { timeoutMs: 20000 },
  )
  if (res.exitCode !== 0) {
    throw new Error(`No terminal emulator found. Run this yourself in a terminal: sh ${script}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'provider',
      description: 'Open Claude Code on Anthropic or on the local Copilot gateway',
    })

    const base = await $.env.get('ANTHROPIC_BASE_URL')
    $.ui.status(base !== undefined && LOCAL.test(base.replace(/\/+$/, '')) ? 'provider: copilot gateway' : undefined)

    return next(e)
  })

  // Translation layer: Claude Code's requests to the gateway lose the thinking blocks of earlier
  // turns, so a conversation can move between models without a 400 (see thinking.ts).
  on('http.fetch', ($, e, next) => {
    const init = e.init
    if (
      next.origin.plugin !== 'engine' ||
      init === undefined ||
      init.method?.toUpperCase() !== 'POST' ||
      typeof init.body !== 'string' ||
      !GATEWAY_MESSAGES.test(e.url)
    ) {
      return next(e)
    }
    const body = stripThinking(init.body)
    return body === undefined ? next(e) : next({ ...e, init: { ...init, body } })
  })

  on('command.run', { command: 'provider' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    const target = (args[0] ?? 'status').toLowerCase()
    const isFresh = args.includes('--new')

    if (target === 'status') {
      const base = await $.env.get('ANTHROPIC_BASE_URL')
      const up = await isUp($, DEFAULT_URL)
      return {
        text: [
          base ? `This session: custom endpoint ${base}` : 'This session: Anthropic (no ANTHROPIC_BASE_URL override)',
          `Copilot gateway at ${DEFAULT_URL}: ${up ? 'running' : 'not running'}`,
          '',
          HELP,
        ].join('\n'),
      }
    }

    if (target === 'copilot') {
      const url = DEFAULT_URL
      const isLocal = args.slice(1).includes('local')
      const port = LOCAL.exec(url)?.[2] ?? '4141'

      if (!(await isUp($, url))) {
        // Default: use an instance that is already running, or stop here.
        if (!isLocal) {
          return {
            text: [
              `No Copilot gateway is responding at ${url}. No window was opened.`,
              'Start it yourself (npx ' + PACKAGE + ' start), or run `/provider copilot local` to have me start it here.',
            ].join('\n'),
          }
        }
        const log = await startGateway($, port)
        if (!(await waitUp($, url, 40))) {
          let out = ''
          try {
            const text = await $.fs.read(log)
            out = typeof text === 'string' ? text.trim().split('\n').slice(-8).join('\n') : ''
          } catch {
            // no log
          }
          return {
            text: [
              `Could not start the gateway on ${url}. No window was opened.`,
              'Not logged in yet? Run once in a terminal: npx ' + PACKAGE + ' auth login',
              out ? `\nLast output:\n${out}` : '',
            ].join('\n'),
          }
        }
      }

      try {
        await openClaude(
          $,
          {
            ANTHROPIC_BASE_URL: url,
            // "dummy" is the gateway's documented placeholder key, not a credential.
            ANTHROPIC_AUTH_TOKEN: 'dummy',
            CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
            CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
            DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
            ANTHROPIC_MODEL: DEFAULT_MODEL,
          },
          [],
          isFresh,
        )
      } catch (err) {
        return { text: `Could not open a terminal window: ${err instanceof Error ? err.message : String(err)}` }
      }
      return {
        text: [
          `Gateway is responding at ${url}. A new window opened with Claude Code on Copilot (default model: Sonnet 5.5).`,
          '/model there lists the Copilot models. You can close this window.',
        ].join('\n'),
      }
    }

    if (target === 'anthropic') {
      try {
        await openClaude($, {}, GATEWAY_VARS, isFresh)
      } catch (err) {
        return { text: `Could not open a terminal window: ${err instanceof Error ? err.message : String(err)}` }
      }
      return {
        text: 'A new window opened with Claude Code on Anthropic (gateway variables cleared). You can close this window.',
      }
    }

    if (target === 'stop') {
      const port = LOCAL.exec(DEFAULT_URL)?.[2] ?? '4141'
      // Only a process whose command line names copilot-api is ended, never an unrelated listener.
      const argv = (await getPlatform($)) === 'windows'
        ? [
            'powershell.exe',
            '-NoProfile',
            '-Command',
            `$n=0; Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"; if ($p.CommandLine -match 'copilot-api') { Stop-Process -Id $_.OwningProcess -Force; $n++ } }; Write-Output $n`,
          ]
        : [
            'sh',
            '-c',
            [
              'n=0',
              `pids=$(lsof -nti tcp:${port} -sTCP:LISTEN 2>/dev/null || ss -ltnpH "sport = :${port}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2)`,
              'for pid in $pids; do',
              '  if ps -p "$pid" -o args= 2>/dev/null | grep -q copilot-api; then kill "$pid" && n=$((n+1)); fi',
              'done',
              'echo $n',
            ].join('\n'),
          ]
      const res = await $.process.run(argv, { timeoutMs: 20000 })
      return {
        text:
          res.stdout.trim() === '0'
            ? `No copilot-api gateway is listening on port ${port}.`
            : `Gateway on port ${port} stopped. Sessions running on it will fail until it is started again.`,
      }
    }

    return { text: `Unknown option "${target}".\n\n${HELP}` }
  })
}
