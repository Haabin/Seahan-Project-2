/**
 * 계정 생성 (관리자용). 자유 가입은 쓰지 않고 관리자가 만든 계정을 공유한다 (NFR-02).
 *   npm run create-user -- <email> <password> <role: viewer|planner|admin> [표시이름]
 * SUPABASE_SERVICE_ROLE_KEY 가 .env.local 에 있어야 한다.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

// 프로토타입 검증이 끝나면 .env.local 에 ACCOUNT_CREATION_LOCKED=true 를 넣어 이 스크립트를 잠근다.
// 이후 계정은 Supabase 대시보드(Authentication → Users)에서 관리자만 만든다.
if (process.env.ACCOUNT_CREATION_LOCKED === "true") {
  console.error("계정 생성이 잠겨 있습니다 (ACCOUNT_CREATION_LOCKED=true). Supabase 대시보드에서 관리자가 생성하세요.");
  process.exit(1);
}

const [email, password, role = "viewer", displayName] = process.argv.slice(2);
if (!email || !password || !["viewer", "planner", "admin"].includes(role)) {
  console.error("usage: npm run create-user -- <email> <password> <viewer|planner|admin> [표시이름]");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 .env.local 에 없습니다.");
  process.exit(1);
}

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName ?? email.split("@")[0] },
  });
  if (error) {
    console.error("createUser 실패:", error.message);
    process.exit(1);
  }
  const userId = data.user.id;
  const { error: pErr } = await admin
    .from("profiles")
    .upsert({ user_id: userId, role, display_name: displayName ?? email.split("@")[0] });
  if (pErr) {
    console.error("profiles 갱신 실패:", pErr.message);
    process.exit(1);
  }
  console.log(`생성 완료: ${email} (${role}) id=${userId}`);
})();
