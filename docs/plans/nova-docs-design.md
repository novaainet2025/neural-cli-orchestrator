# nova-docs Phase 1 MVP 상세 기술 설계

> 정본 경로: `/Users/nova-ai/project/nova-use/docs/plans/nova-docs-design.md`  
> 설계 기준: `nova-docs-master-plan.md` §1–§4.5, 현재 `src/` 구조 및 `electron.vite.config.ts` (renderer root=`src/renderer`)  
> 범위: 단일 사용자, 열기·미리보기·검색·제한 편집·제안/diff/확정 저장·버전 되돌리기. 실시간 협업은 제외한다.

## 1. 파일 트리와 프로세스 경계

`src/docs/**`는 Electron **main process 전용**이다. React는 `src/renderer`에만 두며, 파일 경로·원본 bytes·프로세스 spawn 권한을 갖지 않는다. Renderer는 preload가 노출한 좁은 `window.nova.docs` API만 사용한다. LLM은 문서 바이트나 ZIP/XML/PDF를 직접 변경하지 않고 §6의 `EditPlan`만 생성한다.

```text
src/docs/
├── document-core/
│   ├── index.ts
│   ├── types.ts                    # §2 공용 타입·인터페이스
│   ├── document-session.ts         # 세션 상태 머신
│   ├── transaction.ts              # forward/inverse transaction
│   ├── validator.ts                # schema + semantic validation
│   ├── save-pipeline.ts            # temp→verify→backup→atomic replace
│   ├── session-manager.ts
│   ├── snapshot-store.ts
│   └── errors.ts
├── adapters/
│   ├── index.ts                    # format → adapter registry
│   ├── shared/{capability-probe.ts,process-runner.ts,preview-artifact.ts}
│   ├── docx/{docx-adapter.ts,officecli-client.ts}
│   ├── xlsx/{xlsx-adapter.ts,workbook-bridge.ts}
│   ├── pptx/{pptx-adapter.ts,slide-preview.ts}
│   ├── hwpx/{hwpx-adapter.ts,hwpx-sidecar-client.ts}
│   ├── hwp-viewer/hwp-viewer-adapter.ts
│   └── pdf/{pdf-adapter.ts,pdf-lib-client.ts}
├── ai/
│   ├── edit-plan-schema.ts
│   ├── edit-plan-validator.ts
│   ├── plan-generator.ts           # LLM 호출; JSON만 수용
│   ├── plan-executor.ts
│   ├── precondition.ts
│   └── undo-log.ts
├── sidecar/
│   ├── protocol.ts                 # TS JSON-RPC DTO
│   └── supervisor.ts               # spawn/health/queue/shutdown
└── infrastructure/
    ├── atomic-file-store.ts
    ├── document-job-queue.ts
    └── document-path-policy.ts

src/main/docs-ipc.ts                # IPC handler 등록
src/preload/index.ts                # window.nova.docs bridge만 추가
src/shared/docs-ipc.ts              # bridge/DTO/channel 이름
src/shared/ipc.ts                   # Nova API의 docs namespace 선언
src/main/handlers.ts                # docs IPC 등록 1줄
sidecar/hwpx/{nova_hwpx_sidecar.py,protocol.py,requirements.lock}
src/renderer/components/docs/{DocsWorkspace.tsx,DocsTabBar.tsx,DocsFileBrowser.tsx}
src/renderer/components/docs/viewers/{DocxViewer.tsx,XlsxUniverHost.tsx,PptxViewer.tsx,HwpxViewer.tsx,HwpViewer.tsx,PdfViewer.tsx}
src/renderer/components/docs/panels/{SelectionEditPanel.tsx,PlanDiffPanel.tsx,ConfirmSaveBar.tsx}
src/renderer/components/docs/hooks/useDocsSession.ts
src/renderer/store/useDocsStore.ts
```

Univer는 `XlsxUniverHost`의 **스프레드시트 캔버스**로만 쓴다. import/export round-trip probe가 통과하기 전에는 저장을 비활성화한다. HWPX UI는 선택영역 편집 패널과 preview만 제공하며, 가짜 WYSIWYG를 만들지 않는다.

## 2. document-core 계약 (strict TypeScript)

다음 선언은 `strict: true`에서 독립적으로 컴파일되는 `src/docs/document-core/types.ts`의 계약이다. `DocumentSession`과 모든 adapter는 main에서만 구현한다.

