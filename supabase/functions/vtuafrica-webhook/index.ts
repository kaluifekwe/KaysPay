import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createHash } from "node:crypto";
import { adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { stripRef } from "../_shared/vtuafrica-client.ts";

const VTUAFRICA_API_KEY = Deno.env.get("VTUAFRICA_API_KEY");
const SUCCESS_STATUSES = new Set(["completed", "successful", "success"]);
const FAILURE_STATUSES = new Set(["failed", "refunded", "reversed", "cancelled", "canceled", "declined"]);

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthenticated(event: Record<string, unknown>): boolean {
  if (!VTUAFRICA_API_KEY) return false;
  const provided = String(event.apikey ?? "").trim().toLowerCase();
  const expected = createHash("md5").update(VTUAFRICA_API_KEY).toString().toLowerCase();
  return constantTimeEqual(provided, expected);
}

function safePins(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split("<=>") : [];
  const pins = raw.map((v) => String(v).trim()).filter((v) => v.length > 0 && v.length <= 256).slice(0, 10);
  return pins.length ? pins : undefined;
}

serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let event: Record<string, unknown>;
  try {
    event = await readJsonBody<Record<string, unknown>>(req, 32_768);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid payload");
    return new Response(JSON.stringify({ error: e.message }), { status: e.status });
  }

  if (!isAuthenticated(event)) {
    return new Response(JSON.stringify({ error: "Invalid authentication" }), { status: 401 });
  }

  const rawRef = String(event.ref ?? event.ReferenceID ?? event.reference ?? "").trim();
  const providerRef = stripRef(rawRef);
  if (!providerRef || providerRef.length > 80) {
    return new Response(JSON.stringify({ error: "Invalid reference" }), { status: 400 });
  }

  const status = String(event.status ?? event.Status ?? "").trim().toLowerCase();
  const supabase = adminClient();

  try {
    const { data: tx, error: lookupError } = await supabase
      .from("transactions")
      .select("id, status, type, metadata")
      .eq("metadata->>provider_reference", providerRef)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!tx) return new Response(JSON.stringify({ status: true }), { status: 200 });

    if (!["airtime", "data", "bill", "exam_pin"].includes(tx.type)) {
      return new Response(JSON.stringify({ error: "Unsupported transaction" }), { status: 400 });
    }

    // Idempotent acknowledgement for duplicate/out-of-order terminal callbacks.
    if (tx.status !== "pending") {
      return new Response(JSON.stringify({ status: true }), { status: 200 });
    }

    if (SUCCESS_STATUSES.has(status)) {
      const pins = safePins(event.pins);
      if (pins) {
        const { error: pinError } = await supabase
          .from("transactions")
          .update({ metadata: { ...tx.metadata, pins } })
          .eq("id", tx.id)
          .eq("status", "pending");
        if (pinError) throw pinError;
      }

      const { error: completionError } = await supabase.rpc("complete_service_transaction", {
        p_tx_id: tx.id,
        p_order_id: rawRef || null,
      });
      if (completionError) throw completionError;
    } else if (FAILURE_STATUSES.has(status)) {
      // One callback is not enough evidence to return money: provider/telco
      // status can briefly race delivery. Record it for the reconciler's
      // separated second confirmation; never refund directly from a webhook.
      const { error: observationError } = await supabase
        .from("transactions")
        .update({
          metadata: {
            ...tx.metadata,
            provider_failure_confirmation: {
              at: new Date().toISOString(),
              status,
              message: String(event.message ?? "").slice(0, 300),
              source: "webhook",
            },
          },
        })
        .eq("id", tx.id)
        .eq("status", "pending");
      if (observationError) throw observationError;
    }

    return new Response(JSON.stringify({ status: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("VTUAfrica webhook processing error:", redactSecrets(error));
    return new Response(JSON.stringify({ error: "Processing error" }), { status: 500 });
  }
});
