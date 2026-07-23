#!/usr/bin/env python3
from pathlib import Path

base = Path('/Users/nova-ai/project/nova-use')

files: dict[str, str] = {}

files['src/renderer/components/docs/docsBridge.ts'] = """import type { DocsBridge } from '../../../shared/docs-ipc'

/** Preload type guard: narrow to DocsBridge without any / double assertions. */
export function getDocsBridge(): DocsBridge | undefined {
  const nova = typeof window !== 'undefined' ? window.nova : undefined
  if (!nova || typeof nova !== 'object') return undefined
  const docs = nova.docs
  if (!docs || typeof docs !== 'object') return undefined
  if (typeof docs.commitPlan !== 'function' || typeof docs.getPreview !== 'function') {
    return undefined
  }
  return docs
}

export function isSaveAvailable(
  capabilities: { capabilities: Array<{ name: string; status: string }> },
): boolean {
  return capabilities.capabilities.some((c) => c.name === 'save' && c.status === 'available')
}
"""

files['src/renderer/store/useDocsStore.ts'] = """import { create } from 'zustand'
import type { DocsSessionMetadata, DocumentFormat } from '../../shared/docs-ipc'
import { getDocsBridge } from '../components/docs/docsBridge'

interface DocsState {
  sessions: DocsSessionMetadata[]
  activeSessionId: string | null
  recentDocs: { path: string, format: DocumentFormat, lastOpened: number }[]
  
  openFile: () => Promise<void>
  openDroppedFile: (path: string) => Promise<void>
  closeSession: (sessionId: string) => Promise<void>
  setActiveSession: (sessionId: string) => void
}

export const useDocsStore = create<DocsState>((set) => ({
  sessions: [],
  activeSessionId: null,
  recentDocs: [],

  openFile: async () => {
    const bridge = getDocsBridge()
    if (!bridge) {
      const demoId = `demo-session-${Date.now()}`
      const demoSession: DocsSessionMetadata = {
        sessionId: demoId,
        format: 'docx',
        sourceHash: 'demo-hash',
        revision: 0,
        capabilities: {
          capabilities: [{ name: 'edit', status: 'available' }, { name: 'save', status: 'available' }],
          allowedOperations: ['replaceText']
        },
        state: 'ready'
      }
      set(state => ({
        sessions: [...state.sessions, demoSession],
        activeSessionId: demoId
      }))
      return
    }

    try {
      const session = await bridge.pickOpen()
      if (session) {
        set(state => ({
          sessions: [...state.sessions.filter(s => s.sessionId !== session.sessionId), session],
          activeSessionId: session.sessionId,
          recentDocs: [
            { path: session.sourceHash, format: session.format, lastOpened: Date.now() },
            ...state.recentDocs
          ].slice(0, 10)
        }))
      }
    } catch (e) {
      console.error('Failed to open file via bridge:', e)
    }
  },

  openDroppedFile: async (path: string) => {
    const bridge = getDocsBridge()
    if (!bridge) {
      const demoId = `demo-session-${Date.now()}`
      const demoSession: DocsSessionMetadata = {
        sessionId: demoId,
        format: 'pdf',
        sourceHash: path,
        revision: 0,
        capabilities: {
          capabilities: [{ name: 'open', status: 'available' }],
          allowedOperations: []
        },
        state: 'ready'
      }
      set(state => ({
        sessions: [...state.sessions, demoSession],
        activeSessionId: demoId
      }))
      return
    }

    try {
      const session = await bridge.openDropped({ path })
      if (session) {
        set(state => ({
          sessions: [...state.sessions.filter(s => s.sessionId !== session.sessionId), session],
          activeSessionId: session.sessionId
        }))
      }
    } catch (e) {
      console.error('Failed to open dropped file:', e)
    }
  },

  closeSession: async (sessionId: string) => {
    const bridge = getDocsBridge()
    if (bridge) {
      try {
        await bridge.close({ sessionId })
      } catch (e) {
        console.error('Failed to close session:', e)
      }
    }
    set(state => {
      const newSessions = state.sessions.filter(s => s.sessionId !== sessionId)
      return {
        sessions: newSessions,
        activeSessionId: state.activeSessionId === sessionId 
          ? (newSessions[0]?.sessionId || null) 
          : state.activeSessionId
      }
    })
  },

  setActiveSession: (sessionId: string) => {
    set({ activeSessionId: sessionId })
  }
}))
"""

