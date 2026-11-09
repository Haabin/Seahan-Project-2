"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { Button, Card, inputClass } from "@/components/ui";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createSupabaseBrowser();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError("이메일 또는 비밀번호가 올바르지 않습니다.");
      return;
    }
    router.replace(next.startsWith("/") ? next : "/plan");
    router.refresh();
  }

  return (
    <Card className="p-6">
      <form onSubmit={onSubmit} className="space-y-4" data-testid="login-form">
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
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error ? <p className="rounded-[var(--radius-sm)] bg-danger-bg px-3 py-2 text-xs text-danger">{error}</p> : null}
        <Button type="submit" variant="primary" className="w-full" disabled={loading}>
          {loading ? "로그인 중…" : "로그인"}
        </Button>
      </form>
    </Card>
  );
}
