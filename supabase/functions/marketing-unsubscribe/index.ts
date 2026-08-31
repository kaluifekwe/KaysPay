import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { handleCors, corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  const cors = handleCors(req, "https://kayspay.app");
  if (cors) return cors;

  const token = new URL(req.url).searchParams.get("token") ?? "";
  const { data } = await adminClient().rpc("unsubscribe_marketing_by_token", { p_token: token });
  const ok = data === true;
  return new Response(
    `<!doctype html><html><meta name="viewport" content="width=device-width"><title>KaysPay email preferences</title><body style="font-family:system-ui;max-width:560px;margin:80px auto;padding:24px"><h1>${ok ? "You are unsubscribed" : "Link unavailable"}</h1><p>${ok ? "KaysPay will not send you further marketing emails. Essential account and security messages are unaffected." : "This unsubscribe link is invalid or expired."}</p></body></html>`,
    {
      status: ok ? 200 : 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        ...corsHeaders("https://kayspay.app"),
      },
    },
  );
});
