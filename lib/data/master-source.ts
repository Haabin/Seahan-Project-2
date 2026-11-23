/**
 * 기준정보 출처 표시 (settings.master_source).
 * npm run import:operation-plan 이 실제 운용안을 넣으면 "real" 을 남긴다. 값이 없거나 "fake" 면 예전과 같다.
 * "real" 인 DB 에서는 예전 가상 양식용 "운용안 일괄 등록"(/api/import/master)을 막는다.
 */
export const MASTER_SOURCE_KEY = "master_source";

export const REAL_MASTER_UPLOAD_BLOCKED = "실제 운용안은 npm run import:operation-plan으로만 등록하세요";

export function isRealMasterSource(value: unknown): boolean {
  return value === "real";
}
