#!/bin/bash
# UserPromptSubmit Hook: NCO context + CLI Mesh heartbeat
# Purpose: Report work, detect conflicts, receive messages from other CLIs
# Rule: Never exit 2

INPUT=$(cat)

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/Users/nova-ai/project/nco}"

# Resolve NCO_SESSION_ID: env var > process tree walk
if [ -z "$NCO_SESSION_ID" ]; then
  _CK=$$
  for _i in 1 2 3 4 5; do
    _CK=$(ps -o ppid= -p "$_CK" 2>/dev/null | tr -d ' ')
    [ -z "$_CK" ] && break
    _CM=$(ps -o comm= -p "$_CK" 2>/dev/null)
    if echo "$_CM" | grep -qE '^(claude|node)$'; then
      NCO_SESSION_ID="$_CK"
      break
    fi
  done
  NCO_SESSION_ID="${NCO_SESSION_ID:-${PPID:-$$}}"
fi

# Resolve NCO_NAME: env var > PID-file reservation
if [ -z "$NCO_NAME" ]; then
  for _pf in /tmp/nco-names/claude-*.pid; do
    [ -f "$_pf" ] || continue
    _rp=$(cat "$_pf" 2>/dev/null | tr -d '[:space:]')
    if [ "$_rp" = "$NCO_SESSION_ID" ]; then
      NCO_NAME=$(basename "$_pf" .pid)
      break
    fi
  done
fi
MY_NAME="${NCO_NAME:-cli}"

# ─── Claude-Gemma (MLX 프록시 4100): 토큰 절약 규칙 자동 주입 (세션당 1회, 슬래시 명령 불필요)
GEMMA_MODE=0
if echo "${ANTHROPIC_BASE_URL:-}" | grep -q '4100'; then GEMMA_MODE=1; fi
if [ "$GEMMA_MODE" -eq 0 ]; then
  curl -sf --connect-timeout 1 --max-time 2 http://127.0.0.1:4100/health >/dev/null 2>&1 && GEMMA_MODE=1
fi
GEMMA_APPEND=""
if [ "$GEMMA_MODE" -eq 1 ]; then
  _SID="${NCO_SESSION_ID:-${PPID:-$$}}"
  _GTOK="/tmp/nco-gemma-tok-${_SID}"
  if [ ! -f "$_GTOK" ]; then
    GEMMA_APPEND=" [AUTO_GEMMA:mlx] 슬래시명령 없이 적용. 검증=bash ${PROJECT_DIR}/cli-installs/gemma-gate-check.sh . (--no-plan|--plan 파일). 장문리뷰·전체재탐색 금지. 출력 최소. 설계난해시 advisor 1회."
    touch "$_GTOK" 2>/dev/null || true
  fi
fi

# NCO health check (2s max)
NCO_HEALTH=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/health 2>/dev/null)

