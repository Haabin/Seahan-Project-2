import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/** 요청 쿠키 기반 서버 클라이언트(RLS 적용). Server Component·Server Action·Route Handler에서 사용 */
export async function createSupabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Server Component에서 호출되면 set이 불가능하다. proxy.ts가 세션을 갱신하므로 무시한다.
          }
        },
      },
    },
  );
}

/** 서비스 롤 클라이언트(RLS 우회). 서버에서만, 업로드 처리·시드 등 관리 작업에만 사용 */
export function createSupabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY 가 설정되지 않았습니다");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
