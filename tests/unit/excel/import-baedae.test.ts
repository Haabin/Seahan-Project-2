/**
 * 생산배대 파서 테스트. 가상 파일(scripts/fake/baedae.ts)을 메모리에서 만들어 읽는다.
 */
import { describe, expect, it } from "vitest";
import {
  baedaeMachineCode,
  isBaedaeWorkbook,
  parseBaedaeCellText,
  parseBaedaeWorkbook,
  parseRevFromFilename,
  splitAllowedMolds,
  splitRectWidths,
  type BaedaeSheet,
} from "../../../lib/excel/import-baedae";
import { buildFakeBaedaeBuffer, planToBaedaeShapes, type FakeBaedaeMachine, type FakeBaedaeSheetSpec } from "../../../scripts/fake/baedae";

const START = "2026-10-22"; // 목요일
const MACHINES: FakeBaedaeMachine[] = [
  { label: "01", maker: "AOKI", model: "1000H-60", allowed: ["15L 18L 20L", "(과실, 뉴그린)", ""] },
  { label: 2, maker: "AOKI", model: "500LL-75", allowed: ["1.5L 핸들 (R, Y) / 1.6L 핸들", "1.8L HD - H,N,S", "1L 핸들"] },
  { label: "03", maker: "NISSEI", model: "ASB-70DPH", allowed: ["8. 10. 12. 13L (원형, 사각)", "", ""] },
];

function sheet(over: Partial<FakeBaedaeSheetSpec>): FakeBaedaeSheetSpec {
  return { name: "생산1_1STAGE", title: "생산 1팀 - PET 1", startDate: START, machines: MACHINES, texts: [], shapes: [], ...over };
}

async function parse(specs: FakeBaedaeSheetSpec[], filename = "가상 생산배대 (Rev. 1).xlsx") {
  const buf = await buildFakeBaedaeBuffer(specs);
  return parseBaedaeWorkbook(buf, { filename });
}

const cellsOf = (s: BaedaeSheet, code: string) => s.cells.filter((c) => c.lineCode === code).map((c) => `${c.date.slice(5)}:${c.productName}`);

