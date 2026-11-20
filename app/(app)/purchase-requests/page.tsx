"use client";
import { useState } from "react";
import { normalizePurchaseRows, parsePurchaseCsv, parsePurchaseJson, type PurchaseRow } from "@/lib/purchase-request/normalize";
import { purchaseRowsToCsv, purchaseRowsToXlsx } from "@/lib/purchase-request/export";

const columns: {key:keyof PurchaseRow;label:string}[] = [
  {key:"productCode",label:"품번"},{key:"productName",label:"품명"},
  {key:"quantity",label:"수량"},{key:"unit",label:"단위"},
  {key:"requestedDate",label:"납기일"},{key:"customer",label:"거래처"},
  {key:"note",label:"비고"}
];
function saveBlob(blob:Blob,name:string) {
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function PurchaseRequestsPage() {
  const [rows,setRows]=useState<PurchaseRow[]>([]);
  const [warnings,setWarnings]=useState<string[]>([]);
  const [filename,setFilename]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function readFile(file:File) {
    setBusy(true);setError("");setRows([]);setWarnings([]);setFilename(file.name);
    try {
      if(file.size>10*1024*1024) throw new Error("10MB 이하 파일만 가능합니다.");
      const ext=file.name.split(".").pop()?.toLowerCase();
      let parsed;
      if(ext==="csv") parsed=parsePurchaseCsv(await file.text());
      else if(ext==="json") parsed=parsePurchaseJson(await file.text());
      else if(ext==="xlsx") {
        const ExcelJS=(await import("exceljs")).default;
        const book=new ExcelJS.Workbook();
        await book.xlsx.load(await file.arrayBuffer() as ArrayBuffer);
        const sheet=book.worksheets[0];
        if(!sheet) throw new Error("Excel 시트를 찾을 수 없습니다.");
        const headers=(sheet.getRow(1).values as unknown[]).slice(1).map(v=>String(v??""));
        const records:Record<string,unknown>[]=[];
        sheet.eachRow((row,index)=>{
          if(index===1)return;
          const obj:Record<string,unknown>={};
          headers.forEach((h,i)=>{obj[h]=row.getCell(i+1).text;});
          if(Object.values(obj).some(v=>String(v).trim()))records.push(obj);
        });
        parsed=normalizePurchaseRows(records);
      } else if(ext==="pdf") throw new Error("PDF 자동 추출은 아직 검증되지 않았습니다. PDF 원본을 보관하고 Excel/CSV 자료로 변환해 업로드해 주세요.");
      else throw new Error("지원 형식: .xlsx, .csv, .json");
      setRows(parsed.rows);setWarnings(parsed.warnings);
    } catch(e) {setError(e instanceof Error?e.message:"파일을 읽을 수 없습니다.");}
    finally {setBusy(false);}
  }
  function edit(index:number,key:keyof PurchaseRow,value:string) {
    setRows(current=>current.map((r,i)=>i===index?{...r,[key]:key==="quantity"?(value.trim()===""?null:Number(value)):value}:r));
  }
  async function exportExcel() {
    setBusy(true);setError("");
    try {saveBlob(await purchaseRowsToXlsx(rows),"표준_발주의뢰서.xlsx");}
    catch(e){setError(e instanceof Error?e.message:"Excel 생성 실패");}
    finally{setBusy(false);}
  }
  return <div className="space-y-5">
    <div><h1 className="text-2xl font-bold">발주의뢰서 통합</h1><p className="text-sm text-gray-500">생산계획 앱 내 발주의뢰서 표준화 · 검토 · 표준 문서 출력</p></div>
    <section className="rounded-lg border bg-white p-5 space-y-3">
      <h2 className="font-semibold">원본 파일 선택</h2>
      <input type="file" accept=".xlsx,.csv,.json,.pdf" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(f)void readFile(f);}} />
      {filename&&<p className="text-sm text-gray-500">선택: {filename}</p>}
      {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
      {warnings.length>0&&<div className="rounded bg-amber-50 p-3 text-sm"><strong>검토 필요: {warnings.length}건</strong>{warnings.map((w,i)=><p key={i}>{w}</p>)}</div>}
    </section>
    <section className="rounded-lg border bg-white p-5 space-y-3">
      <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">표준화 결과 ({rows.length}행)</h2>
        <div className="flex gap-2">
          <button disabled={!rows.length||busy} onClick={()=>saveBlob(new Blob([purchaseRowsToCsv(rows)],{type:"text/csv;charset=utf-8"}),"표준_발주의뢰서.csv")} className="rounded border px-3 py-2 text-sm disabled:opacity-40">CSV 다운로드</button>
          <button disabled={!rows.length||busy} onClick={()=>void exportExcel()} className="rounded bg-blue-800 px-3 py-2 text-sm text-white disabled:opacity-40">Excel 다운로드</button>
        </div>
      </div>
      {rows.length===0?<p className="py-8 text-center text-sm text-gray-500">파일을 업로드하면 표준화 결과가 표시됩니다.</p>:
      <div className="overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr>{columns.map(c=><th className="border bg-gray-50 p-2" key={c.key}>{c.label}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{columns.map(c=><td className="border p-1" key={c.key}><input className="w-full min-w-24 p-1" aria-label={`${i+1}행 ${c.label}`} type={c.key==="quantity"?"number":"text"} value={r[c.key]??""} onChange={e=>edit(i,c.key,e.target.value)}/></td>)}</tr>)}</tbody></table></div>}
      <p className="text-xs text-gray-500">현재 화면은 원본 DB 저장 및 생산계획 데이터 연동을 수행하지 않습니다. 표준 문서 출력 전 품번·수량·납기를 확인하세요.</p>
    </section>
  </div>;
}
