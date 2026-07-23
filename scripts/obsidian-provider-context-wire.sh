#!/usr/bin/env bash
# obsidian-provider-context-wire.sh — 각 프로바이더 컨텍스트 진입점에 SECOND-BRAIN.md '포인터'를 주입.
# 전체 임베드 대신 tiny 포인터(미러 재유입·토큰폭증 방지). 네이티브 기구가 있으면 그걸 사용.
# 근거: Fable 어드바이저 T1 조사(프로바이더별 진입점·미러루프 리스크).
set -euo pipefail
VAULT="/Users/nova-ai/obsidian/mac-obsidian"
SB="$VAULT/00-SYSTEM/SECOND-BRAIN.md"
[ -f "$SB" ] || { echo "[wire] SECOND-BRAIN.md 없음 — skip"; exit 0; }
BEG="<!-- NCO-SECOND-BRAIN:BEGIN -->"
END="<!-- NCO-SECOND-BRAIN:END -->"

POINTER="$BEG
> 🧠 NCO 공용 2번째 뇌(Obsidian). 비자명한 작업 전 반드시 아래 파일을 Read하라:
> \`$SB\`
> (전 프로바이더 공용 지식: NCO 규칙·검증영수증·워크플로·런타임. 편집은 vault 원본에서.)
$END"

# 마커 블록 멱등 주입(포인터만 — tiny). python으로 멀티라인 안전 치환.
inject_pointer() {
  local target="$1"
  mkdir -p "$(dirname "$target")"
  POINTER="$POINTER" BEG="$BEG" END="$END" TARGET="$target" python3 - <<'PY'
import os,re
t=os.environ["TARGET"]; beg=os.environ["BEG"]; end=os.environ["END"]; ptr=os.environ["POINTER"]
try: cur=open(t,encoding="utf-8").read()
except FileNotFoundError: cur=""
pat=re.compile(re.escape(beg)+r".*?"+re.escape(end), re.S)
if pat.search(cur):
    new=pat.sub(lambda m: ptr, cur)
else:
    new=(cur.rstrip()+"\n\n"+ptr+"\n") if cur.strip() else ptr+"\n"
open(t,"w",encoding="utf-8").write(new)
PY
  echo "  ✓ ${target/#$HOME/~} ($(wc -l < "$target")행)"
}

echo "[wire] SECOND-BRAIN 포인터 주입 (tiny)"
inject_pointer "$HOME/.codex/AGENTS.md"                               # codex: AGENTS.md 포인터
inject_pointer "$HOME/.gemini/GEMINI.md"                              # gemini/antigravity: GEMINI.md 포인터
# cursor: .mdc + frontmatter(alwaysApply) 필요 → 파일 없으면 frontmatter 선주입
CURSOR_MDC="$HOME/.cursor/rules/nco-second-brain.mdc"
[ -f "$CURSOR_MDC" ] || { mkdir -p "$(dirname "$CURSOR_MDC")"; printf -- '---\nalwaysApply: true\n---\n' > "$CURSOR_MDC"; }
inject_pointer "$CURSOR_MDC"

# opencode: 네이티브 instructions[] (선언적) — opencode.json에 SB 경로 추가
OC="$HOME/.config/opencode/opencode.json"
if [ -f "$OC" ]; then
  python3 - "$OC" "$SB" <<'PY'
import json,sys
p,sb=sys.argv[1],sys.argv[2]
try: d=json.load(open(p))
except Exception: d={}
ins=d.get("instructions") or []
if not isinstance(ins,list): ins=[ins]
if sb not in ins: ins.append(sb)
d["instructions"]=ins
json.dump(d,open(p,"w"),ensure_ascii=False,indent=2)
print("  ✓ opencode.json instructions[] += SECOND-BRAIN")
PY
fi

# aider: 네이티브 read: (전체 내용 로드 — aider는 이게 저렴) — conf에 없을 때만 추가
ACONF="$HOME/.aider.conf.yml"
if [ -f "$ACONF" ] && ! grep -q "SECOND-BRAIN.md" "$ACONF" 2>/dev/null; then
  if ! grep -qE '^\s*read\s*:' "$ACONF"; then
    printf '\n# NCO 2번째 뇌\nread:\n  - %s\n' "$SB" >> "$ACONF"
    echo "  ✓ ~/.aider.conf.yml read: += SECOND-BRAIN"
  else
    echo "  ! ~/.aider.conf.yml 이미 read: 존재 — 수동으로 '$SB' 추가 필요"
  fi
fi

# ollama: 파일 진입점 없음(모델서버) → NCO 호출측(ai-providers.json persona)에서 주입 필요. 여기선 N/A.
# claude-code: 기존 obsidian-context-inject 훅 담당(수정은 nova-fleet-config에서) → skip.
echo "[wire] 완료 (codex·gemini·cursor=포인터 / opencode·aider=네이티브 / ollama=NCO측 / claude=훅)"