describe("생산배대 · 작은 도구", () => {
  it("Rev 번호를 파일 이름에서 읽는다", () => {
    expect(parseRevFromFilename("26년 10월 5주간 생산배대 (Rev. 1).xlsx")).toBe(1);
    expect(parseRevFromFilename("생산배대_Rev3.xlsx")).toBe(3);
    expect(parseRevFromFilename("생산배대 rev_12.xlsx")).toBe(12);
    expect(parseRevFromFilename("생산배대.xlsx")).toBeNull();
  });

  it("호기 라벨: 문자열·숫자 번호, 공백 섞인 코드", () => {
    expect(baedaeMachineCode("01")).toEqual({ code: "PET1", process: "PET1" });
    expect(baedaeMachineCode("18")).toEqual({ code: "PET18", process: "PET1" });
    expect(baedaeMachineCode("B 1")).toEqual({ code: "B1", process: "PET2_BLOW" });
    expect(baedaeMachineCode("E 1")).toEqual({ code: "PE1", process: "PE" });
    expect(baedaeMachineCode("E4")).toEqual({ code: "PE4", process: "PE" });
    expect(baedaeMachineCode("P5")).toEqual({ code: "P5", process: "PET2_INJ" });
    expect(baedaeMachineCode("AOKI")).toBeNull();
    expect(baedaeMachineCode("PISCO2")).toBeNull();
  });

  it("셀 앞 공백 제거, 제품명 뒤 수량·박스 분리", () => {
    expect(parseBaedaeCellText("        대상 김치 1.2kg")).toMatchObject({ kind: "product", productName: "대상 김치 1.2kg", qty: null });
    expect(parseBaedaeCellText("진로 3.6L 전주공장용 라벨 50,400본")).toMatchObject({ productName: "진로 3.6L 전주공장용 라벨", qty: 50400 });
    const box = parseBaedaeCellText("8L 사각  210박스 소진");
    expect(box).toMatchObject({ productName: "8L 사각", qty: null });
    expect(box.extra).toContain("210박스");
    const colors = parseBaedaeCellText("      1.8L HD - N  노랑 264 + 골드 60 + 적색 480 →");
    expect(colors.productName).toBe("1.8L HD - N");
    expect(colors.extra).toContain("노랑 264");
    expect(parseBaedaeCellText("         ").kind).toBe("empty");
    expect(parseBaedaeCellText("250박스").kind).toBe("note");
    expect(parseBaedaeCellText("노랑 192 + 골드 48 + 적색 408").kind).toBe("note");
  });

  it("B열 생산 가능 금형 나누기: 소수점은 지키고 '. ' ',' '/' 로 나눈다", () => {
    expect(splitAllowedMolds("1.5L 핸들 (R, Y) / 1.6L 핸들")).toEqual(["1.5L 핸들 (R", "Y)", "1.6L 핸들"]);
    expect(splitAllowedMolds("8. 10. 12L")).toEqual(["8", "10", "12L"]);
    expect(splitAllowedMolds("1.8L HD")).toEqual(["1.8L HD"]);
  });

  it("네모 폭: 가장 큰 간격에서 둘로, 한 종류뿐이면 절대 기준", () => {
    const real = splitRectWidths([169_978, 182_678, 260_636, 169_978]);
    expect(real.basis).toBe("gap");
    expect(real.threshold).toBeGreaterThan(182_678);
    expect(real.threshold).toBeLessThan(260_636);
    expect(splitRectWidths([182_678, 182_678])).toEqual({ threshold: 220_000, basis: "fallback" });
    expect(splitRectWidths([])).toEqual({ threshold: null, basis: "none" });
  });
});

describe("생산배대 · 블록과 날짜", () => {
  it("3행 블록 → 호기 매핑, 15일 날짜, B열 금형 목록, 시트 안 Rev 표기 무시", async () => {
    const r = await parse([sheet({ texts: [{ machine: 0, day: 0, text: "15L 뉴그린" }], revLabel: "[ Rev' 0 ]" })]);
    expect(r.revNo).toBe(1);
    expect(r.periodStart).toBe("2026-10-22");
    expect(r.periodEnd).toBe("2026-11-05");
    const s = r.sheets[0];
    expect(s.dates).toHaveLength(15);
    expect(s.machines.map((m) => m.code)).toEqual(["PET1", "PET2", "PET3"]);
    expect(s.machines[0]).toMatchObject({ maker: "AOKI", model: "1000H-60", startRow: 4, endRow: 6, productRow: 5 });
    expect(s.machines[1].allowedMoldText).toHaveLength(3);
    expect(s.machines[1].allowedMoldNames).toContain("1.6L 핸들");
  });

  it("도형이 블록 안 어느 행에 있든 그 블록의 호기로 본다", async () => {
    const r = await parse([
      sheet({
        texts: [{ machine: 1, day: 0, text: "A" }],
        shapes: [
          { kind: "arrow", machine: 1, fromDay: 1, fromFrac: 0, toDay: 2, toFrac: 1, rowOffset: 0 },
          { kind: "rect", machine: 1, day: 0, size: "big", rowOffset: 2 },
          { kind: "rect", machine: 0, day: 0, size: "small" },
        ],
      }),
    ]);
    const s = r.sheets[0];
    expect(cellsOf(s, "PET2")).toEqual(["10-22:A", "10-23:A", "10-24:A"]);
    expect(s.cells.find((c) => c.lineCode === "PET2" && c.date === START)?.changeoverType).toBe("FULL");
  });

  it("'middle' 배치(빈칸/코드/모델)와 사출 설비 숫자 = 원료 소비량(톤)", async () => {
    const r = await parse([
      sheet({
        name: "생산2_PET",
        title: "생산 2팀 - PET",
        machines: [
          { label: "P1", model: "(WJ-350)", layout: "middle", allowed: ["마산 140g (12)", "38g, 48.5g", ""] },
          { label: "S1", model: "PISCO1", layout: "middle", allowed: ["진로 4.0L", "테일러 946", ""] },
        ],
        texts: [
          { machine: 0, rowOffset: 0, day: 0, text: 1.8 },
          { machine: 0, rowOffset: 0, day: 1, text: 2 },
          { machine: 0, rowOffset: 1, day: 0, text: "마산 140g (12)" },
          { machine: 1, rowOffset: 1, day: 0, text: "진로 4.0L   25% 214,445본" },
        ],
      }),
    ]);
    const s = r.sheets[0];
    expect(s.machines.map((m) => [m.code, m.productRow])).toEqual([
      ["P1", 5],
      ["S1", 8],
    ]);
    expect(s.resinUsage).toEqual([
      { lineCode: "P1", date: "2026-10-22", ton: 1.8 },
      { lineCode: "P1", date: "2026-10-23", ton: 2 },
    ]);
    const jinro = s.cells.find((c) => c.lineCode === "S1");
    expect(jinro).toMatchObject({ productName: "진로 4.0L", qty: 214445 });
    expect(jinro?.memo).toContain("25%");
  });
});

