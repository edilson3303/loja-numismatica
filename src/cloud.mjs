import { createClient } from '@supabase/supabase-js';

const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/,'');
const key = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '');
if (!url || !/^https:\/\//.test(url)) throw new Error('SUPABASE_URL ausente ou inválida.');
if (!key) throw new Error('SUPABASE_SECRET_KEY ausente (ou SUPABASE_SERVICE_ROLE_KEY legado).');

export const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || 'product-images';
export const supabaseUrl = url;
export const supabase = createClient(url, key, {
  auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false },
  global: { headers: { 'X-Client-Info':'loja-numismatica-server/3.0' } }
});

export function dbError(error, fallback='Falha no banco de dados.') {
  if (!error) return null;
  console.error('Supabase:', error.code || '', error.message || error);
  const e = new Error(fallback);
  e.cause = error;
  return e;
}

export function publicMediaUrl(objectName) {
  const safe = String(objectName || '');
  if (!/^[A-Za-z0-9_-]{10,120}\.webp$/.test(safe)) return null;
  return `${url}/storage/v1/object/public/${encodeURIComponent(storageBucket)}/${encodeURIComponent(safe)}`;
}

export async function audit({userId=null, action, entity=null, entityId=null, ipHash=null, uaHash=null, details=null}) {
  try {
    await supabase.from('audit_logs').insert({
      user_id:userId, action, entity, entity_id:entityId==null?null:String(entityId),
      ip_hash:ipHash, ua_hash:uaHash, details_json:details||null, created_at:Date.now()
    });
  } catch (err) { console.error('Falha ao gravar auditoria:', err); }
}