```ts
export type DocumentFormat = 'docx' | 'xlsx' | 'pptx' | 'hwpx' | 'hwp' | 'pdf'
export type SessionState = 'opening' | 'ready' | 'dirty' | 'saving' | 'failed' | 'closed'
export type EditOperation =
  | 'replaceText' | 'insertParagraph' | 'deleteRange' | 'updateTableCell'
  | 'updateSpreadsheetCell' | 'setSpreadsheetFormula' | 'setSlideText'
  | 'addPdfAnnotation' | 'addPdfOverlay' | 'updatePdfFormField'
  | 'insertPdfPage' | 'deletePdfPage' | 'rotatePdfPage' | 'mergePdf' | 'splitPdf'

export interface DocumentBlock {
  readonly id: string
  readonly kind: 'paragraph' | 'tableCell' | 'spreadsheetCell' | 'slideText' | 'pdfPage' | 'pdfFormField'
  readonly hash: string
  readonly text?: string
  readonly location: Readonly<Record<string, string | number>>
}
export interface DocumentModel { readonly revision: number; readonly blocks: readonly DocumentBlock[] }
export interface CommandTarget { readonly blockId?: string; readonly page?: number; readonly sheet?: string; readonly cell?: string; readonly slide?: number }
export interface CommandPrecondition { readonly revision: number; readonly targetHash?: string; readonly expectedText?: string }
export interface EditCommand {
  readonly commandId: string; readonly op: EditOperation; readonly target: CommandTarget
  readonly precondition: CommandPrecondition; readonly args: Readonly<Record<string, unknown>>
}
export interface EditPlan {
  readonly planId: string; readonly sessionId: string; readonly baseRevision: number
  readonly sourceHash: string; readonly intent: string; readonly commands: readonly EditCommand[]
}
export interface ValidationIssue { readonly code: string; readonly path: string; readonly message: string }
export interface ValidationResult { readonly ok: boolean; readonly errors: readonly ValidationIssue[]; readonly warnings: readonly ValidationIssue[] }
export interface ChangeRecord { readonly commandId: string; readonly before: unknown; readonly after: unknown }
export interface Transaction {
  readonly id: string; readonly sessionId: string; readonly planId: string; readonly baseRevision: number
  readonly forward: readonly EditCommand[]; readonly inverse: readonly EditCommand[]
  readonly changes: readonly ChangeRecord[]; readonly validation: ValidationResult
}
export interface SaveRequest { readonly sessionId: string; readonly transactionId: string; readonly expectedRevision: number; readonly userConfirmed: true }
export interface SaveResult { readonly revision: number; readonly savedPath: string; readonly backupPath: string; readonly contentHash: string }
export interface DocumentSession {
  readonly id: string; readonly format: DocumentFormat; readonly sourceHash: string
  readonly state: SessionState; readonly revision: number; readonly supportedOperations: readonly EditOperation[]
  readModel(): Promise<DocumentModel>
  stage(plan: EditPlan): Promise<Transaction>
  undo(transactionId: string): Promise<Transaction>
  redo(transactionId: string): Promise<Transaction>
  save(request: SaveRequest): Promise<SaveResult>
  close(): Promise<void>
}
export interface Validator {
  validatePlan(plan: EditPlan, session: DocumentSession): Promise<ValidationResult>
  validateTransaction(transaction: Transaction, session: DocumentSession): Promise<ValidationResult>
  validateStagedArtifact(session: DocumentSession, stagedPath: string): Promise<ValidationResult>
}
export interface ValidatedStagedArtifact { readonly stagedPath: string; readonly contentHash: string; readonly validated: true }
export interface SavePipeline {
  save(request: SaveRequest, artifact: ValidatedStagedArtifact): Promise<SaveResult>
  recover(sessionId: string): Promise<{ readonly recovered: boolean; readonly reason?: string }>
}
export interface FormatAdapter {
  readonly format: DocumentFormat; readonly supportedOperations: readonly EditOperation[]
  open(sessionId: string, sourcePath: string): Promise<{ readonly model: DocumentModel; readonly sourceHash: string }>
  apply(session: DocumentSession, transaction: Transaction, stagedPath: string): Promise<{ readonly model: DocumentModel; readonly artifactHash: string }>
  renderPreview(session: DocumentSession, stagedPath: string): Promise<{ readonly path: string; readonly mimeType: string; readonly hash: string }>
  validate(session: DocumentSession, stagedPath: string): Promise<ValidationResult>
  close(sessionId: string): Promise<void>
}
```

