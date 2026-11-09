import { describe, expect, it } from "vitest";
import { classifyLoginError, LOGIN_ERROR_MESSAGES, LoginTimeoutError, withTimeout } from "@/lib/auth/login-error";

function authApiError(status: number, code?: string, message = "msg") {
  return { name: "AuthApiError", status, code, message };
}

describe("NFR-02 로그인 오류 분류 — name/code/status 기준", () => {
  it("AuthApiError code=invalid_credentials → 불일치", () => {
    const r = classifyLoginError(authApiError(400, "invalid_credentials", "Invalid login credentials"));
    expect(r.kind).toBe("invalid_credentials");
    expect(r.message).toBe(LOGIN_ERROR_MESSAGES.invalid_credentials);
  });

  it("AuthApiError status=400 (code 없음) → 불일치", () => {
    expect(classifyLoginError(authApiError(400)).kind).toBe("invalid_credentials");
  });

  it("AuthRetryableFetchError status=0 → 연결 실패", () => {
    const r = classifyLoginError({ name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" });
    expect(r.kind).toBe("network");
    expect(r.message).toBe(LOGIN_ERROR_MESSAGES.network);
  });

  it("fetch TypeError(Failed to fetch) → 연결 실패", () => {
    expect(classifyLoginError(new TypeError("Failed to fetch")).kind).toBe("network");
  });

  it("타임아웃(LoginTimeoutError) → 연결 실패", () => {
    expect(classifyLoginError(new LoginTimeoutError(15000)).kind).toBe("network");
  });

  it("AbortError → 연결 실패", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(classifyLoginError(e).kind).toBe("network");
  });

  it("status 0 이면 이름과 무관하게 연결 실패", () => {
    expect(classifyLoginError({ name: "AuthUnknownError", status: 0, message: "x" }).kind).toBe("network");
  });

  it("5xx → 서버 오류", () => {
    expect(classifyLoginError(authApiError(502, "unexpected_failure")).kind).toBe("server");
    expect(classifyLoginError(authApiError(500)).kind).toBe("server");
    expect(classifyLoginError(authApiError(503)).message).toBe(LOGIN_ERROR_MESSAGES.server);
  });

  it("429 요청 과다 → 서버 오류", () => {
    expect(classifyLoginError(authApiError(429, "over_request_rate_limit")).kind).toBe("server");
  });

  it("그 외(예: 422 weak password, 알 수 없는 오류) → unknown + 원본 요약 보존", () => {
    const r = classifyLoginError(authApiError(422, "weak_password", "Password is too weak"));
    expect(r.kind).toBe("unknown");
    expect(r.message).toBe(LOGIN_ERROR_MESSAGES.unknown);
    expect(r.detail).toContain("AuthApiError");
    expect(r.detail).toContain("weak_password");
    expect(r.detail).toContain("422");
    expect(classifyLoginError(undefined).kind).toBe("unknown");
    expect(classifyLoginError("문자열 오류").kind).toBe("unknown");
  });

  it("메시지 문자열은 판별에 쓰지 않는다 (메시지에 'Invalid login'이 있어도 status 503이면 서버 오류)", () => {
    expect(classifyLoginError({ name: "AuthApiError", status: 503, message: "Invalid login credentials" }).kind).toBe("server");
  });

  it("withTimeout: 시간 안에 끝나면 값, 넘으면 LoginTimeoutError", async () => {
    await expect(withTimeout(Promise.resolve(1), 50)).resolves.toBe(1);
    const slow = new Promise((res) => setTimeout(() => res(2), 200));
    await expect(withTimeout(slow, 20)).rejects.toBeInstanceOf(LoginTimeoutError);
  });
});
