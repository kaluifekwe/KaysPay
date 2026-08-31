import { fetchWithTimeout, ProviderTimeoutError } from "./provider-fetch.ts";

const API_URL="https://api.groq.com/openai/v1/chat/completions";
const API_KEY=Deno.env.get("GROQ_API_KEY")??"";
const MODELS=["qwen/qwen3.6-27b","openai/gpt-oss-20b"] as const;

export type GroqFailureCode="rate_limited"|"timed_out"|"provider_unavailable"|"invalid_response"|"authentication_failed"|"model_unavailable"|"request_rejected";
export class GroqProviderError extends Error{constructor(readonly code:GroqFailureCode,readonly status:number|null=null){super(code);}}

export interface AiOperationsAnswer {
  answer:string;
  highlights:Array<{severity:"info"|"warning"|"critical";title:string;detail:string}>;
  recommended_actions:Array<{title:string;reason:string;requires_approval:boolean}>;
  data_freshness_note:string;
}
export interface AiCampaignCopy {segment:"registered_not_verified"|"verified_kyc_incomplete"|"kyc_completed_not_funded"|"funded_not_purchased"|"inactive";subject:string;heading:string;body:string;cta:string;rationale:string;}
export interface AiIncidentAnalysis {summary:string;likely_cause:string;impact:string;recommendations:Array<{title:string;reason:string;requires_approval:boolean}>;}

const schema={
  type:"object",additionalProperties:false,
  properties:{
    answer:{type:"string"},
    highlights:{type:"array",items:{type:"object",additionalProperties:false,properties:{severity:{type:"string",enum:["info","warning","critical"]},title:{type:"string"},detail:{type:"string"}},required:["severity","title","detail"]}},
    recommended_actions:{type:"array",items:{type:"object",additionalProperties:false,properties:{title:{type:"string"},reason:{type:"string"},requires_approval:{type:"boolean"}},required:["title","reason","requires_approval"]}},
    data_freshness_note:{type:"string"},
  },required:["answer","highlights","recommended_actions","data_freshness_note"],
};

function valid(value:unknown):value is AiOperationsAnswer{
  if(!value||typeof value!=="object")return false;
  const v=value as Record<string,unknown>;
  return typeof v.answer==="string"&&v.answer.length<=6000&&Array.isArray(v.highlights)&&v.highlights.length<=6&&Array.isArray(v.recommended_actions)&&v.recommended_actions.length<=5&&typeof v.data_freshness_note==="string";
}

export function isGroqConfigured():boolean{return API_KEY.startsWith("gsk_");}

