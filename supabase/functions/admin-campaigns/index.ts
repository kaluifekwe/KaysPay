import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { CampaignSegment, generateCampaignDraft } from "../_shared/campaign-assistant.ts";
import { draftCampaignWithGroq, isGroqConfigured } from "../_shared/groq-client.ts";

const SEGMENTS = new Set(["registered_not_verified","verified_kyc_incomplete","kyc_completed_not_funded","funded_not_purchased","inactive"]);
const json = (body: unknown,status=200) => new Response(JSON.stringify(body),{status,headers:{...corsHeaders(),"Content-Type":"application/json"}});
const clean = (value: unknown,max: number) => typeof value === "string" ? value.trim().slice(0,max) : "";
// Creator/promo code, e.g. "JOHN10" -- readable and typeable by a customer,
// case-insensitive at the database level (promo_codes_code_unique index).
const PROMO_CODE_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

serve(async (req) => {
  const cors=handleCors(req); if(cors) return cors;
  let admin;
  try { admin=await requireAdmin(req,req.method==="POST"?"super_admin":"support"); }
  catch(error){ if(error instanceof AdminAuthError)return json({error:error.message},error.status); return json({error:"Unauthorized"},401); }
  const db=adminClient();

  // Creator promo codes -- a second, unrelated admin surface folded into
  // this same function to stay under Supabase's 100-function project cap
  // (same reason the wallet-correction debit was folded into admin-refund).
  // Kept behind its own ?resource= query param so the existing campaigns GET
  // below is completely unaffected when this isn't present.
  if(req.method==="GET" && new URL(req.url).searchParams.get("resource")==="promo_codes"){
    const {data,error}=await db.rpc("admin_list_promo_codes");
    if(error)return json({error:"Could not load promo codes"},500);
    return json({success:true,promo_codes:data});
  }

  if(req.method==="GET"){
    const [{data:campaigns,error},segments]=await Promise.all([
      db.from("marketing_campaigns").select("id,name,subject,segment,inactivity_days,status,scheduled_for,created_at,approved_at,marketing_campaign_recipients(status,delivered_at,bounced_at,opened_at,clicked_at,complained_at,delivery_delayed_at)").order("created_at",{ascending:false}).limit(100),
      Promise.all([...SEGMENTS].map(async segment=>{const {data}=await db.rpc("marketing_segment_members",{p_segment:segment,p_inactivity_days:30});return {segment,count:data?.length??0};})),
    ]);
    if(error)return json({error:"Could not load campaigns"},500);
    await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:"marketing_campaigns_viewed",target_type:"marketing"});
    return json({success:true,campaigns,segments});
  }
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  let body:Record<string,unknown>; try{body=await req.json();}catch{return json({error:"Invalid JSON"},400);}
  const action=body.action;
  if(action==="create_promo_code"){
    const code=clean(body.code,32).toUpperCase();
    const creatorName=clean(body.creator_name,80);
    if(!PROMO_CODE_PATTERN.test(code))return json({error:"Code must be 3-32 letters, numbers, - or _"},400);
    if(creatorName.length<2)return json({error:"Enter the creator's name"},400);
    const {data,error}=await db.from("promo_codes").insert({code,creator_name:creatorName,created_by:admin.userId}).select("id").single();
    if(error){
      const message=error.message?.includes("promo_codes_code_unique")?"That code is already in use.":"Could not create the code";
      return json({error:message},error.message?.includes("promo_codes_code_unique")?409:500);
    }
    await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:"promo_code_created",target_type:"promo_codes",target_id:data.id,metadata:{code,creator_name:creatorName}});
    return json({success:true,id:data.id},201);
  }
  if(action==="toggle_promo_code"){
    const id=clean(body.id,40); const active=body.active===true;
    if(!/^[0-9a-f-]{36}$/i.test(id))return json({error:"Invalid code"},400);
    const {data,error}=await db.from("promo_codes").update({active}).eq("id",id).select("code").maybeSingle();
    if(error||!data)return json({error:"Could not update the code"},500);
    await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:active?"promo_code_activated":"promo_code_deactivated",target_type:"promo_codes",target_id:id,metadata:{code:data.code}});
    return json({success:true});
  }
  if(action==="generate"){
    const prompt=clean(body.prompt,1000);
    const insights=await Promise.all([...SEGMENTS].map(async rawSegment=>{
      const segment=rawSegment as CampaignSegment;
      const {data,error}=await db.rpc("marketing_segment_members",{p_segment:segment,p_inactivity_days:30});
      if(error)throw error;
      return {segment,count:data?.length??0};
    })).catch(()=>null);
    if(!insights)return json({error:"Could not analyze eligible customer segments"},500);
    if(!insights.some(item=>item.count>0))return json({error:"No campaign was created because there are currently no consent-eligible recipients."},409);
    let aiModel="kayspay-private-engine";
    let draft=generateCampaignDraft(insights,prompt);
    if(isGroqConfigured()){
      try{const generated=await draftCampaignWithGroq(prompt,insights.filter(item=>item.count>0));draft=generateCampaignDraft(insights,prompt,generated.copy);aiModel=generated.model;}catch{/* The controlled private engine remains the safe availability fallback. */}
    }
    if(draft.audienceCount<1)return json({error:"The selected audience has no consent-eligible recipients. Choose a segment with eligible customers."},409);
    const {data,error}=await db.from("marketing_campaigns").insert({
      name:draft.name,subject:draft.subject,html_body:draft.htmlBody,text_body:draft.textBody,
      segment:draft.segment,inactivity_days:draft.inactivityDays,created_by:admin.userId,
    }).select("id").single();
    if(error)return json({error:"Could not save the generated campaign"},500);
    await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:"marketing_campaign_ai_generated",target_type:"marketing_campaign",target_id:data.id,metadata:{segment:draft.segment,audience_count:draft.audienceCount,prompt_supplied:prompt.length>0,model:aiModel}});
    return json({success:true,campaign:{id:data.id,...draft,model:aiModel}},201);
  }
  if(action==="test"){
    const subject=clean(body.subject,150),htmlBody=clean(body.html_body,50000),textBody=clean(body.text_body,20000);
    if(!admin.email||subject.length<3||htmlBody.length<10||textBody.length<10)return json({error:"Complete the subject and both message formats first"},400);
    if(!isResendConfigured())return json({error:"Email provider is not configured"},503);
    const result=await sendEmail(admin.email,`[TEST] ${subject}`,htmlBody,{text:textBody});
    if(!result.ok)return json({error:"Test email could not be delivered"},502);
    await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:"marketing_campaign_test_sent",target_type:"marketing"});
    return json({success:true});
  }
  if(action==="create"){
    const name=clean(body.name,120),subject=clean(body.subject,150),htmlBody=clean(body.html_body,50000),textBody=clean(body.text_body,20000),segment=clean(body.segment,40);
    const inactivityDays=segment==="inactive"?Number(body.inactivity_days):null;
    const scheduledFor=body.scheduled_for?new Date(String(body.scheduled_for)):null;
    if(name.length<3||subject.length<3||htmlBody.length<10||textBody.length<10||!SEGMENTS.has(segment))return json({error:"Invalid campaign fields"},400);
    if(segment==="inactive"&&(!Number.isInteger(inactivityDays)||inactivityDays!<1||inactivityDays!>365))return json({error:"Invalid inactivity period"},400);
    if(scheduledFor&&Number.isNaN(scheduledFor.getTime()))return json({error:"Invalid schedule"},400);
    const {data,error}=await db.from("marketing_campaigns").insert({name,subject,html_body:htmlBody,text_body:textBody,segment,inactivity_days:inactivityDays,scheduled_for:scheduledFor?.toISOString()??null,created_by:admin.userId}).select("id").single();
    if(error)return json({error:"Could not create campaign"},500);
    await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:"marketing_campaign_created",target_type:"marketing_campaign",target_id:data.id,metadata:{segment,scheduled:!!scheduledFor}});
    return json({success:true,id:data.id},201);
  }
  const id=clean(body.campaign_id,40); if(!/^[0-9a-f-]{36}$/i.test(id))return json({error:"Invalid campaign"},400);
  if(action==="approve"){
    const {data,error}=await db.rpc("approve_marketing_campaign",{p_campaign_id:id,p_admin_id:admin.userId});
    if(error){
      const message=error.message.includes("NO_ELIGIBLE_RECIPIENTS")
        ?"This campaign has no consent-eligible recipients and cannot be approved."
        :"Campaign must be an unapproved draft";
      return json({error:message},409);
    }
    await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:"marketing_campaign_approved",target_type:"marketing_campaign",target_id:id,metadata:{eligible_recipients:data}});
    return json({success:true,recipients:data});
  }
  if(action==="pause"||action==="cancel"){
    const status=action==="pause"?"paused":"cancelled";
    const {data,error}=await db.from("marketing_campaigns").update({status,updated_at:new Date().toISOString()}).eq("id",id).in("status",["draft","approved","sending","paused"]).select("id").maybeSingle();
    if(error||!data)return json({error:"Campaign cannot be changed from its current state"},409);
    await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:`marketing_campaign_${status}`,target_type:"marketing_campaign",target_id:id});
    return json({success:true});
  }
  return json({error:"Unknown action"},400);
});
