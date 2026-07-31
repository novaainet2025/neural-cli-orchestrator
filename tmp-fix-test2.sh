#!/bin/bash
python3 << 'PY'
from pathlib import Path
p = Path("/Users/nova-ai/project/nova-ax/src/core/verification-authority.test.ts")
text = p.read_text()
text = text.replace(
    "        calls.push({\n"
    "          type: directive?.type || \"unknown\",\n"
    "          priority,\n"
    "          prompt,\n"
    "        });",
    "        calls.push({\n"
    "          type: directive?.type || \"unknown\",\n"
    "          priority: priority ?? -1,\n"
    "          prompt,\n"
    "        });",
    1,
)
p.write_text(text)
print("fixed priority type")
PY
