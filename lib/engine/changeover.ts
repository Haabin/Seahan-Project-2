/**
 * 교체 손실 시간(h) → 가동률 계수 환산 (생산배대 범례표).
 * 표는 settings.changeover_hour_factor_table 에 저장하며, 여기 값은 그 기본값이다.
 */
export type HourFactorTable = Record<string, number>;

export const DEFAULT_HOUR_FACTOR_TABLE: HourFactorTable = {
  "1": 0.96,
  "2": 0.915,
  "3": 0.875,
  "4": 0.83,
  "5": 0.79,
  "6": 0.75,
  "7": 0.71,
  "8": 0.67,
  "9": 0.625,
};

/** settings 값(임의 JSON)을 안전하게 표로 바꾼다. 형식이 틀리면 기본표 */
export function parseHourFactorTable(value: unknown): HourFactorTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_HOUR_FACTOR_TABLE;
  const out: HourFactorTable = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const h = Number(k);
    const f = Number(v);
    if (Number.isFinite(h) && h > 0 && Number.isFinite(f) && f >= 0 && f <= 1) out[String(h)] = f;
  }
  return Object.keys(out).length ? out : DEFAULT_HOUR_FACTOR_TABLE;
}

/**
 * 시간에 해당하는 계수. 표에 정확히 있으면 그 값, 사이 값이면 선형 보간,
 * 0 이하면 1(손실 없음), 표 범위를 넘으면 null(사람이 직접 입력).
 */
export function factorForHours(hours: number, table: HourFactorTable = DEFAULT_HOUR_FACTOR_TABLE): number | null {
  if (!Number.isFinite(hours)) return null;
  if (hours <= 0) return 1;
  const points = Object.entries(table)
    .map(([h, f]) => [Number(h), f] as const)
    .sort((a, b) => a[0] - b[0]);
  if (!points.length) return null;
  const exact = points.find(([h]) => h === hours);
  if (exact) return exact[1];
  const all = [[0, 1] as const, ...points];
  for (let i = 0; i < all.length - 1; i++) {
    const [h0, f0] = all[i];
    const [h1, f1] = all[i + 1];
    if (hours > h0 && hours < h1) {
      const f = f0 + ((f1 - f0) * (hours - h0)) / (h1 - h0);
      return Math.round(f * 1000) / 1000;
    }
  }
  return null;
}
