"use client";

import { ItemList } from "./item-list";
import { useEffect, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { boxCount, type PurchaseRow } from "@/lib/purchase-request/normalize";
import {
  columns, printPurchase,
  purchaseRowsToCsv,
  purchaseRowsToXlsx,
} from "@/lib/purchase-request/export";

import { importPurchase } from "@/lib/purchase-request/import";
import { reviewErrors } from "@/lib/purchase-request/review";

type History = {
  revision: number;
  request_number: string;
  customer_name: string;
  items: PurchaseRow[];
  saved_at: string;
};
type Saved = {
  id: string;
  revision: number;
  request_number: string;
  customer_name: string;
  status: string;
  original_file_name: string;
  original_file_path: string;
  created_at: string;
};
const BUCKET = "purchase-request-originals";
const blank = (): PurchaseRow => ({
  productCode: "",
  productName: "",
  quantity: null,
  unit: "EA",
  requestedDate: "",
  customer: "",
  note: "",
});
export default function PurchaseRequestsPage() {
  const [db] = useState(() => createSupabaseBrowser());
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [number, setNumber] = useState("");
  const [customer, setCustomer] = useState("");
  const [saved, setSaved] = useState<Saved[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [active, setActive] = useState<Saved | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [uploadId, setUploadId] = useState("");
  const issues = reviewErrors(rows, customer);
  const output = rows.map((r) => ({
    ...r,
    customer: r.customer.trim() || customer.trim(),
  }));
  const ready = !!number.trim() && reviewed && !issues.length && !busy;
  async function open(s: Saved) {
    setBusy(true);
    setMessage("");
    try {
      const { data, error } = await db
        .from("purchase_request_history")
        .select("*")
        .eq("request_id", s.id)
        .order("revision", { ascending: false });
      if (error) throw error;
      const versions = (data ?? []) as History[];
      let items = versions[0]?.items;
      if (!items) {
        const result = await db
          .from("purchase_request_items")
          .select("*")
          .eq("request_id", s.id)
          .order("line_number");
        if (result.error) throw result.error;
        items = result.data.map((r) => ({
          productCode: r.product_code,
          productName: r.product_name,
          unit: r.unit,
          quantity: Number(r.quantity),
          requestedDate: r.requested_date || "",
          customer: r.customer_name,
          note: r.note,
        }));
      }
      const latest = versions[0];
      setHistory(versions);
      setActive({ ...s, revision: latest?.revision ?? s.revision });
      setFile(null);
      setWarnings([]);
      setReviewed(!!latest);
      setRows(items);
      setNumber(latest?.request_number ?? s.request_number);
      setCustomer(latest?.customer_name ?? s.customer_name);
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function errorMessage(e: unknown) {
    return e && typeof e === "object" && "message" in e
      ? String(e.message)
      : "작업에 실패했습니다.";
  }
  function fetchSaved() {
    return db.from("purchase_requests").select("id,request_number,customer_name,status,original_file_name,original_file_path,created_at,revision").order("created_at", { ascending: false });
  }
  async function refresh() {
    const { data, error } = await fetchSaved();
    if (error) setMessage(error.message);
    else setSaved((data ?? []) as Saved[]);
  }
  useEffect(() => {
    let active = true;
    void fetchSaved().then(({ data, error }) => {
      if (!active) return;
      if (error) setMessage(error.message);
      else setSaved((data ?? []) as Saved[]);
    });
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function importFile(f: File) {
    setFile(null);
    setActive(null);
    setHistory([]);
    setRows([]);
    setWarnings([]);
    setMessage("");
    setReviewed(false);
    setNumber("");
    setCustomer("");
    if (!f.size || f.size > 10 * 1024 * 1024) {
      setMessage("1바이트 이상 10MB 이하 파일을 선택하세요.");
      return;
    }
    setBusy(true);
    setUploadId(crypto.randomUUID());
    setFile(f);
    try {
      const result = await importPurchase(f, setMessage);
      setMessage("");
      setRows(result.rows.length ? result.rows : [blank()]);
      setWarnings(result.warnings);
      setNumber(result.orderNumber || "");
      const clients = [
        ...new Set(result.rows.map((r) => r.customer).filter(Boolean)),
      ];
      if (clients.length === 1 && result.rows.every((r) => r.customer))
        setCustomer(clients[0]);
    } catch (e) {
      setRows([blank()]);
      setWarnings([errorMessage(e) + " · 원본을 확인하고 직접 입력하세요."]);
    } finally {
      setBusy(false);
    }
  }
  function change(index: number, key: keyof PurchaseRow, value: string) {
    setReviewed(false);
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== index) return r;
        const updated = { ...r, [key]: key === "quantity" ? (value === "" ? null : Number(value)) : value };
        if (key === "quantity") updated.unit = "EA";
        if (["quantity", "productCode", "unit"].includes(key)) updated.boxes = boxCount(updated.productCode, updated.quantity, updated.unit);
        return updated;
      }),
    );
  }
  async function save() {
    if (!ready || (!file && !active)) return;
    setBusy(true);
    setMessage("");
    try {
      const {
        data: { user },
      } = await db.auth.getUser();
      if (!user) throw new Error("로그인이 필요합니다.");
      const id = active?.id ?? uploadId;
      let source = null;
      if (file) {
        const extension = file.name.split(".").pop()?.toLowerCase();
        const path = user.id + "/" + id + "/original." + extension;
        const mime = (
          {
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            csv: "text/csv",
            pdf: "application/pdf",
            json: "application/json",
          } as Record<string, string>
        )[extension ?? ""];
        if (!mime) throw new Error("지원하지 않는 파일 형식입니다.");
        const uploaded = await db.storage
          .from(BUCKET)
          .upload(path, file, { contentType: mime, upsert: false });
        if (
          uploaded.error &&
          !["409", "Duplicate", "ResourceAlreadyExists"].includes(
            String(uploaded.error.statusCode),
          )
        )
          throw uploaded.error;
        source = { path, name: file.name, size: file.size, type: mime };
      }
      const { data: rev, error } = await db.rpc("save_purchase_review", {
        p_id: id,
        p_revision: active?.revision ?? 0,
        p_number: number.trim(),
        p_customer: customer.trim(),
        p_items: output,
        p_file: source,
      });
      if (error) throw error;
      const { data: doc, error: readError } = await db
        .from("purchase_requests")
        .select("*")
        .eq("id", id)
        .single();
      if (readError) throw readError;
      await open(doc as Saved);
      await refresh();
      setMessage("검토본 " + rev + "판을 저장했습니다.");
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function exportCsv() {
    const blob = new Blob([purchaseRowsToCsv(output)], {
      type: "text/csv;charset=utf-8",
    });
    downloadBlob(blob, "표준_발주의뢰서.csv");
  }
  async function exportXlsx() {
    try {
      setBusy(true);
      downloadBlob(
        await purchaseRowsToXlsx(output, number, customer),
        "표준_발주의뢰서.xlsx",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Excel 생성에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }
  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function download(path: string, name: string) {
    const { data, error } = await db.storage.from(BUCKET).download(path);
    if (error || !data) {
      setMessage(error?.message ?? "다운로드 실패");
      return;
    }
    downloadBlob(data, name);
  }
  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 sm:px-8">

      <div>
        <h1 className="text-2xl font-bold">발주의뢰서 통합</h1>
        <p className="text-sm text-gray-500">
          Excel·CSV·PDF에서 품목을 읽어옵니다. 스캔 PDF는 한글·영문 문자를 자동 인식해 검토표에 채웁니다.
        </p>
      </div>
      <fieldset disabled={busy} className="rounded-xl border p-4 space-y-3">
        <label htmlFor="source-file" className="block font-semibold">
          원본 파일 선택 (.xlsx / .csv / .json / .pdf, 최대 10MB)
        </label>
        <input
          id="source-file"
          type="file"
          accept=".xlsx,.csv,.json,.pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void importFile(f);
          }}
        />
        <div className="flex flex-wrap gap-3">
          <input
            className="rounded border p-2"
            placeholder="발주의뢰서 번호 (필수)"
            value={number}
            onChange={(e) => {
              setNumber(e.target.value);
              setReviewed(false);
            }}
          />
          <input
            className="rounded border p-2"
            placeholder="거래처명"
            value={customer}
            onChange={(e) => {
              setCustomer(e.target.value);
              setReviewed(false);
            }}
          />
        </div>
        {warnings.length > 0 && (
          <div className="rounded bg-amber-50 p-3 text-sm text-amber-900">
            {warnings.slice(0, 20).map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}
        {file && (
          <p className="text-sm">
            선택된 원본: {file.name} · {rows.length}개 품목
          </p>
        )}
        {(file || active) && (
          <>
            <ItemList key={active?.id ?? uploadId} rows={rows} issues={issues} change={change}
              remove={i=>{setReviewed(false);setRows(v=>v.filter((_,j)=>j!==i));}}
              add={()=>{setReviewed(false);setRows(v=>[...v,blank()]);}} />
            {issues.filter(issue=>!/^\d+행 · /.test(issue)).map(issue=><p role="alert" key={issue}>{issue}</p>)}
            <label className="block py-3">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={!!issues.length}
                onChange={(e) => setReviewed(e.target.checked)}
              />{" "}
              원본과 품목 수·수량·납기일을 대조했습니다.
            </label>
            <button
              disabled={!ready}
              className="rounded border px-3 py-2 disabled:opacity-40"
              onClick={() => {
                try {
                  printPurchase(number, customer, output);
                } catch (e) {
                  setMessage(errorMessage(e));
                }
              }}
            >
              인쇄 / PDF 저장
            </button>{" "}
            <button
              disabled={!ready}
              className="rounded border px-3 py-2 disabled:opacity-40"
              onClick={exportCsv}
            >
              표준 CSV 다운로드
            </button>{" "}
            <button
              disabled={!ready}
              className="rounded border px-3 py-2 disabled:opacity-40"
              onClick={() => void exportXlsx()}
            >
              표준 Excel 다운로드
            </button>{" "}
            <button
              disabled={!ready}
              onClick={() => void save()}
              className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50"
            >
              {busy ? "저장 중" : "검토한 데이터와 원본 저장"}
            </button>
          </>
        )}
        {history.length > 0 && (
          <details>
            <summary>수정 이력 · {history.length}개 버전</summary>
            {history.map((h) => (
              <details key={h.revision}>
                <summary>
                  {h.revision}판 ·{" "}
                  {new Date(h.saved_at).toLocaleString("ko-KR")} ·{" "}
                  {h.items.length}개 품목
                </summary>
                <p>
                  {h.request_number} · {h.customer_name}
                </p>
                <table>
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {h.items.map((r, i) => (
                      <tr key={i}>
                        {columns.map((c) => (
                          <td className="border p-1" key={c.key}>
                            {r[c.key]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
          </details>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </fieldset>
      <div className="overflow-x-auto rounded-xl border p-4">
        <h2 className="mb-3 font-semibold">저장된 발주의뢰서</h2>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th>번호</th>
              <th>거래처</th>
              <th>원본</th>
              <th>등록일</th>
            </tr>
          </thead>
          <tbody>
            {!saved.length && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-gray-500">
                  저장된 발주의뢰서가 없습니다.
                </td>
              </tr>
            )}
            {saved.map((s) => (
              <tr key={s.id}>
                <td className="border p-2">
                  <button
                    disabled={busy}
                    className="underline"
                    onClick={() => void open(s)}
                  >
                    {s.request_number} · 열기
                  </button>
                </td>
                <td className="border p-2">{s.customer_name}</td>
                <td className="border p-2">
                  <button
                    className="underline"
                    onClick={() =>
                      void download(s.original_file_path, s.original_file_name)
                    }
                  >
                    {s.original_file_name}
                  </button>
                </td>
                <td className="border p-2">
                  {new Date(s.created_at).toLocaleString("ko-KR")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
