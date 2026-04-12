> **작성일**: 2026-04-12
> **버전**: v1.0
> **상태**: 초안
> **요약**: Designer/Supervisor의 멀티모달 UI/UX 리뷰 시스템 아키텍처 설계

# NCO 멀티모달 UI/UX 리뷰 시스템 설계서 (v1.0)

## 0. 도입 배경

NCO의 9개 AI 팀 중 **Designer/Supervisor(Gemini)**는 단순한 코드 작성을 넘어 UI/UX의 시각적 완성도를 검토하고, 멀티모달 분석을 통해 디자인 결함을 발견하는 역할을 수행합니다. 본 문서는 이를 지원하기 위한 백엔드 아키텍처와 도구 세트를 정의합니다.

---

## 1. 아키텍처 개요

기본적인 텍스트 기반 `OrchestratedLoop`를 확장하여, 시각적 데이터를 수집(Capture), 분석(Analyze), 피드백(Feedback)하는 3단계 멀티모달 파이프라인을 구축합니다.

```
┌─────────────────────────────────────────────────────┐
│  Designer / Supervisor Multimodal Pipeline           │
│                                                     │
│  [Agent]   Gemini (Designer)                        │
│               │ (tool: capture_screenshot)          │
│               ▼                                     │
│  [Core]    UI Inspector (Playwright 기반)           │
│               │ (returns Image Artifact)             │
│               ▼                                     │
│  [Agent]   Multimodal Processor (Base64 Encoding)   │
│               │ (Visual Prompt Context)              │
│               ▼                                     │
│  [API]     Gemini Multimodal API (Pro/Flash)        │
│               │ (JSON/Text Review Report)           │
│               ▼                                     │
│  [Event]   action:review / message:direct           │
└─────────────────────────────────────────────────────┘
```

---

## 2. 파일 구조 (신규 및 확장)

```
src/
├── agent/
│   ├── multimodal/
│   │   ├── processor.ts          # 이미지 인코딩 및 토큰화 유틸리티
│   │   └── vision-prompts.ts     # 접근성, 레이아웃, 컬러 분석 전용 프롬프트셋
├── core/
│   ├── ui-inspector.ts           # Playwright 기반 Headless 브라우저 연동
│   └── visual-diff.ts            # 시각적 회귀 테스트(VRT) 엔진
├── security/
│   └── visual-guard.ts           # 스크린샷 내 민감 정보(PII, Credentials) 마스킹
└── docs/design/
    └── NCO-멀티모달-UI-리뷰-설계서.md  (본 문서)
```

---

## 3. 인터페이스 명세

### 3.1 Designer 전용 도구 (AgentTools)

`src/agent/agent-tools.ts`에 다음 도구들을 추가 구현합니다.

```typescript
interface MultimodalTools {
  /**
   * 로컬 프로젝트의 특정 경로 또는 URL을 렌더링하여 스크린샷 캡처
   * @param target URL 또는 로컬 파일 경로
   * @param viewport 뷰포트 크기 (기본값: 1280x720)
   */
  captureScreenshot(target: string, viewport?: { width: number, height: number }): Promise<string>;
  
  /**
   * 캡처된 이미지를 분석하여 디자인 가이드를 기반으로 리뷰 수행
   * @param imagePath 분석할 이미지 경로
   * @param focus 분석 중점 사항 (접근성, 레이아웃, 타이포그래피 등)
   */
  analyzeVisuals(imagePath: string, focus: string): Promise<VisualAnalysisResult>;
  
  /**
   * 발견된 시각적 결함을 엔지니어(Codex/Aider)에게 수정 요청
   */
  requestUIFix(issue: string, screenshotPath: string, targetAgent: string): Promise<void>;
}
```

### 3.2 데이터 모델 (VisualAnalysisResult)

```typescript
interface VisualAnalysisResult {
  overallScore: number;           // 0~100 점수
  accessibility: {
    passed: boolean;
    issues: string[];             // 명도 대비, 폰트 크기 등
  };
  layout: {
    alignment: 'pass' | 'fail';
    spacing: string;              // 여백 일관성 분석
  };
  recommendations: string[];      // 개선 제안 목록
}
```

---

## 4. 데이터 흐름 (Data Flow)

1.  **지시 (Dispatch)**: Commander(claude-code)가 Designer(gemini)에게 "새 로그인 화면의 모바일 UI 접근성 검토" 작업을 할당합니다.
2.  **캡처 (Capture)**: Designer는 `captureScreenshot` 도구를 실행합니다.
    - `ui-inspector.ts`가 Playwright를 통해 로컬 서버의 렌더링 화면을 캡처합니다.
    - `visual-guard.ts`가 화면 내의 `.env` 값이나 민감한 텍스트를 자동 마스킹합니다.
3.  **분석 (Analyze)**: Designer는 `analyzeVisuals` 도구를 실행합니다.
    - `multimodal-processor.ts`가 이미지를 Gemini API 규격에 맞춰 인코딩합니다.
    - `vision-prompts.ts`에서 "Accessibility Expert" 페르소나를 로드하여 API를 호출합니다.
4.  **전파 (Feedback)**: Designer는 분석 결과가 담긴 `action:review` 이벤트를 Event Bus에 발행하고, 필요한 경우 Engineer에게 직접 메시지를 보냅니다.

---

## 5. 구현 우선순위 및 스택

1.  **UI Inspector 엔진 (P1)**: `playwright-core`를 활용한 캡처 기능 구현.
2.  **Multimodal Bridge (P1)**: Gemini Vision API 연동 및 이미지 데이터 처리.
3.  **Visual Guard (P2)**: 이미지 내 텍스트 인식(OCR)을 통한 민감 정보 마스킹.
4.  **VRT (P3)**: 이전 커밋과 현재 상태의 시각적 차이(Pixel Match) 분석.

**기술 스택**:
- **Library**: `playwright-core` (Headless Browser), `sharp` (Image Processing)
- **AI**: Gemini 1.5 Pro / 2.0 (Multimodal Support)
- **Security**: Tesseract.js (Local OCR for Redaction)
