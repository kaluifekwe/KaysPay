import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient,verifyCronSecret,withJobLock } from "../_shared/auth.ts";
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
serve(async req=>{
 if(!verifyCronSecret(req))return json({error:"Unauthorized"},401);
 const db=adminClient();
 const result=await withJobLock(db,"financial-forecast-monitor",async()=>{
  const now=new Date(),start=new Date(now.getTime()-30*86400000).toISOString();
  const [forecast,pnl,markup]=await Promise.all([db.rpc("admin_financial_forecast_report",{p_as_of:now.toISOString()}),db.rpc("admin_consolidated_pnl_report",{p_start:start,p_end:now.toISOString()}),db.rpc("admin_markup_commission_report",{p_start:start,p_end:now.toISOString()})]);
  if(forecast.error||pnl.error||markup.error)return {checked:false,error:"report_unavailable"};
  let alerts=0;
  for(const row of forecast.data?.providers??[]){
   if(row.days_remaining!==null&&Number(row.days_remaining)<=3){await db.rpc("record_monitoring_alert",{p_fingerprint:`financial_low_runway_${row.provider}`,p_type:"provider_low_financial_runway",p_severity:Number(row.days_remaining)<=1?"critical":"warning",p_details:{provider:row.provider,days_remaining:row.days_remaining,balance_kobo:row.balance_kobo,average_daily_spend_kobo:row.average_daily_spend_kobo}});alerts++;}
   if(row.unreconciled_kobo!==null&&Math.abs(Number(row.unreconciled_kobo))>=50000){await db.rpc("record_monitoring_alert",{p_fingerprint:`financial_unreconciled_${row.provider}`,p_type:"provider_finance_unreconciled",p_severity:"warning",p_details:{provider:row.provider,unreconciled_kobo:row.unreconciled_kobo,balance_recorded_at:row.balance_recorded_at}});alerts++;}
  }
  if(Number(pnl.data?.net_operating_profit_kobo)<0){await db.rpc("record_monitoring_alert",{p_fingerprint:"financial_negative_covered_pnl_30d",p_type:"negative_covered_operating_profit",p_severity:"warning",p_details:{window:"30_days",net_operating_profit_kobo:pnl.data.net_operating_profit_kobo,service_cost_coverage_percent:pnl.data.service_cost_coverage_percent,crypto_markup_coverage_percent:pnl.data.crypto_markup_coverage_percent}});alerts++;}
  if(Number(markup.data?.successful)>0&&Number(markup.data?.markup_coverage_percent)<100){await db.rpc("record_monitoring_alert",{p_fingerprint:"financial_crypto_markup_incomplete_30d",p_type:"crypto_markup_coverage_incomplete",p_severity:"warning",p_details:{window:"30_days",successful:markup.data.successful,markup_covered:markup.data.markup_covered,coverage_percent:markup.data.markup_coverage_percent}});alerts++;}
  return {checked:true,alerts};
 });
 return json(result);
});

