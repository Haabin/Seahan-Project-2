# 주간 생산계획 수립 지원 툴 (프로토타입) · 개발 계획 제안 v1

작성일 2026-11-09 · 상태: **승인 대기** (승인 전 코드 작성 없음)

근거 문서: `새한프라텍_주간생산계획수립지원툴_요구사항정의서_v0.2.pdf`, `클로드코드_개발프롬프트_v0.3.md`

---

## 0. 현재 상태 확인

| 항목 | 상태 |
|---|---|
| 저장소 | git 미초기화. 요구사항 문서가 폴더 루트에 있음 → M1 시작 시 `git init` 후 `docs/`로 이동 |
| 샘플 데이터 `data/samples/` | 없음 → `scripts/make-fake-data.ts`로 가상 데이터 생성 |
| Node / npm | v24.19 / 11.17 (사용 가능) |
| pnpm, Vercel CLI, Supabase CLI | 미설치 → M1에서 설치. 로그인은 사용자가 `! vercel login`, `! supabase login`으로 직접 |
| Vercel 계정 · Supabase 프로젝트 | 사용자가 준비. 키는 `.env.local`과 Vercel 환경변수에만 |
| splatech.com | 접속 성공(imweb 기반). 아래 디자인 토큰에 반영 |

---

## 1. 디자인 토큰 (splatech.com 확인 결과)

사이트 HTML/CSS에서 실제 사용 빈도가 높은 색을 추출했다. `<meta theme-color>`는 `#1F3A68`, 본문 강조 글자색은 `#042892`로, 로고(SAEHAN / 새한프라텍(주))의 네이비와 같은 계열이다.

| 토큰 | 사이트 실측 | 잠정값(프롬프트) | 채택 | 용도 |
|---|---|---|---|---|
| `--brand` | `#042892` (46회, 제목·링크 color) | `#091E7C` | **`#042892`** | 주조색: 헤더, 선택 탭, 주 버튼, 링크 |
| `--brand-deep` | `#1F3A68` (46회, theme-color) | `#14213D` | **`#1F3A68`** | 제목·강조 글자, 진한 배경, 브라우저 테마색 |
| `--brand-darkest` | `#00104E` | – | `#00104E` | hover / pressed |
| `--accent` | `#3E76FE` (30회) | `#2F5BEA` | **`#3E76FE`** | 보조 강조, 계획 막대 테두리, 포커스 링 |
| `--accent-mint` | `#00D3A3` (14회, border-color) | – | `#00D3A3` | 사이트 포인트색. 툴에서는 “입고 마커” 정도로 제한적 사용 |
| `--text` | `#212121` | `#2B2F36` | `#212121` | 본문 |
| `--text-muted` | `#757575` / `#999999` | `#6B7280` | `#6B7280` | 보조 글자 (대비 확보 위해 잠정값 유지) |
| `--border` | `#E5E7EB`, `#D5D5D5` | `#E5E7EB` | `#E5E7EB` | 표 격자·카드 테두리 |
| `--bg` / `--bg-sub` | `#FFFFFF` / `#F8F8F8` | `#FFFFFF` / `#F3F6FD` | `#FFFFFF` / `#F3F6FD` | 보조 배경은 네이비 틴트 유지 |
| `--danger` | `#FB2B45` | `#E5484D` | `#E5484D` | 부족·제약 위반 (사이트 빨강은 채도가 높아 잠정값 유지) |
| `--warn` | – | `#E0A21B` | `#E0A21B` | 안전재고 미달, 교체일 표시 |
| `--ok` | – | `#3D9A4A` | `#3D9A4A` | 정상·입고 |
| `--surplus` | – | – | `#9CA3AF` | 과잉(회색, 6.2) |

- 폰트: 사이트는 Questrial + NanumSquare. 프롬프트대로 **Pretendard 셀프 호스팅**(`pretendard` npm + `next/font/local`), 숫자 `tabular-nums`.
- 톤: 여백 넉넉, 장식 없음, 사진 없이 정보 밀도 우선. 둥근 모서리 6px(셀·버튼) / 8px(카드), 그림자 없음(카드는 1px 테두리).
- 구현: `app/globals.css`의 `:root` CSS 변수 한 곳 + Tailwind `theme.extend.colors`에서 변수 참조. 색 교체 시 파일 하나만 수정.

