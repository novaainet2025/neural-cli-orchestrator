# ╔══════════════════════════════════════════════════════════════════════════╗
# ║      NCO (Neural CLI Orchestrator) — Windows Installer                  ║
# ║                                                                          ║
# ║  Windows 10/11 + WSL2 자동 설치 + NCO 전체 환경 구성                     ║
# ║                                                                          ║
# ║  사용법 (PowerShell — 관리자 권한):                                       ║
# ║    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass            ║
# ║    .\setup.ps1                                                           ║
# ║    .\setup.ps1 -SkipWSL      # WSL 이미 설치된 경우                     ║
# ║    .\setup.ps1 -NoInteractive # 자동 설치                                ║
# ╚══════════════════════════════════════════════════════════════════════════╝
#Requires -Version 5.1

param(
    [switch]$SkipWSL,
    [switch]$SkipOllama,
    [switch]$SkipVLLM,
    [switch]$NoInteractive
)

$ErrorActionPreference = "Stop"
$TOTAL_STEPS = 7
$script:Step = 0

# ── 색상 출력 ─────────────────────────────────────────────────────────────
function Write-Ok   { param($msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Info { param($msg) Write-Host "  ▶ $msg" -ForegroundColor Cyan }
function Write-Warn { param($msg) Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Err  { param($msg) Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }
function Write-Step {
    param($label)
    $script:Step++
    Write-Host "`n[$($script:Step)/$TOTAL_STEPS] $label" -ForegroundColor White -BackgroundColor DarkCyan
}

function Write-Banner {
    Clear-Host
    Write-Host @"

  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║    ███╗   ██╗ ██████╗ ██████╗                    ║
  ║    ████╗  ██║██╔════╝██╔═══██╗                   ║
  ║    ██╔██╗ ██║██║     ██║   ██║                   ║
  ║    ██║╚██╗██║██║     ██║   ██║                   ║
  ║    ██║ ╚████║╚██████╗╚██████╔╝                   ║
  ║    ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝                   ║
  ║                                                   ║
  ║    Neural CLI Orchestrator — Windows Installer    ║
  ║    v1.0                                           ║
  ╚═══════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan
}

# ── 관리자 권한 확인 ──────────────────────────────────────────────────────
function Test-Admin {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) {
        Write-Host "`n  관리자 권한이 필요합니다." -ForegroundColor Red
        Write-Host "  PowerShell을 '관리자로 실행'한 후 다시 시도하세요.`n"
        Write-Host "  빠른 방법: Win+X → 'Windows PowerShell(관리자)'"
        exit 1
    }
    Write-Ok "관리자 권한 확인됨"
}

# ═══════════════════════════════════════════════════════════════════════════
# 1. WSL2 설치
# ═══════════════════════════════════════════════════════════════════════════
function Install-WSL2 {
    Write-Step "WSL2 설치"

    if ($SkipWSL) {
        Write-Ok "WSL2 설치 스킵 (--SkipWSL)"
        return
    }

    # WSL 이미 설치 여부 확인
    try {
        $wslVer = wsl --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "WSL2 이미 설치됨"
            return
        }
    } catch {}

    Write-Info "WSL2 설치 중..."
    wsl --install --no-distribution
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "WSL2 설치 실패 또는 재부팅 필요"
    }

    Write-Host ""
    Write-Host "  WSL2 설치를 완료하려면 재부팅이 필요합니다." -ForegroundColor Yellow
    if (-not $NoInteractive) {
        $rb = Read-Host "  지금 재부팅할까요? [y/N]"
        if ($rb -match '^[Yy]$') {
            Restart-Computer -Force
        }
    }
    Write-Warn "재부팅 후 이 스크립트를 다시 실행하세요."
    exit 0
}

# ═══════════════════════════════════════════════════════════════════════════
# 2. Ubuntu 배포판 설치
# ═══════════════════════════════════════════════════════════════════════════
function Install-Ubuntu {
    Write-Step "Ubuntu 설치 (WSL2)"

    $distros = (wsl --list --quiet 2>$null) -join ""
    if ($distros -match "Ubuntu") {
        Write-Ok "Ubuntu 이미 설치됨"
        return
    }

    Write-Info "Ubuntu 설치 중... (약 2-3분)"
    wsl --install -d Ubuntu

    Write-Host ""
    Write-Host "  Ubuntu 초기 설정을 완료하세요:" -ForegroundColor Yellow
    Write-Host "  1. 사용자명 입력"
    Write-Host "  2. 비밀번호 설정"
    Write-Host "  3. 완료 후 이 스크립트를 다시 실행: .\setup.ps1 -SkipWSL"
    exit 0
}

