import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders(),"Content-Type":"application/json"}});
serve(async(req)=>{const cors=handleCors(req);if(cors)return cors;if(req.method!=="GET")return json({error:"Method not allowed"},405);let admin;try{admin=await requireAdmin(req,"support");}catch(error){if(error instanceof AdminAuthError)return json({error:error.message},error.status);return json({error:"Unauthorized"},401);}const db=adminClient();const {data,error}=await db.rpc("provider_operations_report");if(error)return json({error:"Could not load operations report"},500);await db.from("admin_actions").insert({admin_user_id:admin.userId,action_type:"operations_report_viewed",target_type:"operations"});return json({success:true,report:data});});