export async function askGroq(question:string,context:unknown):Promise<{answer:AiOperationsAnswer;model:string}>{
  if(!isGroqConfigured())throw new Error("GROQ_NOT_CONFIGURED");
  const system=`You are KaysPay's read-only operations analyst. KaysPay is a Nigerian financial application. Analyze only the supplied aggregated statistics. Never invent customers, incidents, causes, financial amounts, or provider facts. Clearly distinguish observations from hypotheses. Never request or reveal PII, credentials, PINs, OTPs, account numbers, phone numbers, email addresses, balances, or transaction records. You cannot execute actions. Return only a JSON object with answer, highlights, recommended_actions, and data_freshness_note matching the requested structure. Return no more than 6 highlights and no more than 5 recommended actions. Recommendations that create campaigns, contact customers, alter services, retry transactions, or move money must set requires_approval=true. Be concise and practical.`;
  const messages=[{role:"system",content:system},{role:"user",content:`ADMIN QUESTION:\n${question}\n\nSANITIZED AGGREGATED CONTEXT:\n${JSON.stringify(context)}`}];
  let lastCode:GroqFailureCode="provider_unavailable";
  let lastStatus:number|null=null;
  for(const model of MODELS){
    try{
      const reasoning=model.startsWith("qwen/")?{reasoning_effort:"none",reasoning_format:"hidden"}:{reasoning_effort:"low",reasoning_format:"hidden"};
      const response=await fetchWithTimeout(API_URL,{method:"POST",headers:{Authorization:`Bearer ${API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model,messages,temperature:0.2,max_completion_tokens:1800,...reasoning,response_format:{type:"json_object"}})},30_000);
      if(!response.ok){lastStatus=response.status;lastCode=response.status===429?"rate_limited":[401,403].includes(response.status)?"authentication_failed":response.status===404?"model_unavailable":response.status>=500?"provider_unavailable":"request_rejected";continue;}
      const payload=await response.json() as {choices?:Array<{message?:{content?:string}}>};
      const parsed=JSON.parse(payload.choices?.[0]?.message?.content??"") as unknown;
      if(!valid(parsed)){lastCode="invalid_response";continue;}
      return {answer:parsed,model};
    }catch(error){lastCode=error instanceof GroqProviderError?error.code:error instanceof ProviderTimeoutError||error instanceof DOMException&&error.name==="AbortError"?"timed_out":error instanceof SyntaxError?"invalid_response":"provider_unavailable";if(error instanceof GroqProviderError)lastStatus=error.status;}
  }
  throw new GroqProviderError(lastCode,lastStatus);
}

export async function draftCampaignWithGroq(prompt:string,segments:Array<{segment:string;count:number}>):Promise<{copy:AiCampaignCopy;model:string}>{
  if(!isGroqConfigured())throw new Error("GROQ_NOT_CONFIGURED");
  const campaignSchema={type:"object",additionalProperties:false,properties:{segment:{type:"string",enum:["registered_not_verified","verified_kyc_incomplete","kyc_completed_not_funded","funded_not_purchased","inactive"]},subject:{type:"string"},heading:{type:"string"},body:{type:"string"},cta:{type:"string"},rationale:{type:"string"}},required:["segment","subject","heading","body","cta","rationale"]};
  const messages=[{role:"system",content:"You write concise, trustworthy lifecycle emails for KaysPay, a Nigerian financial app. Return only a JSON object with segment, subject, heading, body, cta, and rationale. Select only one supplied consent-eligible segment. Never make financial promises, invent discounts, imply urgency, or ask for a PIN, OTP, password, account number, balance, or personal information. Do not output HTML, URLs, customer names, or currency amounts. The CTA must describe the next in-app step. Explain the choice using only supplied counts."},{role:"user",content:`ADMIN REQUEST:\n${prompt||"Choose the strongest onboarding recovery opportunity."}\n\nCONSENT-ELIGIBLE SEGMENTS:\n${JSON.stringify(segments)}`}];
  let lastError="AI provider unavailable";
  for(const model of MODELS){try{const reasoning=model.startsWith("qwen/")?{reasoning_effort:"none",reasoning_format:"hidden"}:{reasoning_effort:"low",reasoning_format:"hidden"};const response=await fetchWithTimeout(API_URL,{method:"POST",headers:{Authorization:`Bearer ${API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model,messages,temperature:0.3,max_completion_tokens:900,...reasoning,response_format:{type:"json_object"}})},30_000);if(!response.ok){lastError=`Groq returned HTTP ${response.status}`;continue;}const payload=await response.json() as {choices?:Array<{message?:{content?:string}}>};const copy=JSON.parse(payload.choices?.[0]?.message?.content??"") as AiCampaignCopy;if(!segments.some(item=>item.segment===copy.segment)||copy.subject.length<3||copy.subject.length>120||copy.heading.length<3||copy.heading.length>90||copy.body.length<10||copy.body.length>700||copy.cta.length<2||copy.cta.length>40||copy.rationale.length>500)throw new Error("Invalid campaign response");return {copy,model};}catch(error){lastError=error instanceof Error?error.message:"AI provider unavailable";}}
  throw new Error(lastError);
}

export async function diagnoseIncidentWithGroq(incident:unknown):Promise<{analysis:AiIncidentAnalysis;model:string}>{
  if(!isGroqConfigured())throw new Error("GROQ_NOT_CONFIGURED");
  const incidentSchema={type:"object",additionalProperties:false,properties:{summary:{type:"string"},likely_cause:{type:"string"},impact:{type:"string"},recommendations:{type:"array",maxItems:4,items:{type:"object",additionalProperties:false,properties:{title:{type:"string"},reason:{type:"string"},requires_approval:{type:"boolean"}},required:["title","reason","requires_approval"]}}},required:["summary","likely_cause","impact","recommendations"]};
  const messages=[{role:"system",content:"You are KaysPay's incident analyst for a Nigerian financial application. Return only a JSON object with summary, likely_cause, impact, and recommendations. Use only the supplied sanitized provider metrics. Never claim a root cause that the evidence does not prove; label it as a likely cause or say unknown. Never request or reveal customer data, credentials, balances, PINs, OTPs, account numbers, request bodies, or provider response bodies. Never advise retrying financial transactions automatically. Disabling services, switching gateways, contacting customers, or moving money always requires approval."},{role:"user",content:`SANITIZED INCIDENT:\n${JSON.stringify(incident)}`}];
  let lastError="AI provider unavailable";
  for(const model of MODELS){try{const reasoning=model.startsWith("qwen/")?{reasoning_effort:"none",reasoning_format:"hidden"}:{reasoning_effort:"low",reasoning_format:"hidden"};const response=await fetchWithTimeout(API_URL,{method:"POST",headers:{Authorization:`Bearer ${API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model,messages,temperature:0.1,max_completion_tokens:1000,...reasoning,response_format:{type:"json_object"}})},30_000);if(!response.ok){lastError=`Groq returned HTTP ${response.status}`;continue;}const payload=await response.json() as {choices?:Array<{message?:{content?:string}}>};const analysis=JSON.parse(payload.choices?.[0]?.message?.content??"") as AiIncidentAnalysis;if(!analysis.summary||!analysis.likely_cause||!analysis.impact||!Array.isArray(analysis.recommendations)||analysis.recommendations.length>4)throw new Error("Invalid incident analysis");return {analysis,model};}catch(error){lastError=error instanceof Error?error.message:"AI provider unavailable";}}
  throw new Error(lastError);
}