---

## 2. 폴더 구조

```
.
├─ app/                         # Next.js App Router
│  ├─ (auth)/login/             # 이메일 로그인
│  ├─ (app)/
│  │  ├─ plan/                  # 6.1 계획 간트
│  │  ├─ supply/                # 6.2 수급 검증
│  │  ├─ seabulk/               # 6.3 씨벌크 원료
│  │  ├─ master/                # 6.4 기준정보 (관리자)
│  │  ├─ revisions/             # 6.4 Rev 이력·비교
│  │  └─ view/                  # 6.4 조회 전용 (생산팀·영업팀)
│  ├─ api/                      # Route Handlers (엑셀 업로드/다운로드)
│  └─ layout.tsx, globals.css
├─ components/                  # UI (gantt/, supply/, seabulk/, master/, ui/)
├─ lib/
│  ├─ engine/                   # ★ 순수 TS 계산 엔진 (프레임워크 의존 없음)
│  │  ├─ types.ts               # 입력/출력 타입
│  │  ├─ calendar.ts            # 15일 기간, 주말 판정, 6주 축
│  │  ├─ production.ts          # FR-08 예상 생산량 + 근거
│  │  ├─ constraints.ts         # FR-07 제약 위반
│  │  ├─ supply.ts              # FR-09 수급(예상 재고), FR-11 우선순위 정렬
│  │  ├─ seabulk.ts             # FR-14 사용량, FR-15 사일로 예측
│  │  ├─ ordering.ts            # FR-16 발주 추천
│  │  ├─ diff.ts                # FR-04 Rev 비교
│  │  └─ index.ts               # recalc(input) → 한 번에 전부 계산
│  ├─ excel/                    # SheetJS 파서/생성기 (서버 전용)
│  │  ├─ import-plan.ts         # FR-03
│  │  ├─ import-master.ts       # FR-01 운용안
│  │  ├─ import-shipments.ts    # FR-05 출고일정표
│  │  ├─ import-inventory.ts    # FR-05 제품수불일보
│  │  └─ export-plan.ts         # FR-12
│  ├─ supabase/                 # client/server 클라이언트, DB 타입
│  ├─ actions/                  # Server Actions (저장·확정·설정)
│  └─ auth/                     # 역할 판별 헬퍼
├─ supabase/
│  ├─ migrations/               # SQL 마이그레이션 (표준 PostgreSQL 위주)
│  └─ seed.sql                  # 가상 데이터 시드
├─ scripts/
│  └─ make-fake-data.ts         # 가상 데이터 + 현행 양식 .xlsx 생성
├─ data/samples/                # 실제 자료 (.gitignore)
├─ tests/
│  ├─ unit/                     # Vitest (engine, excel)
│  └─ e2e/                      # Playwright 스모크
├─ docs/                        # 요구사항, OPEN_QUESTIONS.md, PLAN, 운영 매뉴얼
├─ .env.example
└─ README.md
```

---

## 3. 데이터 모델 (Supabase / PostgreSQL)

### 3.1 ERD 요약

```
factories 1─n lines 1─n line_allowed_molds n─1 products
                 │                              │
                 └─n line_product_capacity n────┘
plans 1─n plan_revisions 1─n plan_cells ─n─1 lines, products
lines 1─n downtimes
products 1─n shipments n─1 customers
products 1─n inventory_snapshots
silos 1─n silo_stock_measurements ; silo_receipts ; silo_external_usage
products 1─n monthly_operation_plan
settings (key-value) ; changeover_coefficients ; priority_weights
profiles (auth.users 1─1) ; uploads ; audit_log
```

### 3.2 테이블

