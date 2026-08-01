import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  consumeAuthToken,
  enforceRateLimit,
  getAuthUser,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import {
  isNinBvnConfigured,
  NinBvnError,
  NinModificationType,
  submitNinModification,
} from "../_shared/ninbvn-client.ts";

// CheckMyNINBVN only — Prembly does not offer modification/correction
// services, only verification (confirmed against Prembly's docs 2026-07-06).
//
// Retail price — ₦18,000, confirmed by owner 2026-07-06 (provider cost is
// ₦16,000/order, charged upfront and only refunded if NIMC rejects it).
const MODIFICATION_PRICE_KOBO = 1800000;

const TX_TYPE: Record<NinModificationType, string> = {
  name: "nin_name_modification",
  phone: "nin_phone_modification",
  address: "nin_address_modification",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function newRequestId(): string {
  return `ninmod${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isNinBvnConfigured()) {
    return json({ error: "NIN modification not configured" }, 500);
  }

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError
      ? error
      : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const modType = str(body?.modification_type) as NinModificationType;
  if (!TX_TYPE[modType]) {
    return json({ success: false, error: "Invalid modification type" }, 400);
  }

  const nin = str(body?.nin);
  if (!/^\d{11}$/.test(nin)) {
    return json({ success: false, error: "Enter a valid 11-digit NIN" }, 400);
  }

  const surname = str(body?.surname);
  const firstname = str(body?.firstname);
  if (!surname || !firstname) {
    return json({
      success: false,
      error: "Current surname and first name are required",
    }, 400);
  }

  // Required fields differ per modification type (per CheckMyNINBVN's docs).
  let providerFields: Record<string, string> = { nin, surname, firstname };
  if (modType === "name") {
    const phoneNumber = str(body?.phone_number);
    const newSurname = str(body?.new_surname);
    const newFirstname = str(body?.new_firstname);
    if (!/^0\d{10}$/.test(phoneNumber)) {
      return json({
        success: false,
        error: "Enter a valid phone number on file",
      }, 400);
    }
    if (!newSurname || !newFirstname) {
      return json({ success: false, error: "Enter the corrected name" }, 400);
    }
    providerFields = {
      ...providerFields,
      phone_number: phoneNumber,
      new_surname: newSurname,
      new_firstname: newFirstname,
    };
  } else if (modType === "phone") {
    const newPhoneNumber = str(body?.new_phone_number);
    if (!/^0\d{10}$/.test(newPhoneNumber)) {
      return json(
        { success: false, error: "Enter a valid new phone number" },
        400,
      );
    }
    providerFields = {
      ...providerFields,
      middlename: str(body?.middlename),
      new_phone_number: newPhoneNumber,
    };
  } else {
    const phoneNumber = str(body?.phone_number);
    const newAddress = str(body?.new_address);
    if (!/^0\d{10}$/.test(phoneNumber)) {
      return json({
        success: false,
        error: "Enter a valid phone number on file",
      }, 400);
    }
    if (!newAddress) {
      return json(
        { success: false, error: "Enter the corrected address" },
        400,
      );
    }
    providerFields = {
      ...providerFields,
      phone_number: phoneNumber,
      new_address: newAddress,
    };
  }

  const supabase = adminClient();

  const rate = await enforceRateLimit(
    supabase,
    "nin_modify",
    user.id,
    3,
    3600,
    user.id,
  );
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many modification attempts. Please wait and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({
      success: false,
      error: "Re-authorization required. Please try again.",
    }, 401);
  }

  const requestId = String(body.idempotency_key || newRequestId());
  const txType = TX_TYPE[modType];

  const { data: txId, error: debitError } = await supabase.rpc(
    "debit_for_service",
    {
      p_user_id: user.id,
      p_amount: MODIFICATION_PRICE_KOBO,
      p_type: txType,
      p_network: "N/A",
      p_recipient: nin,
      p_metadata: { service: txType, ...providerFields },
      p_idempotency_key: requestId,
    },
  );

  if (debitError) {
    const msg = debitError.message || "";
    if (msg.includes("INSUFFICIENT_FUNDS")) {
      return json({ success: false, error: "Insufficient balance" });
    }
    if (msg.includes("WALLET_NOT_FOUND")) {
      return json({ success: false, error: "Wallet not found" });
    }
    return json({ success: false, error: "Could not start transaction" }, 500);
  }

  // Not instant — a reviewed order (24-48h), same pattern as nin-validate.
  // The transaction stays 'pending' until nin-reconcile's scheduled sweep
  // resolves it.
  try {
    const { status, data } = await submitNinModification(
      modType,
      providerFields,
    );
    const referenceId = data?.reference_id ?? data?.data?.reference_id ??
      data?.order_id ?? data?.data?.order_id;

    if (status >= 400 || !referenceId) {
      await supabase.rpc("refund_service_transaction", {
        p_tx_id: txId,
        p_reason: data?.message || "order_rejected",
      });
      return json({
        success: false,
        error: data?.message ||
          "Could not submit this request. You were not charged.",
      });
    }

    await supabase
      .from("transactions")
      .update({
        metadata: {
          service: txType,
          ...providerFields,
          reference_id: referenceId,
        },
      })
      .eq("id", txId);

    return json({
      success: true,
      pending: true,
      transaction_id: txId,
      message:
        "Request submitted. This usually takes 24-48 hours — check Transaction History for the result.",
    });
  } catch (e) {
    const isConfigError = e instanceof NinBvnError;
    await supabase.rpc("refund_service_transaction", {
      p_tx_id: txId,
      p_reason: isConfigError
        ? `ninbvn_config: ${e.message}`
        : "provider_unreachable",
    });
    return json({
      success: false,
      error: isConfigError
        ? "Provider not configured. Please try again later."
        : "Network error. Please try again. You were not charged.",
    });
  }
});
