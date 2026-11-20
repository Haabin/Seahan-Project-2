import type { PDFPageProxy } from "pdfjs-dist";
import type { Worker, Word } from "tesseract.js";
import { fieldFor } from "./normalize";

export async function createScanWorker() {
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  const assets = "/purchase-ocr";
  const worker = await createWorker(["kor", "eng"], OEM.LSTM_ONLY, {
    workerPath: assets + "/worker.min.js",
    langPath: assets,
    corePath: assets,
    workerBlobURL: false,
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    return worker;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}

type BoxWord = Pick<Word, "text" | "bbox" | "confidence">;
function centerY(w: BoxWord) {
  return (w.bbox.y0 + w.bbox.y1) / 2;
}

export function scanTable(words: BoxWord[]) {
  const lines: BoxWord[][] = [];
  for (const word of words
    .filter((w) => w.text.trim())
    .sort((a, b) => centerY(a) - centerY(b))) {
    const line = lines.at(-1);
    const first = line?.[0];
    if (
      line &&
      first &&
      Math.abs(centerY(word) - centerY(first)) <=
        0.6 *
          Math.max(first.bbox.y1 - first.bbox.y0, word.bbox.y1 - word.bbox.y0)
    )
      line.push(word);
    else lines.push([word]);
  }
  let anchors: number[] = [];
  return lines.map((line) => {
    const cells: { text: string; left: number; right: number }[] = [];
    for (const w of line.sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
      const prev = cells.at(-1);
      if (prev && w.bbox.x0 - prev.right < 0.75 * (w.bbox.y1 - w.bbox.y0)) {
        const gap = w.bbox.x0 - prev.right;
        prev.text += (gap < 0.22 * (w.bbox.y1 - w.bbox.y0) ? "" : " ") + w.text;
        prev.right = w.bbox.x1;
      } else cells.push({ text: w.text, left: w.bbox.x0, right: w.bbox.x1 });
    }
    const labels = cells.map((c) => c.text);
    const fields = labels.map(fieldFor);
    if (
      fields.includes("quantity") &&
      (fields.includes("productCode") || fields.includes("productName"))
    ) {
      anchors = cells.map((c) => (c.left + c.right) / 2);
      return labels;
    }
    if (!anchors.length) return labels;
    const values = anchors.map(() => "");
    for (const cell of cells) {
      const x = (cell.left + cell.right) / 2;
      const index = anchors.reduce(
        (best, a, i) =>
          Math.abs(a - x) < Math.abs(anchors[best] - x) ? i : best,
        0,
      );
      values[index] = (values[index] + " " + cell.text).trim();
    }
    return values;
  });
}

export async function scanPage(page: PDFPageProxy, worker: Worker) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(
    3,
    Math.sqrt(8000000 / (base.width * base.height)),
    4096 / Math.max(base.width, base.height),
  );
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    await page.render({ viewport, canvas, background: "#fff" }).promise;
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    const words =
      data.blocks?.flatMap((b) =>
        b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)),
      ) ?? [];
    return {
      grid: scanTable(words),
      uncertain: words.filter((w) => w.confidence < 65).map((w) => w.text),
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
