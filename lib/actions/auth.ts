"use server";

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";

export async function signOutAction() {
  const supabase = await createSupabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}
