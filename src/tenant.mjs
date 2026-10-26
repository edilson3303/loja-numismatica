// Identificação da loja pelo endereço acessado (multi-lojas).
//
// Ordem de resolução do host:
//   1. domínio próprio da loja (stores.custom_domain), com ou sem "www.";
//   2. subdomínio da plataforma: <slug>.PLATFORM_DOMAIN;
//   3. hosts da loja padrão (DEFAULT_STORE_HOSTS, padrão: host de BASE_URL).
import { supabase, dbError } from './cloud.mjs';

const isProd = process.env.NODE_ENV === 'production';
const localHosts = isProd ? [] : ['localhost', '127.0.0.1'];
const list = v => String(v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const hostOf = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };

export const platformDomain = String(process.env.PLATFORM_DOMAIN || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
const baseHost = hostOf(process.env.BASE_URL || '');
const defaultSlug = String(process.env.DEFAULT_STORE_SLUG || 'principal').toLowerCase();
const defaultStoreHosts = new Set(list(process.env.DEFAULT_STORE_HOSTS || baseHost));
const platformHosts = new Set([
  ...list(process.env.PLATFORM_HOSTS || baseHost),
  ...(platformDomain ? [platformDomain, 'painel.' + platformDomain] : []),
  ...localHosts
]);

// Subdomínios que nunca podem virar loja.
export const RESERVED_SLUGS = new Set(['www', 'painel', 'admin', 'api', 'app', 'plataforma', 'mail', 'email', 'smtp', 'ftp', 'cdn', 'static', 'suporte', 'help', 'status', 'blog']);

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const STORE_COLUMNS = 'id,slug,name,custom_domain,owner_name,owner_email,owner_phone,document,status,plan_name,monthly_price_cents,paid_until,grace_days,notes,created_at,updated_at';

export function isPlatformHost(host) { return platformHosts.has(String(host || '').toLowerCase()); }

export function storeUrl(store) {
  if (store.custom_domain) return `https://${store.custom_domain}`;
  if (platformDomain) return `https://${store.slug}.${platformDomain}`;
  if (store.slug === defaultSlug && process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  return '';
}

// Data de hoje no fuso de Brasília, formato AAAA-MM-DD.
export function todayBR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(isoDate, months) {
  const [y, m, day] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

// Situação comercial da loja.
//   active    — em dia
//   due       — venceu, mas ainda está dentro da tolerância
//   overdue   — passou da tolerância: loja bloqueada
//   suspended — suspensa manualmente
//   cancelled — cancelada
export function billingState(store, today = todayBR()) {
  if (store.status === 'suspended') return 'suspended';
  if (store.status === 'cancelled') return 'cancelled';
  const paidUntil = String(store.paid_until || '').slice(0, 10);
  if (!paidUntil || paidUntil >= today) return 'active';
  return addDays(paidUntil, Number(store.grace_days || 0)) >= today ? 'due' : 'overdue';
}

export function isStoreOpen(store) {
  const state = billingState(store);
  return state === 'active' || state === 'due';
}

const cache = new Map();
const CACHE_MS = 30_000;
export function clearStoreCache() { cache.clear(); }

async function findStore(host) {
  const bare = host.startsWith('www.') ? host.slice(4) : host;
  const domains = [...new Set([host, bare])];
  let { data, error } = await supabase.from('stores').select(STORE_COLUMNS).in('custom_domain', domains).limit(1).maybeSingle();
  if (error) throw dbError(error);
  if (data) return data;

  if (platformDomain && bare.endsWith('.' + platformDomain)) {
    const slug = bare.slice(0, -(platformDomain.length + 1));
    if (SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug)) {
      ({ data, error } = await supabase.from('stores').select(STORE_COLUMNS).eq('slug', slug).maybeSingle());
      if (error) throw dbError(error);
      if (data) return data;
    }
  }

  if (defaultStoreHosts.has(host) || defaultStoreHosts.has(bare) || localHosts.includes(host)) {
    ({ data, error } = await supabase.from('stores').select(STORE_COLUMNS).eq('slug', defaultSlug).maybeSingle());
    if (error) throw dbError(error);
    if (data) return data;
  }
  return null;
}

export async function storeForHost(host) {
  const key = String(host || '').toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.store;
  const store = await findStore(key);
  cache.set(key, { store, at: Date.now() });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return store;
}

// Fotos novas recebem o prefixo "s<id>-". Fotos antigas (sem prefixo) pertencem à loja 1.
const LEGACY_STORE_ID = 1;
export function mediaPrefix(storeId) { return `s${storeId}-`; }
export function mediaBelongsToStore(objectName, storeId) {
  const m = String(objectName || '').match(/^s(\d+)-/);
  return m ? Number(m[1]) === Number(storeId) : Number(storeId) === LEGACY_STORE_ID;
}
