import {chipHandler} from './handler.js';

const key = (modern: string, legacy: string) =>
  JSON.parse(Deno.env.get(modern) || '{}').default || Deno.env.get(legacy);

Deno.serve(chipHandler({
  url:Deno.env.get('SUPABASE_URL'),
  publicKey:key('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'),
  serviceKey:key('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
}));
