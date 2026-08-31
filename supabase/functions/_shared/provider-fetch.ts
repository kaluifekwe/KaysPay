export class ProviderTimeoutError extends Error {
  readonly code = "PROVIDER_TIMEOUT";

  constructor(readonly timeoutMs: number) {
    super(`Provider request exceeded ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ProviderIdentity { provider:string; service:string; operation:string }
function providerIdentity(input:RequestInfo|URL):ProviderIdentity{
  try{
    const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);
    const host=url.hostname.toLowerCase(),path=url.pathname.toLowerCase();
    if(host.includes("vtunaija")){
      const service=path.includes("internetbundle")||path.includes("querydatatransaction")?"data"
        :path.includes("topup")||path.includes("querytransaction")?"airtime"
        :path.includes("billpayment")?"electricity"
        :path.includes("cablesub")?"cable_tv"
        :path.includes("exam")||path.includes("pricing")?"exam_pins":"vtu";
      return {provider:"vtunaija",service,operation:path.includes("verify")?"verify":path.includes("query")?"reconcile":"request"};
    }
    if(host.endsWith("quidax.io")){const operation=/ticker|market/.test(path)?"markets":/withdraw/.test(path)?"withdrawal":/deposit/.test(path)?"deposit":/bank|account/.test(path)?"bank_account":/off.?ramp|sell/.test(path)?"sell":/on.?ramp|buy/.test(path)?"buy":"account";return {provider:"quidax",service:"crypto",operation};}
    if(host.endsWith("airalo.com"))return {provider:"airalo",service:"esim",operation:/order|purchase/.test(path)?"purchase":/balance/.test(path)?"balance":"catalog"};
    if(host.endsWith("paystack.co")){const transfer=/transfer|bank|resolve/.test(path);return {provider:"paystack",service:transfer?"bank_transfer":"wallet_funding",operation:transfer?"transfer":"funding"};}
    if(host.endsWith("flutterwave.com")){const transfer=/transfer|bank|beneficiar|account.resolve/.test(path);return {provider:"flutterwave",service:transfer?"bank_transfer":"wallet_funding",operation:transfer?"transfer":"funding"};}
    if(host.endsWith("prembly.com"))return {provider:"prembly",service:"identity",operation:path.includes("bvn")?"bvn":"nin"};
    if(host.includes("checkmyninbvn"))return {provider:"checkmyninbvn",service:"identity",operation:path.includes("bvn")?"bvn":"nin"};
    if(host.endsWith("resend.com"))return {provider:"resend",service:"email",operation:"send"};
    if(host==="api.groq.com")return {provider:"groq",service:"admin_ai",operation:"completion"};
    if(host==="exp.host")return {provider:"expo",service:"push_notifications",operation:"send"};
    if(host==="open.er-api.com")return {provider:"open_er_api",service:"exchange_rate",operation:"rates"};
    return {provider:"external",service:"external",operation:"request"};
  }catch{return {provider:"external",service:"external",operation:"request"};}
}
function recordProvider(input:RequestInfo|URL,method:string,outcome:string,status:number|null,duration:number,errorCode:string|null){
  const identity=providerIdentity(input);
  const promise=(async()=>{try{await adminClient().rpc("record_provider_call",{p_provider:identity.provider,p_service:identity.service,p_operation:identity.operation,p_method:["GET","POST","PUT","PATCH","DELETE"].includes(method)?method:"OTHER",p_outcome:outcome,p_status_code:status,p_duration_ms:Math.round(duration),p_error_code:errorCode});}catch{/* Telemetry must never fail the provider call. */}})();
  const runtime=(globalThis as unknown as {EdgeRuntime?:{waitUntil:(p:Promise<unknown>)=>void}}).EdgeRuntime;
  if(runtime)runtime.waitUntil(promise);
}

/**
 * Bounds an external-provider request without retrying it. Financial POSTs
 * must only be retried by callers that can prove provider idempotency.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 20_000,
  fetchImpl: FetchImplementation = fetch,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError("timeoutMs must be between 1 and 120000");
  }

  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const forwardAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) forwardAbort();
  else upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started=Date.now();
  const method=(init.method??"GET").toUpperCase();
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    // Buffer inside the deadline. Native fetch resolves when headers arrive;
    // without this, a provider could send headers and then stall the body.
    const body = await response.arrayBuffer();
    let outcome=response.ok?"success":response.status>=400&&response.status<500&&![401,403,408,429].includes(response.status)?"client_error":"provider_error";
    let errorCode=response.ok?null:`HTTP_${response.status}`;
    // VTUnaija can report its own routing outage as HTTP 4xx. That is a
    // provider failure, not bad customer input. Inspect only a bounded copy
    // for this allowlisted phrase; never store or log the response body.
    if (!response.ok && providerIdentity(input).provider === "vtunaija" && body.byteLength <= 64_000) {
      const providerText = new TextDecoder().decode(body).toLowerCase();
      if (providerText.includes("no active gateway") || providerText.includes("gateway unavailable")) {
        outcome = "provider_error";
        errorCode = "PROVIDER_GATEWAY_UNAVAILABLE";
      }
    }
    recordProvider(input,method,outcome,response.status,Date.now()-started,errorCode);
    return new Response(body.byteLength > 0 ? body : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (controller.signal.aborted && !upstreamSignal?.aborted) {
      recordProvider(input,method,"timeout",null,Date.now()-started,"PROVIDER_TIMEOUT");
      throw new ProviderTimeoutError(timeoutMs);
    }
    recordProvider(input,method,"network_error",null,Date.now()-started,"NETWORK_ERROR");
    throw error;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", forwardAbort);
  }
}
import { adminClient } from "./auth.ts";
