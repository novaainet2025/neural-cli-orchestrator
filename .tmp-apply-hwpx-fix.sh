#!/usr/bin/env bash
set -euo pipefail
FILE=/Users/nova-ai/project/nova-use/src/renderer/components/docs/panels/HwpxEditPanel.tsx
python3 - <<'PY'
from pathlib import Path
path = Path("/Users/nova-ai/project/nova-use/src/renderer/components/docs/panels/HwpxEditPanel.tsx")
text = path.read_text()
old = """  const tableCellBlockId = `table:${tableIndex}:cell:${rowIndex}:${colIndex}`
  const targetBlockId = op === 'replaceText' ? blockId : tableCellBlockId
  const hasPreconditions = SHA256_HEX.test(targetHash)
  const canApply = canEdit && targetBlockId.length > 0 && hasPreconditions
  const applyBlockedReason = !canEdit
    ? editReason
    : !targetBlockId
      ? 'Select or enter a target block first'
      : !hasPreconditions
        ? 'Preconditions require a 64-hex target hash (pick a block from search)'
        : undefined"""
new = """  const tableCellBlockId = `table:${tableIndex}:cell:${rowIndex}:${colIndex}`
  const targetBlockId = op === 'replaceText' ? blockId : tableCellBlockId
  // M6: manual plans require both targetHash (64-hex) and expectedText from the selected block.
  const hasPreconditions = SHA256_HEX.test(targetHash) && expectedText.length > 0
  const canApply = canEdit && targetBlockId.length > 0 && hasPreconditions
  const applyBlockedReason = !canEdit
    ? editReason
    : !targetBlockId
      ? 'Select or enter a target block first'
      : !SHA256_HEX.test(targetHash)
        ? 'Preconditions require a 64-hex target hash (pick a block from search)'
        : expectedText.length === 0
          ? 'Preconditions require expectedText from the selected block'
          : undefined"""
if old not in text:
    if "expectedText.length > 0" in text and "SHA256_HEX.test(targetHash) && expectedText.length > 0" in text:
        print("ALREADY_PATCHED")
    else:
        raise SystemExit("PATCH_TARGET_NOT_FOUND")
else:
    path.write_text(text.replace(old, new, 1))
    print("PATCHED_OK")
PY

bash /Users/nova-ai/project/nco/.tmp-nova-use-docs-verify-exact.sh
