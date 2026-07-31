# NOVA 생태계 — Windows WSL2 설치

macOS에서 개발된 3개 프로젝트를 Windows WSL2(Ubuntu)에 설치합니다.
2026-07-31 기준 **세 저장소 모두 `main` 하나로 통합**되어 브랜치를 고를 필요가 없습니다.

| 프로젝트 | 저장소 | 브랜치 | 포트 |
|---|---|---|---|
| **nco** — Neural CLI Orchestrator | `novaainet2025/neural-cli-orchestrator` | `main` | API 6200 · WS 6201 |
| **nova-ax** | `novaainet2025/nova-ax` | `main` | 6300 |
| **nco-dashboard** | `novaainet2025/NCO-Dashboard` | `main` | 5173 (dev) |

---

## 빠른 시작

이 스크립트들은 nco 저장소의 `wsl-install/` 에 들어 있습니다. WSL2 Ubuntu 터미널에서:

```bash
git clone https://github.com/novaainet2025/neural-cli-orchestrator.git /tmp/nco-boot
cd /tmp/nco-boot/wsl-install

bash install-wsl.sh      # 대화형 — 설치할 AI 프로바이더 CLI를 골라서 진행
bash verify-wsl.sh       # 설치 검증
```

설치가 끝나면 같은 파일이 `$NOVA_ROOT/nco/wsl-install/` 에도 있으므로 `/tmp/nco-boot`
는 지워도 됩니다. (스크립트는 nco 를 `$NOVA_ROOT` 아래에 별도로 clone 합니다.)

무인 설치:

```bash
bash install-wsl.sh --yes                                     # 기본 프로바이더 4종 + Claude 설정
bash install-wsl.sh --providers=codex,opencode,cursor-agent   # 지정 설치
bash install-wsl.sh --all-providers                           # CLI 전체
bash install-wsl.sh --no-providers                            # NCO 본체만
bash install-wsl.sh --claude-config                           # Claude 설정 일습 적용
bash install-wsl.sh --no-claude-config                        # Claude 설정 적용 안 함
bash install-wsl.sh --only=nco                                # 특정 프로젝트만
bash install-wsl.sh --skip-pm2                                # PM2 기동 생략
```

환경변수 오버라이드:

| 변수 | 기본값 | 용도 |
|---|---|---|
| `NOVA_ROOT` | `$HOME/nova` | 설치 루트 |
| `NCO_BRANCH` | `main` | nco 브랜치 |
| `AX_BRANCH` | `main` | nova-ax 브랜치 |
| `DASH_BRANCH` | `main` | dashboard 브랜치 |
| `FLEET_DIR` | `$HOME/nova-fleet-config` | Claude 설정 정본 clone 경로 |
| `FLEET_BRANCH` | `main` | fleet-config 브랜치 |

```bash
NOVA_ROOT=$HOME/apps/nova bash install-wsl.sh --yes
```

> `NOVA_ROOT`를 `/mnt/c/...` 같은 Windows 드라이브로 지정하면 스크립트가 거부합니다.
> WSL에서 Windows 파일시스템은 I/O가 수십 배 느리고 `npm ci`가 심볼릭 링크·권한
> 문제로 실패합니다. 반드시 `$HOME` 하위에 설치하세요.

---

## AI 프로바이더 CLI 선택 설치

nco 저장소의 `cli-installs/install-all.sh`를 도구 단위로 호출합니다.
대화형 실행 시 아래 메뉴가 뜹니다.

```
     1) claude-code    Claude Code CLI      — NCO 기본 두뇌
     2) opencode       OpenCode             — 설계·아키텍처
     3) codex          Codex CLI            — 구현·버그 (hermes 프로바이더도 이 CLI를 공유)
     4) cursor-agent   Cursor Agent         — 코드 리뷰·보안
     5) copilot        GitHub Copilot CLI   — 리서치·문서
     6) gemini-cli     Gemini CLI           — 범용
     7) ollama         Ollama               — 로컬 LLM (GPU 없으면 매우 느림)
     8) gemini-api     google-genai SDK     — Python SDK만 (CLI 아님)

   선택: 1 3 4     ← 번호를 공백/콤마로 · 'a'=전체 · 엔터=기본(1 2 3 4) · 'n'=설치 안 함
```

알아둘 점:

- 개별 CLI 설치가 실패해도 **전체 설치는 중단되지 않습니다.** 실패 목록만 마지막에
  요약되며, `bash ~/nova/nco/cli-installs/install-all.sh <tool>`로 재시도할 수 있습니다.
