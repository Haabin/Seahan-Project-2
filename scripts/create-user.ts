/**
 * 계정 생성 (관리자용). 자유 가입은 쓰지 않고 관리자가 만든 계정을 공유한다 (NFR-02).
 *   npm run create-user -- <email> <password> <role: viewer|planner|admin> [표시이름]
 * SUPABASE_SERVICE_ROLE_KEY 가 .env.local 에 있어야 한다.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

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
