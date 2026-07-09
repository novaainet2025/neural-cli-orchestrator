# Plan: MeloTTS-Korean 통합 대시보드 구축

**ID**: plan_547A4X4jdjok4Zit  
**경로**: /Users/nova-ai/project/@@gentop/lib/MeloTTS-Korean  
**참여 AI (4-Layer)**: opencode → codex+aider → cursor-agent → mlx  
**스택**: Python 3.14 / FastAPI / MeloTTS / vanilla JS  

## 태스크

### Layer 1 — 기반 (직접 처리)
- [x] 폴더 구조 생성 (`model/`, `server/`, `static/`, `outputs/`, `docs/`)
- [ ] huggingface-cli로 `myshell-ai/MeloTTS-Korean` 모델 다운로드
- [ ] Python venv + `pip install melo-tts` + 의존성

### Layer 2 — 아키텍처 설계 (opencode)
- [ ] FastAPI 라우트 설계 (`POST /tts`, `POST /tts/batch`, `GET /history`, `GET /health`, static)
- [ ] 화자/언어 메타데이터 스키마 정의
- [ ] SSML 파서 설계 (pause/prosody 태그)
- [ ] 디렉토리 레이아웃 확정

### Layer 3 — 구현 (codex + aider 병렬)
- [ ] **codex**: `server/main.py` (FastAPI 서버) + `server/tts_engine.py` (MeloTTS 래퍼) + `server/ssml.py`
- [ ] **aider**: `static/index.html` + `static/app.js` + `static/style.css` (대시보드 UI)
- [ ] `start.sh` 시작 스크립트 (uvicorn + 브라우저 오픈)
- [ ] `requirements.txt`

### Layer 4 — 리뷰 + 검증 (cursor-agent + mlx)
- [ ] **cursor-agent**: 코드 리뷰 (보안, 에러 처리, 입력 검증)
- [ ] **mlx**: 한국어 TTS 추론 정상 작동 확인
- [ ] `README.md` (한국어 사용법 + 스크린샷)
- [ ] NCO 모니터 메타데이터 (`/api/realtime/parallel` 등록)

## 성공 기준
- `bash start.sh` → http://localhost:7860 자동 오픈
- 한국어 텍스트 입력 → WAV 파일 생성 + 즉시 재생
- 화자 선택 / 속도 / 배치 / SSML 모두 작동
- 히스토리 20개 유지

## Gap 분석 루프
완료 시 100% 통과까지 반복.
