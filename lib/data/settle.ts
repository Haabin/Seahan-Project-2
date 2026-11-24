/**
 * Promise.allSettled 결과를 순서대로 푼다. 실패가 있으면 목록에서 **앞에 있는** 실패를 던진다.
 * 예전에 차례로 실행하던 조회를 함께 시작할 때, 화면에 보이는 오류가 예전 순서와 같게 하려고 쓴다.
 */
export function unwrapInOrder<T extends readonly unknown[]>(results: { [K in keyof T]: PromiseSettledResult<T[K]> }): T {
  for (const r of results as readonly PromiseSettledResult<unknown>[]) if (r.status === "rejected") throw r.reason;
  return (results as readonly PromiseSettledResult<unknown>[]).map((r) => (r as PromiseFulfilledResult<unknown>).value) as unknown as T;
}
