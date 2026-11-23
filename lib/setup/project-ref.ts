/**
 * 연결된 Supabase 프로젝트 ID(ref) 확인 (순수 함수). 접속 주소·키·비밀번호는 돌려주지 않는다.
 *   - 풀러:  postgresql://postgres.<ref>:<pw>@aws-0-….pooler.supabase.com:6543/postgres
 *   - 직접:  postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres
 *   - 대체:  NEXT_PUBLIC_SUPABASE_URL = https://<ref>.supabase.co
 */
const REF = "[a-z0-9]{15,30}";

export function projectRefFromEnv(env: { DATABASE_URL?: string; NEXT_PUBLIC_SUPABASE_URL?: string }): string | null {
  const db = env.DATABASE_URL ?? "";
  let m = db.match(new RegExp(`^postgres(?:ql)?://postgres\.(${REF}):`));
  if (m) return m[1];
  m = db.match(new RegExp(`@db\.(${REF})\.supabase\.co`));
  if (m) return m[1];
  m = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(new RegExp(`^https://(${REF})\.supabase\.co`));
  if (m) return m[1];
  return null;
}

/** 사용자가 직접 입력한 ID 가 정확히 같을 때만 true (앞뒤 공백만 무시) */
export function isProjectRefConfirmed(expected: string | null, typed: string | null | undefined): boolean {
  if (!expected) return false;
  return (typed ?? "").trim() === expected;
}
