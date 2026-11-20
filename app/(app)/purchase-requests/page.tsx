"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/client";
import { normalizePurchaseRows, parsePurchaseCsv, parsePurchaseJson, type PurchaseRow } from "@/lib/purchase-request/normalize";

type Saved = { id: string; request_number: string; customer_name: string; status: string; original_file_name: string; original_file_path: string; created_at: string };
const BUCKET = "purchase-request-originals";
const blank = (): PurchaseRow => ({productCode:"",productName:"",quantity:null,unit:"EA",requestedDate:"",customer:"",note:""});
const columns: {key:keyof PurchaseRow;label:string}[] = [
  {key:"productCode",label:"품번"},{key:"productName",label:"품명"},{key:"quantity",label:"수량"},{key:"unit",label:"단위"},{key:"requestedDate",label:"납기일"},{key:"customer",label:"거래처"},{key:"note",label:"비고"},
];
export default function PurchaseRequestsPage() {
  const [db] = useState(()=>createSupabaseBrowser());
  const [file,setFile] = useState<File|null>(null);
  const [rows,setRows] = useState<PurchaseRow[]>([]);
  const [warnings,setWarnings] = useState<string[]>([]);
  const [number,setNumber] = useState("");
  const [customer,setCustomer] = useState("");
  const [saved,setSaved] = useState<Saved[]>([]);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  async function refresh() {
    const {data,error} = await db.from("purchase_requests").select("id,request_number,customer_name,status,original_file_name,original_file_path,created_at").order("created_at",{ascending:false}).limit(50);
    if(error) setMessage(error.message);
    else setSaved((data??[]) as Saved[]);
  }
  useEffect(()=>{void refresh();},[]); // eslint-disable-line react-hooks/exhaustive-deps
  async function importFile(f:File) {
    setFile(f);setRows([]);setWarnings([]);setMessage("");
    if(f.size>10*1024*1024){setMessage("10MB 이하 파일만 가능합니다.");setFile(null);return;}
    const ext=f.name.split(".").pop()?.toLowerCase();
    try {
      if(ext==="csv"){const r=parsePurchaseCsv(await f.text());setRows(r.rows);setWarnings([...r.warnings,...r.unmappedColumns.map(c=>`매핑되지 않은 열: ${c}`)]);}
      else if(ext==="json"){const r=parsePurchaseJson(await f.text());setRows(r.rows);setWarnings([...r.warnings,...r.unmappedColumns.map(c=>`매핑되지 않은 열: ${c}`)]);}
      else if(ext==="xlsx"){
        const ExcelJS=(await import("exceljs")).default;
        const book=new ExcelJS.Workbook();
        await book.xlsx.load(await f.arrayBuffer() as ArrayBuffer);
        const sheet=book.worksheets[0];if(!sheet)throw new Error("첫 번째 시트가 없습니다.");
        const headers:string[]=[];sheet.getRow(1).eachCell({includeEmpty:true},(cell,col)=>{headers[col-1]=String(cell.text??"").trim();});
        const raw:Record<string,unknown>[]=[];
        sheet.eachRow((row,index)=>{if(index===1)return;const entry:Record<string,unknown>={};headers.forEach((name,i)=>{if(name)entry[name]=row.getCell(i+1).text;});if(Object.values(entry).some(v=>String(v).trim()))raw.push(entry);});
        const result=normalizePurchaseRows(raw);setRows(result.rows);setWarnings([...result.warnings,...result.unmappedColumns.map(c=>`매핑되지 않은 열: ${c}`)]);
      }else if(ext==="pdf"){setRows([blank()]);setWarnings(["PDF 자동 추출은 아직 지원하지 않습니다. 원본을 보면서 아래 항목을 직접 입력해 주세요."]);}
      else throw new Error("지원 형식: .xlsx, .csv, .json, .pdf");
    } catch(e){setMessage(e instanceof Error?e.message:"파일을 해석하지 못했습니다.");setFile(null);}
  }
  function change(index:number,key:keyof PurchaseRow,value:string) {
    setRows(prev=>prev.map((r,i)=>i===index?{...r,[key]:key==="quantity"?(value===""?null:Number(value)):value}:r));
  }
  async function save() {
    if(!file||!number.trim()||!rows.length){setMessage("원본 파일, 의뢰서 번호, 품목을 확인해 주세요.");return;}
    if(rows.some(r=>!Number.isFinite(r.quantity)||Number(r.quantity)<=0||(!r.productCode.trim()&&!r.productName.trim())||(r.requestedDate!==""&&!/^\d{4}-\d{2}-\d{2}$/.test(r.requestedDate)))){setMessage("품번/품명, 양수 수량, 납기일(YYYY-MM-DD)을 확인해 주세요.");return;}
    setBusy(true);setMessage("");
    let path:string|null=null;let requestId:string|null=null;
    try {
      const {data:{user},error:authError}=await db.auth.getUser();
      if(authError||!user)throw new Error("로그인이 필요합니다.");
      path=`${user.id}/${crypto.randomUUID()}/original.${file.name.split(".").pop()?.toLowerCase()}`;
      const {error:uploadError}=await db.storage.from(BUCKET).upload(path,file,{upsert:false,contentType:file.type||"application/octet-stream"});
      if(uploadError)throw uploadError;
      const {data:request,error:reqError}=await db.from("purchase_requests").insert({
        request_number:number.trim(),customer_name:customer.trim(),owner_id:user.id,
        original_file_name:file.name,original_file_path:path,original_file_type:file.type||"application/octet-stream",original_file_size:file.size,status:"draft",
      }).select("id").single();
      if(reqError)throw reqError;
      requestId=request.id;
      const {error:itemError}=await db.from("purchase_request_items").insert(rows.map((r,i)=>({
        request_id:request.id,line_number:i+1,product_code:r.productCode,product_name:r.productName,
        quantity:r.quantity,unit:r.unit||"EA",requested_date:r.requestedDate||null,customer_name:r.customer,note:r.note,
      })));
      if(itemError)throw itemError;
      setFile(null);setRows([]);setWarnings([]);setNumber("");setCustomer("");setMessage("원본 파일과 표준화 데이터를 저장했습니다.");await refresh();
    }catch(e){
      if(requestId)await db.from("purchase_requests").delete().eq("id",requestId);
      if(path)await db.storage.from(BUCKET).remove([path]);
      setMessage(`저장 실패: ${e instanceof Error?e.message:"알 수 없는 오류"}`);
    }finally{setBusy(false);}
  }
  async function download(path:string) {
    const {data,error}=await db.storage.from(BUCKET).download(path);
    if(error||!data){setMessage(error?.message??"다운로드 실패");return;}
    const url=URL.createObjectURL(data);const a=document.createElement("a");a.href=url;a.download="original-"+path.split("/").at(-1);a.click();URL.revokeObjectURL(url);
  }
  return <section className="space-y-6 p-5">
    <div><h1 className="text-2xl font-bold">발주의뢰서 통합</h1><p className="text-sm text-gray-500">원본은 비공개 Storage에, 검토한 항목은 별도 DB에 저장합니다. PDF는 수동 입력입니다.</p></div>
    <div className="rounded-xl border p-4 space-y-3">
      <label className="block font-semibold">원본 파일 선택 (.xlsx / .csv / .json / .pdf, 최대 10MB)</label>
      <input type="file" accept=".xlsx,.csv,.json,.pdf" onChange={e=>{const f=e.target.files?.[0];if(f)void importFile(f);}}/>
      <div className="flex gap-3"><input className="rounded border p-2" placeholder="발주의뢰서 번호 (필수)" value={number} onChange={e=>setNumber(e.target.value)}/><input className="rounded border p-2" placeholder="거래처명" value={customer} onChange={e=>setCustomer(e.target.value)}/></div>
      {warnings.length>0&&<div className="rounded bg-amber-50 p-3 text-sm text-amber-900">{warnings.slice(0,20).map((w,i)=><div key={i}>{w}</div>)}</div>}
      {file&&<p className="text-sm">선택된 원본: {file.name} · {rows.length}개 품목</p>}
      {file&&<><div className="overflow-x-auto"><table className="min-w-full text-sm"><thead><tr>{columns.map(c=><th key={c.key} className="border p-2">{c.label}</th>)}<th>삭제</th></tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{columns.map(c=><td key={c.key} className="border p-1"><input className="w-32 rounded border p-1" type={c.key==="quantity"?"number":"text"} min={c.key==="quantity"?"0.000001":undefined} value={r[c.key]??""} onChange={e=>change(i,c.key,e.target.value)}/></td>)}<td><button onClick={()=>setRows(v=>v.filter((_,j)=>i!==j))}>삭제</button></td></tr>)}</tbody></table></div><button className="rounded border px-3 py-2" onClick={()=>setRows(v=>[...v,blank()])}>품목 추가</button> <button disabled={busy} onClick={()=>void save()} className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">{busy?"저장 중":"검토한 데이터와 원본 저장"}</button></>}
      {message&&<p role="status" className="text-sm">{message}</p>}
    </div>
    <div className="rounded-xl border p-4"><h2 className="mb-3 font-semibold">저장된 발주의뢰서</h2><table className="w-full text-sm"><thead><tr><th>번호</th><th>거래처</th><th>원본</th><th>등록일</th></tr></thead><tbody>{saved.map(s=><tr key={s.id}><td className="border p-2">{s.request_number}</td><td className="border p-2">{s.customer_name}</td><td className="border p-2"><button className="underline" onClick={()=>void download(s.original_file_path)}>{s.original_file_name}</button></td><td className="border p-2">{new Date(s.created_at).toLocaleString("ko-KR")}</td></tr>)}</tbody></table></div>
  </section>;
}
