#!/bin/bash
set -e
FILE=/Users/nova-ai/project/nova-ax/src/core/verification-authority.test.ts
python3 << 'PY'
from pathlib import Path
p = Path("/Users/nova-ai/project/nova-ax/src/core/verification-authority.test.ts")
text = p.read_text()
broken = """      ncoPriority: NCO_DIRECTIVE_PRIORITY,

    const directiveDelivery"""
fixed = """      ncoPriority: NCO_DIRECTIVE_PRIORITY,
    });
    const directiveDelivery"""
if broken in text:
    text = text.replace(broken, fixed, 1)
    p.write_text(text)
    print("fixed test 15 syntax")
else:
    print("pattern not found")
PY
