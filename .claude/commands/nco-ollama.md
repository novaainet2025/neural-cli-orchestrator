# Ollama 로컬 LLM (양자화 Gemma `gemma4:26b` 등) — 시작/상태/테스트/프록시.

# 사용법:
#   /nco-ollama                          — 상태 (기본)
#   /nco-ollama start                    — 모델 pull + 준비 (Ollama 데몬 필요)
#   /nco-ollama stop                     — 안내 (OS별 Ollama 종료)
#   /nco-ollama models | test | chat …   — OpenAI 호환 :11434/v1

# 이전에는 /home/nova/projects/neural-cli-orchestrator/... 를 박아둬서
# 이 머신(macOS)에서는 exit 127 로 즉시 실패했다. NCO 프로젝트 경로에서 찾는다.
export ARGUMENTS
NCO_DIR="${NCO_PROJECT_DIR:-$HOME/project/nco}"
SCRIPT="$NCO_DIR/cli-installs/ollama-nco-cmd.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "[오류] ollama 커맨드 스크립트를 찾을 수 없습니다: $SCRIPT"
  echo "       NCO_PROJECT_DIR 로 실제 NCO 경로를 지정하세요."
  exit 1
fi

bash "$SCRIPT"