- 모든 CLI는 `~/.local` 아래에 **sudo 없이** 설치됩니다. 설치 후 `source ~/.bashrc`
  또는 새 터미널이 필요합니다.
- `codex`를 설치하면 NCO의 `hermes` 프로바이더도 함께 동작합니다 — 같은 CLI를 공유합니다.
- 파이프 실행(`curl ... | bash`)처럼 stdin이 터미널이 아니면 메뉴를 띄울 수 없으므로
  기본 4종으로 자동 진행합니다. 다르게 하려면 `--providers=` 를 명시하세요.
- **`agy` 프로바이더는 설치 대상에 없습니다.** `install-all.sh`에 루틴이 없어 수동
  설치가 필요하며, nco 기본 설정에서도 `enabled=false`입니다.

### WSL 프로바이더 활성화 정책

설치 스크립트가 `nco/config/platform-patch.wsl.sh`를 자동 실행해 활성 상태를 WSL 기준으로 맞춥니다.

- **활성화**: opencode · codex · cursor-agent · copilot · hermes · claude-code · openrouter · openclaw · agy
- **ollama**: 기본 **비활성**. `ollama`를 선택했고 `nvidia-smi`가 감지되면 자동으로
  `--gpu` 모드가 적용됩니다. GPU 없이 켜면 추론이 실용 불가 수준으로 느립니다.

---

## Claude Code 설정 일습 (설정 · 상태바 · 훅 · 커스텀 커맨드)

NCO 백엔드만 깔면 Claude Code 쪽은 아무것도 바뀌지 않습니다. 상태바도, `/nco-*`
슬래시 커맨드도, 훅도 따로 적용해야 합니다. 설치 중에 선택할 수 있습니다.

```
  Claude Code 설정 일습을 이 머신에 적용할까요?
    적용 대상: settings.json · 상태바(statusLine) · 훅 · 슬래시 커맨드 · 스킬
    출처: nova-fleet-config (공개 저장소) · 기존 설정은 백업 후 병합

  적용? [Y/n]:
```

`--claude-config` / `--no-claude-config` 로 비대화형 지정도 됩니다. `--yes` 는
적용을 기본값으로 씁니다. 파이프 실행처럼 stdin 이 터미널이 아니면 **건너뜁니다** —
남의 `~/.claude` 를 말없이 고치지 않기 위해서입니다.

### 무엇이 어디로 가는가

정본은 `nova-fleet-config`(공개 저장소)이고, 배포는 그 저장소의
`install/apply.sh --merge-settings` 가 합니다.

| 출처 | 대상 |
|---|---|
| `claude/hooks/*` | `~/.claude/hooks/` |
| `claude/commands/*` | `~/.claude/commands/` (`/nco-*` 62종 포함) |
| `claude/skills/*` | `~/.claude/skills/` |
| `scripts/*` | `~/projects/scripts/` |
| `claude/settings.template.json` | `~/.claude/settings.json` 에 **병합** |

`settings.json` 은 덮어쓰지 않고 병합합니다 — `statusLine` 은 canonical 값으로
설정하고, `hooks` 는 canonical ∪ 기존 머신 설정의 **합집합**(command 기준 dedup)입니다.
변경 전 원본은 `settings.json.fleet-bak` 으로 백업됩니다.

경로는 `{{HOME}}` · `{{USER}}` · `{{OS}}` · `{{BASH_PATH}}` 토큰으로 저장돼 있어
설치 시점에 이 머신 기준으로 치환됩니다. 원본 머신(macOS)의 절대경로가 새어 들어가지
않습니다.

### 주의

- **적용 후 새 터미널을 열거나 Claude Code 를 재시작해야 반영됩니다.**
- `apply.sh` 는 `jq` · `python3` · `git` 을 요구합니다 (설치 스크립트가 §1에서 깝니다).
- `~/.claude/settings.json` 이 깨진 JSON 이면 `apply.sh` 가 적용을 거부합니다.
  설치 스크립트가 미리 검사해 원인을 알려줍니다.
- 설정 적용이 실패해도 **전체 설치는 중단되지 않습니다.** 경고만 남고 나머지가 진행됩니다.
- `claude` CLI 자체는 프로바이더 선택에서 `claude-code` 를 골라야 설치됩니다.
  설정만 깔고 CLI 가 없으면 `verify-wsl.sh` 가 경고합니다.

나중에 수동 적용:

```bash
git clone https://github.com/novaainet2025/nova-fleet-config.git ~/nova-fleet-config
bash ~/nova-fleet-config/install/apply.sh --merge-settings
```

---

## 수동 설치 (스크립트 없이)

