import { requireSession } from "@/lib/auth/session";
import { TopNav } from "@/components/top-nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  return (
    <div className="flex min-h-screen flex-col">
      <TopNav displayName={session.displayName} role={session.role} />
      <main className="mx-auto w-full min-w-[1280px] max-w-[1900px] flex-1 px-5 py-4">{children}</main>
    </div>
  );
}