describe("생산배대 · 네모 = 금형 교체", () => {
  it("큰 네모 = Full, 작은 네모 = B/M. 빨강과 연분홍은 같은 것", async () => {
    const r = await parse([
      sheet({
        texts: [
          { machine: 0, day: 0, text: "A" },
          { machine: 0, day: 2, text: "      B" },
          { machine: 0, day: 4, text: "      C" },
          { machine: 0, day: 6, text: "      D" },
        ],
        shapes: [
          { kind: "rect", machine: 0, day: 2, size: "big" },
          { kind: "rect", machine: 0, day: 4, size: "small", fill: "FF0000" },
          { kind: "rect", machine: 0, day: 6, size: "small", fill: "accent2" },
        ],
      }),
    ]);
    const s = r.sheets[0];
    expect(s.stats).toMatchObject({ rectFull: 1, rectBm: 2 });
    const types = s.cells.map((c) => [c.productName, c.changeoverType, c.changeoverColor]);
    expect(types).toEqual([
      ["A", "NONE", null],
      ["B", "FULL", "accent2"],
      ["C", "BM", "FF0000"],
      ["D", "BM", "accent2"],
    ]);
    expect(r.rectThresholdBasis).toBe("gap");
  });

  it("워크북 전체 기준: 한 종류만 있는 시트도 다른 시트의 기준으로 가른다", async () => {
    const r = await parse([
      sheet({
        texts: [
          { machine: 0, day: 0, text: "A" },
          { machine: 1, day: 0, text: "B" },
        ],
        shapes: [
          { kind: "rect", machine: 0, day: 0, size: "big" },
          { kind: "rect", machine: 1, day: 0, size: "small" },
        ],
      }),
      sheet({
        name: "생산2_PET",
        title: "생산 2팀 - PET",
        machines: [{ label: "S1", model: "PISCO1", layout: "middle" }],
        texts: [
          { machine: 0, day: 0, text: "X" },
          { machine: 0, day: 3, text: "Y" },
        ],
        // 실제 파일의 생산2 시트 네모 폭(약 19px)
        shapes: [
          { kind: "rect", machine: 0, day: 0, size: "small", widthEmu: 182_678 },
          { kind: "rect", machine: 0, day: 3, size: "small", widthEmu: 182_678 },
        ],
      }),
    ]);
    expect(r.rectThresholdBasis).toBe("gap");
    expect(r.sheets[0].stats).toMatchObject({ rectFull: 1, rectBm: 1 });
    expect(r.sheets[1].stats).toMatchObject({ rectFull: 0, rectBm: 2 });
    expect(r.sheets[1].cells.every((c) => c.changeoverType === "BM")).toBe(true);
  });

  it("'HR' 네모는 무시, 다른 글자 네모는 메모 박스, 테두리 없는 네모는 경고", async () => {
    const r = await parse([
      sheet({
        texts: [
          { machine: 0, day: 0, text: "A" },
          { machine: 0, day: 3, text: "B" },
          { machine: 0, day: 5, text: "C" },
        ],
        shapes: [
          { kind: "rect", machine: 0, day: 0, size: "small", text: "HR" },
          { kind: "rect", machine: 0, day: 3, size: "small", text: "양념장 840 T3", frac: 0 },
          { kind: "rect", machine: 0, day: 5, size: "big", noBorder: true },
          { kind: "rect", machine: 1, day: 0, size: "big" },
          { kind: "rect", machine: 1, day: 1, size: "small" },
        ],
      }),
    ]);
    const s = r.sheets[0];
    expect(s.stats).toMatchObject({ hrBoxes: 1, textBoxes: 1, borderless: 1, rectFull: 1, rectBm: 1 });
    expect(s.cells.find((c) => c.productName === "A")?.changeoverType).toBe("NONE");
    expect(s.cells.find((c) => c.productName === "B")?.memo).toContain("양념장 840 T3");
    expect(s.cells.find((c) => c.productName === "B")?.changeoverType).toBe("NONE");
    expect(s.cells.find((c) => c.productName === "C")?.changeoverType).toBe("NONE");
    expect(s.warnings.some((w) => w.message.includes("테두리 없는 네모"))).toBe(true);
    // 생산 칸이 없는 날의 네모는 교체로 반영하지 못했다고 알린다
    expect(s.changeovers.filter((c) => !c.applied)).toHaveLength(2);
  });
});

