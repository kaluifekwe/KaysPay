import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { askGroq, draftCampaignWithGroq, GroqProviderError, isGroqConfigured } from "../_shared/groq-client.ts";
import { CampaignSegment, generateCampaignDraft } from "../_shared/campaign-assistant.ts";

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders(),"Content-Type":"application/json","Cache-Control":"no-store"}});
const SEGMENTS=["registered_not_verified","verified_kyc_incomplete","kyc_completed_not_funded","funded_not_purchased","inactive"];
function compactContext(value:unknown,budget=16_000):unknown{let remaining=budget;const visit=(item:unknown,depth:number):unknown=>{if(remaining<=0)return "[truncated]";if(item===null||typeof item==="boolean"||typeof item==="number"){remaining-=16;return item;}if(typeof item==="string"){const text=item.slice(0,300);remaining-=text.length;return text;}if(depth>=4)return "[summary omitted]";if(Array.isArray(item))return item.slice(0,10).map(entry=>visit(entry,depth+1));if(typeof item==="object"){const output:Record<string,unknown>={};for(const [key,entry] of Object.entries(item as Record<string,unknown>).slice(0,25)){if(remaining<=0)break;remaining-=key.length;output[key]=visit(entry,depth+1);}return output;}return String(item).slice(0,100);};return visit(value,0);}

