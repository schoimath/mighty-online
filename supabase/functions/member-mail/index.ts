import nodemailer from 'npm:nodemailer@10.6.1';
import {createMailWorker} from './worker.js';

const url = Deno.env.get('SUPABASE_URL');
const key = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
async function rpc(name: string, args: object) {
  const headers: Record<string,string> = {apikey:key,'Content-Type':'application/json'};
  if (!key.startsWith('sb_secret_')) headers.Authorization='Bearer '+key;
  const response = await fetch(url+'/rest/v1/rpc/'+name,{method:'POST',headers,
    body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(8000)});
  if (!response.ok) throw Object.assign(new Error('Mail operation failed'),{status:response.status});
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}
Deno.serve(createMailWorker({
  getContext:(token: string) => rpc('mighty_mail_worker_context',{p_token:token}), rpc,
  connect:(sender: {sender:string,password:string}|null) => nodemailer.createTransport({
    host:'smtp.gmail.com',port:465,secure:true,auth:sender?{user:sender.sender,pass:sender.password}:undefined,
    connectionTimeout:8000,greetingTimeout:8000,socketTimeout:12000,
    tls:{minVersion:'TLSv1.2'},logger:false,debug:false
  })
}));