### 1. 시스템 준비

```bash
sudo apt update
# better-sqlite3 · hnswlib-node 는 node-gyp로 C++ 컴파일된다 → 빌드 도구 필수
sudo apt install -y build-essential python3 python3-venv pkg-config curl git ca-certificates lsof jq

# Redis — nco의 bullmq 작업 큐가 필수로 요구
sudo apt install -y redis-server
sudo systemctl enable --now redis-server 2>/dev/null || sudo service redis-server start
redis-cli ping          # → PONG

# Node.js 22 — nco의 engines.node 는 >=22
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm install 22 && nvm alias default 22

export NOVA_ROOT="$HOME/nova" && mkdir -p "$NOVA_ROOT"
```

### 2. nco

```bash
cd "$NOVA_ROOT"
git clone https://github.com/novaainet2025/neural-cli-orchestrator.git nco
cd nco

npm ci                                # 불변식: --legacy-peer-deps 금지
cp .env.example .env                  # 이후 키 입력 (아래 .env 항목 참고)
bash config/platform-patch.wsl.sh     # WSL 프로바이더 정책 (GPU 노드면 --gpu)
npm run build
npm run migrate

npm install -g pm2
pm2 start dist/index.js --name nco
curl -fsS http://127.0.0.1:6200/health   # → {"status":"healthy",...}
```

저장소에 이미 있는 설치 자산을 그대로 써도 됩니다:

```bash
bash setup.sh                     # 대화형 전체 설치 (에이전트 포함)
bash setup.sh --no-interactive    # 무인
bash setup.sh --skip-agents       # CLI 설치 생략
# 원클릭 (clone 포함)
curl -fsSL https://raw.githubusercontent.com/novaainet2025/neural-cli-orchestrator/main/bootstrap.sh | bash
```

### 3. nova-ax

```bash
cd "$NOVA_ROOT"
git clone https://github.com/novaainet2025/nova-ax.git nova-ax
cd nova-ax

npm ci
cp "$NOVA_ROOT/nco/wsl-install/env-templates/nova-ax.env.template" .env   # 저장소에 .env.example 없음
npm run build
pm2 start dist/index.js --name nova-ax
```

`AX_NCO_SECRET`은 nco 쪽과 **값이 일치해야** 상호 인증이 통과합니다.

### 4. nco-dashboard

```bash
cd "$NOVA_ROOT"
git clone https://github.com/novaainet2025/NCO-Dashboard.git nco-dashboard
cd nco-dashboard

npm ci
npm run dev -- --host      # → Windows 브라우저에서 http://localhost:5173
```

대시보드는 `.env`를 읽지 않습니다. `vite.config.ts`의 프록시가 `/api`→`:6200`,
`/ws`→`:6201`, `/health`→`:6200`으로 넘기고, 일부 소스에는 `http://localhost:6200`이
직접 박혀 있습니다. nco를 **같은 WSL 인스턴스**에서 띄우면 그대로 동작합니다.

---

## 트러블슈팅

### WSL에서 systemd가 안 돌 때

```bash
sudo service redis-server start        # 1차 폴백
redis-server --daemonize yes           # 2차 폴백
redis-cli ping
```

systemd를 영구 활성화하려면 `/etc/wsl.conf`에 아래를 넣고 PowerShell에서 `wsl --shutdown`:

```ini
[boot]
systemd=true
```

### `better-sqlite3` / `hnswlib-node` 빌드 실패

`node-gyp` 에러는 컴파일러나 Python이 없다는 뜻입니다.

```bash
sudo apt install -y build-essential python3 pkg-config
rm -rf node_modules && npm ci
npm rebuild better-sqlite3
npm rebuild hnswlib-node
```

**macOS에서 만든 `node_modules`를 복사해 오지 마세요.** arm64 macOS 바이너리는
WSL(x86_64 Linux)에서 로드되지 않습니다. WSL 안에서 `npm ci`를 다시 실행해야 합니다.

### `db/hnsw-indices/*.hnsw` 로드 오류

저장소에 커밋된 hnsw 벡터 인덱스는 바이너리입니다. 아키텍처 차이로 로드가 실패하면
치우고 NCO가 새로 만들게 두세요 (임베딩이 다시 쌓입니다).

```bash
mv ~/nova/nco/db/hnsw-indices ~/nova/nco/db/hnsw-indices.bak
pm2 restart nco
```

### Playwright 의존성 (nco-dashboard)

```bash
cd ~/nova/nco-dashboard
npx playwright install-deps
npx playwright install chromium
```

### 포트 충돌 (6200 · 6300 · 5173 · 6379)

