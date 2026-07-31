#!/usr/bin/env node
/**
 * IQ test automation via nova-use electron + nco-browser.mjs
 * Boots electron like browser-control-acceptance.mjs, then drives IQ test.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../nova-use')
const cli = join(root, 'bin/nco-browser.mjs')
const port = Number(process.env.NOVA_IQ_CDP_PORT ?? 9272)
const cdpBase = `http://127.0.0.1:${port}`
const logPath = '/tmp/iq-test-browser-run.log'
const IQ_URL = process.env.IQ_TEST_URL || 'https://iq-test.us/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = async (line) => {
  const text = `${line}\n`
  process.stdout.write(text)
  await writeFile(logPath, text, { flag: 'a' })
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`)
  return response.json()
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }
  command(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    }, 60000)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
    return result.result.value
  }
  close() { this.socket.close() }
}

async function connectCdp(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP ws timeout')), 10000)
    socket.once('open', () => { clearTimeout(t); resolve() })
    socket.once('error', (e) => { clearTimeout(t); reject(e) })
  })
  return new Cdp(socket)
}

async function waitForCdpTarget(electronExit) {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (electronExit) throw new Error(`Electron exited: ${electronExit}`)
    try {
      const targets = await fetchJson(`${cdpBase}/json/list`)
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* retry */ }
    await sleep(500)
  }
  throw new Error('CDP not ready')
}

function runCli(args, bridgeUrl, bridgeToken) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: {
        ...process.env,
        NCO_BRIDGE_URL: bridgeUrl,
        NCO_BRIDGE_TOKEN: bridgeToken,
        NCO_BRIDGE_TIMEOUT_MS: '90000',
        NCO_BROWSER_ONLY: '1',
      },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'timeout', stdout, stderr }) }, 120000)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }) })
  })
}

async function readBridgeFromStore() {
  const store = join(process.env.HOME || '/Users/nova-ai', '.nco-cli-ext')
  const url = (await readFile(join(store, 'bridge-url'), 'utf8')).trim()
  const token = (await readFile(join(store, 'bridge-token'), 'utf8')).trim()
  return { url, token }
}

async function waitBridgeFileChanged(beforeUrl, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { url, token } = await readBridgeFromStore()
    if (url && url !== beforeUrl) return { url, token }
    await sleep(500)
  }
  return await readBridgeFromStore()
}

function parseAnalyze(stdout) {
  try {
    const envelope = JSON.parse(stdout)
    const data = envelope?.payload?.data
    if (data) return data
  } catch { /* page file */ }
  return null
}

function pickAnswerSelector(analyzeData) {
  const buttons = analyzeData?.buttons || analyzeData?.fields?.filter((f) => f.type === 'button') || []
  const ctas = analyzeData?.comprehension?.primaryCta
  const startTexts = /start|begin|시작|테스트|test|continue|next|다음/i
  for (const b of buttons) {
    const text = `${b.text || b.label || ''}`
    if (startTexts.test(text) && b.selector) return { kind: 'start', selector: b.selector, text }
  }
  if (ctas?.selector && startTexts.test(ctas.text || '')) return { kind: 'start', selector: ctas.selector, text: ctas.text }
  // answer options - pick first clickable option
  const options = analyzeData?.fields?.filter((f) => f.selector && /radio|button|option|choice/i.test(f.type || '')) || []
  if (options.length) return { kind: 'answer', selector: options[0].selector, text: options[0].label || options[0].text }
  const links = analyzeData?.links || []
  for (const l of links.slice(0, 8)) {
    if (l.selector) return { kind: 'answer', selector: l.selector, text: l.text }
  }
  return null
}