files['src/renderer/components/docs/panels/DiffConfirmDialog.tsx'] = """import React, { useState } from 'react'
import type { DocsSessionMetadata } from '../../../../shared/docs-ipc'
import { getDocsBridge, isSaveAvailable } from '../docsBridge'

interface DiffConfirmDialogProps {
  session: DocsSessionMetadata
  transactionId?: string
  isOpen: boolean
  onConfirm: () => void
  onCancel: () => void
}

export const DiffConfirmDialog: React.FC<DiffConfirmDialogProps> = ({ session, transactionId, isOpen, onConfirm, onCancel }) => {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  if (!isOpen) return null

  const handleConfirm = async () => {
    const bridge = getDocsBridge()
    if (!bridge) {
      setToast({ message: 'Demo mode: Save is a no-op', type: 'error' })
      setTimeout(() => {
        setToast(null)
        onConfirm()
      }, 2000)
      return
    }

    if (!transactionId) {
      setToast({ message: 'No staged transaction to commit', type: 'error' })
      setTimeout(() => setToast(null), 2000)
      return
    }

    try {
      await bridge.commitPlan({
        sessionId: session.sessionId,
        transactionId,
        expectedRevision: session.revision,
        userConfirmed: true,
      })
      onConfirm()
    } catch (e) {
      console.error('Failed to commit plan:', e)
      setToast({ message: 'Failed to save changes', type: 'error' })
      setTimeout(() => setToast(null), 2000)
    }
  }

  const canSave = isSaveAvailable(session.capabilities)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[600px] bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl flex flex-col overflow-hidden relative">
        {toast && (
          <div className={`absolute top-4 right-4 p-3 text-xs rounded border shadow-lg z-50 transition-opacity ${toast.type === 'success' ? 'bg-green-950 border-green-500/50 text-green-300' : 'bg-red-950 border-red-500/50 text-red-300'}`}>
            {toast.message}
          </div>
        )}
        <div className="p-4 border-b border-neutral-800">
          <h2 className="text-lg font-bold text-white">Review Changes</h2>
          <p className="text-sm text-neutral-400 mt-1">Session: {session.sessionId}</p>
        </div>
        
        <div className="p-4 h-64 overflow-y-auto bg-neutral-950">
          <div className="text-sm font-mono text-neutral-300">
            <span className="text-red-400">- Original text example</span><br/>
            <span className="text-green-400">+ AI modified text example</span>
          </div>
        </div>

        <div className="p-4 border-t border-neutral-800 flex items-center justify-end gap-3 bg-neutral-900">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-neutral-300 hover:text-white hover:bg-neutral-800 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canSave}
            className={`px-4 py-2 text-sm font-medium rounded transition-colors ${
              canSave 
                ? 'bg-blue-600 hover:bg-blue-500 text-white' 
                : 'bg-neutral-700 text-neutral-500 cursor-not-allowed'
            }`}
          >
            Approve & Save
          </button>
        </div>
      </div>
    </div>
  )
}
"""

