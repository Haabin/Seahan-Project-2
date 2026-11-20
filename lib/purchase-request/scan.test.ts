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
