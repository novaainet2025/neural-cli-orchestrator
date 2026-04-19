# Ollama 로컬 LLM (양자화 Gemma `gemma4:26b` 등) — 시작/상태/테스트/프록시.

# 사용법:
#   /nco-ollama                          — 상태 (기본)
#   /nco-ollama start                    — 모델 pull + 준비 (Ollama 데몬 필요)
#   /nco-ollama stop                     — 안내 (OS별 Ollama 종료)
#   /nco-ollama models | test | chat …   — OpenAI 호환 :11434/v1

export ARGUMENTS
bash "/home/nova/projects/neural-cli-orchestrator/cli-installs/ollama-nco-cmd.sh"