if [ -n "$NCO_HEALTH" ]; then
    PROVIDER_COUNT=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/api/ai-providers 2>/dev/null | grep -o '"id"' | wc -l 2>/dev/null || echo "?")

    # Session state
    NCO_SESSION_DIR="/tmp/nco-sessions"
    NCO_SESSION_FILE="$NCO_SESSION_DIR/$NCO_SESSION_ID.json"

    # ─── Mesh Heartbeat ───────────────────────────
    BRANCH=$(cd "$PROJECT_DIR" 2>/dev/null && git branch --show-current 2>/dev/null || echo "unknown")
    CHANGED_LIST=$(cd "$PROJECT_DIR" 2>/dev/null && git diff --name-only 2>/dev/null | head -5 | tr '\n' ',' | sed 's/,$//')
    FILES_JSON=$(echo "$CHANGED_LIST" | python3 -c "import sys; f=sys.stdin.read().strip(); print('['+','.join(['\"'+x+'\"' for x in f.split(',') if x])+']')" 2>/dev/null || echo "[]")
    PROMPT_PREVIEW=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('userMessage','')[:80])" 2>/dev/null || echo "")

    MESH_HB=$(curl -s --connect-timeout 1 --max-time 2 -X POST http://localhost:6200/api/mesh/heartbeat \
      -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"$NCO_SESSION_ID\",\"agentId\":\"$MY_NAME\",\"pid\":$NCO_SESSION_ID,\"status\":\"coding\",\"currentWork\":\"$(echo "$PROMPT_PREVIEW" | sed 's/"/\\"/g' | sed "s/'/\\\\'/g")\",\"currentFiles\":$FILES_JSON,\"branch\":\"$BRANCH\"}" 2>/dev/null)

    # Extract conflicts
    MESH_CONFLICTS=$(echo "$MESH_HB" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('conflicts',[]); print('; '.join(c)) if c else print('')" 2>/dev/null || echo "")

    # Extract pending messages (full content for Claude to read)
    MESH_MSG_TEXT=$(echo "$MESH_HB" | python3 -c "
import sys,json
d=json.load(sys.stdin)
msgs=d.get('messages',[])
if not msgs:
    print('')
else:
    lines=[]
    for m in msgs:
        t=m.get('type','info').upper()
        f=m.get('fromAgent','?')
        c=m.get('content','')
        lines.append(f'[{t}] {f}: {c}')
    print(' | '.join(lines))
" 2>/dev/null || echo "")

    # ─── Session state ────────────────────────────
    TOTAL_CHANGED=0
    NCO_USED="false"
    if [ -f "$NCO_SESSION_FILE" ]; then
        TOTAL_CHANGED=$(grep -o '"changed_files": *[0-9]*' "$NCO_SESSION_FILE" 2>/dev/null | grep -o '[0-9]*' || echo "0")
        NCO_USED=$(grep -o '"nco_used": *[a-z]*' "$NCO_SESSION_FILE" 2>/dev/null | grep -o 'true\|false' || echo "false")
    else
        cd "$PROJECT_DIR" 2>/dev/null
        C1=$(git diff --name-only 2>/dev/null | wc -l || echo "0")
        C2=$(git diff --cached --name-only 2>/dev/null | wc -l || echo "0")
        TOTAL_CHANGED=$((C1 + C2))
    fi

    # ─── 에이전트 가용 상태 수집 ──────────────────
    AGENT_STATUS=$(curl -s --connect-timeout 1 --max-time 2 http://localhost:6200/api/daemons 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    online=[a['id'] for a in d.get('daemons',[]) if a.get('status')!='offline' or a.get('available')]
    busy=[a['id'] for a in d.get('daemons',[]) if a.get('status')=='working']
    parts=[]
    if online: parts.append('online:'+','.join(online[:5]))
    if busy: parts.append('busy:'+','.join(busy))
    print('|'.join(parts))
except: print('')
" 2>/dev/null || echo "")

    # ─── 프롬프트 기반 자동 오케스트레이션 힌트 ──
    PROMPT_TEXT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('userMessage','').lower()[:200])" 2>/dev/null || echo "")

    # 작업 유형 자동 감지
    ORCH_HINT=""
    if echo "$PROMPT_TEXT" | grep -qE '(구현|만들어|추가|implement|create|add|build)'; then
        if [ "$TOTAL_CHANGED" -ge 5 ]; then
            ORCH_HINT="AUTO_COMMANDER: 대규모 구현 감지 → nco_commander 사용 권장"
        else
            ORCH_HINT="AUTO_PARALLEL: 구현 작업 감지 → nco_parallel([codex,aider]) 후 cursor-agent 리뷰 권장"
        fi
    elif echo "$PROMPT_TEXT" | grep -qE '(리뷰|검토|review|check|audit|보안|security)'; then
        ORCH_HINT="AUTO_REVIEW: cursor-agent + vllm 병렬 리뷰 권장"
    elif echo "$PROMPT_TEXT" | grep -qE '(설계|아키텍처|design|architect|구조|structure)'; then
        ORCH_HINT="AUTO_DESIGN: opencode + gemini 병렬 설계 검토 권장"
    elif echo "$PROMPT_TEXT" | grep -qE '(테스트|test|검증|verify|validate)'; then
        ORCH_HINT="AUTO_TEST: codex(생성) + vllm(검증) 병렬 권장"
    elif echo "$PROMPT_TEXT" | grep -qE '(리팩토링|refactor|정리|cleanup|최적화|optimize)'; then
        ORCH_HINT="AUTO_REFACTOR: opencode 분석 → aider 적용 파이프라인 권장"
    fi

    # NCO usage hint (파일 변경 기반)
    if [ "$TOTAL_CHANGED" -ge 5 ] && [ "$NCO_USED" = "false" ]; then
        NCO_HINT="MUST_ORCHESTRATE: ${TOTAL_CHANGED}개 파일 변경됨. nco_commander 또는 nco_parallel 즉시 사용."
    elif [ "$TOTAL_CHANGED" -ge 3 ] && [ "$NCO_USED" = "false" ]; then
        NCO_HINT="SHOULD_ORCHESTRATE: ${TOTAL_CHANGED}개 파일 변경. cursor-agent 또는 vllm 리뷰 권장."
    elif [ "$NCO_USED" = "true" ]; then
        NCO_HINT="NCO_ACTIVE"
    else
        NCO_HINT="NCO_READY"
    fi

    # ─── Build context string ─────────────────────
    CONTEXT="[NCO:${MY_NAME}] Commander모드. 에이전트(${PROVIDER_COUNT}개) 대기중. 변경파일:${TOTAL_CHANGED}. ${NCO_HINT}"

    if [ -n "$ORCH_HINT" ]; then
        CONTEXT="${CONTEXT} ${ORCH_HINT}."
    fi
    if [ -n "$AGENT_STATUS" ]; then
        CONTEXT="${CONTEXT} AGENTS:${AGENT_STATUS}."
    fi
    # Append mesh info
    if [ -n "$MESH_CONFLICTS" ]; then
        CONTEXT="${CONTEXT} CONFLICT: ${MESH_CONFLICTS}."
    fi
    if [ -n "$MESH_MSG_TEXT" ]; then
        CONTEXT="${CONTEXT} MESH_MSG: ${MESH_MSG_TEXT}"
    fi

    FINAL_CTX="${CONTEXT}${GEMMA_APPEND}"
    cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "$( echo "$FINAL_CTX" | sed 's/"/\\"/g' | tr '\n' ' ' )"
  }
}
ENDJSON
else
    OFF_CTX="[NCO:${MY_NAME}] Offline. Run /nco-start if needed.${GEMMA_APPEND}"
    cat <<ENDJSON
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "$( echo "$OFF_CTX" | sed 's/"/\\"/g' | tr '\n' ' ' )"
  }
}
ENDJSON
fi

exit 0
