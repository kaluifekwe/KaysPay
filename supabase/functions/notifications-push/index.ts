import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret } from "../_shared/auth.ts";
import { fetchWithTimeout } from "../_shared/provider-fetch.ts";

// Delivers pending in-app notifications as device push, via the Expo Push API
// (see the notifications-push cron in migration 051). Runs every minute:
// picks up notifications with pushed=false, sends one push per registered
// device token, then marks them pushed. Cron-only (x-cron-secret gated).
//
// The Expo Push API needs no secret — the recipient push token addresses the
// device. We only send recent notifications (< 1h) so a backlog can't spam.
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);

  const supabase = adminClient();
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data: notes, error } = await supabase
    .from("notifications")
    .select("id, user_id, title, body, type, data")
    .eq("pushed", false)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) return json({ sent: 0, error: error.message }, 500);
  if (!notes || notes.length === 0) return json({ checked: 0, sent: 0 });

  const userIds = [...new Set(notes.map((n: any) => n.user_id))];
  const { data: tokens } = await supabase.from("push_tokens").select("user_id, token").in("user_id", userIds);

  const byUser = new Map<string, string[]>();
  for (const t of tokens || []) {
    const arr = byUser.get(t.user_id) || [];
    arr.push(t.token);
    byUser.set(t.user_id, arr);
  }

  const messages: any[] = [];
  for (const n of notes) {
    for (const tok of byUser.get(n.user_id) || []) {
      messages.push({
        to: tok,
        title: n.title,
        body: n.body,
        sound: "default",
        data: { type: n.type, ...(n.data || {}) },
      });
    }
  }

  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    try {
      const res = await fetchWithTimeout(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(batch),
      }, 20_000);
      if (res.ok) sent += batch.length;
    } catch {
      // best-effort — a failed batch is dropped, not retried, to avoid spam
    }
  }

  // Mark all attempted notifications pushed so they aren't re-sent next minute.
  await supabase.from("notifications").update({ pushed: true }).in("id", notes.map((n: any) => n.id));

  return json({ checked: notes.length, recipients: messages.length, sent });
});
