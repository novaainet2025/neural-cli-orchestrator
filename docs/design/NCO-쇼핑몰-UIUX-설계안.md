# NCO 쇼핑몰 UI/UX 및 인터페이스 설계안 (v1.0)

## 1. UI/UX 전략 및 원칙

### 1.1 디자인 목표
- **심플함 (Simplicity)**: 사용자가 고민 없이 구매 여정을 완료할 수 있는 간결한 인터페이스.
- **신뢰성 (Reliability)**: 결제 및 배송 정보의 명확한 전달과 보안 요소 강조.
- **반응성 (Responsiveness)**: 200ms 이내 응답을 체감할 수 있는 최적화된 모바일-퍼스트 레이아웃.

### 1.2 핵심 UX 원칙
- **3-Click Rule**: 메인 화면에서 상품 결제 단계까지 최대 3번의 주요 클릭으로 도달.
- **Visual Feedback**: 장바구니 담기, 결제 완료 등 상태 변화 시 즉각적인 시각적 보상 제공.
- **Mobile First**: 엄지손가락 조작 범위(Thumb Zone)를 고려한 하단 탭 바 및 큰 터치 타겟 적용.

---

## 2. 디자인 시스템 (Visual Identity)

### 2.1 컬러 팔레트
| 용도 | 색상 코드 | 느낌 |
|------|-----------|------|
| **Primary** | `#1A1A2E` | 신뢰감 있는 네이비 (브랜드 메인) |
| **Accent** | `#4FC3F7` | 활력을 주는 스카이 블루 (CTA 버튼) |
| **Background** | `#F8F9FA` | 깨끗한 배경 (Light 모드 기준) |
| **Success** | `#4CAF50` | 긍정적인 완료 상태 |
| **Error** | `#FF5252` | 주의가 필요한 오류 상태 |

### 2.2 타이포그래피
- **Primary Font**: `Pretendard` (가독성이 뛰어난 산세리프 체)
- **Scale**:
  - Heading 1: 24px, Bold (페이지 타이틀)
  - Heading 2: 18px, SemiBold (섹션 타이틀)
  - Body: 14px, Regular (상품 설명, 기본 텍스트)
  - Caption: 12px, Regular (부가 정보, 메타데이터)

---

## 3. 주요 화면 설계 (Wireframe Concepts)

### 3.1 메인 페이지 (Home)
- **Top**: 검색창 (Auto-complete 지원) 및 장바구니 아이콘.
- **Hero**: 대형 프로모션 배너 (이미지 로딩 최적화 적용).
- **Body**: 카테고리 퀵 메뉴, "실시간 인기 상품" 그리드 레이아웃.

### 3.2 상품 목록 & 검색 (Listing)
- **Filter**: 하단 시트(Bottom Sheet) 형태의 필터링 (가격대, 카테고리, 평점).
- **Grid**: 2열 그리드 (모바일) / 4열 그리드 (데스크탑).
- **Interaction**: 스크롤 시 상단 헤더 고정 (Sticky Header).

### 3.3 상품 상세 (Detail)
- **Image**: 스와이프 가능한 고해상도 이미지 갤러리.
- **Sticky Bottom CTA**: "장바구니"와 "바로 구매" 버튼을 하단에 고정하여 접근성 극대화.
- **Info**: 아코디언 형식의 상세 설명, 상품평, 배송/환불 안내.

### 3.4 주문/결제 (Checkout)
- **Progress Bar**: 장바구니 → 주문서 작성 → 결제 완료 단계 표시.
- **Simplified Form**: 배송지 주소 자동 완성, 최근 사용 결제 수단 우선 노출.
- **Trust Elements**: 결제 보안 인증 로고 및 안내 문구 배치.

---

## 4. 인터페이스 명세 (API Interface Spec)

프론트엔드(React/Next.js)와 백엔드(Microservices) 간의 통신 규약입니다.

### 4.1 상품 서비스 (Product Service)
- `GET /api/v1/products`: 상품 목록 조회 (Paging, Filter 적용).
- `GET /api/v1/products/:id`: 특정 상품 상세 정보.
- `GET /api/v1/categories`: 전체 카테고리 구조.

### 4.2 주문 서비스 (Order Service)
- `POST /api/v1/orders`: 신규 주문 생성.
- `GET /api/v1/orders/me`: 현재 로그인 사용자의 주문 내역.
- `PUT /api/v1/orders/:id/cancel`: 주문 취소 요청.

### 4.3 결제 서비스 (Payment Service)
- `POST /api/v1/payments/ready`: PG사 결제창 호출을 위한 사전 데이터 준비.
- `POST /api/v1/payments/approve`: 결제 승인 결과 검증 및 저장.

### 4.4 공통 응답 규격
```json
{
  "success": true,
  "data": { ... },
  "error": null,
  "timestamp": "2026-06-10T15:00:00Z"
}
```

---

## 5. 관리자 페이지 (Admin UI)

### 5.1 대시보드
- **Visuals**: 매출 추이 그래프 (Recharts 활용), 실시간 주문 현황 카드.
- **Navigation**: 상품 관리, 회원 관리, 주문/배송 관리, 프로모션 설정 사이드바.

### 5.2 데이터 관리
- **Tables**: 정렬 및 멀티 체크박스 지원 테이블.
- **Editors**: WYSIWYG 에디터를 통한 상품 상세 페이지 구성.

---

## 6. 성능 및 접근성 요구사항
- **Lighthouse Score**: Performance 90+, Accessibility 100 목표.
- **SEO**: Next.js SSR/SSG를 통한 메타 태그 및 시맨틱 마크업 최적화.
- **Error Handling**: API 타임아웃 또는 실패 시 사용자에게 친절한 Empty State 및 재시도 버튼 노출.