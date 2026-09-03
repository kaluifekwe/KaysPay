import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { diagnoseIncidentWithGroq, isGroqConfigured } from "../_shared/groq-client.ts";

const ALERT_EMAIL=Deno.env.get("SECURITY_ALERT_EMAIL")||"kaluifekwe6@gmail.com";
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
serve(async(req)=>{
  if(!verifyCronSecret(req))return json({error:"Unauthorized"},401);
  const db=adminClient();
  try{
    const result=await withJobLock(db,"provider-health-monitor",async()=>{
      const {data,error}=await db.rpc("provider_operations_report");if(error)throw error;
      let alerts=0;
      for(const p of data.providers as Array<Record<string,unknown>>){
        const calls=Number(p.calls_15m||0),failures=Number(p.failures_15m||0),rate=Number(p.failure_rate_15m||0),latency=Number(p.avg_latency_15m||0);
        if(calls<3)continue;
        const critical=failures>=5&&rate>=50;const warning=failures>=3&&rate>=20||latency>=10000;
        if(!critical&&!warning)continue;
        const severity=critical?"critical":"warning",provider=String(p.provider),service=String(p.service);
        const {data:shouldEmail}=await db.rpc("record_monitoring_alert",{p_fingerprint:`provider_${provider}_${service}_health`,p_type:`Provider service degraded: ${provider} / ${service}`,p_severity:severity,p_details:{provider,service,calls_15m:calls,failures_15m:failures,failure_rate_15m:rate,avg_latency_15m:latency}});
        alerts++;
        if(shouldEmail&&provider!=="groq"&&isGroqConfigured())try{const diagnosis=await diagnoseIncidentWithGroq({provider,service,severity,calls_15m:calls,failures_15m:failures,failure_rate_15m:rate,avg_latency_15m:latency});await db.from("monitoring_alerts").update({incident_analysis:diagnosis.analysis,analysis_model:diagnosis.model,analysis_generated_at:new Date().toISOString()}).eq("fingerprint",`provider_${provider}_${service}_health`);}catch{/* Detection and alerts must not depend on AI availability. */}
        if(shouldEmail&&isResendConfigured())await sendEmail(ALERT_EMAIL,`[${severity.toUpperCase()}] KaysPay: ${provider} / ${service}`,`<p>${provider} – ${service} is degraded.</p><p>15-minute calls: ${calls}<br>Failures: ${failures}<br>Failure rate: ${rate}%<br>Average latency: ${latency}ms</p><p>No financial action was taken automatically.</p>`);
      }
      return {alerts};
    });return json({success:true,...result});
  }catch(e){
    // A real ~12-minute, 100%-failure-rate VTUNaija outage (2026-09-03)
    // crossed this monitor's own thresholds and it still never alerted --
    // the cron fired on schedule and the underlying data clearly qualified,
    // so something inside this try block silently threw and got swallowed
    // by the old bare catch. Self-monitor from here on: if this function
    // ever throws again, that failure becomes its own alert instead of
    // vanishing, so a future incident is caught even if this one's exact
    // cause couldn't be pinned down after the fact.
    const message=String((e as Error)?.message??e).slice(0,300);
    try{
      const {data:shouldEmail}=await db.rpc("record_monitoring_alert",{p_fingerprint:"provider_health_monitor_self_failure",p_type:"provider-health-monitor itself threw an exception",p_severity:"critical",p_details:{error:message}});
      if(shouldEmail&&isResendConfigured())await sendEmail(ALERT_EMAIL,"[CRITICAL] KaysPay: provider-health-monitor is broken",`<p>The provider-health monitor threw an exception and could not check anything this run.</p><p>Error: ${message}</p><p>Provider failures will NOT be detected automatically until this is fixed.</p>`);
    }catch{/* Even self-monitoring must not throw a second, masking exception. */}
    return json({error:"Provider monitor failed",detail:message},500);
  }
});
