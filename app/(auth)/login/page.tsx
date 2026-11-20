import { LoginForm } from "@/components/auth/login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-sub px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-2xl font-extrabold tracking-tight text-brand">SAEHAN</div>
          <h1 className="mt-2 text-base font-semibold text-brand-deep">주간 생산계획 수립 지원 툴</h1>
          <p className="mt-1 text-xs text-text-muted">오창 1공장 · 1-Stage (PET 1~18호기) 프로토타입</p>
        </div>
        <LoginForm next={next ?? "/plan"} />
        <p className="mt-4 text-center text-[11px] text-text-faint">
          계정은 운영 관리자가 만들어 전달합니다. 비밀번호 분실 시 관리자에게 문의하세요.
        </p>
      </div>
    </main>
  );
}
