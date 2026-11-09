import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 배포 확인용. 로그인 불필요, 비밀값 없음. 어떤 커밋이 어느 리전에서 떠 있는지 보여준다 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    region: process.env.VERCEL_REGION ?? null,
    env: process.env.VERCEL_ENV ?? "development",
    time: new Date().toISOString(),
  });
}
