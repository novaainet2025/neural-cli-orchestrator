#!/usr/bin/env bash
# MLX·GGML Whisper 모델 다운로드 및(선택) Core ML 변환. MeloTTS-Korean 폴더는 수정하지 않습니다.
# 배치: <gentop>/lib/scripts/download_models.sh (한 단계 상위가 lib)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(basename "${SCRIPT_DIR}")" != "scripts" ]]; then
  echo "[download_models] 오류: 이 파일은 lib/scripts/download_models.sh 위치에 두고 실행하세요." >&2
  exit 1
fi

LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${LIB_DIR}"

# huggingface-cli 사용을 위해 venv가 있으면 활성화
if [[ -f "${LIB_DIR}/venv/bin/activate" ]]; then
  # shellcheck source=/dev/null
  source "${LIB_DIR}/venv/bin/activate"
fi

echo "[download_models] 작업 디렉터리: ${LIB_DIR}"

mkdir -p "${LIB_DIR}/models/mlx-turbo" "${LIB_DIR}/models/ggml"

echo "[download_models] MLX 커뮤니티 모델 다운로드..."
huggingface-cli download mlx-community/whisper-large-v3-turbo --local-dir "${LIB_DIR}/models/mlx-turbo/"

echo "[download_models] whisper.cpp GGML 가중치 다운로드..."
huggingface-cli download ggerganov/whisper.cpp \
  --include "ggml-large-v3-turbo-q5_0.bin" \
  --local-dir "${LIB_DIR}/models/ggml/"

WHISPER_ROOT="${LIB_DIR}/vendor/whisper.cpp"
GEN_SCRIPT="${WHISPER_ROOT}/models/generate-coreml-model.sh"

if [[ -d "${WHISPER_ROOT}/build" ]] && [[ -f "${GEN_SCRIPT}" ]]; then
  echo "[download_models] whisper.cpp 빌드 확인됨 — Core ML 모델 변환 실행..."
  (cd "${WHISPER_ROOT}/models" && bash "./generate-coreml-model.sh" large-v3-turbo)
else
  echo "[download_models] Core ML 변환 생략: ${WHISPER_ROOT}/build 없거나 ${GEN_SCRIPT} 없음 (setup.sh 빌드 후 재실행 가능)"
fi

echo ""
echo "========== 다운로드 요약 =========="
echo "- MLX (mlx-community/whisper-large-v3-turbo): ${LIB_DIR}/models/mlx-turbo/"
du -sh "${LIB_DIR}/models/mlx-turbo" 2>/dev/null || true
echo "- GGML (ggml-large-v3-turbo-q5_0.bin): ${LIB_DIR}/models/ggml/"
du -sh "${LIB_DIR}/models/ggml" 2>/dev/null || true
if [[ -d "${WHISPER_ROOT}/models" ]]; then
  echo "- whisper.cpp models/ (Core ML 산출물은 변환 성공 시 이 하위에 생성될 수 있음): ${WHISPER_ROOT}/models/"
fi
echo "=================================="
echo "[download_models] 완료"