describe("생산배대 · 화살표 = 진행 기간", () => {
  it("제품명 칸 + 화살표 칸 = 생산일. 1칸 = 1일, 2칸 = 2일. 대기 칸은 비운다", async () => {
    const r = await parse([
      sheet({
        texts: [
          { machine: 1, day: 0, text: "1.8L HD - N" }, // + 화살표 D~F → 4일
          { machine: 2, day: 4, text: "8L 사각" }, // 같은 칸 안 화살표 → 1일
          { machine: 0, day: 0, text: "A" }, // + 화살표 1칸 → 2일
          { machine: 0, day: 5, text: "B" }, // + 화살표 2칸 → 3일
        ],
        shapes: [
          { kind: "arrow", machine: 1, fromDay: 1, fromFrac: 0.05, toDay: 3, toFrac: 0.95 },
          { kind: "arrow", machine: 2, fromDay: 4, fromFrac: 0.3, toDay: 4, toFrac: 0.9 },
          { kind: "arrow", machine: 0, fromDay: 1, fromFrac: 0, toDay: 1, toFrac: 1 },
          { kind: "arrow", machine: 0, fromDay: 6, fromFrac: 0, toDay: 7, toFrac: 1 },
        ],
      }),
    ]);
    const s = r.sheets[0];
    expect(cellsOf(s, "PET2")).toEqual(["10-22:1.8L HD - N", "10-23:1.8L HD - N", "10-24:1.8L HD - N", "10-25:1.8L HD - N"]);
    expect(cellsOf(s, "PET3")).toEqual(["10-26:8L 사각"]);
    expect(cellsOf(s, "PET1")).toEqual(["10-22:A", "10-23:A", "10-27:B", "10-28:B", "10-29:B"]);
    // 다음 제품까지 자동으로 잇지 않는다: 10-24~10-26 은 대기
    expect(s.cells.some((c) => c.lineCode === "PET1" && c.date === "2026-10-25")).toBe(false);
    expect(s.stats.arrows).toBe(4);
  });

  it("50% 임계값: 덮은 비율이 낮으면 제외, 30~70% 는 포함하되 경고", async () => {
    const r = await parse([
      sheet({
        texts: [
          { machine: 0, day: 0, text: "A" },
          { machine: 1, day: 0, text: "B" },
          { machine: 2, day: 0, text: "C" },
        ],
        shapes: [
          { kind: "arrow", machine: 0, fromDay: 1, fromFrac: 0, toDay: 2, toFrac: 0.2 }, // 2일째 20% → 제외
          { kind: "arrow", machine: 1, fromDay: 1, fromFrac: 0, toDay: 2, toFrac: 0.5 }, // 2일째 50% → 포함 + 경고
          { kind: "arrow", machine: 2, fromDay: 1, fromFrac: 0, toDay: 2, toFrac: 0.9 }, // 2일째 90% → 포함
        ],
      }),
    ]);
    const s = r.sheets[0];
    expect(cellsOf(s, "PET1")).toEqual(["10-22:A", "10-23:A"]);
    expect(cellsOf(s, "PET2")).toEqual(["10-22:B", "10-23:B", "10-24:B"]);
    expect(cellsOf(s, "PET3")).toEqual(["10-22:C", "10-23:C", "10-24:C"]);
    const warns = s.warnings.filter((w) => w.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ lineCode: "PET2", date: "2026-10-24" });
    expect(warns[0].message).toContain("50%");
  });

  it("임계값은 옵션(설정값)으로 바꿀 수 있다", async () => {
    const buf = await buildFakeBaedaeBuffer([
      sheet({
        texts: [{ machine: 0, day: 0, text: "A" }],
        shapes: [{ kind: "arrow", machine: 0, fromDay: 1, fromFrac: 0, toDay: 2, toFrac: 0.4 }],
      }),
    ]);
    const strict = await parseBaedaeWorkbook(buf, { filename: "x (Rev. 0).xlsx", arrowMinCover: 0.5, arrowAmbiguous: [0.5, 0.5] });
    expect(cellsOf(strict.sheets[0], "PET1")).toEqual(["10-22:A", "10-23:A"]);
    const loose = await parseBaedaeWorkbook(buf, { filename: "x (Rev. 0).xlsx", arrowMinCover: 0.3, arrowAmbiguous: [0.3, 0.3] });
    expect(cellsOf(loose.sheets[0], "PET1")).toEqual(["10-22:A", "10-23:A", "10-24:A"]);
  });

  it("겹침 경고: 화살표 구간 안에 다른 제품명이 있으면 그 칸은 새 제품 + 경고", async () => {
    const r = await parse([
      sheet({
        texts: [
          { machine: 0, day: 0, text: "A" },
          { machine: 0, day: 2, text: "B" },
        ],
        shapes: [{ kind: "arrow", machine: 0, fromDay: 1, fromFrac: 0, toDay: 3, toFrac: 1 }],
      }),
    ]);
    const s = r.sheets[0];
    expect(cellsOf(s, "PET1")).toEqual(["10-22:A", "10-23:A", "10-24:B", "10-25:A"]);
    expect(s.warnings.some((w) => w.level === "warn" && w.date === "2026-10-24" && w.message.includes("겹칩니다"))).toBe(true);
  });

  it("제품명 없이 시작하는 화살표, 세로선, mathMinus 는 읽지 않고 알린다. 선 색은 상관없다", async () => {
    const r = await parse([
      sheet({
        texts: [{ machine: 1, day: 0, text: "A" }],
        shapes: [
          { kind: "arrow", machine: 0, fromDay: 1, fromFrac: 0, toDay: 2, toFrac: 1 },
          { kind: "vline", machine: 1, day: 5 },
          { kind: "minus", machine: 1, day: 6 },
          { kind: "arrow", machine: 1, fromDay: 1, fromFrac: 0, toDay: 1, toFrac: 1, color: "FF0000" },
          { kind: "arrow", machine: 1, fromDay: 2, fromFrac: 0, toDay: 2, toFrac: 1, color: "0066FF" },
        ],
      }),
    ]);
    const s = r.sheets[0];
    expect(cellsOf(s, "PET1")).toEqual([]);
    expect(cellsOf(s, "PET2")).toEqual(["10-22:A", "10-23:A", "10-24:A"]);
    expect(s.warnings.some((w) => w.message.includes("제품명 없이 시작"))).toBe(true);
    expect(s.stats).toMatchObject({ arrows: 3, ignoredLines: 1, ignoredOther: 1 });
  });
});