serve(async(req)=>{
  const cors=handleCors(req);if(cors)return cors;
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  let admin;try{admin=await requireAdmin(req,"super_admin");}catch(error){if(error instanceof AdminAuthError)return json({error:error.message},error.status);return json({error:"Unauthorized"},401);}
  if(!isGroqConfigured())return json({error:"Groq is not configured yet"},503);
  let body:{question?:unknown;request_id?:unknown};try{body=await readJsonBody(req,4096);}catch(error){if(error instanceof RequestBodyError)return json({error:error.message},error.status);return json({error:"Invalid request"},400);}
  const question=typeof body.question==="string"?body.question.trim():"";
  const requestId=typeof body.request_id==="string"?body.request_id:"";
  if(question.length<3||question.length>1000)return json({error:"Question must be between 3 and 1,000 characters"},400);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))return json({error:"Invalid request identifier"},400);
  const db=adminClient();
  const now=new Date(),start=new Date(now.getTime()-30*86400000);
  const [operations,onboarding,segments,campaigns,campaignIntelligence,incidents,business,profit,finance,markup,pnl,forecast]=await Promise.all([
    db.rpc("provider_operations_report"),
    db.rpc("admin_onboarding_funnel_report",{p_start:start.toISOString(),p_end:now.toISOString(),p_platform:null,p_app_version:null,p_country_code:null,p_network_type:null,p_acquisition_source:null}),
    Promise.all(SEGMENTS.map(async segment=>{const {data}=await db.rpc("marketing_segment_members",{p_segment:segment,p_inactivity_days:30});return {segment,count:data?.length??0};})),
    db.from("marketing_campaigns").select("status").gte("created_at",start.toISOString()).limit(100),
    db.rpc("ai_campaign_intelligence_report",{p_inactivity_days:30}),
    db.from("monitoring_alerts").select("fingerprint,alert_type,severity,details,occurrence_count,first_seen_at,last_seen_at,status,incident_analysis").in("status",["open","acknowledged"]).order("last_seen_at",{ascending:false}).limit(20),
    db.rpc("admin_business_intelligence_report",{p_start:start.toISOString(),p_end:now.toISOString()}),
    db.rpc("admin_profit_report",{p_start:start.toISOString(),p_end:now.toISOString()}),
    db.rpc("admin_provider_finance_report",{p_start:start.toISOString(),p_end:now.toISOString()}),
    db.rpc("admin_markup_commission_report",{p_start:start.toISOString(),p_end:now.toISOString()}),
    db.rpc("admin_consolidated_pnl_report",{p_start:start.toISOString(),p_end:now.toISOString()}),
    db.rpc("admin_financial_forecast_report",{p_as_of:now.toISOString()}),
  ]);
  if(operations.error||onboarding.error||campaigns.error||campaignIntelligence.error||incidents.error||business.error||profit.error||finance.error||markup.error||pnl.error||forecast.error)return json({error:"Could not prepare the sanitized operations summary"},500);
  const report=onboarding.data??{};
  const campaignStatusCounts=(campaigns.data??[]).reduce((counts:Record<string,number>,item:{status?:string})=>{const status=String(item.status??"unknown");counts[status]=(counts[status]??0)+1;return counts;},{});
  const context=compactContext({generated_at:now.toISOString(),window:"last_30_days",operations:operations.data,active_incidents:incidents.data,business_intelligence:{...(business.data??{}),profit:profit.data,provider_finance:finance.data,markup_commission:markup.data,consolidated_pnl:pnl.data,financial_forecast:forecast.data},onboarding:{cohort:report.cohort,conversion:report.conversion,stages:report.stages,timing:report.timing,stuck:report.stuck,failures:Array.isArray(report.failures)?report.failures.slice(0,10):[]},campaign_intelligence:campaignIntelligence.data,campaign_status_counts:campaignStatusCounts});
  try{
    const result=await askGroq(question,context);
    let campaign=null;
    const wantsCampaign=/\b(create|prepare|write|design|draft|generate|make|build)\b[\s\S]{0,80}\b(campaign|email|outreach|message)\b|\b(campaign|email|outreach)\b[\s\S]{0,80}\b(create|prepare|write|design|draft|generate|make|build)\b/i.test(question);
    if(wantsCampaign){
      const intelligenceSegments=Array.isArray(campaignIntelligence.data?.segments)?campaignIntelligence.data.segments:[];
      const aiSegments=intelligenceSegments.map((item:{segment:string;consent_eligible:number})=>({segment:item.segment,count:Number(item.consent_eligible??0),intelligence:item}));
      if(!aiSegments.some((item:{count:number})=>item.count>0)){
        const notice="No campaign was created because there are currently no consent-eligible recipients. Customers must have a verified email, explicit marketing consent, and no active suppression before they can receive a campaign.";
        return json({success:true,...result,answer:{...result.answer,answer:notice},campaign:null,campaign_notice:notice});
      }
      const generated=await draftCampaignWithGroq(question,aiSegments.filter((item:{count:number})=>item.count>0));
      const renderSegments=aiSegments.map((item:{segment:string;count:number})=>({segment:item.segment as CampaignSegment,count:item.count}));
      const draft=generateCampaignDraft(renderSegments,question,generated.copy);
      const {data:created,error:createError}=await db.from("marketing_campaigns").insert({name:draft.name,subject:draft.subject,html_body:draft.htmlBody,text_body:draft.textBody,segment:draft.segment,inactivity_days:draft.inactivityDays,created_by:admin.userId,ai_request_id:requestId}).select("id").single();
      if(createError)throw createError;
      campaign={id:created.id,...draft,model:generated.model,status:"draft"};
    }
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(question)))).map(v=>v.toString(16).padStart(2,"0")).join("");
    await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:campaign?"ai_campaign_draft_created":"ai_operations_question_asked",target_type:campaign?"marketing_campaign":"operations",target_id:campaign?.id??null,metadata:{model:result.model,question_hash:digest,usage_limit:"provider_managed",created_campaign:!!campaign}});
    return json({success:true,...result,campaign});
  }catch(error){
    const code=error instanceof GroqProviderError?error.code:"provider_unavailable";
    const providerStatus=error instanceof GroqProviderError?error.status:null;
    console.error("admin-ai-assistant failed",{code,provider_status:providerStatus,action:"no_action_taken"});
    const message=code==="rate_limited"?"Groq's current usage limit has been reached. Please retry after the provider resets the limit.":code==="timed_out"?"The AI request timed out before Groq responded. Please try again.":code==="invalid_response"?"Groq returned an incomplete response. Please try the question again.":code==="authentication_failed"?"Groq rejected the configured API key. Replace the GROQ_API_KEY Supabase secret and try again.":code==="model_unavailable"?"The configured Groq model is unavailable. The model configuration needs to be updated.":code==="request_rejected"?"Groq rejected the AI request format. The model request configuration needs to be updated.":"The AI provider is temporarily unavailable. No action was taken.";
    return json({error:message,error_code:code,provider_status:providerStatus},["authentication_failed","model_unavailable","request_rejected"].includes(code)?400:503);
  }
});
