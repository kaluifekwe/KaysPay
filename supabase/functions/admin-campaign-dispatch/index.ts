import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders(),"Content-Type":"application/json"}});
const esc=(value:string)=>value.replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]!));

serve(async(req)=>{
  const cors=handleCors(req);if(cors)return cors;
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  let admin;try{admin=await requireAdmin(req,"super_admin");}catch(error){if(error instanceof AdminAuthError)return json({error:error.message},error.status);return json({error:"Unauthorized"},401);}
  if(!isResendConfigured())return json({error:"Email provider is not configured"},503);
  let body:Record<string,unknown>;try{body=await req.json();}catch{return json({error:"Invalid JSON"},400);}
  const id=typeof body.campaign_id==="string"?body.campaign_id:"";
  if(!/^[0-9a-f-]{36}$/i.test(id))return json({error:"Invalid campaign"},400);
  const db=adminClient();
  const {data:batch,error}=await db.rpc("claim_marketing_campaign_batch",{p_campaign_id:id,p_limit:20});
  if(error)return json({error:"Campaign is not approved, is paused, or is scheduled for later"},409);
  if(!batch?.length){
    const {count}=await db.from("marketing_campaign_recipients").select("user_id",{count:"exact",head:true}).eq("campaign_id",id).in("status",["pending","failed","sending"]);
    if(!count)await db.from("marketing_campaigns").update({status:"sent",updated_at:new Date().toISOString()}).eq("id",id).in("status",["approved","sending"]);
    return json({success:true,processed:0,remaining:count??0});
  }
  let sent=0,failed=0;
  const base=Deno.env.get("SUPABASE_URL")??"";
  for(const row of batch){
    const unsubscribe=`${base}/functions/v1/marketing-unsubscribe?token=${encodeURIComponent(row.unsubscribe_token)}`;
    const html=`${row.html_body}<hr><p style="font-size:12px;color:#667085">You received this because you opted in to KaysPay updates. <a href="${esc(unsubscribe)}">Unsubscribe</a>.</p>`;
    const text=`${row.text_body}\n\nUnsubscribe: ${unsubscribe}`;
    const result=await sendEmail(row.email,row.subject,html,{text});
    await db.from("marketing_campaign_recipients").update(result.ok?{status:"sent",sent_at:new Date().toISOString(),failure_code:null,updated_at:new Date().toISOString()}:{status:"failed",failure_code:"provider_error",updated_at:new Date().toISOString()}).eq("campaign_id",id).eq("user_id",row.user_id).eq("status","sending");
    result.ok?sent++:failed++;
  }
  await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:"marketing_campaign_batch_dispatched",target_type:"marketing_campaign",target_id:id,metadata:{sent,failed}});
  return json({success:true,processed:batch.length,sent,failed,run_again:true});
});