describe("생산배대 · 기타", () => {
  it("메모 행 글자는 생산 칸의 메모가 되고, 음성공장 시트는 건너뛴다", async () => {
    const r = await parse([
      sheet({
        texts: [
          { machine: 0, day: 0, text: "A" },
          { machine: 0, day: 0, rowOffset: 0, text: "650발주 - 24,300" },
          { machine: 0, day: 9, rowOffset: 0, text: "대기" },
        ],
      }),
      sheet({ name: "음성공장", title: "음성", texts: [{ machine: 0, day: 0, text: "Z" }] }),
    ]);
    expect(r.sheets).toHaveLength(1);
    expect(r.skippedSheets).toEqual(["음성공장"]);
    expect(r.sheets[0].cells[0].memo).toContain("650발주");
    expect(r.sheets[0].cells).toHaveLength(1);
  });

  it("파일 이름에 Rev 가 없으면 null + 경고", async () => {
    const r = await parse([sheet({ texts: [{ machine: 0, day: 0, text: "A" }] })], "가상 생산배대.xlsx");
    expect(r.revNo).toBeNull();
    expect(r.warnings.some((w) => w.message.includes("Rev"))).toBe(true);
  });

  it("형식 판별: 생산배대는 true, 도형 없는 파일은 false", async () => {
    const withShapes = await buildFakeBaedaeBuffer([
      sheet({
        texts: [{ machine: 0, day: 0, text: "A" }],
        shapes: [
          { kind: "rect", machine: 0, day: 0, size: "big" },
          { kind: "arrow", machine: 0, fromDay: 1, fromFrac: 0, toDay: 2, toFrac: 1 },
        ],
      }),
    ]);
    const plain = await buildFakeBaedaeBuffer([sheet({ texts: [{ machine: 0, day: 0, text: "A" }] })]);
    expect(await isBaedaeWorkbook(withShapes)).toBe(true);
    expect(await isBaedaeWorkbook(plain)).toBe(false);
  });

  it("왕복: 계획 → 생산배대 모양 → 다시 읽으면 같은 제품·교체", async () => {
    const plan = [
      { machine: 0, day: 0, productName: "가", changeover: "NONE" as const },
      { machine: 0, day: 1, productName: "가", changeover: "NONE" as const },
      { machine: 0, day: 2, productName: "나", changeover: "BM" as const },
      { machine: 0, day: 3, productName: "나", changeover: "NONE" as const },
      { machine: 0, day: 6, productName: "다", changeover: "FULL" as const, qty: 12000 },
      { machine: 2, day: 14, productName: "가", changeover: "NONE" as const },
    ];
    const { texts, shapes } = planToBaedaeShapes(plan);
    const r = await parse([sheet({ texts, shapes })]);
    const got = r.sheets[0].cells.map((c) => `${c.lineCode}|${c.date}|${c.productName}|${c.changeoverType}|${c.qty}`);
    expect(got).toEqual([
      "PET1|2026-10-22|가|NONE|null",
      "PET1|2026-10-23|가|NONE|null",
      "PET1|2026-10-24|나|BM|null",
      "PET1|2026-10-25|나|NONE|null",
      "PET1|2026-10-28|다|FULL|12000",
      "PET3|2026-11-05|가|NONE|null",
    ]);
    expect(r.sheets[0].warnings.filter((w) => w.level === "warn")).toEqual([]);
  });
});
