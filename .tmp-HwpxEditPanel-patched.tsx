import React, { useEffect, useRef, useState } from 'react'
import type { DocsSearchResult, DocsSessionMetadata } from '../../../../shared/docs-ipc'
import { getDocsBridge } from '../docsBridge'
import type { EditPlanCommand } from '../../../../docs/ai/editplan-schema'
import { SHA256_HEX, TABLE_CELL_BLOCK_ID, isCompleteSnippet, sha256Hex } from '../blockSelection'

interface HwpxEditPanelProps {
  session: DocsSessionMetadata
}

type HwpxOp = 'replaceText' | 'insertTableRow' | 'deleteTableRow' | 'updateTableCell'

export const HwpxEditPanel: React.FC<HwpxEditPanelProps> = ({ session }) => {
  const bridge = getDocsBridge()
  const [op, setOp] = useState<HwpxOp>('replaceText')
  const [text, setText] = useState('')
  const [tableIndex, setTableIndex] = useState(0)
  const [rowIndex, setRowIndex] = useState(0)
  const [colIndex, setColIndex] = useState(0)
  const [blockId, setBlockId] = useState('')
  const [targetHash, setTargetHash] = useState('')
  const [expectedText, setExpectedText] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DocsSearchResult[]>([])
  const [truncatedSelection, setTruncatedSelection] = useState(false)

  const editCap = session.capabilities.capabilities.find(c => c.name === 'edit')
  const canEdit = editCap?.status === 'available'
  const editReason = editCap?.reason || 'Edit not supported'
  const tableCellBlockId = `table:${tableIndex}:cell:${rowIndex}:${colIndex}`
  const targetBlockId = op === 'replaceText' ? blockId : tableCellBlockId
  const hasPreconditions = SHA256_HEX.test(targetHash)
  const canApply = canEdit && targetBlockId.length > 0 && hasPreconditions
  const applyBlockedReason = !canEdit
    ? editReason
    : !targetBlockId
      ? 'Select or enter a target block first'
      : !hasPreconditions
        ? 'Preconditions require a 64-hex target hash (pick a block from search)'
        : undefined

  // Search results are bound to the revision they were fetched at.
  useEffect(() => {
    setResults([])
  }, [session.sessionId, session.revision])

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!bridge || !query.trim()) return
    try {
      setResults(await bridge.search({
        sessionId: session.sessionId,
        expectedRevision: session.revision,
        query: query.trim(),
      }))
    } catch (err) {
      console.error('HWPX block search failed:', err)
    }
  }

  const handleSelect = async (result: DocsSearchResult) => {
    setBlockId(result.blockId)
    const cell = TABLE_CELL_BLOCK_ID.exec(result.blockId)
    if (cell) {
      setTableIndex(Number(cell[1]))
      setRowIndex(Number(cell[2]))
      setColIndex(Number(cell[3]))
    }
    setExpectedText(result.snippet)
    setTruncatedSelection(!isCompleteSnippet(result))
    setTargetHash(await sha256Hex(result.snippet))
  }

  const buildCommand = (): EditPlanCommand => {
    const base = {
      commandId: `cmd-${Date.now()}`,
      precondition: { revision: session.revision, targetHash, expectedText },
    }
    switch (op) {
      case 'replaceText':
        return { ...base, op, target: { blockId }, args: { text } }
      case 'insertTableRow':
      case 'deleteTableRow':
      case 'updateTableCell':
        return { ...base, op, target: { blockId: tableCellBlockId }, args: op === 'updateTableCell' ? { text } : {} }
    }
  }

  const handleApply = async () => {
    if (!bridge || !canApply) return
    try {
      const planId = `plan-${Date.now()}`
      const proposal = await bridge.proposePlan({
        sessionId: session.sessionId,
        plan: {
          planId,
          sessionId: session.sessionId,
          baseRevision: session.revision,
          sourceHash: session.sourceHash,
          intent: `Apply ${op}`,
          commands: [buildCommand()]
        }
      })
      const staged = await bridge.stagePlan({
        sessionId: session.sessionId,
        planId: proposal.plan.planId
      })
      window.dispatchEvent(new CustomEvent('docs:showDiff', {
        detail: { transactionId: staged.transaction.transactionId, changeLog: staged.transaction.changeLog }
      }))
    } catch (e) {
      console.error(`Failed to apply ${op}:`, e)
    }
  }

  const applyRef = useRef<() => void>(() => {})
  applyRef.current = () => { void handleApply() }

  useEffect(() => {
    const handleSave = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail
      if (detail?.sessionId === session.sessionId) {
        applyRef.current()
      }
    }
    window.addEventListener('docs:triggerSave', handleSave)
    return () => window.removeEventListener('docs:triggerSave', handleSave)
  }, [session.sessionId])

  return (
    <div className="w-80 h-full border-l border-neutral-800 bg-neutral-900 flex flex-col text-neutral-200">
      <div className="p-4 border-b border-neutral-800">
        <h3 className="font-bold text-sm">HWPX Edit Panel</h3>
        <p className="text-xs text-neutral-400 mt-1">Session: {session.sessionId}</p>
        <p className="text-xs text-neutral-400 mt-1">Selection-based edits</p>
      </div>
      <div className="flex-1 p-4 flex flex-col gap-4 overflow-y-auto">
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-neutral-400">Find Block</label>
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              type="text"
              className="flex-1 bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none focus:border-blue-500"
              placeholder="Search document text..."
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            <button
              type="submit"
              className="px-3 py-1 rounded text-sm bg-neutral-800 hover:bg-neutral-700"
            >
              Search
            </button>
          </form>
          {results.length > 0 && (
            <div className="max-h-40 overflow-y-auto border border-neutral-800 rounded">
              {results.map(result => (
                <div
                  key={result.blockId}
                  onClick={() => { void handleSelect(result) }}
                  className={`p-2 cursor-pointer text-xs border-b border-neutral-800 last:border-b-0 ${
                    blockId === result.blockId ? 'bg-blue-950 text-blue-200' : 'hover:bg-neutral-800'
                  }`}
                  title={result.snippet}
                >
                  <div className="font-mono text-neutral-400">{result.blockId}</div>
                  <div className="truncate">{result.snippet}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-neutral-400">Operation</label>
          <select
            className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none focus:border-blue-500"
            value={op}
            onChange={(e) => setOp(e.target.value as HwpxOp)}
            disabled={!canEdit}
          >
            <option value="replaceText">Replace Text</option>
            <option value="insertTableRow">Insert Table Row</option>
            <option value="deleteTableRow">Delete Table Row</option>
            <option value="updateTableCell">Update Table Cell</option>
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-neutral-400">Target Hash (Precondition)</label>
          <input
            type="text"
            className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="Auto-filled from block selection"
            value={targetHash}
            onChange={e => setTargetHash(e.target.value)}
            disabled={!canEdit}
          />
          <label className="text-xs font-medium text-neutral-400">Expected Text (Precondition)</label>
          <textarea
            className="w-full h-16 bg-neutral-950 border border-neutral-800 rounded p-2 text-sm resize-none focus:outline-none focus:border-blue-500"
            placeholder="Auto-filled from block selection"
            value={expectedText}
            onChange={e => setExpectedText(e.target.value)}
            disabled={!canEdit}
          />
          {truncatedSelection && (
            <div className="p-2 bg-neutral-800 text-yellow-500 rounded text-xs border border-yellow-700/50">
              Block text exceeds the search snippet limit; preconditions may not match the full block.
            </div>
          )}
        </div>

        {op === 'replaceText' && (
          <>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-neutral-400">Block ID</label>
              <input
                type="text"
                className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none focus:border-blue-500"
                placeholder="paragraph:0"
                value={blockId}
                onChange={e => setBlockId(e.target.value)}
                disabled={!canEdit}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-neutral-400">Proposed Change</label>
              <textarea
                className="w-full h-32 bg-neutral-950 border border-neutral-800 rounded p-2 text-sm resize-none focus:outline-none focus:border-blue-500"
                placeholder="Edit selected content..."
                value={text}
                onChange={e => setText(e.target.value)}
                disabled={!canEdit}
              />
            </div>
          </>
        )}

        {op !== 'replaceText' && (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-neutral-400">Table Index (numeric)</label>
            <input
              type="text"
              inputMode="numeric"
              className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none focus:border-blue-500"
              placeholder="0"
              value={tableIndex}
              onChange={e => setTableIndex(Math.max(0, parseInt(e.target.value) || 0))}
              disabled={!canEdit}
            />

            <label className="text-xs font-medium text-neutral-400">Row Index (anchor cell)</label>
            <input
              type="number"
              min={0}
              className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none focus:border-blue-500"
              value={rowIndex}
              onChange={e => setRowIndex(Math.max(0, parseInt(e.target.value) || 0))}
              disabled={!canEdit}
            />

            <label className="text-xs font-medium text-neutral-400">Col Index (anchor cell)</label>
            <input
              type="number"
              min={0}
              className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none focus:border-blue-500"
              value={colIndex}
              onChange={e => setColIndex(Math.max(0, parseInt(e.target.value) || 0))}
              disabled={!canEdit}
            />

            <label className="text-xs font-medium text-neutral-400">Synthesized Block ID</label>
            <input
              type="text"
              readOnly
              className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none text-neutral-500"
              placeholder="table:0:cell:0:0"
              value={tableCellBlockId}
              disabled={!canEdit}
            />

            {op === 'updateTableCell' && (
              <>
                <label className="text-xs font-medium text-neutral-400">Cell Text</label>
                <textarea
                  className="w-full h-24 bg-neutral-950 border border-neutral-800 rounded p-2 text-sm resize-none focus:outline-none focus:border-blue-500"
                  placeholder="Cell content..."
                  value={text}
                  onChange={e => setText(e.target.value)}
                  disabled={!canEdit}
                />
              </>
            )}
          </div>
        )}

        {!canEdit && (
          <div className="mt-2 p-2 bg-neutral-800 text-yellow-500 rounded text-xs border border-yellow-700/50">
            <strong>Read-only:</strong> {editReason}
          </div>
        )}

        <div className="mt-auto" title={applyBlockedReason}>
          <button
            className={`w-full font-medium py-2 rounded transition-colors text-sm ${
              canApply
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
            }`}
            onClick={() => { void handleApply() }}
            disabled={!canApply}
          >
            Preview Changes
          </button>
        </div>
      </div>
    </div>
  )
}
