import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TerminalContainer from '../terminal/TerminalContainer'
import { useWorkspaceStore } from '../../store/useWorkspaceStore'
import type {
  AgentBridgeStatus,
  BrowserAgentActionEvent,
  BrowserAgentPageDigest,
  BrowserAgentSettings,
  BrowserAgentTaskEvent,
} from '../../../shared/ipc'

const HISTORY_KEY = 'nco.history'
const BACKUP_KEY = 'nco.browser-backup-meta'
const TOKEN_HINT_KEY = 'nco.browser-token-hint'

type TaskState = 'idle' | 'run' | 'done' | 'stop'
type HistoryItem = { id: string; text: string; type: 'goal' | 'custom'; fav: boolean; ts: number }
type SlashCmd = {
  cmd: string
  desc: string
  template?: string
  action?: () => void
}
type OrchSubtask = { id: string; title: string; scope: string; assignee: string }

const DEFAULT_MISSION =
  '현재 열린 웹페이지를 분석하고, 사용자가 요청하는 작업(클릭·검색·로그인·입력 등)을 자율적으로 수행한다.'

const DEFAULT_SETTINGS: BrowserAgentSettings = {
  mission: DEFAULT_MISSION,
  brief: true,
  autoAnalyze: true,
  realtime: true,
  autoApprove: false,
  autoEnter: true,
}

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as HistoryItem[]) : []
  } catch {
    return []
  }
}

function persistHistory(items: HistoryItem[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 100)))
}

function slashQuery(value: string, cursor: number): string | null {
  const before = value.slice(0, cursor)
  const m = before.match(/(?:^|\s)(\/[^\s/]*)$/)
  return m ? m[1] : null
}

function connectionLabel(status: AgentBridgeStatus | null): string {
  if (!status) return '연결 중…'
  if (status.error) return `오류: ${status.error}`
  if (status.running) {
    const agents = status.connectedAgents ?? 0
    const port = status.port ? `:${status.port}` : ''
    return `● 연결됨${port} · 에이전트 ${agents}`
  }
  return '대기 중…'
}

