# claude-4: Mesh Auto-Responder 성능 분석

> 분석 대상: `mesh-auto-responder.js`
> 분석일: 2026-04-14

## 1. REPLY_COOLDOWN_MS 30초 적정성 평가

### 현재 설정
```javascript
const REPLY_COOLDOWN_MS = 30_000; // Line 369
```

### 적용 범위
- **발신자별 cooldown** (Line 390): 같은 발신자에게 30초 내 재응답 금지
- **브로드캐스트 글로벌 cooldown** (Line 385): 브로드캐스트 메시지에 30초 글로벌 제한

### 평가
| 항목 | 현재 | 평가 |
|------|------|------|
| 루프 방지 효과 | 30초 | 적절 — bot 간 무한 루프 차단 |
| 다중 태스크 처리 | 30초 | **부적절** — 5개 태스크 순차 전송 시 1개만 처리됨 |
| 사용자 대기 체감 | 30초 | 과도 — 10초면 충분 |

### 개선안
```javascript
const REPLY_COOLDOWN_MS = 10_000;       // DM: 10초로 축소
const BROADCAST_COOLDOWN_MS = 5_000;    // 브로드캐스트: 5초 (태스크별 처리)
// + 메시지 내용 기반 중복 판별 (같은 content만 cooldown)
```

## 2. tryDirectFileCreation 경로 파싱 분석

### 현재 정규식 (Line 198-199)
```javascript
const FILE_CREATE_RE = /(?:파일을?\s*(?:만들|생성|작성)|md\s*파일|\.md\s*(?:만들|생성|작성|파일))/i;
const PATH_RE = /([A-Za-z]:[\\\/][^\s,]+|\/mnt\/[^\s,]+|\/[a-z][^\s,]*\/[^\s,]+)/;
```

### 문제점
1. **PATH_RE가 첫 번째 경로를 잡음** — 소스 파일 경로(`/home/nova/...`)가 출력 디렉토리보다 먼저 매칭
2. **파일명 고정**: `${AGENT_ID}.md` — 커스텀 파일명 불가 (Line 289)
3. **Windows 경로 이중 슬래시**: `D:\\temp\\MESH-TEST` → `/mnt/d//temp//MESH-TEST`

### 개선안
```javascript
// Windows 경로 우선 매칭
const WIN_PATH_RE = /([A-Za-z]:[\\\/][^\s,]+)/;
const UNIX_PATH_RE = /(\/mnt\/[^\s,]+)/;
const path = content.match(WIN_PATH_RE)?.[1] || content.match(UNIX_PATH_RE)?.[1];

// 커스텀 파일명 추출
const filenameMatch = content.match(/(\S+\.md)\s*파일/);
const filename = filenameMatch?.[1] || `${AGENT_ID}.md`;
```

## 3. WebSocket 재연결 안정성

### 현재 로직 (Lines 395-403)
```javascript
ws.addEventListener('close', () => {
  console.log('WS 연결 끊김. 3초 후 재연결...');
  setTimeout(connect, 3000);  // 고정 3초 재연결
});
```

### 평가
- **장점**: 단순하고 예측 가능
- **단점**: 서버 재시작 시 모든 responder가 동시에 3초 후 연결 → 썬더링 허드

### 개선안
```javascript
// 지수 백오프 + 지터
let reconnectDelay = 1000;
ws.addEventListener('close', () => {
  const jitter = Math.random() * 2000;
  setTimeout(connect, reconnectDelay + jitter);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
});
ws.addEventListener('open', () => { reconnectDelay = 1000; });
```

## 4. 종합 성능 개선 제안

1. **Cooldown 세분화**: DM vs 브로드캐스트 분리, content 기반 중복 판별
2. **경로 파싱 강화**: Windows 경로 우선, 커스텀 파일명 지원
3. **WebSocket 지수 백오프**: 썬더링 허드 방지
4. **태스크 큐**: 동시 다중 [TASK] 수신 시 큐에 쌓고 순차 처리 (cooldown 우회)