files['src/renderer/components/docs/DocViewer.tsx'] = """import React, { useState } from 'react'
import { useDocsStore } from '../../store/useDocsStore'
import { UniverSheetHost } from './viewers/UniverSheetHost'
import { PdfViewerHost } from './viewers/PdfViewerHost'
import { HwpxEditPanel } from './panels/HwpxEditPanel'
import { DiffConfirmDialog } from './panels/DiffConfirmDialog'
import { isSaveAvailable } from './docsBridge'
import { ArrowLeft } from 'lucide-react'

export const DocViewer: React.FC = () => {
  const { sessions, activeSessionId, setActiveSession } = useDocsStore()
  const [showDiff, setShowDiff] = useState(false)
  const [transactionId, setTransactionId] = useState<string | undefined>(undefined)

  const activeSession = sessions.find(s => s.sessionId === activeSessionId)

  if (!activeSession) {
    return null
  }

  const canSave = isSaveAvailable(activeSession.capabilities)

  const renderViewer = () => {
    switch (activeSession.format) {
      case 'xlsx':
        return <UniverSheetHost session={activeSession} />
      case 'pdf':
        return <PdfViewerHost session={activeSession} />
      case 'hwpx':
      case 'docx':
      case 'pptx':
      case 'hwp':
      default:
        return (
          <div className="flex-1 flex items-center justify-center bg-white text-neutral-800">
            <div className="text-center">
              <h2 className="text-xl font-bold uppercase">{activeSession.format} Viewer</h2>
              <p className="mt-2 text-neutral-500">Render artifact mapped here</p>
            </div>
          </div>
        )
    }
  }

  return (
    <div className="flex flex-col h-full bg-neutral-900 text-white overflow-hidden">
      <div className="h-12 border-b border-neutral-800 flex items-center px-4 justify-between bg-neutral-950 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveSession('')}
            className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-white transition-colors"
            title="Back to Docs Home"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="font-semibold">{activeSession.sourceHash || activeSession.sessionId}</span>
          <span className="px-2 py-0.5 rounded bg-neutral-800 uppercase text-xs font-medium text-neutral-400">
            {activeSession.format}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {activeSession.format === 'hwpx' && canSave && (
            <button
              onClick={() => {
                setTransactionId(undefined)
                setShowDiff(true)
              }}
              className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 rounded transition-colors"
            >
              Simulate Diff
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {renderViewer()}
        {activeSession.format === 'hwpx' && (
          <HwpxEditPanel session={activeSession} />
        )}
      </div>

      <DiffConfirmDialog
        session={activeSession}
        transactionId={transactionId}
        isOpen={showDiff}
        onConfirm={() => setShowDiff(false)}
        onCancel={() => setShowDiff(false)}
      />
    </div>
  )
}
"""