저장은 session별 단일 job queue에서만 실행한다: revision/sourceHash 재확인 → session temp에 adapter 적용 → 포맷 재열기 검증 → render diff → 사용자 확인 → 같은 볼륨 backup → atomic replace → hash/revision 기록. 어느 단계든 실패하면 원본을 바꾸지 않는다. 교체가 원자적이지 않은 파일시스템은 저장 실패로 처리하며 복사 방식으로 강등하지 않는다.

## 3. 포맷 adapter 책임, 의존성, 제외 범위

| Adapter | Phase 1 책임 | 의존 바이너리/라이브러리 | 명시적 미지원 |
| --- | --- | --- | --- |
| `docx` | 문단·표 셀의 텍스트 중심 model/transaction, 저장 후 재열기 검증 | OfficeCLI; preview는 LibreOffice headless | Word급 WYSIWYG, 도형/매크로/변경추적 완전 보존, LLM OOXML 직접 조작 |
| `xlsx` | 셀값·수식 transaction. probe된 입출력 경로에서만 원본 저장 | Renderer: Univer Sheets; Main: OfficeCLI 또는 검증된 변환; LibreOffice preview | Univer 단독 저장, VBA·피벗·차트 편집, probe 전 save |
| `pptx` | 열람 우선; capability가 증명된 텍스트 객체의 `setSlideText`만 | OfficeCLI, LibreOffice preview | 애니메이션·전환·도형 배치·미디어 WYSIWYG |
| `hwpx` | python-hwpx로 문단/표 셀 편집, rhwp preview artifact | python-hwpx sidecar, rhwp(뷰어 전용) | rhwp 저장/편집, HWP 바이너리 편집, 한컴 전용 객체 완전 보존 |
| `pdf` | 주석·highlight·overlay·form·page insert/delete/rotate·merge/split | Renderer: PDF.js; Main: pdf-lib; Office 파생 PDF: LibreOffice headless | 기존 본문 reflow 편집, PDF→Office 역변환, PyMuPDF(AGPL) |

`hwp-viewer`는 rhwp로 rendering artifact만 만들며 edit/save operation은 빈 집합이다. HWP→HWPX 변환 버튼도 검증된 변환 엔진이 생기기 전에는 노출하지 않는다. PDF는 기존 페이지에 비파괴 변경을 하거나 원본 Office를 수정해 새 파생 PDF를 만드는 두 경로만 허용한다.

## 4. Main↔Renderer IPC 허용 목록

모든 payload는 main에서 JSON schema와 session ownership을 검증한다. preload bridge는 raw `ipcRenderer`를 노출하지 않는다. drag/drop에서 UI는 `File`을 bridge에 넘기며, **preload만** `webUtils.getPathForFile(file)`로 내부 path를 얻어 `docs:openDropped`를 호출한다. 따라서 React API와 renderer state에는 filesystem path가 없다.

| Channel | Bridge request | Main 결과/제한 |
| --- | --- | --- |
| `docs:pickOpen` | 없음 | native dialog로 선택한 regular file만 세션화 |
| `docs:openDropped` | preload 내부 `{ sourcePath }` | MIME/확장자/realpath/readability를 재검사 |
| `docs:getSession` | `{ sessionId }` | metadata/capability만 |
| `docs:getPreview` | `{ sessionId, revision }` | main-owned preview token/표시 데이터만 |
| `docs:search` | `{ sessionId, revision, query }` | 제한된 model 검색 결과 |
| `docs:proposePlan` | `{ sessionId, expectedRevision, instruction }` | main LLM가 plan 생성·검증; 저장 금지 |
| `docs:stagePlan` | `{ sessionId, planId }` | 검증된 plan만 staged artifact와 read-only diff 생성 |
| `docs:commitPlan` | `{ sessionId, transactionId, expectedRevision, userConfirmed: true }` | SavePipeline만 호출; path/bytes 거부 |
| `docs:undo`, `docs:redo` | `{ sessionId, transactionId, expectedRevision }` | 기록된 inverse/forward만 stage |
| `docs:listVersions` | `{ sessionId }` | snapshot metadata만 |
| `docs:restoreVersion` | `{ sessionId, revision, userConfirmed: true }` | staged transaction 경유 |
| `docs:close` | `{ sessionId }` | queue drain 후 handle/temp 정리 |