# ═══════════════════════════════════════════════════════════════════════════
# 3. Windows 도구 설치 (Node.js, Windows Terminal)
# ═══════════════════════════════════════════════════════════════════════════
function Install-WindowsTools {
    Write-Step "Windows 도구 설치"

    # winget 확인
    $hasWinget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $hasWinget) {
        Write-Warn "winget 없음 — App Installer를 Microsoft Store에서 설치하세요"
        Write-Warn "Node.js는 https://nodejs.org 에서 수동 설치 가능"
    } else {
        # Node.js
        $nodeVer = node --version 2>$null
        if (-not $nodeVer) {
            Write-Info "Node.js LTS 설치 중..."
            winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements 2>$null
            $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
        }
        $nodeVer = node --version 2>$null
        if ($nodeVer) { Write-Ok "Node.js $nodeVer" } else { Write-Warn "Node.js 설치 확인 필요" }

        # Windows Terminal
        $hasWT = Get-Command wt -ErrorAction SilentlyContinue
        if (-not $hasWT) {
            Write-Info "Windows Terminal 설치 중..."
            winget install --id Microsoft.WindowsTerminal -e --silent --accept-source-agreements 2>$null
            Write-Ok "Windows Terminal 설치 완료"
        } else {
            Write-Ok "Windows Terminal 이미 설치됨"
        }
    }

    # Claude Code (Windows)
    $claudeVer = claude --version 2>$null
    if (-not $claudeVer) {
        Write-Info "Claude Code 설치 중..."
        try {
            npm install -g @anthropic-ai/claude-code 2>$null
            Write-Ok "Claude Code 설치 완료"
        } catch {
            Write-Warn "Claude Code 설치 실패 — WSL에서 설치됩니다"
        }
    } else {
        Write-Ok "Claude Code 이미 설치됨"
    }
}

# ═══════════════════════════════════════════════════════════════════════════
# 4. WSL에서 setup.sh 실행
# ═══════════════════════════════════════════════════════════════════════════
function Install-NCOinWSL {
    Write-Step "NCO 설치 (WSL 내부)"

    $ScriptDir = Split-Path -Parent $MyInvocation.ScriptName
    if (-not $ScriptDir) { $ScriptDir = Get-Location }

    # Windows 경로 → WSL 경로 변환
    $Drive = ($ScriptDir -replace "^([A-Za-z]):.*", '$1').ToLower()
    $WslPath = "/mnt/$Drive" + ($ScriptDir -replace "^[A-Za-z]:", "" -replace "\\", "/")

    Write-Info "WSL 경로: $WslPath"

    $ExtraArgs = ""
    if ($NoInteractive) { $ExtraArgs += " --no-interactive" }
    if ($SkipOllama -or $SkipVLLM) { $ExtraArgs += " --skip-ollama" }

    $WslCmd = "chmod +x '$WslPath/setup.sh' && bash '$WslPath/setup.sh'$ExtraArgs"

    Write-Info "WSL에서 setup.sh 실행 중..."
    Write-Host ""
    wsl --exec bash -c $WslCmd

    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Warn "setup.sh 오류 (exit $LASTEXITCODE)"
        Write-Warn "수동 실행: wsl bash '$WslPath/setup.sh'"
    } else {
        Write-Ok "WSL NCO 설치 완료"
    }
}

# ═══════════════════════════════════════════════════════════════════════════
# 5. 바탕화면 바로가기 생성
# ═══════════════════════════════════════════════════════════════════════════
function Create-Shortcuts {
    Write-Step "바탕화면 바로가기 생성"

    $Desktop = [Environment]::GetFolderPath("Desktop")

    # NCO Start
    @"
@echo off
title NCO - Neural CLI Orchestrator
echo Starting NCO...
wsl bash -c "cd ~/projects/neural-cli-orchestrator && node dist/index.js &" 2>nul
wsl claude --dangerously-skip-permissions
"@ | Set-Content -Path "$Desktop\NCO Start.bat" -Encoding UTF8
    Write-Ok "바로가기: NCO Start.bat"

    # Claude Gemma
    @"
@echo off
title Claude Gemma (Ollama)
wsl claude-gemma --dangerously-skip-permissions
"@ | Set-Content -Path "$Desktop\Claude Gemma.bat" -Encoding UTF8
    Write-Ok "바로가기: Claude Gemma.bat"

    # Claude Code (일반)
    @"
@echo off
title Claude Code
wsl claude --dangerously-skip-permissions
"@ | Set-Content -Path "$Desktop\Claude Code.bat" -Encoding UTF8
    Write-Ok "바로가기: Claude Code.bat"
}

# ═══════════════════════════════════════════════════════════════════════════
# 6. Ollama 안내
# ═══════════════════════════════════════════════════════════════════════════
function Show-OllamaNotice {
    if ($SkipOllama -or $SkipVLLM) { return }

    Write-Host "`n  ── Ollama 로컬 AI (선택 — GPU 권장) ──" -ForegroundColor Cyan
    Write-Host "  Windows: https://ollama.com 에서 설치 후:"
    Write-Host "    ollama pull gemma4:26b"
    Write-Host "  NCO Validator는 http://localhost:11434/v1 (ai-providers.json) 을 사용합니다."
}

# ═══════════════════════════════════════════════════════════════════════════
# 완료 메시지
# ═══════════════════════════════════════════════════════════════════════════
function Write-Done {
    Write-Host @"

  ╔═══════════════════════════════════════════════════╗
  ║  NCO 설치 완료!                                   ║
  ╚═══════════════════════════════════════════════════╝

  다음 단계:
  1. WSL 터미널 열기: wsl  (또는 Windows Terminal)
  2. source ~/.bashrc
  3. claude  →  /nco-start  →  /nco-status

  바탕화면 바로가기:
  - NCO Start.bat    : NCO + Claude Code 시작
  - Claude Gemma.bat : Gemma(Ollama) + Claude Code
  - Claude Code.bat  : 일반 Claude Code

  API 키 설정 (WSL에서):
  nano ~/projects/neural-cli-orchestrator/.env

"@ -ForegroundColor White
}

# ═══════════════════════════════════════════════════════════════════════════
# 메인
# ═══════════════════════════════════════════════════════════════════════════
Write-Banner
Test-Admin
Install-WSL2
Install-Ubuntu
Install-WindowsTools
Install-NCOinWSL
Create-Shortcuts
Show-OllamaNotice
Write-Done