| 테이블 | 주요 컬럼 | 비고 |
|---|---|---|
| `factories` | id, code(`F1`,`F2`), name | NFR-08 |
| `lines` (호기) | id, factory_id, code(`PET1`…), name, **process_type**(`PET1_1STAGE` / `PET2_INJ` / `PET2_BLOW` / `PE`), uses_seabulk, sort_order, is_plan_target | 1단계는 PET1~18만 `is_plan_target=true` |
| `products` (제품=금형) | id, code, name, cavity, pack_unit, preform_weight_g, safety_stock(기본 0, Q12), unit(`본`/`천본`, Q3), default_daily_capa | FR-01 |
| `line_allowed_molds` | line_id, product_id | FR-02 / FR-07 ① |
| `line_product_capacity` | line_id, product_id, daily_capa | 없으면 `products.default_daily_capa` 사용 |
| `changeover_coefficients` | process_type, changeover_type(`BM`/`FULL`), hours, factor, next_day_start | 기본: PET1 BM 3h 0.87, PET1 FULL 익일(교체일 0), PET2 BM 2h 0.91, PET2 FULL 4h 0.83, PE 6h 0.75 |
| `settings` | key, value(jsonb), updated_by, updated_at | `weekend_factor`=0.8(Q5), `daily_changeover_limit`=3(Q4, 공장 단위), `silo_lower_bound_ton`=30(Q2), `silo_upper_bound_ton`=160, `lead_time_days`=30, `receipt_unit_ton`=22, `surplus_days`=14, `qty_unit`=`본` |
| `plans` | id, factory_id, process_tab, period_start(목), period_end(+14일), created_by | 15일 한 묶음 |
| `plan_revisions` | id, plan_id, rev_no(초안은 null), status(`draft`/`confirmed`), reason_category(설비/품질/인원/출고계획/급발주/기타), reason_text, parent_revision_id, created_by, created_at | FR-04. 확정본은 불변 |
| `plan_cells` | revision_id, line_id, date, product_id, qty(null 허용), changeover_type(`NONE`/`BM`/`FULL`), memo | FR-02. (revision, line, date) 유니크 |
| `downtimes` | line_id, start_date, end_date, reason, created_by | FR-06 |
| `customers` | id, name, is_major | FR-11 |
| `shipments` | product_id, customer_id, ship_date, qty, upload_id | FR-05 출고일정표 |
| `inventory_snapshots` | product_id, as_of_date, qty, upload_id | FR-05 제품수불일보 |
| `uploads` | id, kind(plan/master/shipment/inventory), filename, uploaded_by, uploaded_at(=기준 시각), row_count, warnings(jsonb) | FR-05 “기준 시각” 표시 |
| `silos` | id, code(`S55`,`S150`), volume_m3, max_ton(40/120) | FR-15 |
| `silo_stock_measurements` | date, silo_id, measured_ton | 아침 실측(기초재고) |
| `silo_receipts` | id, supplier, planned_date, qty_ton, order_date, status | FR-17 |
| `silo_external_usage` | factory_id, label, weekday_ton, weekend_ton | Q9: 계획 밖 사출설비(A1, 2공장 P1~4) 고정 사용량 |
| `monthly_operation_plan` | product_id, line_id, year_month, qty, working_days | 3~6주 추정용 (운용안) |
| `priority_weights` | key(`due_soon`/`major_customer`/`below_safety`), weight | FR-11, 기본 3/2/1 |
| `profiles` | user_id(auth.users), display_name, role(`planner`/`viewer`/`admin`), team | NFR-02 |
| `audit_log` | table_name, row_id, action, changed_by, changed_at, diff | FR-01 “수정자·시각”, NFR-02 접속 기록 |

### 3.3 RLS 정책 (역할 3종)

| 역할 | 기준정보·설정 | 계획(초안·확정) | 수요·재고·원료 | 계정 |
|---|---|---|---|---|
| `viewer` (생산팀·영업팀) | 읽기 | **확정본만 읽기** | 읽기 | – |
| `planner` (생산지원팀장) | 읽기 | 읽기·쓰기(초안/확정/변경) | 읽기·쓰기(업로드, 입고일정) | – |
| `admin` (운영 관리자) | 읽기·쓰기 | 읽기·쓰기 | 읽기·쓰기 | 역할 부여 |

- 역할 판별은 `profiles.role`을 읽는 SQL 함수 하나(`app_role()`)로 통일 → 사내 이전 시 이 함수와 인증 레이어만 교체.
- 확정된 `plan_revisions` / `plan_cells`는 UPDATE/DELETE 금지 정책 (NFR-09).
- `SUPABASE_SERVICE_ROLE_KEY`는 서버의 시드/업로드 처리에서만 사용.

