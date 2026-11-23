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

async function isUp($: EngineInterface, url: string): Promise<boolean> {
  try {
    const res = await $.http.fetch(`${url}/v1/models`, { method: 'GET' })
    if (res.ok) return true
  } catch {
    // fall through to curl
  }
  try {
    const res = await $.process.run(
      ['curl.exe', '-s', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '3', `${url}/v1/models`],
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
  const home = (await $.env.get('USERPROFILE')) ?? ''
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

// Opens a new PowerShell window running claude. `env` reaches only that window;
// `clear` names variables removed from it first.
async function openClaude(
  $: EngineInterface,
  env: Record<string, string>,
  clear: string[],
  isFresh: boolean,
): Promise<void> {
  const remove = clear.length > 0
    ? `Remove-Item ${clear.map(n => `Env:${n}`).join(',')} -ErrorAction SilentlyContinue; `
    : ''
  // --plugin-dir loads this mod in the new window too: it brings /provider there and the
  // request rewriter below, which a bare `claude` would not have.
  const command = `${remove}claude${isFresh ? '' : ' --continue'} --plugin-dir "${$.plugin.root}"`
  await $.process.run(
    [
      'powershell.exe',
      '-NoProfile',
      '-Command',
      `Start-Process powershell.exe -ArgumentList '-NoExit','-Command','${command}'`,
    ],
    { env, timeoutMs: 20000 },
  )
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
      return {
        text: [
          `Gateway is responding at ${url}. A new window opened with Claude Code on Copilot (default model: Sonnet 5.5).`,
          '/model there lists the Copilot models. You can close this window.',
        ].join('\n'),
      }
    }

    if (target === 'anthropic') {
      await openClaude($, {}, GATEWAY_VARS, isFresh)
      return {
        text: 'A new window opened with Claude Code on Anthropic (gateway variables cleared). You can close this window.',
      }
    }

    if (target === 'stop') {
      const port = LOCAL.exec(DEFAULT_URL)?.[2] ?? '4141'
      // Only a process whose command line names copilot-api is ended, never an unrelated listener.
      const res = await $.process.run(
        [
          'powershell.exe',
          '-NoProfile',
          '-Command',
          `$n=0; Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"; if ($p.CommandLine -match 'copilot-api') { Stop-Process -Id $_.OwningProcess -Force; $n++ } }; Write-Output $n`,
        ],
        { timeoutMs: 20000 },
      )
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
