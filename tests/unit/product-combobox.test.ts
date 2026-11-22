import { describe, expect, it } from "vitest";
import { filterProducts } from "../../components/product-combobox";

const P = [
  { id: "1", code: "P0120", name: "1.8L HD - N" },
  { id: "2", code: "P0031", name: "1.8L HD - N - GOLD" },
  { id: "3", code: "P0073", name: "대상 김치 1.5kg" },
  { id: "4", code: "P0074", name: "대상 김치 1.2kg" },
  { id: "5", code: "P0006", name: "15L 뉴그린" },
];
const names = (q: string) => filterProducts(P, q).map((p) => p.name);

describe("제품 검색", () => {
  it("검색어가 없으면 전체", () => {
    expect(names("")).toHaveLength(5);
  });
  it("품명 일부로 찾는다. 공백·기호·대소문자는 무시", () => {
    expect(names("김치")).toEqual(["대상 김치 1.2kg", "대상 김치 1.5kg"]);
    expect(names("1.8lhdn")).toEqual(["1.8L HD - N", "1.8L HD - N - GOLD"]);
    expect(names("hd gold")).toEqual(["1.8L HD - N - GOLD"]);
  });
  it("품번으로도 찾는다", () => {
    expect(names("p0073")).toEqual(["대상 김치 1.5kg"]);
  });
  it("이름이 검색어로 시작하는 제품이 위로 온다", () => {
    expect(names("15")[0]).toBe("15L 뉴그린");
  });
  it("맞는 것이 없으면 빈 목록", () => {
    expect(names("없는제품")).toEqual([]);
  });
});
