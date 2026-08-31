import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";

const WEBHOOK_SECRET=Deno.env.get("RESEND_WEBHOOK_SECRET")??"";
const EVENTS=new Set(["email.sent","email.delivered","email.delivery_delayed","email.bounced","email.failed","email.suppressed","email.complained","email.opened","email.clicked"]);
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});

function decodeBase64(value:string):Uint8Array{
  const binary=atob(value);return Uint8Array.from(binary,ch=>ch.charCodeAt(0));
}
function equal(a:Uint8Array,b:Uint8Array):boolean{
  if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
async function verify(raw:string,id:string,timestamp:string,signature:string):Promise<boolean>{
  if(!WEBHOOK_SECRET.startsWith("whsec_")||!id||!/^\d{10}$/.test(timestamp)||!signature)return false;
  const seconds=Number(timestamp);if(!Number.isFinite(seconds)||Math.abs(Date.now()/1000-seconds)>300)return false;
  try{
    const key=await crypto.subtle.importKey("raw",decodeBase64(WEBHOOK_SECRET.slice(6)),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const expected=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${id}.${timestamp}.${raw}`)));
    return signature.split(" ").some(part=>{const [version,value]=part.split(",",2);if(version!=="v1"||!value)return false;try{return equal(expected,decodeBase64(value));}catch{return false;}});
  }catch{return false;}
}

serve(async(req)=>{
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  if(!WEBHOOK_SECRET)return json({error:"Webhook is not configured"},503);
  const raw=await req.text();
  if(raw.length>100_000)return json({error:"Payload too large"},413);
  const id=req.headers.get("svix-id")??"",timestamp=req.headers.get("svix-timestamp")??"",signature=req.headers.get("svix-signature")??"";
  if(!await verify(raw,id,timestamp,signature))return json({error:"Invalid signature"},400);
  let payload:{type?:string;created_at?:string;data?:{email_id?:string}};
  try{payload=JSON.parse(raw);}catch{return json({error:"Invalid payload"},400);}
  const eventType=payload.type??"",messageId=payload.data?.email_id??"",createdAt=new Date(payload.created_at??"");
  if(!EVENTS.has(eventType)||!/^[0-9a-z-]{8,128}$/i.test(messageId)||Number.isNaN(createdAt.getTime()))return json({error:"Unsupported payload"},400);
  const {error}=await adminClient().rpc("record_marketing_email_event",{p_svix_id:id,p_message_id:messageId,p_event_type:eventType,p_event_created_at:createdAt.toISOString()});
  if(error)return json({error:"Event could not be recorded"},500);
  return json({received:true});
});
