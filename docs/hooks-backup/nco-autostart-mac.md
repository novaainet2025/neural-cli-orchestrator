# NCO 자동시작 — Mac 대응 가이드

> Windows `nco-autostart-backend.vbs` / `nco-autostart-full.vbs` 대응
> (platform/windows 75d3b0b 커밋 본문에서 발췌 + Mac 적용)

## 방법 1: pm2 startup (추천 — 이미 pm2 사용 중)

```bash
# 1. startup 스크립트 생성 (출력된 sudo 명령 실행)
pm2 startup launchd

# 2. 현재 프로세스 스냅샷 저장 → 부팅 시 자동 복원
pm2 save
```

현재 실행 중인 프로세스:
- `nco-backend` — NCO 백엔드 (포트 6200/6201)
- `mlx-server` — MLX 로컬 추론 서버 (포트 8000/4100)

## 방법 2: launchd plist (시스템 표준)

```xml
<!-- ~/Library/LaunchAgents/net.nova.nco-autostart.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>net.nova.nco-autostart</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>cd ~/project/nco &amp;&amp; npm start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/nco-autostart.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/nco-autostart-err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/net.nova.nco-autostart.plist
```

## Windows → Mac 치환표

| Windows (VBS)              | Mac 대응                    |
|----------------------------|-----------------------------|
| `chr(34)` (큰따옴표)       | `"` 또는 `'...'`           |
| `timeout /t 3 /nobreak`   | `sleep 3`                  |
| `WScript.Shell.Run`       | `open -a` 또는 직접 실행    |
| `%APPDATA%\...\Startup\`  | `~/Library/LaunchAgents/`  |
| `.vbs` 스크립트            | `.plist` 또는 pm2 ecosystem |

## 주의

- 이 문서는 참조용 — platform/windows 커밋의 VBS는 Mac에 머지하지 않음
- pm2 방식이 이미 사용 중이므로 `pm2 startup launchd && pm2 save`가 가장 간단
