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
  let userId: string;
  if (error) {
    // 이미 있는 계정이면 역할·표시이름만 다시 맞춘다(비밀번호는 바꾸지 않는다)
    if (!/already.*registered|already exists/i.test(error.message)) {
      console.error("createUser 실패:", error.message);
      process.exit(1);
    }
    const { data: list, error: lErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (lErr || !found) {
      console.error("이미 있는 계정을 찾지 못했습니다:", lErr?.message ?? email);
      process.exit(1);
    }
    userId = found.id;
    console.log(`이미 있는 계정입니다. 역할만 맞춥니다: ${email}`);
  } else {
    userId = data.user.id;
  }
  const { error: pErr } = await admin
    .from("profiles")
    .upsert({ user_id: userId, role, display_name: displayName ?? email.split("@")[0] });
  if (pErr) {
    console.error("profiles 갱신 실패:", pErr.message);
    process.exit(1);
  }
  console.log(`생성 완료: ${email} (${role}) id=${userId}`);
})();
