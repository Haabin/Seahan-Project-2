import {
  fieldFor,
  parsePurchaseCsv,
  parsePurchaseJson,
  parseTable,
  type PurchaseImport,
} from "./normalize";

export async function importPurchase(
  file: File,
  onProgress?: (message: string) => void,
): Promise<PurchaseImport> {
  const ext = file.name.split(".").at(-1)?.toLowerCase();
  const buffer = await file.arrayBuffer();
  if (ext === "json")
    return parsePurchaseJson(new TextDecoder().decode(buffer));
  if (ext === "csv") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      text = new TextDecoder("euc-kr", { fatal: true }).decode(buffer);
    }
    return parsePurchaseCsv(text);
  }
  const result: PurchaseImport = {
    rows: [],
    warnings: [],
    unmappedColumns: [],
  };
  function add(name: string, grid: string[][]) {
    const parsed = parseTable(grid);
    result.rows.push(...parsed.rows);
    result.warnings.push(...parsed.warnings.map((w) => name + " · " + w));
  }
  if (ext === "xlsx") {
    const { Workbook } = await import("exceljs");
    const book = new Workbook();
    await book.xlsx.load(buffer);
    for (const sheet of book.worksheets) {
      if (sheet.state !== "visible") {
        result.warnings.push(sheet.name + " · 숨김 시트 제외");
        continue;
      }
      const grid: string[][] = [];
      sheet.eachRow((row) => {
        const line: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell, col) => {
          const value = cell.value;
          line[col - 1] =
            value instanceof Date
              ? value.toISOString().slice(0, 10)
              : cell.text.trim();
        });
        grid.push(line);
      });
      add(sheet.name, grid);
    }
  } else if (ext === "pdf") {
    const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdf.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    const task = pdf.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
    });
    let worker: import("tesseract.js").Worker | undefined;
    try {
      const doc = await task.promise;
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const words = content.items
          .flatMap((t) =>
            "str" in t && t.str.trim()
              ? [{ x: t.transform[4], y: t.transform[5], value: t.str.trim() }]
              : [],
          )
          .sort((a, b) => b.y - a.y || a.x - b.x);
        const lines: (typeof words)[] = [];
        for (const w of words) {
          const last = lines.at(-1);
          if (last && Math.abs(last[0].y - w.y) < 3) last.push(w);
          else lines.push([w]);
        }
        let anchors: number[] = [];
        const grid: string[][] = [];
        for (const line of lines) {
          line.sort((a, b) => a.x - b.x);
          const labels = line.map((w) => w.value);
          const keys = labels.map(fieldFor);
          if (
            keys.includes("quantity") &&
            (keys.includes("productName") || keys.includes("productCode"))
          ) {
            anchors = line.map((w) => w.x);
            grid.push(labels);
          } else if (anchors.length) {
            const cells = anchors.map(() => "");
            for (const w of line) {
              const col = anchors.reduce(
                (best, x, j) =>
                  Math.abs(x - w.x) < Math.abs(anchors[best] - w.x) ? j : best,
                0,
              );
              cells[col] = (cells[col] + " " + w.value).trim();
            }
            grid.push(cells);
          } else grid.push(labels);
        }
        const label = i + "쪽";
        if (anchors.length && grid.length > 1 && parseTable(grid).rows.length) {
          add(label, grid);
          continue;
        }
        onProgress?.(`스캔 문자 인식 중 · ${i} / ${doc.numPages}쪽`);
        try {
          const { createScanWorker, scanPage } = await import("./scan");
          worker ??= await createScanWorker();
          const scanned = await scanPage(page, worker);
          add(label, scanned.grid);
          result.warnings.push(
            label +
              " · 스캔 인식 결과를 원본과 대조하세요." +
              (scanned.uncertain.length
                ? " 인식이 불확실한 글자: " +
                  scanned.uncertain.slice(0, 12).join(", ")
                : ""),
          );
        } catch {
          result.warnings.push(
            label +
              " · 스캔 인식 실패. 이 페이지의 품목을 원본과 대조해 추가하세요.",
          );
        } finally {
          page.cleanup();
        }
      }
    } finally {
      try {
        await worker?.terminate();
      } finally {
        await task.destroy();
      }
    }
  } else throw new Error("지원하는 형식은 XLSX, CSV, JSON, PDF입니다.");
  return result;
}
