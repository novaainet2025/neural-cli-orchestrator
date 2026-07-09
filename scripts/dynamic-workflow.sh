#!/usr/bin/env bash
# dynamic-workflow.sh "fix login bug in auth flow" --mode auto
# dynamic-workflow.sh "create startup from plan to delivery" --mode company

set -euo pipefail

NCO_API="${NCO_API:-http://localhost:6200}"
ENV_FILE="/Users/nova-ai/project/nco/.env"
PROJECT_DIR="/Users/nova-ai/project/nco"
MAX_WAIT_SECONDS=300
POLL_INTERVAL=2

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

usage() {
  cat <<'EOF'
Usage: dynamic-workflow.sh "<task description>" [--mode auto|task|parallel|discussion|consensus|company]
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "${RED}Missing required command: $1${RESET}" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd python3
require_cmd grep

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

TASK_DESCRIPTION="$1"
shift

REQUESTED_MODE="auto"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || { echo "${RED}--mode requires a value${RESET}" >&2; exit 1; }
      REQUESTED_MODE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "${RED}Unknown argument: $1${RESET}" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$REQUESTED_MODE" in
  auto|task|parallel|discussion|consensus|company) ;;
  *)
    echo "${RED}Invalid mode: $REQUESTED_MODE${RESET}" >&2
    usage >&2
    exit 1
    ;;
esac

if [[ ! -f "$ENV_FILE" ]]; then
  echo "${RED}Missing env file: $ENV_FILE${RESET}" >&2
  exit 1
fi

NCO_TOKEN="$(grep -E '^(NCO_TOKEN|NCO_API_TOKEN|API_TOKEN)=' "$ENV_FILE" | tail -n 1 | cut -d '=' -f 2- | tr -d '"' | tr -d "'" || true)"
if [[ -z "$NCO_TOKEN" ]]; then
  echo "${RED}NCO_TOKEN not found in $ENV_FILE${RESET}" >&2
  exit 1
fi

to_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

choose_auto_mode() {
  local text
  text="$(to_lower "$1")"

  if [[ "$text" =~ (parallel|team|multiple) ]]; then
    echo "parallel"
  elif [[ "$text" =~ (company|startup|full) ]]; then
    echo "company"
  elif [[ "$text" =~ (complex|compare|discuss) ]]; then
    echo "discussion"
  elif [[ "$text" =~ (image|video|generate) ]]; then
    echo "task"
  elif [[ "$text" =~ (design|architect|plan) ]]; then
    echo "task"
  elif [[ "$text" =~ (implement|code|fix|build) ]]; then
    echo "task"
  elif [[ "$text" =~ (review|check|security) ]]; then
    echo "task"
  elif [[ "$text" =~ (research|find|search) ]]; then
    echo "task"
  else
    echo "task"
  fi
}

provider_for_task() {
  local text
  text="$(to_lower "$1")"

  if [[ "$text" =~ (image|video|generate) ]]; then
    echo "higgsfield"
  elif [[ "$text" =~ (design|architect|plan) ]]; then
    echo "opencode"
  elif [[ "$text" =~ (implement|code|fix|build) ]]; then
    echo "codex"
  elif [[ "$text" =~ (review|check|security) ]]; then
    echo "cursor-agent"
  elif [[ "$text" =~ (research|find|search) ]]; then
    echo "copilot"
  else
    echo "cursor-agent"
  fi
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

extract_json_field() {
  local file="$1"
  local expr="$2"
  python3 - "$file" "$expr" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)
value = data
for part in expr.split('.'):
    if not part:
        continue
    if isinstance(value, dict):
        value = value.get(part)
    else:
        value = None
        break
if value is None:
    sys.exit(1)
if isinstance(value, (dict, list)):
    print(json.dumps(value, ensure_ascii=False))
else:
    print(value)
PY
}

pretty_print_json() {
  python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), indent=2, ensure_ascii=False))'
}

TASK_JSON="$(printf '%s' "$TASK_DESCRIPTION" | json_escape)"
SELECTED_MODE="$REQUESTED_MODE"
if [[ "$SELECTED_MODE" == "auto" ]]; then
  SELECTED_MODE="$(choose_auto_mode "$TASK_DESCRIPTION")"
fi

ENDPOINT=""
PAYLOAD=""
POLL_KIND=""
POLL_ID=""
ROUTED_PROVIDER=""

case "$SELECTED_MODE" in
  task)
    ROUTED_PROVIDER="$(provider_for_task "$TASK_DESCRIPTION")"
    ENDPOINT="/api/task"
    PAYLOAD="$(cat <<EOF
{"prompt":$TASK_JSON,"mode":"task","ai":"$ROUTED_PROVIDER","projectDir":"$PROJECT_DIR"}
EOF
)"
    ;;
  parallel)
    ENDPOINT="/api/parallel"
    PAYLOAD="$(cat <<EOF
{"prompt":$TASK_JSON,"providers":["codex","cursor-agent","opencode"]}
EOF
)"
    ;;
  discussion)
    ENDPOINT="/api/discussion"
    PAYLOAD="$(cat <<EOF
{"prompt":$TASK_JSON,"mode":"discussion","providers":["codex","cursor-agent","opencode"],"maxRounds":3}
EOF
)"
    ;;
  consensus)
    ENDPOINT="/api/consensus"
    PAYLOAD="$(cat <<EOF
{"prompt":$TASK_JSON,"providers":["codex","cursor-agent","opencode"],"consensusThreshold":0.8}
EOF
)"
    ;;
  company)
    ENDPOINT="/api/conductor"
    PAYLOAD="$(cat <<EOF
{"prompt":"회사 만들기. 기획부터 설계, 구현, QA, 배포 준비까지 company mode로 처리하라.\n\n원본 작업:\n$TASK_DESCRIPTION","projectDir":"$PROJECT_DIR"}
EOF
)"
    ;;
