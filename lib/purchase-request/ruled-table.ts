import { PSM, type Worker } from "tesseract.js";
import { fieldFor } from "./normalize";

interface Rule { y: number; left: number; right: number }
interface Cell { left: number; right: number; top: number; bottom: number }

function tableRules(width: number, height: number, dark: (x: number, y: number) => boolean) {
  const groups: Rule[][] = [];
  for (let y = 0; y < height; y++) {
    let left = 0;
    for (let x = 0; x <= width; x++) {
      if (x < width && dark(x, y)) continue;
      if (x - left >= Math.max(90, width * 0.18)) {
        let group = groups.find(g => Math.abs(g[0].right - x + 1) <= 3 && y - g[g.length - 1].y < 160);
        if (!group) { group = []; groups.push(group); }
        const last = group.at(-1);
        if (!last || y - last.y > 2) group.push({ y, left, right: x - 1 });
      }
      left = x + 1;
    }
  }
  return groups.filter(g => g.length >= 3).sort((a,b) => b.length - a.length);
}

export async function readRuledTable(canvas: HTMLCanvasElement, worker: Worker, englishWorker: () => Promise<Worker>) {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const dark = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return pixels[i]*0.3 + pixels[i+1]*0.59 + pixels[i+2]*0.11 < 145;
  };
  for (const rules of tableRules(width, height, dark)) {
    const left = Math.min(...rules.map(r => r.left));
    const right = rules[0].right;
    const bands: Cell[][] = [];
    const boundaries = new Set<number>();
    for (let r = 0; r < rules.length - 1; r++) {
      const top = rules[r].y, bottom = rules[r+1].y;
      const walls: number[] = [];
      for (let x = left; x <= right; x++) {
        let ink = 0;
        for (let y = top + 1; y < bottom; y++) if (dark(x,y)) ink++;
        if (ink >= (bottom - top - 1) * 0.88 && x - (walls.at(-1) ?? -10) > 2) walls.push(x);
      }
      const cells = walls.slice(1).map((x,i) => ({ left: walls[i], right: x, top, bottom }));
      for (const x of walls) boundaries.add(x);
      bands.push(cells);
    }
    const edges = [...boundaries].sort((a,b) => a-b).filter((x,i,a) => i === 0 || x-a[i-1] > 2);
    if (edges.length < 3 || edges.length > 80) continue;
    const grid: string[][] = [];
    let matrix = false;
    let orderHeader = false;
    let quantityCol = -1;
    const tile = document.createElement("canvas");
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
    try {
      for (const [r,cells] of bands.entries()) {
        const row = Array<string>(edges.length - 1).fill("");
        for (const cell of cells) {
          const mid = Math.round((cell.left + cell.right) / 2);
          if (mid < rules[r].left) continue;
          let last = r+1;
          while (last < rules.length-1 && mid < rules[last].left) last++;
          const x = cell.left+3, y = cell.top+3;
          const w = cell.right-x-2, h = rules[last].y-y-2;
          if (w <= 0 || h <= 0) continue;
          let ink = 0;
          for (let dy=0; dy<h && ink<5; dy++) for(let dx=0;dx<w;dx++) if(dark(x+dx,y+dy)) ink++;
          if (ink < 5) continue;
          const scale = Math.min(2, 1600/w, 500/h);
          tile.width = Math.ceil(w*scale)+16; tile.height = Math.ceil(h*scale)+16;
          const tc = tile.getContext("2d")!;
          tc.fillStyle = "white"; tc.fillRect(0,0,tile.width,tile.height);
          tc.drawImage(canvas,x,y,w,h,8,8,w*scale,h*scale);
          const pix = tc.getImageData(0,0,tile.width,tile.height);
          for(let i=0;i<pix.data.length;i+=4) {
            const value = Math.min(255, Math.max(0, (pix.data[i]*0.3+pix.data[i+1]*0.59+pix.data[i+2]*0.11 - 30)*1.45));
            pix.data[i]=pix.data[i+1]=pix.data[i+2]=value;
          }
          tc.putImageData(pix,0,0);
          const read = await worker.recognize(tile);
          let value = read.data.text.trim().replace(/\s*\n\s*/g," ");
          // A merged item heading covers both the sequence number and the name.
          const anchor = !orderHeader && fieldFor(value)==="productName" ? cell.right-3 : cell.left+3;
          const col = edges.findIndex((v,i) => v<=anchor && edges[i+1]>anchor);
          if (col === quantityCol && /^[0-9A-Za-z., ]+$/.test(value)) {
            const latin = await (await englishWorker()).recognize(tile);
            const candidate = latin.data.text.trim().replace(/\s+/g, "");
            if (/^\d+(?:[,.]\d+)*(?:P|PLT|EA|BOX|KEA)?$/i.test(candidate)) value = candidate;
          }
          if (col >= 0) row[col]=value.normalize("NFKC");
        }
        if (row.some(v => fieldFor(v)==="quantity")) {
          orderHeader=true;
          quantityCol=row.findIndex(v => fieldFor(v)==="quantity");
        }
        if (row.some(v => /^\d{4}[.\/-]\d{1,2}[.\/-]\d{1,2}$/.test(v))) matrix=true;
        grid.push(row);
      }
    } finally {
      tile.width=tile.height=0;
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    }
    if ((matrix || orderHeader) && grid.some(row => row.some(v => ["productCode","productName"].includes(fieldFor(v) ?? "")))) {
      if (!matrix && rules[0].y > 30) {
        const mail = document.createElement("canvas");
        const zoom = Math.min(2, Math.sqrt(8000000 / (width * rules[0].y)));
        mail.width=Math.ceil(width*zoom); mail.height=Math.ceil(rules[0].y*zoom);
        mail.getContext("2d")!.drawImage(canvas, 0, 0, width, rules[0].y, 0, 0, mail.width, mail.height);
        const english = await englishWorker();
        await english.setParameters({tessedit_pageseg_mode: PSM.SPARSE_TEXT});
        const header = await english.recognize(mail);
        mail.height=mail.width=0;
        const received = header.data.text.match(/(20\d{2}[-.]\d{2}[-.]\d{2})\s+\d{1,2}:\d{2}/);
        if (received) grid.unshift(["발주일", received[1].replace(/\./g, "-")]);
      }
      return grid;
    }
  }
  return null;
}