async function main() {
  await writeFile(logPath, '')
  const beforeBridge = await readBridgeFromStore()
  log(`=== IQ Test Automation ===`)
  log(`Target: ${IQ_URL}`)

  const userDataDir = await mkdtemp(join(tmpdir(), 'nova-iq-test-'))
  const electronExecutable = process.env.NOVA_ACCEPTANCE_EXECUTABLE
    ? resolve(process.env.NOVA_ACCEPTANCE_EXECUTABLE)
    : require('electron')
  const electronArgs = [
    ...(process.env.NOVA_ACCEPTANCE_EXECUTABLE ? [] : ['.']),
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
  ]
  let electronExit = null
  const electron = spawn(electronExecutable, electronArgs, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NOVA_VAULT_AUTOINDEX: '0' },
  })
  electron.stdout.on('data', (c) => process.stderr.write(c))
  electron.stderr.on('data', (c) => process.stderr.write(c))
  electron.on('exit', (code, signal) => { electronExit = `code=${code} signal=${signal}` })

  try {
    const target = await waitForCdpTarget(() => electronExit)
    const cdp = await connectCdp(target)
    await sleep(2000)
    const bridge = await waitBridgeFileChanged(beforeBridge.url, 90000)
    log(`=== BRIDGE ${bridge.url} ===`)

    await cdp.evaluate(`(async () => { await window.nova?.browserAgent?.autoApprove?.(true); return true; })()`)

    const run = async (label, ...args) => {
      log(`=== ${label}: nco-browser ${args.join(' ')} ===`)
      const result = await runCli(args, bridge.url, bridge.token)
      log(result.stdout || result.stderr || '(empty)')
      log(`EXIT_CODE=${result.code}`)
      return result
    }

    let status = await run('status', 'status')
    let nav = await run('navigate', 'navigate', IQ_URL)
    if (nav.code !== 0 && /allowlist|blocked|denied/i.test(nav.stderr + nav.stdout)) {
      log('=== navigate blocked, trying iqtest.kr ===')
      nav = await run('navigate-iqtest.kr', 'navigate', 'https://www.iqtest.kr/')
    }
    await sleep(4)

    let questions = 0
    const maxQuestions = 12
    let lastUrl = ''
    let lastTitle = ''

    for (let round = 0; round < maxQuestions + 3; round += 1) {
      const analyze = await run(`analyze-${round}`, 'analyze')
      let data = null
      if (analyze.code === 0) {
        data = parseAnalyze(analyze.stdout)
      }
      if (!data) {
        const page = await run(`page-${round}`, 'page')
        try { data = JSON.parse(page.stdout) } catch { /* ignore */ }
      }
      lastUrl = data?.url || lastUrl
      lastTitle = data?.title || lastTitle
      log(`PAGE: title=${lastTitle} url=${lastUrl}`)

      if (/result|score|your iq|결과|점수/i.test(`${lastTitle} ${lastUrl} ${data?.purpose || ''}`)) {
        log('=== RESULT PAGE DETECTED ===')
        break
      }

      const pick = data ? pickAnswerSelector(data) : null
      if (!pick) {
        log('No selector found; trying screenshot')
        await run('screenshot', 'screenshot', `iq-round-${round}`)
        break
      }
      log(`PICK: ${JSON.stringify(pick)}`)
      const click = await run(`click-${round}`, 'click', pick.selector)
      if (click.code !== 0) {
        await run(`force-${round}`, 'force', pick.selector)
      }
      questions += pick.kind === 'answer' ? 1 : 0
      await sleep(2)
      if (questions >= 10 && pick.kind === 'answer') break
    }

    const finalAnalyze = await run('final-analyze', 'analyze')
    const finalPage = await run('final-page', 'page')
    let final = null
    try { final = JSON.parse(finalPage.stdout) } catch { final = parseAnalyze(finalAnalyze.stdout) }
    log(`=== FINAL ===`)
    log(`URL: ${final?.url || lastUrl}`)
    log(`Title: ${final?.title || lastTitle}`)
    const scoreMatch = JSON.stringify(final || {}).match(/IQ[^0-9]{0,20}(\d{2,3})/i)
    if (scoreMatch) log(`IQ Score hint: ${scoreMatch[0]}`)

    cdp.close()
  } finally {
    electron.kill('SIGTERM')
    await sleep(500)
    if (electron.exitCode === null) electron.kill('SIGKILL')
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch(async (error) => {
  log(`FATAL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