```bash
lsof -i :6200 -i :6300 -i :5173 -i :6379
```

NCO는 진행 중인 작업이 있을 수 있으니 `kill -9`는 마지막 수단으로 두세요:

```bash
curl -fsS 'http://127.0.0.1:6200/api/tasks?limit=5' | jq '.tasks[] | {id,status}'
pm2 restart nco
```

### Windows 브라우저에서 대시보드가 안 열릴 때

```bash
npm run dev -- --host            # 0.0.0.0 바인딩
hostname -I                      # WSL IP → http://<IP>:5173
```

### 대시보드 메모리 위젯이 비어 있음 — WSL에서는 정상

`vite.config.ts`의 `/local/mac-memory` 미들웨어는 macOS 전용 명령(`sysctl -n hw.memsize`,
`vm_stat`, `memory_pressure`, `machdep.cpu.brand_string`)을 씁니다. `try/catch` 안에 있어
**dev 서버 기동과 나머지 기능에는 영향이 없고**, 해당 엔드포인트만 실패합니다.
메모리 위젯이 필요하면 `/proc/meminfo` 기반 분기 패치가 별도로 필요합니다.

### Ollama를 Windows 호스트에서 쓸 때

WSL의 `127.0.0.1`은 Windows 호스트가 아닙니다.

```bash
HOST_IP=$(ip route show default | awk '{print $3}')
echo "OLLAMA_HOST=http://$HOST_IP:11434"     # nco/.env 에 반영
```

---

## 검증

```bash
bash verify-wsl.sh
```

프로세스 존재가 아니라 **실제 동작**을 확인합니다:

1. Node 22+ · Redis `PONG`
2. 3개 저장소의 브랜치·커밋 해시
3. 네이티브 모듈 `require()` 성공 여부 — 아키텍처 불일치는 로드 시점에만 드러납니다
4. `dist/` 빌드 산출물 실재
5. `/health` **응답 본문**
6. `.env` 필수 키가 플레이스홀더로 남아 있지 않은지
7. 설치된 프로바이더 CLI + NCO `/api/agents`가 인식한 에이전트 목록
8. Claude 설정 — `settings.json` JSON 유효성, `statusLine` 이 가리키는 스크립트의
   **실재 여부**, 등록된 훅이 전부 실제 파일로 존재하는지, 훅·커맨드·스킬 개수,
   `claude` CLI 설치 여부

종료 코드 `0`이면 전체 통과, `1`이면 실패 항목이 있습니다.

---

## 브랜치 통합 이력 (2026-07-31)

설치가 브랜치 이름에 의존하지 않도록 세 저장소를 정리했습니다.

| 저장소 | 조치 | 결과 |
|---|---|---|
| nco | 이미 `main` 단일 | `8944d8f` |
| nova-ax | `agent/verification-audit-recovery` → `main` 병합 | `470ff70` |
| nco-dashboard | agent 브랜치는 PR #1로 이미 병합됨 | `91d6578` |
| nco-dashboard | GitHub 기본 브랜치 `master` → `main` 변경 | 이제 `git clone`이 최신을 받음 |

`NCO-Dashboard`의 `origin/master`(2026-04-10 초기 커밋 2개)는 `main`과 **공통 조상이
없어**(`no merge base`) 병합하지 않았습니다. 무관한 이력이므로 그대로 둡니다.
통합이 끝난 agent 브랜치들은 기록으로 보존합니다.

---

## 알려진 한계

- **이 스크립트는 실제 WSL2에서 아직 실행 검증되지 않았습니다.** 개발 머신(macOS)에
  Linux 런타임이 없어, 외부 명령을 스텁으로 대체한 상태에서 제어흐름만 검증했습니다.
  apt 설치 · nvm · `npm ci` 네이티브 빌드 · PM2 기동은 실환경 확인이 필요합니다.
- 커밋된 `*.hnsw` 인덱스가 arm64 macOS → x86_64 Linux에서 로드되는지 미확인입니다.
- `AX_NCO_SECRET` 상호 인증 실동작은 미확인입니다.

---

## 파일 구성

```
neural-cli-orchestrator/wsl-install/     ← 정본 (nco 저장소에 버전관리됨)
├── README-WSL.md                    이 문서
├── install-wsl.sh                   통합 설치 (프로바이더 선택 포함)
├── verify-wsl.sh                    설치 검증
└── env-templates/
    ├── nco.env.template             nco용 (.env.example 없을 때 폴백)
    └── nova-ax.env.template         nova-ax용 (저장소에 .env.example 없음)
```