Main→Renderer event는 `docs:progress`, `docs:sessionChanged`, `docs:capabilityChanged`, `docs:sidecarStatus`뿐이다. `docs:open(path)`, generic invoke, write/export-by-path, process spawn, raw bytes 채널은 만들지 않는다.

## 5. python-hwpx sidecar JSON-RPC와 생명주기

Main은 필요 시 long-lived Python child를 spawn하고 stdin/stdout으로 **JSON-RPC 2.0 NDJSON**를 전송한다. stdout은 protocol 전용, stderr는 로그 전용이다. localhost port/token은 사용하지 않는다. JSON에 HWPX base64를 넣지 않으며, session work directory 안의 상대 파일명만 넘긴다. sidecar는 `..`, separator, symlink와 `.hwpx` 외 예상 밖 확장자를 거부한다. notification은 금지한다.

```json
{"jsonrpc":"2.0","id":"req-42","method":"hwpx.apply","params":{"jobId":"job-7","inputFile":"source.hwpx","outputFile":"staged.hwpx","commands":[]}}
```

성공은 `{"jsonrpc":"2.0","id":"req-42","result":{...}}`, 실패는 `{"jsonrpc":"2.0","id":"req-42","error":{"code":-32010,"message":"...","data":{"kind":"VALIDATION"}}}`이다. 표준 오류는 `-32700/-32600/-32601/-32602/-32603`를 사용한다.

| Method | Params | Result |
| --- | --- | --- |
| `sidecar.health` | `{ protocolVersion: 1 }` | `{ protocolVersion: 1, pythonHwpxVersion, ready: true }` |
| `hwpx.inspect` | `{ jobId, inputFile }` | `{ model, sourceHash }` |
| `hwpx.apply` | `{ jobId, inputFile, outputFile, commands }` | `{ model, artifactHash, changeLog }` |
| `hwpx.validate` | `{ jobId, inputFile }` | `{ ok, issues }` |
| `hwpx.renderPreview` | `{ jobId, inputFile, outputFile }` | `{ artifactFile, mimeType, hash }` |
| `hwpx.closeJob` | `{ jobId }` | `{ closed: true }` |
| `sidecar.shutdown` | `{ reason: 'app-quit' \| 'restart' }` | `{ accepted: true }` |

첫 HWPX 편집에서 Python/script를 resolve하고 spawn한다. 2초 이내 `health`의 id와 `protocolVersion===1`, `ready===true`를 확인한 뒤 단일 request queue(최대 줄 길이, timeout, pending-id map)로 전환한다. crash·invalid JSON·timeout이면 in-flight 요청은 실패시키고 원본은 불변이다. 읽기/검증 요청에 한해 한 번 lazy restart할 수 있으나 apply/save는 자동 재실행하지 않는다. 앱 종료 시 `shutdown`을 2초 기다린 뒤 종료하고, 실패를 성공 상태로 보고하지 않는다.

## 6. AI 편집: EditPlan schema, 제한 명령, precondition/undo

흐름은 `read-only snapshot + instruction → main LLM의 EditPlan JSON → schema → semantic validator → Transaction → staged artifact + 재열기 검증 → rendered diff → userConfirmed → SavePipeline`이다. schema는 untrusted LLM output의 모양만 확인하고, 의미 검증을 대체하지 않는다.

```json
{
  "$schema":"https://json-schema.org/draft/2020-12/schema",
  "type":"object", "additionalProperties":false,
  "required":["planId","sessionId","baseRevision","sourceHash","intent","commands"],
  "properties":{
    "planId":{"type":"string","minLength":1},
    "sessionId":{"type":"string","minLength":1},
    "baseRevision":{"type":"integer","minimum":0},
    "sourceHash":{"type":"string","pattern":"^[A-Fa-f0-9]{64}$"},
    "intent":{"type":"string","minLength":1,"maxLength":2000},
    "commands":{"type":"array","minItems":1,"maxItems":100,"items":{"$ref":"#/$defs/command"}}
  },
  "$defs":{"command":{"type":"object","additionalProperties":false,
    "required":["commandId","op","target","precondition","args"],
    "properties":{"commandId":{"type":"string"},
      "op":{"enum":["replaceText","insertParagraph","deleteRange","updateTableCell","updateSpreadsheetCell","setSpreadsheetFormula","setSlideText","addPdfAnnotation","addPdfOverlay","updatePdfFormField","insertPdfPage","deletePdfPage","rotatePdfPage","mergePdf","splitPdf"]},
      "target":{"type":"object"},
      "precondition":{"type":"object","required":["revision"]},
      "args":{"type":"object","maxProperties":20}}}}
}
```

