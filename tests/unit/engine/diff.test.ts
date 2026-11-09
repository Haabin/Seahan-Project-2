import { describe, expect, it } from "vitest";
import { diffCells } from "@/lib/engine/diff";
import { cell } from "./fixtures";

describe("FR-04 Rev 비교", () => {
  it("FR-04 추가·삭제·변경을 구분한다", () => {
    const before = [
      cell("L1", "2026-11-12", "P1"),
      cell("L1", "2026-11-13", "P1", { qty: 1000 }),
      cell("L1", "2026-11-14", "P2"),
      cell("L1", "2026-11-15", null), // 양쪽 빈 셀 → 무시
      cell("L2", "2026-11-12", "P3"),
    ];
    const after = [
      cell("L1", "2026-11-12", "P1"), // 동일
      cell("L1", "2026-11-13", "P1", { qty: 2000, changeoverType: "BM" }), // qty, 교체유형 변경
      cell("L1", "2026-11-14", "P3"), // 제품 변경
      cell("L1", "2026-11-15", null),
      cell("L1", "2026-11-16", "P1"), // 추가
      // L2 11/12 삭제 (셀 없음)
    ];
    const diffs = diffCells(before, after);
    expect(diffs).toHaveLength(4);

    const changedQty = diffs.find((d) => d.lineId === "L1" && d.date === "2026-11-13")!;
    expect(changedQty.kind).toBe("changed");
    expect(changedQty.changedFields).toEqual(["qty", "changeoverType"]);
    expect(changedQty.before?.qty).toBe(1000);
    expect(changedQty.after?.qty).toBe(2000);

    const changedProduct = diffs.find((d) => d.date === "2026-11-14")!;
    expect(changedProduct.kind).toBe("changed");
    expect(changedProduct.changedFields).toEqual(["productId"]);

    const added = diffs.find((d) => d.date === "2026-11-16")!;
    expect(added.kind).toBe("added");
    expect(added.before).toBeNull();
    expect(added.after?.productId).toBe("P1");

    const removed = diffs.find((d) => d.lineId === "L2")!;
    expect(removed.kind).toBe("removed");
    expect(removed.before?.productId).toBe("P3");
    expect(removed.after).toBeNull();
  });

  it("FR-04 제품을 지워 빈 셀이 되면 removed", () => {
    const diffs = diffCells([cell("L1", "2026-11-12", "P1")], [cell("L1", "2026-11-12", null)]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].kind).toBe("removed");
    expect(diffs[0].after?.productId).toBeNull();
  });

  it("FR-04 메모 변경도 감지 (빈 문자열과 null 은 동일 취급)", () => {
    expect(diffCells([cell("L1", "2026-11-12", "P1", { memo: "" })], [cell("L1", "2026-11-12", "P1", { memo: null })])).toHaveLength(0);
    const d = diffCells([cell("L1", "2026-11-12", "P1")], [cell("L1", "2026-11-12", "P1", { memo: "급발주" })]);
    expect(d).toHaveLength(1);
    expect(d[0].changedFields).toEqual(["memo"]);
  });

  it("FR-04 변경 없음 → 빈 배열", () => {
    const cells = [cell("L1", "2026-11-12", "P1", { qty: 10 })];
    expect(diffCells(cells, cells.map((c) => ({ ...c })))).toEqual([]);
  });
});