esac

TMP_RESPONSE="$(mktemp)"
TMP_POLL="$(mktemp)"
cleanup() {
  rm -f "$TMP_RESPONSE" "$TMP_POLL"
}
trap cleanup EXIT

echo "${BLUE}${BOLD}NCO Dynamic Workflow${RESET}"
echo "${BLUE}Requested mode:${RESET} $REQUESTED_MODE"
echo "${BLUE}Selected mode:${RESET} $SELECTED_MODE"
if [[ -n "$ROUTED_PROVIDER" ]]; then
  echo "${BLUE}Provider:${RESET} $ROUTED_PROVIDER"
fi
echo "${BLUE}Endpoint:${RESET} $ENDPOINT"

HTTP_CODE="$(
  curl -sS \
    -H "Authorization: Bearer $NCO_TOKEN" \
    -H "Content-Type: application/json" \
    -X POST "${NCO_API}${ENDPOINT}" \
    -d "$PAYLOAD" \
    -o "$TMP_RESPONSE" \
    -w '%{http_code}'
)"

if [[ ! "$HTTP_CODE" =~ ^2 ]]; then
  echo "${RED}Request failed with HTTP ${HTTP_CODE}${RESET}" >&2
  cat "$TMP_RESPONSE" >&2
  exit 1
fi

case "$SELECTED_MODE" in
  task|company)
    POLL_KIND="task"
    POLL_ID="$(extract_json_field "$TMP_RESPONSE" "taskId" || true)"
    ;;
  discussion|consensus)
    POLL_KIND="discussion"
    POLL_ID="$(extract_json_field "$TMP_RESPONSE" "sessionId" || true)"
    ;;
  parallel)
    POLL_KIND=""
    POLL_ID=""
    ;;
esac

if [[ -z "$POLL_ID" && "$SELECTED_MODE" != "parallel" ]]; then
  echo "${RED}Could not determine poll id from response${RESET}" >&2
  cat "$TMP_RESPONSE" >&2
  exit 1
fi

if [[ "$SELECTED_MODE" == "parallel" ]]; then
  echo "${GREEN}Parallel workflow started.${RESET}"
  echo "${YELLOW}This endpoint is fire-and-forget and does not return a task/session id to poll.${RESET}"
  cat "$TMP_RESPONSE" | pretty_print_json
  exit 0
fi

echo "${YELLOW}Polling ${POLL_KIND} ${POLL_ID} for up to ${MAX_WAIT_SECONDS}s...${RESET}"

deadline=$((SECONDS + MAX_WAIT_SECONDS))
while (( SECONDS < deadline )); do
  if [[ "$POLL_KIND" == "task" ]]; then
    HTTP_CODE="$(
      curl -sS \
        -H "Authorization: Bearer $NCO_TOKEN" \
        "${NCO_API}/api/tasks/${POLL_ID}" \
        -o "$TMP_POLL" \
        -w '%{http_code}'
    )"
    if [[ "$HTTP_CODE" == "200" ]]; then
      STATUS="$(extract_json_field "$TMP_POLL" "task.status" || true)"
      RESULT="$(extract_json_field "$TMP_POLL" "task.response" || true)"
      ERROR_MSG="$(extract_json_field "$TMP_POLL" "task.error" || true)"
      if [[ "$STATUS" == "completed" ]]; then
        echo "${GREEN}${BOLD}Completed${RESET}"
        echo "${GREEN}Task ID:${RESET} $POLL_ID"
        [[ -n "$RESULT" ]] && printf '%s\n' "$RESULT" || cat "$TMP_POLL" | pretty_print_json
        exit 0
      elif [[ "$STATUS" == "failed" || "$STATUS" == "cancelled" ]]; then
        echo "${RED}${BOLD}Task ${STATUS}${RESET}" >&2
        [[ -n "$ERROR_MSG" ]] && printf '%s\n' "$ERROR_MSG" >&2
        [[ -n "$RESULT" ]] && printf '%s\n' "$RESULT" >&2
        exit 1
      else
        echo "${YELLOW}Task status:${RESET} ${STATUS:-unknown}"
      fi
    fi
  else
    HTTP_CODE="$(
      curl -sS \
        -H "Authorization: Bearer $NCO_TOKEN" \
        "${NCO_API}/api/discussions/${POLL_ID}" \
        -o "$TMP_POLL" \
        -w '%{http_code}'
    )"
    if [[ "$HTTP_CODE" == "200" ]]; then
      STATUS="$(extract_json_field "$TMP_POLL" "discussion.status" || true)"
      REPORT="$(extract_json_field "$TMP_POLL" "discussion.report" || true)"
      if [[ "$STATUS" == "completed" ]]; then
        echo "${GREEN}${BOLD}Completed${RESET}"
        echo "${GREEN}Session ID:${RESET} $POLL_ID"
        if [[ -n "$REPORT" ]]; then
          printf '%s\n' "$REPORT"
        else
          cat "$TMP_POLL" | pretty_print_json
        fi
        exit 0
      elif [[ "$STATUS" == "failed" ]]; then
        echo "${RED}${BOLD}Discussion failed${RESET}" >&2
        cat "$TMP_POLL" | pretty_print_json >&2
        exit 1
      else
        echo "${YELLOW}Discussion status:${RESET} ${STATUS:-unknown}"
      fi
    fi
  fi
  sleep "$POLL_INTERVAL"
done

echo "${RED}Timed out after ${MAX_WAIT_SECONDS}s${RESET}" >&2
cat "$TMP_POLL" | pretty_print_json >&2 || cat "$TMP_POLL" >&2
exit 1
