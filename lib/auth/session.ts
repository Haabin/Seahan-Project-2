import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";

export type AppRole = "viewer" | "planner" | "admin";

export interface SessionInfo {
  userId: string;
  email: string;
  displayName: string;
  role: AppRole;
}

/**
 * 로그인 사용자와 역할. 요청당 1회만 조회한다.
 * JWT는 getClaims()로 로컬 검증한다(공개키는 인스턴스에 캐시) → Supabase Auth 서버 왕복을 줄인다.
 */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const supabase = await createSupabaseServer();
  let userId: string | null = null;
  let email = "";

  const { data: claims } = await supabase.auth.getClaims();
  if (claims?.claims?.sub) {
    userId = claims.claims.sub;
    email = (claims.claims.email as string | undefined) ?? "";
  } else {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    userId = user.id;
    email = user.email ?? "";
  }

  const { data: profile } = await supabase.from("profiles").select("display_name, role").eq("user_id", userId).maybeSingle();
  return {
    userId,
    email,
    displayName: profile?.display_name || email.split("@")[0] || "사용자",
    role: (profile?.role as AppRole) ?? "viewer",
  };
});

export async function requireSession(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

export function canWrite(role: AppRole) {
  return role === "planner" || role === "admin";
}

export function isAdmin(role: AppRole) {
  return role === "admin";
}

/** 쓰기 권한이 없으면 예외. Server Action 첫 줄에서 호출 */
export async function requireWriter(): Promise<SessionInfo> {
  const s = await requireSession();
  if (!canWrite(s.role)) throw new Error("작성 권한이 없습니다 (조회 전용 계정)");
  return s;
}

export async function requireAdmin(): Promise<SessionInfo> {
  const s = await requireSession();
  if (!isAdmin(s.role)) throw new Error("관리자 권한이 필요합니다");
  return s;
}
