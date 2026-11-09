/** 탭 전환 즉시 표시되는 스켈레톤. 서버 데이터가 오는 동안 빈 화면 대신 보여준다 */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="불러오는 중">
      <div className="mb-4 h-6 w-40 rounded bg-border/70" />
      <div className="mb-3 h-11 rounded-[var(--radius-md)] border border-border bg-white" />
      <div className="grid grid-cols-[1fr_320px] gap-3">
        <div className="rounded-[var(--radius-md)] border border-border bg-white p-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="mb-2 flex gap-2">
              <div className="h-8 w-20 rounded bg-bg-sub" />
              <div className="h-8 flex-1 rounded bg-bg-sub" />
            </div>
          ))}
        </div>
        <div className="rounded-[var(--radius-md)] border border-border bg-white p-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="mb-2 h-12 rounded bg-bg-sub" />
          ))}
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-text-faint">데이터를 불러오는 중…</p>
    </div>
  );
}
