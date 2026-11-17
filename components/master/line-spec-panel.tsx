"use client";

/**
 * 기준정보 › 호기 · 허용 금형 탭의 설비 상세 정보 (line_specs).
 * 현행 계획표의 3행(설비번호/제조사/모델), A열 메모(도입·취출·H/R), B열(생산 가능 제품 원문)을 옮겨 적는 칸.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { upsertLineSpec } from "@/lib/actions/equipment";
import { emptyLineSpec, LINE_SPEC_FIELDS, type LineSpec } from "@/lib/data/line-specs";
import { Button, cx, inputSmClass } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

type FieldKey = (typeof LINE_SPEC_FIELDS)[number][0];
const MULTILINE: FieldKey[] = ["hotRunner", "cavityNote", "allowedProductsRaw", "memo"];

export function LineSpecPanel({ lineId, lineName, spec }: { lineId: string; lineName: string; spec: LineSpec | undefined }) {
  // 설비를 바꾸면 key 로 다시 마운트되므로 초기값만 쓴다
  const initial = spec ?? emptyLineSpec(lineId);
  const router = useRouter();
  const [vals, setVals] = useState<Record<FieldKey, string>>(
    () => Object.fromEntries(LINE_SPEC_FIELDS.map(([k]) => [k, initial[k] ?? ""])) as Record<FieldKey, string>,
  );
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    const payload: Record<string, string | null> = { lineId };
    for (const [k] of LINE_SPEC_FIELDS) payload[k] = vals[k] === "" ? null : vals[k];
    const r = await upsertLineSpec(payload);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: "설비 정보 저장됨" } : { ok: false, text: r.error });
    if (r.ok) {
      setEditing(false);
      router.refresh();
    }
    setTimeout(() => setMsg(null), 2500);
  }

  const summary = [initial.maker, initial.model].filter(Boolean).join(" · ");

  return (
    <div data-testid="line-spec-panel" className="mb-3 rounded-[var(--radius-sm)] border border-border">
      <div className="flex items-center justify-between border-b border-border bg-bg-sub px-2 py-1.5">
        <div className="text-xs">
          <span className="font-semibold text-brand-deep">설비 상세</span>
          <span className="ml-2 text-text-muted">{lineName}{summary ? ` · ${summary}` : ""}</span>
          {initial.updatedAt ? <span className="ml-2 text-text-faint">수정 {fmtDateTime(initial.updatedAt)}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {msg ? <span className={cx("text-xs", msg.ok ? "text-ok" : "text-danger")}>{msg.text}</span> : null}
          {editing ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                취소
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={save}>
                저장
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setEditing(true)}>
              수정
            </Button>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-[150px_1fr] gap-x-2 gap-y-1 p-2 text-xs md:grid-cols-[150px_1fr_150px_1fr]">
        {LINE_SPEC_FIELDS.map(([k, label]) => {
          const multiline = MULTILINE.includes(k);
          return (
            <div key={k} className={cx("contents")}>
              <dt className="py-1 text-text-muted">{label}</dt>
              <dd className={cx("min-w-0", multiline ? "md:col-span-3" : "")}>
                {editing ? (
                  multiline ? (
                    <textarea
                      className={cx(inputSmClass, "h-auto min-h-[52px] w-full py-1")}
                      rows={k === "allowedProductsRaw" || k === "memo" ? 3 : 2}
                      value={vals[k]}
                      onChange={(e) => setVals({ ...vals, [k]: e.target.value })}
                    />
                  ) : (
                    <input
                      type={k === "installedOn" ? "date" : "text"}
                      className={cx(inputSmClass, "w-full")}
                      value={vals[k]}
                      onChange={(e) => setVals({ ...vals, [k]: e.target.value })}
                    />
                  )
                ) : (
                  <div className={cx("whitespace-pre-wrap break-words py-1", initial[k] ? "text-text" : "text-text-faint")}>{initial[k] || "—"}</div>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