files['src/renderer/components/docs/viewers/PdfViewerHost.tsx'] = """import React, { useEffect, useRef, useState } from 'react'
import type { DocsSessionMetadata } from '../../../../shared/docs-ipc'
import { getDocsBridge } from '../docsBridge'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

const HEX_HASH_RE = /^[0-9a-f]{64}$/i

function isLoadablePreviewToken(token: string): boolean {
  return (
    token.startsWith('data:') ||
    token.startsWith('blob:') ||
    token.startsWith('http://') ||
    token.startsWith('https://')
  )
}

interface PdfViewerHostProps {
  session: DocsSessionMetadata
}

export const PdfViewerHost: React.FC<PdfViewerHostProps> = ({ session }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hashToken, setHashToken] = useState<string | null>(null)
  const bridge = getDocsBridge()

  useEffect(() => {
    let active = true

    const loadPdf = async () => {
      if (!bridge) {
        setLoading(false)
        return
      }

      try {
        const preview = await bridge.getPreview({
          sessionId: session.sessionId,
          expectedRevision: session.revision
        })
        if (!active) return

        const token = preview.token
        if (HEX_HASH_RE.test(token)) {
          setHashToken(token)
          setLoading(false)
          return
        }

        if (!isLoadablePreviewToken(token)) {
          setError(`Preview token is not a loadable URL: ${token.slice(0, 32)}…`)
          setLoading(false)
          return
        }

        const loadingTask = pdfjsLib.getDocument({ url: token })
        const pdf = await loadingTask.promise
        if (!active) return

        const page = await pdf.getPage(1)
        if (!active) return

        const viewport = page.getViewport({ scale: 1.5 })
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width

        if (containerRef.current) {
          await page.render({ canvas, viewport }).promise
          if (active) {
            containerRef.current.innerHTML = ''
            containerRef.current.appendChild(canvas)
            setLoading(false)
          }
        }
      } catch (err) {
        if (active) {
          setError(String(err))
          setLoading(false)
        }
      }
    }

    loadPdf()

    return () => {
      active = false
    }
  }, [session.sessionId, session.revision, bridge])

  return (
    <div className="flex-1 w-full h-full bg-neutral-100 flex flex-col text-neutral-800">
      <div className="h-12 bg-neutral-200 border-b border-neutral-300 flex items-center px-4 gap-4">
        <span className="font-medium text-sm">PDF Toolbar Skeleton</span>
        <button className="px-2 py-1 bg-white rounded shadow-sm text-xs font-medium">Highlight</button>
        <button className="px-2 py-1 bg-white rounded shadow-sm text-xs font-medium">Comment</button>
      </div>
      <div className="flex-1 flex items-center justify-center overflow-auto p-4 relative">
        {loading && <p>Loading PDF...</p>}
        {error && <p className="text-red-500">Failed to load PDF: {error}</p>}
        {hashToken && (
          <div className="text-center max-w-md">
            <p className="font-bold text-lg mb-2">Preview token received</p>
            <p className="text-sm text-neutral-600">
              Core returned a content hash; renderer cannot load bytes from hash alone.
            </p>
            <p className="text-xs font-mono mt-2 text-neutral-500 break-all">{hashToken}</p>
          </div>
        )}
        <div ref={containerRef} className="shadow-lg bg-white" />
        
        {!bridge && !loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-100">
            <div className="text-center">
              <p className="font-bold text-lg mb-2">PDF.js Viewer</p>
              <p className="text-sm">Session: {session.sessionId}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
"""

files['src/renderer/components/docs/viewers/UniverSheetHost.tsx'] = """import React, { useEffect, useRef } from 'react'
import type { DocsSessionMetadata } from '../../../../shared/docs-ipc'
import { getDocsBridge } from '../docsBridge'
import { createUniver, defaultTheme } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/presets/preset-sheets-core'
import '@univerjs/presets/lib/styles/preset-sheets-core.css'

interface UniverSheetHostProps {
  session: DocsSessionMetadata
}

export const UniverSheetHost: React.FC<UniverSheetHostProps> = ({ session }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const bridge = getDocsBridge()

  useEffect(() => {
    if (!containerRef.current) return

    const { univer, univerAPI } = createUniver({
      theme: defaultTheme,
      presets: [
        UniverSheetsCorePreset({
          container: containerRef.current,
        }),
      ],
    })

    const workbook = univerAPI.createWorkbook({
      id: 'demo-sheet',
      name: 'Demo Sheet',
      sheets: {
        'sheet-01': {
          id: 'sheet-01',
          name: 'Demo',
          cellData: {
            0: { 0: { v: 'nova-docs demo (read-only)' } },
            1: { 0: { v: 'Format' }, 1: { v: 'xlsx' } },
            2: { 0: { v: 'Session' }, 1: { v: session.sessionId } },
          },
        },
      },
    })
    // Read-only demo scope: block edits until the real bridge-backed model lands.
    workbook.setEditable(false)

    return () => {
      univer.dispose()
    }
  }, [session.sessionId])

  return (
    <div className="flex-1 w-full h-full bg-white flex flex-col relative text-neutral-500">
      {!bridge && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 bg-white/80">
          <div className="text-center">
            <p className="font-bold text-lg mb-2">Univer Sheet Host (Demo)</p>
            <p className="text-sm">Session: {session.sessionId}</p>
            <p className="text-sm mt-4">Canvas embedded here. Changes emitted via docs-ipc type.</p>
          </div>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
}
"""

for rel, content in files.items():
    path = base / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    print(f'WROTE {rel} ({len(content)} bytes)')

print('ALL_DONE')
