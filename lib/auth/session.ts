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

/** 로그인 사용자와 역할. 요청당 1회만 조회한다 */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, role")
    .eq("user_id", user.id)
    .maybeSingle();
  return {
    userId: user.id,
    email: user.email ?? "",
    displayName: profile?.display_name || user.email?.split("@")[0] || "사용자",
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