---

## 4. 계산 엔진 (`lib/engine`) 설계

`recalc(input) → result` 하나의 순수 함수. 입력은 셀 배열 + 기준정보 + 설정 + 수요·재고 + 사일로 데이터, 출력은 셀별 생산량(근거 포함)·위반 목록·제품별 재고 추이·사일로 추이·발주 추천. 브라우저에서 간트 수정마다 호출(목표 100ms 이하, 요구 1초 이내).

| 모듈 | 규칙 (요구사항 5장 그대로) | 근거(explain) 필드 |
|---|---|---|
| `production` | `qty ?? capa × 교체계수(교체일) × 주말계수(토·일)`, 가동불가일 0, PET1 Full set은 교체일 0 | capa, 적용 계수와 이유, 입력 수량 여부, 결과 |
| `constraints` | ① 허용 목록 밖 금형 ② 하루(공장) 교체 횟수 > 한도 ③ 가동불가일 배치. 추가 주의(위반 아님): 제품이 전일과 다른데 교체유형 `NONE` | 위반 종류, 셀 위치, 한도값 |
| `supply` | `재고(d) = 재고(d-1) + Σ생산(d) − 출고(d)`; `<0` 부족, `<안전재고` 경고, `> 향후 N일 출고합` 과잉. 제품별 최초 부족일·수량 | 각 날짜의 세 항 |
| `priority` | 점수 = w1·(납기 임박: 1/(최초부족까지 일수+1)) + w2·대형거래선 + w3·안전재고 미달 | 항목별 점수 |
| `seabulk.usage` | `Σ(계획수량 × 중량g) / 1e6` 톤, 공장별 집계 + 계획 밖 설비 고정값(Q9) | 설비별 기여 |
| `seabulk.silo` | 1~2주: 계획, 3~6주: `월 운용안 물량 ÷ 가동일수 × 중량`(주말계수 적용 여부는 질문 B-3); `재고(d)=재고(d-1)+입고−사용`; 상한 160t, 하한 설정값 | 일별 세 항, 추정/계획 구분 |
| `ordering` | 최초 하한미달일 − 리드타임 = 발주 기한; 필요량 = (하한 − 최저 예상재고) → 22t 단위 올림 | 미달 예상일, 일평균 사용량, 계산식 |
| `diff` | 두 Rev의 셀 비교 → 추가/삭제/변경 셀 목록 | – |

Vitest 필수 케이스: 5장 예시 **Capa 100,000 × B/M 0.87 = 87,000**, 주말 0.8 적용, Full set 교체일 0, 가동불가일 0, 부족 최초일 산출, 교체 횟수 초과, 사일로 상한/하한 경고, 발주량 22t 올림, 40호기×15일 재계산 1초 이내 성능 테스트.

---

## 5. API 목록

Server Action(SA)은 폼·버튼 저장, Route Handler(RH)는 파일 업·다운로드.

| 구분 | 이름 | 역할 | FR |
|---|---|---|---|
| SA | `savePlanDraft(planId, cells)` | 초안 자동 저장 | FR-02 |
| SA | `confirmRevision(planId, reason?)` | Rev 0 확정 / Rev n+1 변경 저장 (사유 필수 검증) | FR-04 |
| SA | `getRevisionDiff(revA, revB)` | Rev 비교 | FR-04 |
| SA | `upsertDowntime / deleteDowntime` | 가동 불가일 | FR-06 |
| RH | `POST /api/import/plan` | 현행 계획표 .xlsx → 셀 + 미매칭 목록 | FR-03 |
| RH | `POST /api/import/master` | 운용안 .xlsx → 기준정보 일괄 등록 | FR-01 |
| RH | `POST /api/import/shipments`, `/inventory` | 출고일정표, 수불일보 | FR-05 |
| RH | `GET /api/export/plan?revisionId=` | 현행 양식 .xlsx 다운로드 | FR-12 |
| SA | `updateMaster*` (lines, products, allowedMolds, capacity, coefficients, settings) | 기준정보 편집, audit_log 기록 | FR-01, NFR-07 |
| SA | `updatePriorityWeights` | 가중치 | FR-11 |
| SA | `upsertSiloReceipt / deleteSiloReceipt`, `upsertSiloMeasurement`, `updateExternalUsage` | 원료 | FR-17, FR-15, Q9 |
| SA | `setUserRole` (admin) | 역할 | NFR-02 |
| – | 계산 API 없음 | 계산은 클라이언트 `lib/engine`, 서버는 저장만 | NFR-05 |