export function BrowserControlPanel(): JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = workspaces[0]?.id

  const [status, setStatus] = useState<AgentBridgeStatus | null>(null)
  const [provider, setProvider] = useState('claude')
  const [customCommand, setCustomCommand] = useState('')
  const [terminalId, setTerminalId] = useState<string | null>(null)

  const [isCollabOpen, setIsCollabOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isTermOpen, setIsTermOpen] = useState(false)
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [isTokenOpen, setIsTokenOpen] = useState(false)
  const [tokenHint, setTokenHint] = useState(() => localStorage.getItem(TOKEN_HINT_KEY) ?? '')

  const [goalInput, setGoalInput] = useState('')
  const [slashActive, setSlashActive] = useState(0)
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory())
  const [historyIndex, setHistoryIndex] = useState(-1)
  const historyTempRef = useRef('')

  const [taskState, setTaskState] = useState<TaskState>('idle')
  const [actions, setActions] = useState<BrowserAgentActionEvent[]>([])
  const [taskResult, setTaskResult] = useState<string | null>(null)
  const [pageDigest, setPageDigest] = useState<BrowserAgentPageDigest | null>(null)
  const [settings, setSettings] = useState<BrowserAgentSettings>(DEFAULT_SETTINGS)

  const [collab, setCollab] = useState({
    mode: 'parallel' as 'parallel' | 'orch',
    instruction: '',
    providers: { claude: true, codex: true, agy: true },
  })
  const [orchSubtasks, setOrchSubtasks] = useState<OrchSubtask[]>([
    { id: '1', title: '', scope: '', assignee: 'codex' },
    { id: '2', title: '', scope: '', assignee: 'agy' },
  ])

  const logRef = useRef<HTMLDivElement>(null)
  const goalRef = useRef<HTMLTextAreaElement>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)
  const tokenDialogRef = useRef<HTMLDivElement>(null)

  const agent = typeof window !== 'undefined' ? window.nova?.browserAgent : undefined

  const saveHistoryItem = useCallback((text: string, type: 'goal' | 'custom') => {
    const trimmed = text.trim()
    if (!trimmed) return
    setHistory((prev) => {
      const existIdx = prev.findIndex((h) => h.text === trimmed && h.type === type)
      let fav = false
      let id: string = crypto.randomUUID()
      const next = [...prev]
      if (existIdx >= 0) {
        fav = next[existIdx].fav
        id = next[existIdx].id
        next.splice(existIdx, 1)
      }
      next.unshift({ id, text: trimmed, type, fav, ts: Date.now() })
      const capped = next.slice(0, 100)
      persistHistory(capped)
      return capped
    })
    setHistoryIndex(-1)
  }, [])

  const toggleFav = useCallback((id: string) => {
    setHistory((prev) => {
      const next = prev.map((h) => (h.id === id ? { ...h, fav: !h.fav, ts: Date.now() } : h))
      persistHistory(next)
      return next
    })
  }, [])

  const handleCapture = useCallback(async (mode: 'element' | 'region') => {
    try {
      const res = await agent?.engine?.capture?.({ mode })
      if (res?.alias) {
        setGoalInput((prev) => prev + (prev ? ' ' : '') + res.alias)
        goalRef.current?.focus()
      }
    } catch (e) {
      console.error(e)
    }
  }, [agent])

  const handlePinTab = useCallback(async () => {
    try {
      await agent?.engine?.pinTab?.({})
    } catch (e) {
      console.error(e)
    }
  }, [agent])

  const handleStopTask = useCallback(async () => {
    try {
      setTaskState('stop')
      if (terminalId) {
        await agent?.engine?.control?.({ terminalId, op: 'stop' })
      } else {
        await agent?.engine?.control?.({ terminalId: '', op: 'interrupt' })
      }
    } catch (e) {
      console.error(e)
    }
  }, [agent, terminalId])

  const handleClearPanels = useCallback(() => {
    setGoalInput('')
    setActions([])
    setTaskResult(null)
    setTaskState('idle')
  }, [])

  const slashCommands: SlashCmd[] = useMemo(
    () => [
      { cmd: '/분석', desc: '이 페이지 분석·재분석', template: '이 페이지를 분석하고 무엇을 할 수 있는지 알려줘' },
      { cmd: '/스크린샷', desc: '화면 캡처해 판독', template: 'nco-browser screenshot 으로 화면을 캡처해 내용을 판독해줘' },
      { cmd: '/로그인', desc: '이 사이트 로그인', template: '이 사이트에 로그인해줘' },
      { cmd: '/회원가입', desc: '회원가입(민감 제출 전 확인)', template: '이 사이트에 회원가입해줘. 최종 제출 직전엔 나에게 확인해줘' },
      { cmd: '/검색', desc: '이 사이트에서 검색', template: '이 사이트에서 다음을 검색해줘: ' },
      { cmd: '/작성', desc: '글/폼 작성', template: '다음 내용으로 작성해줘: ' },
      { cmd: '/search', desc: '⚡즉시 검색(검색창에 입력+엔터, LLM 우회)', template: '/search ' },
      { cmd: '/click', desc: '⚡즉시 클릭 <셀렉터|ref>', template: '/click ' },
      { cmd: '/type', desc: '⚡즉시 입력 <셀렉터> <값>', template: '/type ' },
      { cmd: '/scroll', desc: '⚡즉시 스크롤 <셀렉터|숫자>', template: '/scroll ' },
      { cmd: '/navigate', desc: '⚡즉시 이동 <url>', template: '/navigate ' },
      { cmd: '/요소', desc: '요소 선택 캡처(@cap 삽입)', action: () => void handleCapture('element') },
      { cmd: '/영역', desc: '영역 드래그 캡처(@cap 삽입)', action: () => void handleCapture('region') },
      { cmd: '/캡처고정', desc: '이 탭을 제어 대상으로 고정', action: () => void handlePinTab() },
      { cmd: '/중지', desc: '진행 중 작업 중지', action: () => void handleStopTask() },
      { cmd: '/지우기', desc: '입력·로그·결과 비우기', action: handleClearPanels },
    ],
    [handleCapture, handlePinTab, handleStopTask, handleClearPanels],
  )

  const cursorPos = goalRef.current?.selectionStart ?? goalInput.length
  const slashQ = slashQuery(goalInput, cursorPos)
  const slashItems = useMemo(() => {
    if (slashQ == null) return []
    const ql = slashQ.toLowerCase()
    return slashCommands.filter((c) => c.cmd.toLowerCase().startsWith(ql))
  }, [slashQ, slashCommands])

  useEffect(() => {
    setSlashActive(0)
  }, [slashQ])

  useEffect(() => {
    let unmounted = false
    if (!agent) return

    agent.status?.().then((s) => { if (!unmounted) setStatus(s) }).catch(console.error)
    const unsubStatus = agent.onStatus?.((s) => { if (!unmounted) setStatus(s) })

    const unsubAction = agent.onAction?.((action: BrowserAgentActionEvent) => {
      if (unmounted) return
      setActions((prev) => {
        const existingIdx = prev.findIndex((a) => a.seq === action.seq)
        if (existingIdx >= 0) {
          const next = [...prev]
          next[existingIdx] = action
          return next
        }
        return [...prev, action]
      })
      if (action.status === 'run') {
        setTaskState((prev) => (prev !== 'stop' ? 'run' : prev))
      }
    })

    const unsubPage = agent.onPage?.((digest: BrowserAgentPageDigest) => {
      if (!unmounted) setPageDigest(digest)
    })

    const unsubTask = agent.onTask?.((task: BrowserAgentTaskEvent) => {
      if (unmounted) return
      if (task.kind === 'result') {
        setTaskResult(task.message || '작업 완료')
        setTaskState('done')
      } else if (task.kind === 'stop') {
        setTaskState('stop')
      }
    })

    agent.settings?.get?.().then((s) => {
      if (!unmounted && s) setSettings((prev) => ({ ...prev, ...s }))
    }).catch(console.error)

    return () => {
      unmounted = true
      unsubStatus?.()
      unsubAction?.()
      unsubPage?.()
      unsubTask?.()
    }
  }, [agent])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [actions])

  useEffect(() => {
    if (!isHistoryOpen) return
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node
      const menu = document.getElementById('bc-history-menu')
      const btn = document.getElementById('bc-history-btn')
      if (menu && !menu.contains(t) && btn && !btn.contains(t)) setIsHistoryOpen(false)
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [isHistoryOpen])

  useEffect(() => {
    if (isTokenOpen) tokenDialogRef.current?.focus()
  }, [isTokenOpen])

  const handleSettingsChange = async <K extends keyof BrowserAgentSettings>(
    key: K,
    value: BrowserAgentSettings[K],
  ): Promise<void> => {
    const next = { ...settings, [key]: value }
    setSettings(next)
    try {
      await agent?.settings?.set?.(next)
      if (key === 'autoApprove') await agent?.autoApprove?.(Boolean(value))
    } catch (e) {
      console.error(e)
    }
  }

  const tryDirectCommand = async (goal: string): Promise<boolean> => {
    const m = goal.match(/^\/(search|click|type|scroll|navigate)\s*([\s\S]*)$/i)
    if (!m) return false
    const cmd = m[1].toLowerCase()
    const rest = m[2].trim()

    if (cmd === 'navigate') {
      if (!rest || !terminalId) return true
      await agent?.engine?.goal?.({ terminalId, text: `navigate ${rest}`, autoEnter: settings.autoEnter })
      return true
    }

    const execCmd = cmd as 'search' | 'click' | 'type' | 'scroll'
    let args: Record<string, unknown> = {}
    if (execCmd === 'search') {
      if (!rest) return true
      args = { text: rest }
    } else if (execCmd === 'click') {
      if (!rest) return true
      args = { selector: rest }
    } else if (execCmd === 'type') {
      const sp = rest.indexOf(' ')
      if (sp < 0) return true
      args = { selector: rest.slice(0, sp), text: rest.slice(sp + 1) }
    } else {
      const n = Number(rest)
      args = rest && Number.isFinite(n) ? { dy: n } : (rest ? { selector: rest } : { y: 0 })
    }

    try {
      await agent?.exec?.({ command: execCmd, args })
    } catch (e) {
      console.error(e)
    }
    return true
  }

  const handleRunGoal = async (): Promise<void> => {
    const goal = goalInput.trim()
    if (!goal) return
    saveHistoryItem(goal, 'goal')
    setTaskState('run')
    setIsHistoryOpen(false)

    if (await tryDirectCommand(goal)) {
      setGoalInput('')
      return
    }

    if (!terminalId) {
      setTaskResult('엔진을 먼저 시작하세요 (▶ 엔진 시작).')
      setTaskState('idle')
      return
    }

    try {
      setActions([])
      setTaskResult(null)
      await agent?.engine?.goal?.({ terminalId, text: goal, autoEnter: settings.autoEnter })
      setGoalInput('')
    } catch (e) {
      console.error(e)
      setTaskState('idle')
    }
  }

  const handleStartSession = async (): Promise<void> => {
    if (!activeWorkspaceId) return
    try {
      setIsTermOpen(true)
      const res = await agent?.engine?.start?.({ provider, workspaceId: activeWorkspaceId })
      if (res?.terminalId) setTerminalId(res.terminalId)
    } catch (e) {
      console.error(e)
    }
  }

  const handleReloadEngine = async (): Promise<void> => {
    try {
      if (terminalId) {
        const res = await agent?.engine?.control?.({ terminalId, op: 'reload' })
        if (res?.terminalId) setTerminalId(res.terminalId)
      } else {
        await handleStartSession()
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleClearContext = async (): Promise<void> => {
    if (!terminalId) return
    try {
      await agent?.engine?.control?.({ terminalId, op: 'clearContext' })
    } catch (e) {
      console.error(e)
    }
  }

  const handleAnalyzeNow = async (): Promise<void> => {
    try {
      const digest = await agent?.engine?.analyze?.()
      if (digest) setPageDigest(digest)
    } catch (e) {
      console.error(e)
    }
  }

  const handleCollabSubmit = async (): Promise<void> => {
    const providers = Object.entries(collab.providers)
      .filter(([, v]) => v)
      .map(([k]) => k)
    let instruction = collab.instruction.trim()
    if (collab.mode === 'orch') {
      const lines = orchSubtasks
        .filter((s) => s.title.trim())
        .map((s) => `- [${s.assignee}] ${s.title}${s.scope ? ` (${s.scope})` : ''}`)
      if (lines.length) instruction = `${instruction}\n\n하위작업:\n${lines.join('\n')}`.trim()
    }
    if (!instruction) return
    try {
      await agent?.collab?.({ mode: collab.mode, instruction, providers })
    } catch (e) {
      console.error(e)
    }
  }

  const handleReconnect = async (): Promise<void> => {
    try {
      const s = await agent?.restart?.()
      if (s) setStatus(s)
    } catch (e) {
      console.error(e)
    }
  }

  const handleExportBackup = (): void => {
    const backup = {
      format: 'nco-browser-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        history,
        settings,
        customCommand,
        provider,
        meta: localStorage.getItem(BACKUP_KEY),
      },
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `nco-browser-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const handleImportBackup = async (file: File): Promise<void> => {
    try {
      const parsed = JSON.parse(await file.text()) as {
        format?: string
        version?: number
        data?: {
          history?: HistoryItem[]
          settings?: Partial<BrowserAgentSettings>
          customCommand?: string
          provider?: string
        }
      }
      if (parsed.format !== 'nco-browser-backup' || parsed.version !== 1 || !parsed.data) {
        console.error('Invalid backup format')
        return
      }
      if (Array.isArray(parsed.data.history)) {
        setHistory(parsed.data.history)
        persistHistory(parsed.data.history)
      }
      if (parsed.data.settings) {
        const next = { ...settings, ...parsed.data.settings }
        setSettings(next)
        await agent?.settings?.set?.(next)
      }
      if (typeof parsed.data.customCommand === 'string') setCustomCommand(parsed.data.customCommand)
      if (typeof parsed.data.provider === 'string') setProvider(parsed.data.provider)
    } catch (e) {
      console.error(e)
    }
  }

  const pickSlash = (i: number): void => {
    const it = slashItems[i]
    if (!it || !goalRef.current) return
    const el = goalRef.current
    const start = el.selectionStart ?? goalInput.length
    const before = goalInput.slice(0, start).replace(/(^|\s)\/[^\s/]*$/, '$1')
    const after = goalInput.slice(start)
    if (it.action) {
      setGoalInput(before + after)
      it.action()
      return
    }
    const inserted = before + (it.template ?? '') + after
    setGoalInput(inserted)
    requestAnimationFrame(() => {
      const pos = (before + (it.template ?? '')).length
      el.setSelectionRange(pos, pos)
      el.focus()
    })
  }

  const handleGoalKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActive((i) => (i + 1) % slashItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActive((i) => (i - 1 + slashItems.length) % slashItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickSlash(slashActive)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setGoalInput((v) => v.replace(/(^|\s)\/[^\s/]*$/, '$1'))
        return
      }
    }

    const el = e.currentTarget
    if (e.key === 'ArrowUp' && el.selectionStart === 0) {
      const list = history.filter((h) => h.type === 'goal')
      if (!list.length) return
      if (historyIndex < list.length - 1) {
        if (historyIndex === -1) historyTempRef.current = goalInput
        const next = historyIndex + 1
        setHistoryIndex(next)
        setGoalInput(list[next].text)
        e.preventDefault()
      }
      return
    }
    if (e.key === 'ArrowDown' && el.selectionEnd === el.value.length) {
      const list = history.filter((h) => h.type === 'goal')
      if (!list.length) return
      if (historyIndex > 0) {
        const next = historyIndex - 1
        setHistoryIndex(next)
        setGoalInput(list[next].text)
        e.preventDefault()
      } else if (historyIndex === 0) {
        setHistoryIndex(-1)
        setGoalInput(historyTempRef.current)
        e.preventDefault()
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleRunGoal()
    }
  }

  const sortedHistory = useMemo(
    () => [...history].sort((a, b) => {
      if (a.fav !== b.fav) return a.fav ? -1 : 1
      return b.ts - a.ts
    }),
    [history],
  )

  const resultTally = useMemo(() => {
    const ok = actions.filter((a) => a.status === 'ok').length
    const err = actions.filter((a) => a.status === 'err').length
    return { ok, err, total: actions.length }
  }, [actions])

  const inputCls =
    'bg-[#21262d] border border-[#30363d] rounded-[5px] px-[7px] py-[5px] text-[#e6edf3] text-[12px] outline-none focus:border-[#58a6ff]'
  const btnCls = `${inputCls} hover:border-[#58a6ff] cursor-pointer transition-colors`
  const iconBtn = `${btnCls} flex items-center justify-center min-w-[28px]`

  return (
    <div className="flex flex-col h-full w-full min-w-0 bg-[#0d1117] text-[#e6edf3] text-xs font-sans overflow-hidden">
      <header className="flex flex-wrap gap-1.5 items-center p-[7px_9px] border-b border-[#30363d] bg-[#161b22] flex-none">
        <span className="text-[#8b949e] flex-[1_1_100%] truncate text-[11px]" title={connectionLabel(status)}>
          {connectionLabel(status)}
        </span>
        <label className="text-[#8b949e] text-[11px] flex items-center gap-1">
          프로바이더
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className={inputCls}
            aria-label="프로바이더"
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="agy">agy</option>
            <option value="custom">custom</option>
            <option value="nova-cli">nova-cli</option>
            <option value="shell">shell</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void handleStartSession()}
          className={`${btnCls} bg-[#1f6feb] border-[#388bfd]`}
          title="선택한 엔진으로 세션 시작"
        >
          ▶ 엔진 시작
        </button>
        <div className="ml-auto flex flex-wrap gap-1.5 items-center">
          <button type="button" onClick={() => setIsCollabOpen((v) => !v)} className={iconBtn} title="협업" aria-expanded={isCollabOpen}>🤝</button>
          <button type="button" onClick={() => void handlePinTab()} className={iconBtn} title="현재 탭 고정">🎯</button>
          <button type="button" onClick={() => void handleStopTask()} className={`${iconBtn} border-[#f85149] text-[#ff7b72] hover:bg-[#3d1416]`} title="작업 중지">⏹</button>
          <button type="button" onClick={handleClearPanels} className={iconBtn} title="패널 비우기">🧹</button>
          <button type="button" onClick={() => void handleReloadEngine()} className={iconBtn} title="엔진 재시작">🔄</button>
          <button type="button" onClick={() => void handleClearContext()} className={iconBtn} title="컨텍스트 초기화">/clear</button>
          <button type="button" onClick={() => void handleCapture('element')} className={iconBtn} title="요소 캡처">📷</button>
          <button type="button" onClick={() => void handleCapture('region')} className={iconBtn} title="영역 캡처">▭</button>
          <button type="button" onClick={() => setIsSettingsOpen((v) => !v)} className={iconBtn} title="설정" aria-expanded={isSettingsOpen}>⚙</button>
          <button type="button" onClick={() => void handleReconnect()} className={iconBtn} title="재연결">↻</button>
          <button type="button" onClick={() => setIsTokenOpen(true)} className={iconBtn} title="토큰">🔑</button>
          <button type="button" onClick={handleExportBackup} className={iconBtn} title="백업 내보내기">⬇️</button>
          <button type="button" onClick={() => backupInputRef.current?.click()} className={iconBtn} title="백업 복원">⬆️</button>
          <input
            ref={backupInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void handleImportBackup(f)
            }}
          />
        </div>
      </header>

      {provider === 'custom' && (
        <div className="p-[6px_10px] border-b border-[#30363d] bg-[#0f141a] flex-none">
          <input
            type="text"
            spellCheck={false}
            autoComplete="off"
            className={`${inputCls} w-full font-mono`}
            placeholder="예: INTER_SESSION_HOST=host INTER_SESSION_PORT=9474 claude --dangerously-skip-permissions"
            value={customCommand}
            onChange={(e) => setCustomCommand(e.target.value)}
            onBlur={() => { if (customCommand.trim()) saveHistoryItem(customCommand, 'custom') }}
          />
        </div>
      )}

      {isCollabOpen && (
        <div className="flex flex-col gap-2 p-[6px_10px] border-b border-[#30363d] bg-[#0f141a] flex-none">
          <div className="flex flex-wrap gap-2 items-center">
            <select
              value={collab.mode}
              onChange={(e) => setCollab({ ...collab, mode: e.target.value as 'parallel' | 'orch' })}
              className={inputCls}
              aria-label="협업 모드"
            >
              <option value="parallel">병렬</option>
              <option value="orch">오케스트레이션</option>
            </select>
            <input
              type="text"
              spellCheck={false}
              placeholder="claude·codex·agy에 맡길 목표/지시"
              value={collab.instruction}
              onChange={(e) => setCollab({ ...collab, instruction: e.target.value })}
              className={`${inputCls} flex-1 min-w-[120px]`}
            />
            <div className="flex gap-2 items-center">
              {(['claude', 'codex', 'agy'] as const).map((p) => (
                <label key={p} className="flex items-center gap-0.5 text-[#8b949e] text-[11px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={collab.providers[p]}
                    onChange={(e) =>
                      setCollab({ ...collab, providers: { ...collab.providers, [p]: e.target.checked } })
                    }
                  />
                  {p}
                </label>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void handleCollabSubmit()}
              className={`${btnCls} bg-[#238636] border-[#2ea043] font-semibold whitespace-nowrap`}
            >
              위임
            </button>
          </div>
          {collab.mode === 'orch' && (
            <div className="flex flex-col gap-1">
              {orchSubtasks.map((st) => (
                <div key={st.id} className="flex gap-1.5 items-center">
                  <input
                    className={`${inputCls} flex-[2] text-[11px]`}
                    placeholder="작업 제목"
                    value={st.title}
                    onChange={(e) =>
                      setOrchSubtasks((prev) =>
                        prev.map((x) => (x.id === st.id ? { ...x, title: e.target.value } : x)),
                      )
                    }
                  />
                  <input
                    className={`${inputCls} flex-[3] text-[11px]`}
                    placeholder="스코프 (예: src/**/*.ts)"
                    value={st.scope}
                    onChange={(e) =>
                      setOrchSubtasks((prev) =>
                        prev.map((x) => (x.id === st.id ? { ...x, scope: e.target.value } : x)),
                      )
                    }
                  />
                  <select
                    className={inputCls}
                    value={st.assignee}
                    onChange={(e) =>
                      setOrchSubtasks((prev) =>
                        prev.map((x) => (x.id === st.id ? { ...x, assignee: e.target.value } : x)),
                      )
                    }
                  >
                    <option value="codex">codex</option>
                    <option value="agy">agy</option>
                    <option value="claude">claude</option>
                  </select>
                  <button
                    type="button"
                    className={`${btnCls} text-[10px] px-1.5 py-0.5`}
                    onClick={() => setOrchSubtasks((prev) => prev.filter((x) => x.id !== st.id))}
                  >
                    x
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={`${btnCls} text-[10px] px-1.5 py-0.5 self-start`}
                onClick={() =>
                  setOrchSubtasks((prev) => [
                    ...prev,
                    { id: crypto.randomUUID(), title: '', scope: '', assignee: 'codex' },
                  ])
                }
              >
                + 하위작업 추가
              </button>
            </div>
          )}
        </div>
      )}

      {isSettingsOpen && (
        <div className="flex flex-col gap-1 p-[6px_10px] border-b border-[#30363d] bg-[#0f141a] flex-none">
          <label className="flex items-center gap-1.5 text-[#8b949e] text-[12px] cursor-pointer">
            <input type="checkbox" checked={settings.brief} onChange={(e) => void handleSettingsChange('brief', e.target.checked)} />
            🎯 시작 시 미션 브리핑 주입
          </label>
          <label className="flex items-center gap-1.5 text-[#8b949e] text-[12px] cursor-pointer">
            <input type="checkbox" checked={settings.autoAnalyze} onChange={(e) => void handleSettingsChange('autoAnalyze', e.target.checked)} />
            📄 페이지 로드 시 자동 분석 → 엔진 전달
          </label>
          <label className="flex items-center gap-1.5 text-[#8b949e] text-[12px] cursor-pointer">
            <input type="checkbox" checked={settings.realtime} onChange={(e) => void handleSettingsChange('realtime', e.target.checked)} />
            ⚡ 실시간 변화 트리거(URL·오류·모달) → 엔진 즉시 알림
          </label>
          <label className="flex items-center gap-1.5 text-[#8b949e] text-[12px] cursor-pointer">
            <input type="checkbox" checked={settings.autoApprove} onChange={(e) => void handleSettingsChange('autoApprove', e.target.checked)} />
            ✅ 브라우저 액션 자동 승인
          </label>
          <label className="flex items-center gap-1.5 text-[#8b949e] text-[12px] cursor-pointer">
            <input type="checkbox" checked={settings.autoEnter} onChange={(e) => void handleSettingsChange('autoEnter', e.target.checked)} />
            ⏎ 입력 후 자동 Enter
          </label>
          <textarea
            className={`${inputCls} w-full mt-1 min-h-[40px] resize-y`}
            placeholder="에이전트 기본 임무"
            value={settings.mission}
            onChange={(e) => void handleSettingsChange('mission', e.target.value)}
            rows={2}
            spellCheck={false}
          />
        </div>
      )}

      <div className="flex gap-1.5 p-[8px_9px] border-b border-[#30363d] bg-[#0f141a] relative flex-none">
        <button
          id="bc-history-btn"
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setIsHistoryOpen((v) => !v)
          }}
          className="bg-transparent border-none text-[#8b949e] px-1 text-sm cursor-pointer outline-none"
          title="명령 히스토리"
          aria-expanded={isHistoryOpen}
        >
          ⏱
        </button>

        {isHistoryOpen && (
          <div
            id="bc-history-menu"
            role="listbox"
            aria-label="명령 히스토리"
            className="absolute left-[30px] bottom-[calc(100%-4px)] z-[21] max-h-[240px] w-[300px] overflow-y-auto bg-[#161b22] border border-[#58a6ff] rounded-lg shadow-[0_-4px_16px_rgba(0,0,0,.5)] p-1"
          >
            {sortedHistory.length === 0 ? (
              <div className="p-2 text-[#8b949e] text-[11px] text-center">히스토리가 없습니다.</div>
            ) : (
              sortedHistory.map((item) => (
                <div
                  key={item.id}
                  role="option"
                  className="flex gap-2 items-center px-2 py-1.5 rounded-[5px] cursor-pointer text-[12px] border-b border-[#21262d] hover:bg-[#1f6feb33]"
                  onClick={() => {
                    if (item.type === 'goal') {
                      setGoalInput(item.text)
                      goalRef.current?.focus()
                    } else {
                      setProvider('custom')
                      setCustomCommand(item.text)
                    }
                    setIsHistoryOpen(false)
                  }}
                >
                  <span
                    className={`cursor-pointer ${item.fav ? 'text-[#e3b341]' : 'text-[#6e7681]'}`}
                    title="즐겨찾기 토글"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleFav(item.id)
                    }}
                  >
                    ★
                  </span>
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[#e6edf3]">{item.text}</span>
                  <span className="text-[10px] text-[#8b949e] bg-[#21262d] px-1 rounded">{item.type}</span>
                </div>
              ))
            )}
          </div>
        )}

        {slashItems.length > 0 && (
          <div
            role="listbox"
            aria-label="슬래시 명령"
            className="absolute left-[9px] right-[9px] bottom-[calc(100%-4px)] z-20 max-h-[240px] overflow-y-auto bg-[#161b22] border border-[#58a6ff] rounded-lg shadow-[0_-4px_16px_rgba(0,0,0,.5)] p-1"
          >
            {slashItems.map((it, i) => (
              <div
                key={it.cmd}
                role="option"
                aria-selected={i === slashActive}
                className={`flex gap-2 items-baseline px-2 py-1.5 rounded-[5px] cursor-pointer text-[12px] ${
                  i === slashActive ? 'bg-[#1f6feb33]' : ''
                }`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pickSlash(i)
                }}
                onMouseEnter={() => setSlashActive(i)}
              >
                <span className="text-[#79c0ff] font-semibold min-w-[78px]">{it.cmd}</span>
                <span className="text-[#8b949e]">{it.desc}</span>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={goalRef}
          className={`${inputCls} flex-1 min-h-[34px] max-h-[40vh] resize-y placeholder:text-[#6e7681] text-[13px]`}
          placeholder="목표 입력 (Enter 실행 · / 메뉴 · ⚡즉시: /search·/click·/type). 📷캡처는 @cap1 단축어"
          value={goalInput}
          rows={2}
          spellCheck={false}
          onChange={(e) => setGoalInput(e.target.value)}
          onKeyDown={handleGoalKeyDown}
          aria-label="목표 입력"
        />
        <button
          type="button"
          onClick={() => void handleRunGoal()}
          className={`${btnCls} bg-[#238636] border-[#2ea043] font-semibold whitespace-nowrap self-stretch`}
        >
          ▶ 실행
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto block">
        <section className="m-2 border border-[#2f81f7] rounded-lg bg-[#161b22]">
          <h3 className="m-0 px-2.5 py-2 text-[12px] text-[#8b949e] border-b border-[#21262d] flex justify-between items-center">
            <span className="flex items-center gap-2">
              🧭 작업 세션
              <span
                className={`text-[10px] font-semibold px-[7px] py-px rounded-full ${
                  taskState === 'idle'
                    ? 'bg-[#21262d] text-[#8b949e]'
                    : taskState === 'run'
                      ? 'bg-[#1f2d16] text-[#d29922] animate-pulse'
                      : taskState === 'done'
                        ? 'bg-[#12261a] text-[#56d364]'
                        : 'bg-[#3d1416] text-[#ff7b72]'
                }`}
              >
                {taskState === 'idle' ? '대기' : taskState === 'run' ? '실행' : taskState === 'done' ? '완료' : '중지'}
              </span>
            </span>
            <button
              type="button"
              className={btnCls}
              title="진행 과정·결과 비우기"
              onClick={() => {
                setActions([])
                setTaskResult(null)
                setTaskState('idle')
              }}
            >
              지우기
            </button>
          </h3>
          <div className="p-2.5 text-[12px]">
            {taskResult && (
              <div className="pb-2 mb-2 border-b border-[#21262d]">
                <div className="text-[10px] text-[#6e7681] mb-1 tracking-wide">✅ 결과</div>
                <div className="whitespace-pre-wrap break-words text-[#e6edf3] text-[12px] leading-relaxed">{taskResult}</div>
                {resultTally.total > 0 && (
                  <>
                    <div className="my-1.5 text-[11px] text-[#8b949e]">
                      단계 {resultTally.total} · 성공 {resultTally.ok} · 실패 {resultTally.err}
                    </div>
                    <ol className="m-0 pl-[18px] flex flex-col gap-0.5">
                      {actions.map((a) => (
                        <li
                          key={`sum-${a.seq}`}
                          className={`text-[11px] ${
                            a.status === 'ok' ? 'text-[#7ee787]' : a.status === 'err' ? 'text-[#ff7b72]' : 'text-[#8b949e]'
                          }`}
                        >
                          {a.seq}. {a.action} {a.detail}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            )}
            <div className="text-[10px] text-[#6e7681] mb-1 tracking-wide">⚡ 진행 과정</div>
            <div ref={logRef} className="flex flex-col gap-1.5 max-h-[40vh] overflow-y-auto" aria-live="polite">
              {actions.length === 0 ? (
                <div className="text-[#6e7681] text-[11px]">
                  아직 액션이 없습니다. 목표를 입력하면 에이전트가 분석·클릭·입력을 수행합니다.
                </div>
              ) : (
                actions.map((act) => (
                  <div
                    key={act.seq}
                    className={`flex items-baseline gap-1.5 p-[5px_7px] rounded-[5px] bg-[#0d1117] border-l-[3px] text-[11px] ${
                      act.status === 'ok'
                        ? 'border-l-[#2ea043]'
                        : act.status === 'err'
                          ? 'border-l-[#f85149]'
                          : 'border-l-[#388bfd]'
                    }`}
                  >
                    <span
                      className={`flex-none min-w-[16px] h-4 leading-4 text-center rounded-full text-[10px] font-bold ${
                        act.status === 'ok'
                          ? 'bg-[#12261a] text-[#56d364]'
                          : act.status === 'err'
                            ? 'bg-[#3d1416] text-[#ff7b72]'
                            : 'bg-[#21262d] text-[#8b949e]'
                      }`}
                    >
                      {act.seq}
                    </span>
                    <span className="flex-none font-semibold text-[#79c0ff]">{act.action}</span>
                    <span className="flex-1 min-w-0 text-[#8b949e] break-words">{act.detail}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="m-2 border border-[#30363d] rounded-lg bg-[#161b22]">
          <h3 className="m-0 px-2.5 py-2 text-[12px] text-[#8b949e] border-b border-[#21262d] flex justify-between items-center">
            <span>📄 현재 페이지</span>
            <button type="button" onClick={() => void handleAnalyzeNow()} className={btnCls} title="지금 재분석">
              재분석
            </button>
          </h3>
          <div className="p-2.5 text-[12px]">
            <div className={pageDigest?.title ? 'text-[#e6edf3] font-semibold' : 'text-[#6e7681]'}>
              {pageDigest?.title || '페이지 로드 대기…'}
            </div>
            <div className="text-[#58a6ff] text-[11px] break-all">{pageDigest?.url}</div>
            <div className="text-[#6e7681] text-[11px] mt-1 whitespace-pre-wrap">
              {pageDigest ? (
                <>
                  {pageDigest.purpose ? `🎯 ${pageDigest.purpose} · ` : ''}
                  {pageDigest.progress ? `📶 진행 ${pageDigest.progress} · ` : ''}
                  폼 {pageDigest.counts.forms} · 입력 {pageDigest.counts.inputs} · 버튼{' '}
                  {pageDigest.counts.buttons} · 링크 {pageDigest.counts.links}
                  {pageDigest.nextAction ? `\n➡ 다음: ${pageDigest.nextAction}` : ''}
                </>
              ) : null}
            </div>
            <div className="mt-2 flex flex-col">
              {pageDigest?.fields?.slice(0, 6).map((f, i) => (
                <div key={i} className="flex gap-1.5 py-0.5 border-b border-dashed border-[#21262d] text-[11px]">
                  <span className="text-[#8b949e] min-w-[70px] truncate">{f.label || '(필드)'}</span>
                  <span className="text-[#e6edf3]">{f.type}</span>
                  <span className="text-[#6e7681] font-mono ml-auto break-all">{f.selector}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="m-2 border border-[#30363d] rounded-lg bg-[#0d1117] overflow-hidden">
          <button
            type="button"
            className="w-full text-left px-2.5 py-2 text-[12px] text-[#8b949e] cursor-pointer select-none bg-[#161b22] sticky top-0 border-0 border-b border-[#21262d]"
            onClick={() => setIsTermOpen((v) => !v)}
            aria-expanded={isTermOpen}
          >
            {isTermOpen ? '▾' : '▸'} 🖥 엔진 터미널 ({provider}
            {terminalId ? ` · ${terminalId.slice(0, 8)}` : ''}) — 클릭하여 {isTermOpen ? '접기' : '펼치기'}
          </button>
          <div
            className={`${isTermOpen ? 'block' : 'hidden'} h-[50vh] min-h-[240px] p-1.5 relative w-full bg-[#0a0a0a]`}
            aria-label="NCO CLI terminal"
          >
            <TerminalContainer
              agentId={provider}
              workspaceId={activeWorkspaceId}
              paneKey="browser-control"
              existingTerminalId={terminalId ?? undefined}
            />
          </div>
        </section>
      </div>

      {isTokenOpen && (
        <div
          className="fixed inset-0 z-[9998] grid place-items-center bg-[rgb(1_4_9_/_75%)]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bc-token-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setIsTokenOpen(false)
          }}
        >
          <div
            ref={tokenDialogRef}
            tabIndex={-1}
            className="w-[min(360px,calc(100vw-32px))] p-[18px] border border-[#58a6ff] rounded-lg bg-[#161b22] outline-none"
          >
            <h2 id="bc-token-title" className="m-0 mb-2.5 text-base">브리지 토큰</h2>
            <p className="text-[#8b949e] text-[13px] leading-relaxed m-0 mb-3">
              메인 프로세스 브리지가 발급한 capability token 힌트를 저장합니다. 실제 토큰 바인딩은 메인/preload(codex)가 담당합니다.
            </p>
            <input
              type="password"
              autoComplete="off"
              className={`${inputCls} w-full mb-3`}
              placeholder="Capability token (선택)"
              value={tokenHint}
              onChange={(e) => setTokenHint(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className={btnCls} onClick={() => setIsTokenOpen(false)}>취소</button>
              <button
                type="button"
                className={`${btnCls} bg-[#238636] border-[#2ea043]`}
                onClick={() => {
                  localStorage.setItem(TOKEN_HINT_KEY, tokenHint)
                  setIsTokenOpen(false)
                  void handleReconnect()
                }}
              >
                저장하고 재연결
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
