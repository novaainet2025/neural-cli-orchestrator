#!/usr/bin/env bash
# MeloTTS-Korean 및 주변 도구와 무관: 가상환경·whisper.cpp 빌드만 수행합니다.
# 배치: <gentop>/lib/scripts/setup.sh (한 단계 상위가 lib)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(basename "${SCRIPT_DIR}")" != "scripts" ]]; then
  echo "[setup] 오류: 이 파일은 lib/scripts/setup.sh 위치에 두고 실행하세요." >&2
  exit 1
fi

LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${LIB_DIR}"

echo "[setup] 작업 디렉터리: ${LIB_DIR}"

# Python 3.14 가상환경 생성
python3.14 -m venv "${LIB_DIR}/venv"

# 의존성 설치
# shellcheck source=/dev/null
source "${LIB_DIR}/venv/bin/activate"
pip install -r "${LIB_DIR}/requirements.txt"

# whisper.cpp 저장소 클론 (이미 있으면 건너뜀)
VENDOR_WHISPER="${LIB_DIR}/vendor/whisper.cpp"
if [[ ! -d "${VENDOR_WHISPER}/.git" ]]; then
  echo "[setup] whisper.cpp 클론 중..."
  mkdir -p "${LIB_DIR}/vendor"
  git clone https://github.com/ggerganov/whisper.cpp.git "${VENDOR_WHISPER}"
else
  echo "[setup] whisper.cpp 이미 존재 — 클론 생략"
fi

# CMake 빌드 (macOS, Core ML 활성화)
cd "${VENDOR_WHISPER}"
cmake -B build -DWHISPER_COREML=ON
cmake --build build --config Release -j"$(sysctl -n hw.ncpu)"

echo "[setup] 완료: venv, pip 패키지, whisper.cpp(Core ML) 빌드가 준비되었습니다."
