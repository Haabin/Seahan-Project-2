import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * 세션 쿠키 갱신 + 미로그인 사용자 리다이렉트 (NFR-02).
 * Next.js 16에서는 middleware.ts 대신 proxy.ts를 쓴다.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // JWT를 로컬에서 검증한다(만료 시 자동 갱신). Auth 서버 왕복을 줄여 탭 전환 지연을 낮춘다
  const { data: claims } = await supabase.auth.getClaims();
  const user = claims?.claims?.sub ? { id: claims.claims.sub } : null;

  const path = request.nextUrl.pathname;
  const isLogin = path.startsWith("/login");

  if (!user && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  if (user && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/plan";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts|api/health|.*\\.(?:png|svg|jpg|ico|woff2?)$).*)"],
};
