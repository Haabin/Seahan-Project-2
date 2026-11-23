# 새한프라텍 — 주간 생산계획표 제작지원 개발 지침

> 범위: `hwangcy022/Seahan-Project-2` 전체(생산계획표, 주문 입력, 재고현황, 수급 검증, 씨벌크 원료, 기준정보). 주문 기능의 요구사항과 구현 현황은 `PRD.md`, 화면·기술 개요는 `README.md`, 미확정 값은 `docs/OPEN_QUESTIONS.md`를 따른다. 이 문서는 코딩 에이전트가 반복해서 지킬 **프로젝트 공통 규칙**이다.
>
> 기준일: 2026-11-24 (`main` = `b65f6dd` 이후). 아래 "확인된 환경"은 이 날짜에 확인한 사실이다. 작업을 시작할 때 다시 확인한다.

## 1. 최우선 보호 규칙

1. **`main` 병합 = 운영 배포.** Vercel 운영 브랜치가 `main`이라 병합 즉시 운영 사이트에 나간다. `main`에 직접 올리지 않고, 작업 브랜치 → PR → 미리보기 확인 → 병합 순서를 지킨다. 병합은 사용자 승인 후에만 한다.
2. **운영 DB 하나를 모두가 쓴다.** 운영 사이트와 PR 미리보기가 같은 Supabase 프로젝트를 본다. 시험용 DB가 따로 없으므로 미리보기에서 저장·삭제하면 운영 데이터가 바뀐다. 쓰기 동작을 시험할 때는 사용자 승인을 받고, 만든 시험 데이터는 지운다.
3. **자동 백업이 없다.** Supabase 무료 요금제라 백업·시점 복구가 없다. 스키마를 바꾸는 작업 전에는 수동 백업(`pg_dump`)을 받았는지 확인한다.
4. **DB 구조 변경은 승인 후, 병합 전에 적용.** 마이그레이션·RLS·Storage 정책·시드·운영 데이터 수정은 사용자 승인 없이 실행하지 않는다. 코드가 새 표·열을 읽는다면 **마이그레이션을 먼저 적용하고 나서** 병합한다(순서가 바뀌면 운영 화면이 오류가 난다).
5. **기존 기능·데이터 보존.** 생산계획, 설비, 금형, 씨벌크, 수급 검증, 재고, 주문의 기존 메뉴·라우트·API·권한·데이터를 임의로 삭제·대체·초기화하지 않는다. 공유 컴포넌트·엔진·인증을 고칠 때는 영향 범위를 먼저 밝힌다.
6. **완료 근거 필수.** 패키지 설치·화면 표시·배포 READY를 기능 정상 작동의 증거로 삼지 않는다. 실제로 실행한 검증과 하지 못한 검증을 구분해 보고한다.
7. **기밀 보호.** API 키, 서비스 롤 키, DB 접속 문자열, 개인정보, 실제 회사 문서 원본을 코드·로그·문서·커밋에 넣지 않는다. 저장소는 공개 상태다.

## 2. 프로젝트 목적과 업무 경계

- 목적: 새한프라텍 주간 생산계획표를 **입력·검증·변경**하는 의사결정 지원 툴. 주문 접수(직접 입력·엑셀·발주서 파일·사진) → 초안 자동 생성 → 사람이 수정·확정 → 수급·원료·재고 검증까지 지원한다.
- **자동 확정은 하지 않는다.** 초안 자동 생성은 초안까지만 만들고, 계획 확정(Rev)은 사람이 한다. 확정된 Rev는 바꾸지 않는다(NFR-09).
- **발주서 검토 저장 ≠ 주문 등록 ≠ 생산계획 확정 ≠ 실제 출고 확정.** 발주서 검토본을 저장해도 주문 목록에는 들어가지 않는다. 「주문으로 보내기」를 눌러야 들어간다.
- 외부 시스템(몰드 출고지시 등) 자동 등록은 범위 밖이다(`PRD.md` P2).

## 3. 확인된 환경 (2026-11-24)

