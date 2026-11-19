import { describe, expect, it } from "vitest";
import { isRealMasterSource, REAL_MASTER_UPLOAD_BLOCKED } from "@/lib/data/master-source";

describe("기준정보 출처 (settings.master_source)", () => {
  it('"real" 일 때만 실제 데이터로 본다 (없음·"fake" 는 예전 동작)', () => {
    expect(isRealMasterSource("real")).toBe(true);
    for (const v of [undefined, null, "fake", "REAL", { value: "real" }]) expect(isRealMasterSource(v)).toBe(false);
    expect(REAL_MASTER_UPLOAD_BLOCKED).toBe("실제 운용안은 npm run import:operation-plan으로만 등록하세요");
  });
});
