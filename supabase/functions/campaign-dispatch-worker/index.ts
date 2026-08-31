import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
const esc=(value:string)=>value.replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]!));

serve(async(req)=>{
  if(!verifyCronSecret(req))return json({error:"Unauthorized"},401);
  if(!isResendConfigured())return json({error:"Email provider is not configured"},503);
  const db=adminClient();
  try{
    const result=await withJobLock(db,"marketing-campaign-dispatch",async()=>{
      const {data:campaigns,error}=await db.from("marketing_campaigns").select("id").in("status",["approved","sending"]).or(`scheduled_for.is.null,scheduled_for.lte.${new Date().toISOString()}`).order("approved_at").limit(5);
      if(error)throw error;
      let sent=0,failed=0,processed=0;
      for(const campaign of campaigns??[]){
        const {data:batch,error:claimError}=await db.rpc("claim_marketing_campaign_batch",{p_campaign_id:campaign.id,p_limit:20});
        if(claimError)continue;
        for(const row of batch??[]){
          const unsubscribe=`${Deno.env.get("SUPABASE_URL")}/functions/v1/marketing-unsubscribe?token=${encodeURIComponent(row.unsubscribe_token)}`;
          const html=`${row.html_body}<hr><p style="font-size:12px;color:#667085">You received this because you opted in to KaysPay updates. <a href="${esc(unsubscribe)}">Unsubscribe</a>.</p>`;
          const result=await sendEmail(row.email,row.subject,html,{
            text:`${row.text_body}\n\nUnsubscribe: ${unsubscribe}`,
            idempotencyKey:`campaign/${campaign.id}/${row.user_id}`,
          });
          await db.from("marketing_campaign_recipients").update(result.ok?{status:"sent",provider_message_id:result.id??null,sent_at:new Date().toISOString(),failure_code:null,updated_at:new Date().toISOString()}:{status:"failed",failure_code:"provider_error",updated_at:new Date().toISOString()}).eq("campaign_id",campaign.id).eq("user_id",row.user_id).eq("status","sending");
          processed++;result.ok?sent++:failed++;
        }
        const {data:remaining}=await db.from("marketing_campaign_recipients").select("status,attempts").eq("campaign_id",campaign.id).in("status",["pending","sending","failed"]);
        const actionable=(remaining??[]).filter(r=>r.status!=="failed"||r.attempts<5).length;
        if(actionable===0){
          const exhausted=(remaining??[]).some(r=>r.status==="failed"&&r.attempts>=5);
          await db.from("marketing_campaigns").update({status:exhausted?"failed":"sent",updated_at:new Date().toISOString()}).eq("id",campaign.id).in("status",["approved","sending"]);
        }
      }
      return {processed,sent,failed};
    });
    return json({success:true,...result});
  }catch(error){return json({error:"Campaign worker failed"},500);}
});
