import React, { useState, useEffect } from 'react'
import type { DocsSessionMetadata } from '../../../../shared/docs-ipc'
import { getDocsBridge } from '../docsBridge'
import type { EditPlanCommand } from '../../../../docs/ai/editplan-schema'

interface HwpxEditPanelProps {
  session: DocsSessionMetadata
}

type HwpxOp = 'replaceText' | 'insertTableRow' | 'deleteTableRow' | 'updateTableCell'

export const HwpxEditPanel: React.FC<HwpxEditPanelProps> = ({ session }) => {
  const bridge = getDocsBridge()
  const [op, setOp] = useState<HwpxOp>('replaceText')
  const [text, setText] = useState('')
  const [tableId, setTableId] = useState('')
  const [rowIndex, setRowIndex] = useState(0)
  const [colIndex, setColIndex] = useState(0)
  const [blockId, setBlockId] = useState('')
  const [targetHash, setTargetHash] = useState('')
  const [expectedText, setExpectedText] = useState('')

  const editCap = session.capabilities.capabilities.find(c => c.name === 'edit')
  const canEdit = editCap?.status === 'available'
  const editReason = editCap?.reason || 'Edit not supported'

  const tableCellBlockId =
    tableId !== ''
      ? `table:${tableId}:cell:${rowIndex}:${colIndex}`
      : ''

  useEffect(() => {
    const handleSave = (e: Event) => {
      const ev = e as CustomEvent
      if (ev.detail.sessionId === session.sessionId) {
        console.log('HWPX save triggered')
      }
    }
    window.addEventListener('docs:triggerSave', handleSave)
    return () => window.removeEventListener('docs:triggerSave', handleSave)
  }, [session.sessionId])

  const handleApply = async () => {
    if (!bridge || !canEdit) return

    let command: EditPlanCommand = {
      commandId: `cmd-${Date.now()}`,
      op: 'replaceText',
      target: {},
      precondition: { revision: session.revision, targetHash, expectedText },
      args: {}
    }

    if (op === 'replaceText') {
      command.op = 'replaceText'
      command.target = { blockId }
      command.args = { text }
    } else if (op === 'insertTableRow' || op === 'deleteTableRow' || op === 'updateTableCell') {
      command.op = op
      command.target = { blockId: `table:${tableId}:cell:${rowIndex}:${colIndex}` }
      command.args = op === 'updateTableCell' ? { text } : {}
    }

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
          commands: [command]
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

  return (
    <div className="w-80 h-full border-l border-neutral-800 bg-neutral-900 flex flex-col text-neutral-200">
      <div className="p-4 border-b border-neutral-800">
        <h3 className="font-bold text-sm">HWPX Edit Panel</h3>
        <p className="text-xs text-neutral-400 mt-1">Session: {session.sessionId}</p>
        <p className="text-xs text-neutral-400 mt-1">Selection-based edits</p>
      </div>
      <div className="flex-1 p-4 flex flex-col gap-4 overflow-y-auto">
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
            placeholder="Hash..."
            value={targetHash}
            onChange={e => setTargetHash(e.target.value)}
            disabled={!canEdit}
          />
          <label className="text-xs font-medium text-neutral-400">Expected Text (Precondition)</label>
          <textarea
            className="w-full h-16 bg-neutral-950 border border-neutral-800 rounded p-2 text-sm resize-none focus:outline-none focus:border-blue-500"
            placeholder="Expected text..."
            value={expectedText}
            onChange={e => setExpectedText(e.target.value)}
            disabled={!canEdit}
          />
        </div>

        {op === 'replaceText' && (
          <>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-neutral-400">Block ID</label>
              <input
                type="text"
                className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none focus:border-blue-500"
                placeholder="block-id"
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
              value={tableId}
              onChange={e => setTableId(e.target.value)}
              disabled={!canEdit}
            />

            <label className="text-xs font-medium text-neutral-400">Row Index (anchor cell)</label>
            <input
              type="number"
              className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none focus:border-blue-500"
              value={rowIndex}
              onChange={e => setRowIndex(parseInt(e.target.value))}
              disabled={!canEdit}
            />

            <label className="text-xs font-medium text-neutral-400">Col Index (anchor cell)</label>
            <input
              type="number"
              className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm focus:outline-none focus:border-blue-500"
              value={colIndex}
              onChange={e => setColIndex(parseInt(e.target.value))}
              disabled={!canEdit}
            />

            <label className="text-xs font-medium text-neutral-400">Synthesized Block ID</label>
            <input
              type="text"
              readOnly
              className="w-full bg-neutral-950 border border-neutral-800 rounded p-2 text-sm text-neutral-400 focus:outline-none"
              placeholder="table:0:cell:0:0"
              value={tableCellBlockId}
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

        <div className="mt-auto" title={!canEdit ? editReason : undefined}>
          <button 
            className={`w-full font-medium py-2 rounded transition-colors text-sm ${
              canEdit 
                ? 'bg-blue-600 hover:bg-blue-500 text-white' 
                : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
            }`}
            onClick={handleApply}
            disabled={!canEdit}
          >
            Preview Changes
          </button>
        </div>
      </div>
    </div>
  )
}
