/**
 * 로그인 오류 분류 (NFR-02 사용성).
 * 메시지 문자열이 아니라 error.name / error.code / error.status 로 판별한다.
 * Supabase auth-js 규약:
 *  - AuthApiError: 서버가 응답한 오류. status(HTTP), code('invalid_credentials' 등)
 *  - AuthRetryableFetchError: fetch 자체 실패(네트워크·CORS·차단). status 0
 *  - 그 외 fetch 예외(TypeError: Failed to fetch), AbortError(타임아웃)
 */

export type LoginErrorKind = "invalid_credentials" | "network" | "server" | "unknown";

export interface LoginErrorInfo {
  kind: LoginErrorKind;
  message: string;
  /** 원본 요약(콘솔 기록용) */
  detail: string;
}

export const LOGIN_ERROR_MESSAGES: Record<LoginErrorKind, string> = {
  invalid_credentials: "이메일 또는 비밀번호가 올바르지 않습니다.",
  network: "서버에 연결할 수 없습니다. 인터넷 연결이나 사내 네트워크 차단 여부를 확인한 뒤 다시 시도하세요.",
  server: "일시적인 서버 오류입니다. 잠시 후 다시 시도하세요.",
  unknown: "로그인 중 문제가 발생했습니다. 계속되면 관리자에게 문의하세요.",
};

/** 타임아웃을 나타내기 위해 호출 측에서 던지는 오류 */
export class LoginTimeoutError extends Error {
  readonly status = 0;
  constructor(ms: number) {
    super(`login timeout after ${ms}ms`);
    this.name = "LoginTimeoutError";
  }
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

const NETWORK_NAMES = new Set(["AuthRetryableFetchError", "LoginTimeoutError", "AbortError", "TimeoutError"]);
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "request_timeout"]);
const INVALID_CODES = new Set(["invalid_credentials", "invalid_grant", "user_not_found", "email_not_confirmed"]);

export function classifyLoginError(err: unknown): LoginErrorInfo {
  const e = (err ?? {}) as ErrorLike;
  const name = typeof e.name === "string" ? e.name : "";
  const code = typeof e.code === "string" ? e.code : "";
  const status = typeof e.status === "number" ? e.status : undefined;
  const message = typeof e.message === "string" ? e.message : "";
  const detail = `${name || "Error"}${code ? `/${code}` : ""}${status !== undefined ? `/${status}` : ""}${message ? `: ${message}` : ""}`;

  // 1) 네트워크·연결 실패
  if (NETWORK_NAMES.has(name) || NETWORK_CODES.has(code) || status === 0) {
    return { kind: "network", message: LOGIN_ERROR_MESSAGES.network, detail };
  }
  // fetch 자체가 던지는 TypeError (브라우저: "Failed to fetch", Node: "fetch failed")에는 status/code 가 없다
  if (name === "TypeError" && status === undefined && code === "") {
    return { kind: "network", message: LOGIN_ERROR_MESSAGES.network, detail };
  }

  // 2) 아이디·비밀번호 불일치
  if (name === "AuthApiError" && (INVALID_CODES.has(code) || status === 400)) {
    return { kind: "invalid_credentials", message: LOGIN_ERROR_MESSAGES.invalid_credentials, detail };
  }
  if (INVALID_CODES.has(code)) {
    return { kind: "invalid_credentials", message: LOGIN_ERROR_MESSAGES.invalid_credentials, detail };
  }

  // 3) 서버 오류·요청 과다
  if (status !== undefined && (status >= 500 || status === 429)) {
    return { kind: "server", message: LOGIN_ERROR_MESSAGES.server, detail };
  }
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit") {
    return { kind: "server", message: LOGIN_ERROR_MESSAGES.server, detail };
  }

  // 4) 그 외
  return { kind: "unknown", message: LOGIN_ERROR_MESSAGES.unknown, detail };
}

/** 지정 시간 안에 끝나지 않으면 LoginTimeoutError 로 거부한다 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new LoginTimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