---

## 6. 화면 목록

| # | 화면 | 핵심 요소 | FR |
|---|---|---|---|
| 0 | 로그인 | 이메일/비밀번호 (Supabase Auth), 역할별 첫 화면 | NFR-02 |
| 6.1 | 계획 간트 `/plan` | 공정 탭(1-Stage 활성, 2-Stage·PE / 2공장은 비활성 표시), Rev 선택, 기준 시각, 가져오기/내보내기, 호기 행 × 15일 열, 막대 드래그 이동·끝단 연장, 셀 편집 팝오버(허용 금형만 선택, 수량, 교체유형), 가동불가 빗금, 위반 빨간 테두리, 셀 클릭 → 계산 근거 패널, 오른쪽 경고 목록(클릭 시 셀로 이동), 확정/변경 저장 모달(사유 필수) | FR-02,03,04,06,07,08,10,12 |
| 6.2 | 수급 검증 `/supply` | 제품 행 × 15일 열 예상재고, 빨강/노랑/회색, 가중치 슬라이더 3개와 정렬, 최초 부족일·수량 열, 제품 클릭 → 간트 셀 이동 | FR-09, FR-11 |
| 6.3 | 씨벌크 원료 `/seabulk` | 6주 선 그래프(상·하한선, 1~2주/3~6주 음영 구분, 입고 마커), 발주 추천 카드(기한·물량·근거), 일자별 표(기초재고·1/2공장 사용량·입고), 입고 일정·실측 재고·외부 설비 사용량 편집 | FR-14~17 |
| 6.4a | 기준정보 `/master` (admin) | 호기·허용 금형·Capa·교체 계수·설정값·가중치 표 편집, 운용안 엑셀 일괄 등록, 수정자·시각 | FR-01, NFR-07 |
| 6.4b | Rev 이력 `/revisions` | Rev 목록(번호·상태·사유·작성자·시각), 두 Rev 선택 → 바뀐 셀 표 | FR-04 |
| 6.4c | 조회 전용 `/view` | 최신 확정 계획 간트(읽기 전용) + 최근 변경 내역, 엑셀 내보내기 | FR-13 |

---

## 7. 마일스톤 · 완료 기준 · 예상 소요시간

소요시간은 **클로드 코드 실작업 시간**과 **사용자 확인·외부 설정(로그인, 키 입력, 검토)을 포함한 경과 시간** 두 가지로 적었다. 외부 서비스 설정과 빌드/배포 대기에 따라 달라질 수 있다.

| 단계 | 산출물 | 완료 기준 | 실작업(추정) | 경과 시간(추정) |
|---|---|---|---|---|
| **M1** 데이터·엔진 | git init, Next.js 골격, 디자인 토큰, Supabase 마이그레이션·RLS·시드, `scripts/make-fake-data.ts`, `lib/engine` 전체 + Vitest, `docs/OPEN_QUESTIONS.md`, Vercel 프리뷰 1회 배포 | Vitest 전부 통과(87,000 케이스 포함), 성능 테스트 1초 이내, 프리뷰 URL에서 Supabase 연결 확인 | 3~4시간 | 반나절 ~ 1일 (Vercel/Supabase 로그인·키 설정 포함) |
| **M2** 엑셀 입출력 | 운용안 일괄 등록, 계획표 가져오기(미매칭 목록), 현행 양식 내보내기, 출고일정표·수불 업로드, 업로드 기준 시각 | 가상 .xlsx 왕복(가져오기→내보내기) 시 셀 값 일치, 미매칭 셀 목록 표시, 파서 단위 테스트 통과 | 2~3시간 | 반나절 |
| **M3** 계획 간트 | 6.1 화면 전체, 드래그·연장, 즉시 재계산, 위반 강조, 경고 목록, 근거 패널, Rev 확정·변경 사유·비교 | Playwright: 셀 입력→1초 내 경고 갱신, 사유 없이 저장 불가, Rev 비교 표시 | 4~6시간 | 1일 |
| **M4** 수급·원료 | 6.2, 6.3 화면, 가중치 정렬, 6주 그래프, 발주 추천 카드, 입고 일정 등록 | 가중치 변경 시 순서 변경, 입고 등록 시 그래프 재계산, 하한 미달 시 추천 카드 노출 | 3~4시간 | 반나절 ~ 1일 |
| **M5** 기준정보·조회·마무리 | 6.4 화면들, 역할 3종 RLS 검증, 프로덕션 배포, README(로컬 실행·환경변수·Vercel/Supabase·백업·사내 이전), 운영 매뉴얼 초안 | viewer 계정으로 수정 시도 시 거부, 관리자 기준정보 수정 시 audit 기록, 프로덕션 URL 동작 | 2~3시간 | 반나절 |
| **합계** | | | **14~20시간** | **약 3~4 작업일** |