- 저장소: `hwangcy022/Seahan-Project-2` (공개). 원격 브랜치는 `main` 하나.
- 배포: Vercel 프로젝트 `seahan-project-2`, 운영 도메인 `seahan-project-2.vercel.app`, 운영 브랜치 `main`. PR마다 미리보기가 만들어지며, 미리보기는 Vercel 로그인이 필요하다. 배포된 커밋은 `/api/health`로 확인한다.
- DB: Supabase 프로젝트 `saehan-dev-v1.1` (무료 요금제, 서울). 운영·미리보기 공용. Vercel에는 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`만 등록돼 있다.
- 스택: Next.js 16(App Router), React 19, TypeScript, Tailwind v4, Supabase(PostgreSQL·Auth·RLS·Storage), ExcelJS, PDF.js, Tesseract.js, Vitest, Playwright.
- 역할: `viewer` / `planner` / `admin` (`profiles.role`). 쓰기는 `app_can_write()`(planner·admin), 관리 기능은 `app_is_admin()`.
- 데이터: 기준정보(제품·호기·금형·계수)는 실제 운용안에서 가져온 값이 들어 있다(`settings.master_source = "real"`이면 시드·초기화가 막힌다). `lib/purchase-request/products.json`의 품번 23개는 **직접 만든 가상 데이터**이며 실제 회사 품번이 아니다.

### 화면과 코드 위치

| 화면 | 경로 | 주요 코드 |
|---|---|---|
| 생산계획표 | `/plan` | `components/gantt/`, `lib/engine/`, `lib/actions/plan.ts` |
| 주문 입력 | `/orders` | `components/orders/`, `lib/actions/orders.ts`, `lib/orders/` |
| 파일·사진으로 가져오기 | `/purchase-requests` (주문 입력 화면에서 들어감) | `app/(app)/purchase-requests/`, `lib/purchase-request/`, `lib/actions/purchase-orders.ts` |
| 재고현황 | `/inventory` | `components/inventory/`, `lib/stock/`, `lib/actions/stock.ts` |
| 수급 검증 · 씨벌크 원료 | `/supply`, `/seabulk` | `lib/engine/supply.ts`, `lib/engine/seabulk.ts` |
| 계획 조회 · Rev 이력 | `/view`, `/revisions` | `lib/data/plan-context.ts` |
| 기준정보 | `/master` (admin) | `components/master/`, `lib/actions/master.ts` |

### 마이그레이션 (`supabase/migrations/`)

`npm run db:migrate`는 파일명 순으로 아직 적용하지 않은 파일만 실행하고, 적용 이력을 `_migrations` 표에 **파일명**으로 남긴다.

- 번호 `0002`~`0004`는 두 갈래 작업이 합쳐지며 **파일이 두 개씩** 있다. 파일명이 달라 모두 적용된다. 이미 적용된 파일의 이름을 바꾸면 다시 실행되므로 **이름을 바꾸지 않는다.**
- 새 마이그레이션은 다음 번호(현재 `0010`부터)로 만들고, 여러 번 실행해도 결과가 같게 쓴다(`if not exists`, `drop policy if exists`, `on conflict do nothing`).
- **마이그레이션으로 기준정보 값을 바꾸지 않는다.** 마이그레이션은 모든 DB에서 실행된다. 교체 계수 값은 `config/changeover-defaults.json` + `npm run setup:real-data`로만 적용한다.

## 4. 반드시 지킬 업무 규칙

- **교체 가동률:** 공식 `(24−h)/24`가 아니라 기준표(`settings.changeover_factor_table`, 주간계획표 I65:J73 원본)에서 찾은 값을 **소수 둘째 자리에서 내림**한다(2h 0.915 → 0.91, 3h 0.875 → 0.87, 9h 0.625 → 0.62). 계산은 `lib/engine/changeover.ts`의 `rateFromLostHours` 하나만 쓴다. 기준표 밖(10h 이상)만 공식을 쓰고 「기준표 밖」으로 표시한다.
- **교체 시간:** PET1은 B/M 2h · FULLSET 6h. PET2(B/M 2h · FULL 4h)와 PE(B/M 6h · FULL 6h)는 팀장님 확인 전이라 **바꾸지 않는다.**
- **엔진은 저장된 계수를 곱한다.** `changeover_coefficients.factor`가 기준표 계산값과 다르면 기준정보 화면에 경고가 뜨고 「전체 다시 계산」으로 맞춘다.
- **주문:** 기준 표는 `orders` 하나다. 초안 자동 생성과 수급 검증은 `orders`만 읽는다. 발주서(`purchase_requests`)는 입력 경로 중 하나이고, 「주문으로 보내기」(`sendPurchaseToOrders`)로만 `orders`에 들어간다. 품목 하나 = 주문 한 건, 주문번호는 `발주번호-행번호`.
- **제품 연결:** 발주서 품번과 생산계획 제품(`products`)은 체계가 다르다. 자동으로 확정하지 않고 사람이 고른다. 확정한 연결은 `purchase_product_links`에 저장해 다음에 먼저 채운다.
- **발주서 권한:** 올린 사람과 관리자(admin)가 볼 수 있다. 검토본 수정·저장은 올린 사람만 한다. 직접 쓰기는 막혀 있고 `save_purchase_review` 함수로만 저장한다.
- **셀 편집:** 편집창은 「완료」를 눌러야 반영된다(`components/gantt/cell-edit-session.ts`). 자동 생성 셀을 고치면 사람이 수정한 셀로 표시한다.

## 5. 실행 및 검증

```bash
npm run dev          # predev 가 OCR 파일을 public/purchase-ocr 로 복사한다
npm run lint
npm run typecheck
npm test             # Vitest 단위 테스트
npm run build
npm run test:e2e     # Playwright (DB·계정 필요)
```

- `db:migrate`, `db:seed`, `db:reset`, `setup:real-data`, `import:operation-plan`, `demo-plan:*`는 **데이터를 바꾸는 명령**이다. 사용자 승인 없이 실행하지 않는다. `db:reset`은 전부 지운다.
- 접속 정보는 `.env.local`의 `DATABASE_URL`만 쓴다. 이 파일은 커밋하지 않는다.
- 실행하지 못한 검증은 **미실행**으로 보고하고 이유를 적는다.

## 6. 작업 절차 — Plan → Do → Verify

### Plan (수정 전)
1. `git status`, 현재 브랜치·HEAD, 관련 코드와 이 문서·`PRD.md`를 확인한다. `main`이 최신인지 확인한다.
2. 화면 → 액션/API → DB의 호출 경로를 실제 파일로 확인한다. 없는 경로를 추정하지 않는다.
3. DB·권한·공유 코드(엔진, 인증, 상단 메뉴)에 영향이 있으면 범위와 되돌리는 방법을 먼저 제시하고 승인을 받는다.

### Do (승인된 범위만)
1. `main`에서 작업 브랜치를 만들어 최소 범위로 수정한다. 기존 코드 스타일을 따른다.
2. 기존 표와 함수를 먼저 재사용한다. 같은 일을 하는 표·모듈을 새로 만들지 않는다.
3. 계산·검증 로직은 순수 함수로 분리하고 테스트를 쓴다(`tests/unit/`).
4. 불확실한 OCR 결과, 미등록 품번, 제품 연결은 자동으로 확정하지 않는다.

### Verify (수정 후)
1. lint, typecheck, 단위 테스트를 실행한다. 빌드는 PR의 Vercel 미리보기 빌드로 확인한다.
2. 미리보기에서 바뀐 화면과 기존 주요 화면(`/plan`, `/orders`, `/inventory`, `/supply`, `/seabulk`, `/view`, `/master`)이 오류 없이 열리는지 확인한다.
3. 쓰기 동작은 승인을 받아 시험하고, 시험 데이터를 지운다. 지우지 못한 것은 보고한다.
4. 병합 후 `/api/health`로 운영 커밋을 확인한다.

## 7. 문서 책임

- `CLAUDE.md`: 프로젝트 전체의 작업·보호·검증 규칙 (이 문서).
- `PRD.md`: 주문 기능의 요구사항과 구현 현황.
- `README.md`: 화면·기술 개요와 설치 방법.
- `docs/OPEN_QUESTIONS.md`: 현업 확인이 필요한 값과 현재 기본값.
- `docs/팀원_공유_변경목록.md`, `docs/팀원_실제데이터_세팅.md`: 팀원 안내.
- 문서와 코드가 다르면 **코드가 현행 동작의 근거**다. 차이를 보고하고, 어느 쪽도 말없이 덮어쓰지 않는다.

## 8. 작업 완료 보고 형식

한국어로 간결하게 보고한다.

- **기준:** 브랜치·HEAD
- **변경:** 수정 파일과 이유
- **검증:** lint / typecheck / test / 미리보기 화면 / 쓰기 동작 각각 통과·실패·미실행
- **DB:** 마이그레이션 필요 여부와 적용 여부
- **잔여:** 미구현·미검증·남은 시험 데이터·승인 요청