허용 매핑은 DOCX/HWPX=`replaceText`, `insertParagraph`, `deleteRange`, `updateTableCell`; XLSX=`updateSpreadsheetCell`, `setSpreadsheetFormula`; PPTX=`setSlideText`; PDF=나머지 PDF operation이다. `hwp` edit operation은 없다. `runCommand`, `writeFile`, arbitrary path export, network fetch, macro 실행, OOXML/XML/ZIP/PDF binary replace는 schema에도 adapter에도 존재하지 않는다. merge/split의 입력은 main이 session화한 artifact로 제한한다.

실행 전에 (1) session 귀속, (2) `baseRevision`, (3) 문서 `sourceHash`, (4) target 존재와 block `targetHash`/`expectedText`, (5) adapter capability, (6) argument/page/cell/document bounds를 모두 검사한다. 하나라도 실패하면 plan 전체를 rejected로 끝내며 staged artifact와 원본을 저장하지 않는다. 적용 때마다 immutable undo log에 before semantic value, inverse command, target, base/result revision, artifact hash를 적는다. undo/redo는 LLM을 다시 부르지 않고 저장된 inverse/forward를 새 transaction으로 재검증·stage·확정 저장한다. hash 또는 revision 충돌은 conflict이며 덮어쓰지 않는다.

## 7. 병렬 구현 분해와 무중복 소유권

공유 파일의 공동 편집을 금지한다. 계약이 바뀌면 소유자 Track C에 요청하고 다른 track은 수신된 계약만 소비한다. cursor-agent는 변경하지 않고 review/typecheck/test를 담당한다.

| Track | 담당 | 단독 소유 파일 |
| --- | --- | --- |
| A | codex — core/adapters | `src/docs/document-core/**`, `src/docs/adapters/index.ts`, `src/docs/adapters/shared/**`, `src/docs/adapters/docx/**`, `src/docs/adapters/xlsx/**`, `src/docs/adapters/pptx/**`, `src/docs/adapters/pdf/**`, `src/docs/adapters/hwp-viewer/**`, `src/docs/infrastructure/{atomic-file-store.ts,document-job-queue.ts,document-path-policy.ts}`, `tests/docs/document-core.spec.ts`, `tests/docs/adapters.spec.ts` |
| B | agy — React UI | `src/renderer/components/docs/**`, `src/renderer/store/useDocsStore.ts`, `src/renderer/App.tsx`의 docs route 최소 diff, `tests/renderer/docs-workspace.spec.tsx` |
| C | codex — AI/sidecar/IPC | `src/docs/ai/**`, `src/docs/sidecar/**`, `src/docs/adapters/hwpx/**`, `src/main/docs-ipc.ts`, `src/shared/docs-ipc.ts`, `src/shared/ipc.ts`의 docs namespace, `src/preload/index.ts`의 docs bridge, `src/main/handlers.ts`의 등록 1줄, `sidecar/hwpx/**`, `tests/docs/{ai-pipeline.spec.ts,hwpx-rpc.spec.ts}`, `tests/main/docs-ipc.spec.ts` |

따라서 A∩B=A∩C=B∩C=∅이다. 구현 순서는 C가 IPC contract/mock handler를 먼저 고정하고, A가 core/non-HWPX adapter와 저장 테스트를, C가 AI/sidecar를, B가 bridge 소비 UI를 병렬 구현한다. 이후 cursor-agent가 `npm run typecheck`, `npm test`, 그리고 5개 포맷의 open→허용 편집→save→reopen 및 schema 실패 시 원본 불변을 T1로 확인한다. 실제 의존성 설치·sidecar 번들·실앱 왕복은 이 설계 문서 작성 시점에는 아직 미검증이다.
