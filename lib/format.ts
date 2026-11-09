const DOW = ["일", "월", "화", "수", "목", "금", "토"];

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return Math.round(n).toLocaleString("ko-KR");
}

export function fmtTon(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return `${n.toFixed(digits)}t`;
}

/** '2026-11-12' → '11/12' */
export function fmtMD(iso: string): string {
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}

/** '2026-11-12' → '11/12 목' */
export function fmtMDW(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${fmtMD(iso)} ${DOW[d.getUTCDay()]}`;
}

export function dowKo(iso: string): string {
  return DOW[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 제품 id → 안정적인 막대 색 인덱스(1~6) */
export function colorIndexFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 6) + 1;
}
