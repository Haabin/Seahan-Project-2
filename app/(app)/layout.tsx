import Script from "next/script";
import { requireSession } from "@/lib/auth/session";
import { TopNav } from "@/components/top-nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  return (
    <div className="flex min-h-screen flex-col">
      <TopNav displayName={session.displayName} role={session.role} />
      <main className="mx-auto w-full min-w-[1280px] max-w-[1900px] flex-1 px-5 py-4">{children}</main>
      {/* 외부 챗봇 위젯 (로그인 후 화면에만 표시). 페이지 하이드레이션 뒤에 로드되므로 초기 렌더를 막지 않는다 */}
      <Script
        src="https://chatbot.aiconvergencelab.com/widget.js"
        data-slug="bot-170139d0"
        data-title="호준_새한 프라텍"
        strategy="lazyOnload"
      />
    </div>
  );
}
