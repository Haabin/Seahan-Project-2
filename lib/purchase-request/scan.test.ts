import {expect,it} from "vitest";
import {scanTable} from "./scan";
import {parseTable} from "./normalize";

it("스캔에서 조각난 열 제목을 병합하고 중앙 정렬된 수량을 같은 행에 배치한다",()=>{
  const word=(text:string,x:number,y:number,width:number)=>({text,confidence:90,bbox:{x0:x,y0:y,x1:x+width,y1:y+20}});
  const grid=scanTable([
    word("품번",10,10,35),word("품명",160,10,35),word("수",300,10,17),word("량",319,10,17),
    word("품목-1",5,60,60),word("투명",145,61,34),word("용기",188,60,34),word("240",304,63,32)
  ]);
  expect(parseTable(grid).rows).toMatchObject([{productCode:"품목-1",productName:"투명 용기",quantity:240}]);
});

it("PNG 확장자만 붙인 다른 형식의 파일을 OCR 전에 거부한다", async () => {
  const { importPurchase } = await import("./import");
  const file = new File(["not a png"], "발주.png", { type: "image/png" });
  await expect(importPurchase(file)).rejects.toThrow("파일 내용이 JPG 또는 PNG 형식과 일치하지 않습니다.");
});

it("발주수 열의 P와 미정 수량을 구분한다", () => {
  const {rows} = parseTable([["번호","품목","발주수","단가"],["1","2L","2P","300"],["2","2L","나머지","300"]]);
  expect(rows.map(r => r.originalQuantity)).toEqual(["2P","나머지"]);
  expect(rows[1].quantity).toBeNull();
});

it("날짜 머리글에서 공장 열이 없어도 빈칸과 총합계를 제외한다", () => {
  const {rows} = parseTable([["자재명","2026.11.13","2026.11.16","총합계"],["샘플","","42,120","42,120"]]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({requestedDate:"2026-11-16",quantity:42120});
});
