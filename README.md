# 주간 생산계획 수립 지원 툴 (프로토타입)

새한프라텍 오창 1공장 1-Stage(PET 1~18호기) 주간 생산계획을 **입력·검증·변경**하고, 씨벌크 원료 사일로 재고를 6주 앞까지 예측하는 의사결정 지원 툴입니다. 자동 확정은 하지 않습니다.

- 요구사항: `docs/새한프라텍_주간생산계획수립지원툴_요구사항정의서_v0.2.pdf`
- 개발 계획: `docs/PLAN_v1.md`(상세), `docs/PLAN_v2.md`(결정·일정)
- 미확정 값과 기본값: `docs/OPEN_QUESTIONS.md`
- 운영 매뉴얼: `docs/운영매뉴얼_초안.md`

> ⚠️ **NFR-01**: 이 프로토타입은 Vercel·Supabase(외부 클라우드)에 **가상 데이터만** 올립니다. 실제 자료는 `data/samples/`에 두며 git에서 제외됩니다. 운영 전환 시 사내 호스팅 이전 절차는 아래 「사내 호스팅 이전」을 참고하세요.

## 기술 스택

| 영역 | 선택 |
|---|---|
| 프론트/서버 | Next.js 16 (App Router) · TypeScript · Tailwind v4 · Pretendard(셀프 호스팅) |
| DB·인증 | Supabase (PostgreSQL + Auth + RLS). 스키마는 `supabase/migrations/*.sql` |
| 계산 엔진 | `lib/engine/` 순수 TypeScript. 브라우저에서 즉시 재계산 (NFR-05) |
| 엑셀 | ExcelJS (`lib/excel/`), 서버에서만 파싱 |
| 테스트 | Vitest(`tests/unit`), Playwright(`tests/e2e`) |
| 배포 | GitHub → Vercel (push마다 프리뷰, `main`은 프로덕션) |

## 로컬 실행

```bash
npm install
cp .env.example .env.local        # 값 채우기 (아래 환경변수)
npm run db:migrate                # supabase/migrations 적용
npm run fake-data                 # 가상 데이터 + 샘플 엑셀 생성 (supabase/seed.sql, data/fake/*.xlsx)
npm run db:seed                   # 시드 적용
npm run create-user -- admin@example.com '비밀번호' admin 관리자
npm run dev                       # http://localhost:3000
```

### 환경변수 (`.env.local`)

| 변수 | 용도 | Vercel 등록 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 프로젝트 URL | ✅ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 브라우저용 anon 키 (RLS 적용) | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용. 업로드 처리·계정 생성 | ✅ (서버 전용) |
| `DATABASE_URL` | 마이그레이션·시드 스크립트 전용 접속 문자열 | ❌ 로컬만 |

키는 코드에 넣지 않습니다. `.env.example`에는 변수 이름만 둡니다.

## 명령

| 명령 | 설명 |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Vitest (계산 엔진, 엑셀 파서) |
| `npm run test:e2e` | Playwright 스모크. 로그인 검증은 `E2E_EMAIL`, `E2E_PASSWORD` 필요 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` / `db:seed` / `db:reset` | DB 적용. `reset`은 public 스키마를 지우고 다시 만듦(주의) |
| `npm run fake-data` | 가상 데이터·샘플 엑셀 재생성 |
| `npm run create-user -- <email> <pw> <viewer\|planner\|admin> [이름]` | 계정 생성 (자유 가입 없음) |

## 역할 (NFR-02)

| 역할 | 할 수 있는 일 |
|---|---|
| `viewer` 조회 (생산팀·영업팀) | 확정 계획·Rev 이력 조회, 엑셀 내보내기 |
| `planner` 작성 (생산지원팀장) | 계획 입력·확정·변경, 수요·재고 업로드, 입고 일정 |
| `admin` 관리 | 위 전부 + 기준정보·설정·계정 역할 |

역할은 `profiles.role`에 있으며 RLS 정책이 DB에서 강제합니다. 확정된 Rev는 트리거로 수정·삭제가 막힙니다(NFR-09).

## Vercel · Supabase 설정

1. Supabase 프로젝트 생성 → Authentication → Providers → Email에서 **Sign-ups 비활성**(관리자가 계정 생성).
2. 로컬에서 `npm run db:migrate && npm run fake-data && npm run db:seed`.
3. GitHub 저장소를 Vercel에 Import → 환경변수 3개 등록(`DATABASE_URL` 제외) → 배포.
4. `npm run create-user`로 admin·planner·viewer 계정 생성 후 공유.

## 백업

- Supabase 대시보드 → Database → Backups(일 1회 자동, NFR-09).
- 수동: `pg_dump "$DATABASE_URL" --schema=public > backup_$(date +%F).sql`.
- 모든 Rev와 변경 사유는 `plan_revisions`·`plan_cells`·`audit_log`에 남습니다.

## 사내 호스팅 이전 (운영 단계, Q10)

Supabase 전용 기능 의존은 두 곳뿐입니다.

| 의존 | 위치 | 이전 방법 |
|---|---|---|
| `auth.users`, `auth.uid()` | `0001_init.sql`의 `profiles` FK와 `app_role()` 함수 | 사내 PostgreSQL에 `auth` 스키마 대신 자체 `users` 테이블을 두고 `app_role()`이 세션 변수(`current_setting('app.user_id')`)를 읽도록 교체 |
| `@supabase/ssr` 클라이언트 | `lib/supabase/*`, `proxy.ts`, `lib/auth/session.ts` | 사내 인증(LDAP/AD 또는 자체 로그인)으로 교체. 데이터 접근은 표준 PostgreSQL 드라이버(`postgres`)로 전환 가능 |

그 외 스키마·트리거·RLS는 표준 PostgreSQL 문법이며 `pg_dump`/`psql`로 그대로 옮겨집니다. Next.js는 사내 서버에서 `npm run build && npm run start`(또는 Docker)로 실행합니다.
