# NCO Mac 셋업 레퍼런스 — 2026-04-19

> macOS Apple Silicon (Mac Studio M4 Ultra) 기준 전체 설정 가이드

---

## 1. 디렉토리 구조

```
/Users/nova-ai/project/
├── neural-cli-orchestrator/   ← NCO 레포 (git)
│   ├── .claude/hooks/         ← Claude Code 훅 (Mac 전용)
│   ├── cli-installs/          ← anthropic-mlx-proxy.py, mlx-ctl.sh 등
│   ├── scripts/               ← mesh-gc.sh, agent-warmup.sh
│   ├── docs/                  ← 맥락노트, 개선노트, 레퍼런스
│   └── ecosystem.config.cjs   ← PM2 설정 (Mac 경로 /nco 사용)
├── nco/                       ← PM2 cwd 실제 실행 경로
└── LM-models/mlx/             ← Gemma 4 26B 4-bit 모델
```

---

## 2. PM2 프로세스

```bash
pm2 list                        # 상태 확인
pm2 start ecosystem.config.cjs  # 전체 시작
pm2 restart nco-backend         # NCO 백엔드 재시작
pm2 logs nco-backend --lines 50 # 로그 확인
```

| 이름 | 포트 | 설명 |
|------|------|------|
| nco-backend | 6200 (API), 6201 (WS) | NCO TypeScript 백엔드 |
| mlx-server | 8000 | MLX Gemma 4 26B 모델 서버 |

---

## 3. Claude-Gemma (MLX) 프록시

Mac에서 Claude Code → MLX 모델 경유 설정:

```bash
# 프록시 시작 (포트 4100)
nohup python3 /Users/nova-ai/project/neural-cli-orchestrator/cli-installs/anthropic-mlx-proxy.py 4100 \
  >>/tmp/mlx-proxy.log 2>&1 &

# 헬스체크
curl -sSf http://127.0.0.1:4100/health

# 로그 확인
tail -f /tmp/mlx-proxy.log
```

**프록시 경로**: `cli-installs/anthropic-mlx-proxy.py`

MLX 서버 (포트 8000) → 프록시 (포트 4100) → Claude Code

---

## 4. Cron 등록

```bash
# Mesh GC (5분마다 좀비 세션 청소)
(crontab -l 2>/dev/null; echo "*/5 * * * * /Users/nova-ai/project/neural-cli-orchestrator/scripts/mesh-gc.sh >> /tmp/nco-mesh-gc.log 2>&1") | crontab -

# 확인
crontab -l | grep mesh-gc
```

---

## 5. Statusline OAuth 캐시

```bash
# 수동 갱신
TOKEN=$(cat ~/.claude/.credentials.json | python3 -c \
  "import json,sys; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])")
curl -sS https://api.anthropic.com/api/oauth/usage \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" \
  > ~/.claude/usage-statusline-cache.json && echo "갱신 완료"

# 캐시 확인
python3 -c "import json; d=json.load(open('$HOME/.claude/usage-statusline-cache.json')); \
  print(f\"1일: {d['five_hour']['utilization']}% / 주별: {d['seven_day']['utilization']}%\")"
```

---

## 6. 마이그레이션 확인

```bash
python3 -c "
import sqlite3
d = sqlite3.connect('/Users/nova-ai/project/nco/db/nco.db')
rows = d.execute('SELECT filename FROM schema_migrations ORDER BY filename').fetchall()
for r in rows: print(r[0])
"
```

---

## 7. 롤백 방법

```bash
# platform/mac 이전 커밋으로 롤백
git log --oneline platform/mac -10
git checkout platform/mac
git reset --hard <commit-hash>

# PM2 재시작
pm2 restart nco-backend
```

---

## 8. Windows vs Mac 차이

| 항목 | Windows (WSL) | Mac (Apple Silicon) |
|------|---------------|---------------------|
| 로컬 모델 | vLLM (CUDA RTX 4090) | MLX (Apple Silicon) |
| 프록시 | anthropic-vllm-proxy.mjs | anthropic-mlx-proxy.py |
| 모델 경로 | /mnt/d/llm-models/vllm/ | ~/project/LM-models/mlx/ |
| date 명령 | GNU date (-d) | BSD date (-j -f) |
| Ollama URL | http://172.28.112.1:11434 | http://localhost:11434 |

---

> **작성 시점**: 2026-04-19 (KST)