각 마일스톤 종료 시 ① 만든 것 ② 테스트 결과 ③ 실행 방법 ④ 남은 것 ⑤ Vercel 프리뷰 URL을 보고하고 멈춘다.

---

## 8. 질문 목록 (요구사항 모호점)

**A. 진행 방식 (답이 있어야 M1 배포 단계 진행 가능)**
- A-1. Vercel·Supabase 프로젝트가 준비되어 있나? 배포는 Vercel CLI(사용자가 `! vercel login`)로 할지, GitHub 저장소를 만들어 Git 연동으로 할지?
- A-2. 패키지 매니저: npm(설치됨) 그대로 쓸지, pnpm을 설치할지? → 기본 **npm**.
- A-3. 계정 생성 방식: 관리자가 초대(가입 비공개) vs 자유 가입? → 기본 **관리자 초대, 자유 가입 비활성**.

**B. 계산 규칙 세부 (기본값으로 진행 가능, 답 오면 조정)**
- B-1. 기간 기준일: “이번 주 목요일”을 월~일 기준 주의 목요일로 보고, 사용자가 다른 목요일을 고를 수 있게 한다. (오늘 11/9 월 → 11/12 목 ~ 11/26 목)
- B-2. 교체 횟수 집계: 셀에 입력한 교체유형(B/M, Full set)만 세고, 제품이 전일과 다른데 교체유형이 `없음`이면 “교체유형 미입력” 주의 표시. 한도는 공장 단위 기본 3회(Q4). 맞는가?
- B-3. 3~6주 사일로 추정에도 주말계수를 적용할지? 부록의 실사용량(평일 19~23t, 주말 15~16t)을 보면 적용이 맞아 보여 **기본 적용**.
- B-4. “과잉” 기준(6.2 회색)이 정의서에 없음 → 설정값 `과잉 기준 일수` 기본 14일(예상재고 > 향후 14일 출고합)로 제안.
- B-5. 우선순위 가중치(FR-11) 점수식: 4장 `priority` 식, 기본 가중치 3/2/1로 제안.
- B-6. Capa는 호기×제품 단위로 저장하고, 없으면 제품 기본 Capa를 쓴다. 맞는가?
- B-7. 사일로 2기 배분: 입고·사용을 합계 기준으로 계산하고 그래프는 합계(상한 160t) 1개 선 + 기별 실측치 표로 제안. 기별 개별 추이가 필요한가?
- B-8. 발주 추천 물량 “하한 위로 회복” 범위: 하한 미달 이후 리드타임 구간(30일)의 최저 재고를 하한 위로 올리는 양을 22t 단위 올림으로 제안.

**C. 데이터·보안**
- C-1. Supabase에는 가상 데이터만 올린다. 실제 샘플을 나중에 받으면 로컬 Supabase(Docker) 또는 사내 PC에서만 다룬다. 동의하는가?
- C-2. 요구사항 문서(pdf/docx)는 git에 커밋해도 되는가? (고객사 문서라면 `.gitignore` 처리)

답이 없는 항목은 괄호 안 기본값으로 진행하고 `docs/OPEN_QUESTIONS.md`에 기록한다.
