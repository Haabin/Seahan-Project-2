"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { classifyLoginError, withTimeout, type LoginErrorKind } from "@/lib/auth/login-error";
import { Button, Card, inputClass } from "@/components/ui";

const LOGIN_TIMEOUT_MS = 15_000;

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<{ kind: LoginErrorKind; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowser();
      // 15초 안에 응답이 없으면 연결 실패로 처리한다
      const { error: authError } = await withTimeout(supabase.auth.signInWithPassword({ email, password }), LOGIN_TIMEOUT_MS);
      if (authError) throw authError;
      router.replace(next.startsWith("/") ? next : "/plan");
      router.refresh();
      // 성공 시 페이지가 바뀌므로 loading 은 유지한다
    } catch (err) {
      const info = classifyLoginError(err);
      if (info.kind === "unknown" || info.kind === "server") {
        console.error("[login] 원본 오류:", info.detail, err);
      }
      setError({ kind: info.kind, message: info.message });
      setLoading(false);
    }
  }

  return (
    <Card className="p-6">
      <form onSubmit={onSubmit} className="space-y-4" data-testid="login-form" noValidate>
        <div>
          <label htmlFor="email" className="mb-1 block text-xs font-medium text-text-muted">
            이메일
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            className={inputClass}
            value={email}
            disabled={loading}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-xs font-medium text-text-muted">
            비밀번호
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            className={inputClass}
            value={password}
            disabled={loading}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error ? (
          <p
            role="alert"
            data-testid="login-error"
            data-kind={error.kind}
            className={`rounded-[var(--radius-sm)] px-3 py-2 text-xs ${error.kind === "invalid_credentials" ? "bg-danger-bg text-danger" : "bg-warn-bg text-[#9a6b00]"}`}
          >
            {error.message}
          </p>
        ) : null}
        <Button type="submit" variant="primary" className="w-full" disabled={loading} data-testid="login-submit">
          {loading ? "로그인 중…" : "로그인"}
        </Button>
      </form>
    </Card>
  );
}
