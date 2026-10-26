// Painel do dono da plataforma: lojas-clientes, mensalidades e acesso.
// Disponível somente nos hosts da plataforma (PLATFORM_HOSTS / painel.PLATFORM_DOMAIN).
import path from 'node:path';
import { supabase, audit, dbError } from './cloud.mjs';
import {
  randomToken, sha256, constantEq, hashPassword, verifyPassword, validatePassword,
  encryptSecret, decryptSecret, newTotpSecret, verifyTotp, otpauthUri, cleanText, cleanMultiline, safeInt
} from './security.mjs';
import {
  isPlatformHost, billingState, storeUrl, todayBR, addDays, addMonths, clearStoreCache,
  SLUG_RE, DOMAIN_RE, RESERVED_SLUGS, STORE_COLUMNS, platformDomain
} from './tenant.mjs';

const ISSUER = 'Plataforma numismática';
const DEFAULT_HERO = 'Catálogo numismático com estoque controlado no servidor. O pedido é registrado com os preços vigentes e confirmado por atendimento.';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function reaisToCents(value) {
  const raw = String(value ?? '').trim().replace(/\s/g, '').replace(/^R\$/i, '');
  if (!raw) return 0;
  let n = raw;
  if (raw.includes(',') && raw.includes('.')) n = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  else if (raw.includes(',')) n = raw.replace(',', '.');
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0 || v > 1_000_000) throw new Error('Valor inválido.');
  return Math.round(v * 100);
}
function cleanDate(value, fallback) {
  const v = String(value || '').trim();
  if (!v) return fallback;
  if (!DATE_RE.test(v) || Number.isNaN(new Date(v + 'T12:00:00Z').getTime())) throw new Error('Data inválida.');
  return v;
}
function cleanDomain(value) {
  let v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!DOMAIN_RE.test(v)) throw new Error('Domínio inválido. Exemplo: lojadojoao.com.br');
  if (platformDomain && (v === platformDomain || v.endsWith('.' + platformDomain))) throw new Error('Use o campo "endereço" para subdomínios da plataforma.');
  return v;
}
function validateStore(body, { partial = false } = {}) {
  const out = {};
  if (!partial || 'name' in body) {
    out.name = cleanText(body.name, 120);
    if (out.name.length < 2) throw new Error('Informe o nome da loja.');
  }
  if (!partial || 'slug' in body) {
    out.slug = cleanText(body.slug, 40).toLowerCase();
    if (!SLUG_RE.test(out.slug)) throw new Error('Endereço inválido: use letras minúsculas, números e hífen (ex.: loja-do-joao).');
    if (RESERVED_SLUGS.has(out.slug)) throw new Error('Este endereço é reservado. Escolha outro.');
  }
  if (!partial || 'custom_domain' in body) out.custom_domain = cleanDomain(body.custom_domain);
  for (const [k, max] of [['owner_name', 120], ['owner_email', 180], ['owner_phone', 40], ['document', 30], ['plan_name', 60]])
    if (!partial || k in body) out[k] = cleanText(body[k], max) || null;
  if (out.plan_name === null) out.plan_name = 'Mensal';
  if (!partial || 'notes' in body) out.notes = cleanMultiline(body.notes, 2000) || null;
  if (!partial || 'monthly_price_reais' in body) out.monthly_price_cents = reaisToCents(body.monthly_price_reais);
  if (!partial || 'paid_until' in body) out.paid_until = cleanDate(body.paid_until, addMonths(todayBR(), 1));
  if (!partial || 'grace_days' in body) out.grace_days = safeInt(body.grace_days ?? 5, 0, 60);
  if ('status' in body) {
    if (!['active', 'suspended', 'cancelled'].includes(body.status)) throw new Error('Situação inválida.');
    out.status = body.status;
  }
  return out;
}
function friendlyDbError(error, fallback) {
  const msg = String(error?.message || '') + ' ' + String(error?.details || '');
  if (error?.code === '23505' && msg.includes('slug')) return new Error('Já existe uma loja com esse endereço.');
  if (error?.code === '23505' && msg.includes('custom_domain')) return new Error('Esse domínio já está em uso por outra loja.');
  return dbError(error, fallback);
}

export function registerPlatformRoutes(app, deps) {
  const { publicDir, privateDir, authLimiter, clientMeta, loadPlatformSession, ensurePlatformSession, platformCsrf, destroySession, rotateSession } = deps;
  const platformAudit = (req, entry) => audit({ platformUserId: req.platformUser?.id || null, ...clientMeta(req), ...entry, action: 'platform.' + entry.action });

  const onlyPlatformHost = (req, res, next) => isPlatformHost(req.hostname) ? next() : res.status(404).json({ error: 'Endpoint não encontrado.' });
  app.use(['/api/platform', '/plataforma'], onlyPlatformHost, loadPlatformSession);

  async function platformUserFor(req, res) {
    const s = req.platformSession;
    if (!s || s.auth_stage !== 'authenticated' || !s.platform_user_id) return null;
    const { data: user, error } = await supabase.from('platform_users').select('id,email,active').eq('id', s.platform_user_id).maybeSingle();
    if (error) throw dbError(error);
    if (!user || !user.active) { await destroySession(req, res, 'platform'); return null; }
    return user;
  }
  async function requirePlatform(req, res, next) {
    try {
      req.platformUser = await platformUserFor(req, res);
      if (!req.platformUser) return res.status(401).json({ error: 'Autenticação necessária.' });
      next();
    } catch (e) { next(e); }
  }
  async function pageAuth(req, res, next) {
    try {
      req.platformUser = await platformUserFor(req, res);
      if (!req.platformUser) return res.redirect(302, '/plataforma/entrar');
      next();
    } catch (e) { next(e); }
  }

  // ----- Páginas -----
  app.get('/plataforma/entrar', (req, res) => res.sendFile(path.join(publicDir, 'plataforma-entrar.html')));
  app.get('/plataforma', pageAuth, (req, res) => res.sendFile(path.join(privateDir, 'plataforma.html')));
  app.get('/plataforma/plataforma.js', pageAuth, (req, res) => res.sendFile(path.join(privateDir, 'plataforma.js')));

  // ----- Instalação e login -----
  app.get('/api/platform/csrf', ensurePlatformSession, (req, res) => res.json({ csrfToken: req.platformSession.csrf_token }));
  async function platformUserCount() {
    const { count, error } = await supabase.from('platform_users').select('id', { count: 'exact', head: true });
    if (error) throw dbError(error, 'Execute primeiro supabase/migrate-multi-loja.sql.');
    return Number(count || 0);
  }
  app.get('/api/platform/setup/status', async (req, res, next) => { try { res.json({ setupRequired: !(await platformUserCount()) }); } catch (e) { next(e); } });
  app.post('/api/platform/setup', authLimiter, ensurePlatformSession, platformCsrf, async (req, res, next) => {
    try {
      if (await platformUserCount()) return res.status(409).json({ error: 'A plataforma já possui administrador.' });
      const expected = String(process.env.PLATFORM_SETUP_TOKEN || process.env.SETUP_TOKEN || '');
      if (expected.length < 24 || !constantEq(sha256(expected), sha256(String(req.get('x-setup-token') || '')))) return res.status(403).json({ error: 'Token de instalação inválido.' });
      const email = cleanText(req.body?.email, 180).toLowerCase(), password = String(req.body?.password || '');
      if (!email.includes('@')) return res.status(400).json({ error: 'E-mail inválido.' });
      const errors = validatePassword(password); if (errors.length) return res.status(400).json({ error: 'Senha deve conter ' + errors.join(', ') + '.' });
      const secret = newTotpSecret(), t = Date.now();
      const { data: user, error } = await supabase.from('platform_users').insert({ email, password_hash: await hashPassword(password), totp_secret_enc: encryptSecret(secret), totp_enabled: true, created_at: t, updated_at: t }).select('id').single();
      if (error) throw dbError(error, 'Não foi possível criar o administrador da plataforma.');
      await audit({ platformUserId: user.id, action: 'platform.setup', ...clientMeta(req) });
      res.status(201).json({ ok: true, secret, otpauthUri: otpauthUri(secret, email, ISSUER) });
    } catch (e) { next(e); }
  });

  app.post('/api/platform/auth/login', authLimiter, ensurePlatformSession, platformCsrf, async (req, res, next) => {
    try {
      const email = cleanText(req.body?.email, 180).toLowerCase(), password = String(req.body?.password || ''), t = Date.now();
      const { data: user, error } = await supabase.from('platform_users').select('*').ilike('email', email).maybeSingle(); if (error) throw dbError(error);
      const fakeHash = '$argon2id$v=19$m=65536,t=3,p=1$QnJvd25Gb3hKdW1wczEyMzQ1Ng$X+J1u9wR98K6A/pxvO7h2H4Rx9DioalK4ss0JvQ8fWw';
      const usable = !!user && user.active !== false;
      if (usable && user.locked_until > t) return res.status(429).json({ error: 'Conta temporariamente bloqueada.' });
      const ok = await verifyPassword(usable ? user.password_hash : fakeHash, password);
      if (!usable || !ok) {
        if (usable) { const fails = Number(user.failed_logins || 0) + 1, lock = fails >= 5 ? t + 15 * 60_000 : 0; await supabase.from('platform_users').update({ failed_logins: lock ? 0 : fails, locked_until: lock, updated_at: t }).eq('id', user.id); }
        await audit({ platformUserId: user?.id || null, action: 'platform.login_failed', ...clientMeta(req) });
        return res.status(401).json({ error: 'Credenciais inválidas.' });
      }
      await supabase.from('platform_users').update({ failed_logins: 0, locked_until: 0, updated_at: t }).eq('id', user.id);
      await rotateSession(req, res, { scope: 'platform', userId: user.id, stage: 'password' });
      res.json({ requires2fa: true, csrfToken: req.platformSession.csrf_token });
    } catch (e) { next(e); }
  });
  app.post('/api/platform/auth/2fa', authLimiter, ensurePlatformSession, platformCsrf, async (req, res, next) => {
    try {
      const s = req.platformSession;
      if (s.auth_stage !== 'password' || !s.platform_user_id) return res.status(401).json({ error: 'Faça login primeiro.' });
      const { data: user, error } = await supabase.from('platform_users').select('*').eq('id', s.platform_user_id).maybeSingle(); if (error) throw dbError(error);
      if (!user || !user.active || !user.totp_secret_enc) return res.status(401).json({ error: '2FA indisponível.' });
      if (!verifyTotp(decryptSecret(user.totp_secret_enc), req.body?.code)) { await audit({ platformUserId: user.id, action: 'platform.2fa_failed', ...clientMeta(req) }); return res.status(401).json({ error: 'Código 2FA inválido.' }); }
      const t = Date.now(); await supabase.from('platform_users').update({ last_login_at: t, updated_at: t }).eq('id', user.id);
      await rotateSession(req, res, { scope: 'platform', userId: user.id, stage: 'authenticated' });
      await audit({ platformUserId: user.id, action: 'platform.login_success', ...clientMeta(req) });
      res.json({ ok: true, csrfToken: req.platformSession.csrf_token });
    } catch (e) { next(e); }
  });
  app.post('/api/platform/auth/logout', ensurePlatformSession, platformCsrf, async (req, res, next) => {
    try { await destroySession(req, res, 'platform'); res.json({ ok: true }); } catch (e) { next(e); }
  });
  app.get('/api/platform/me', requirePlatform, (req, res) => res.json({ user: req.platformUser, csrfToken: req.platformSession.csrf_token, platformDomain }));

  // ----- Lojas -----
  async function loadStores() {
    const [{ data: stores, error }, { data: stats, error: statsErr }] = await Promise.all([
      supabase.from('stores').select(STORE_COLUMNS).order('created_at', { ascending: true }),
      supabase.from('platform_store_stats').select('*')
    ]);
    if (error) throw dbError(error); if (statsErr) throw dbError(statsErr);
    const byId = new Map((stats || []).map(s => [Number(s.store_id), s]));
    const today = todayBR();
    return (stores || []).map(s => ({ ...s, state: billingState(s, today), url: storeUrl(s), stats: byId.get(Number(s.id)) || {} }));
  }

  app.get('/api/platform/overview', requirePlatform, async (req, res, next) => {
    try {
      const stores = await loadStores();
      const today = todayBR(), monthStart = today.slice(0, 8) + '01', in7 = addDays(today, 7);
      const { data: pays, error } = await supabase.from('store_payments').select('amount_cents').gte('paid_at', monthStart);
      if (error) throw dbError(error);
      const count = st => stores.filter(s => s.state === st).length;
      const billable = stores.filter(s => ['active', 'due', 'overdue'].includes(s.state));
      res.json({
        today,
        totals: {
          stores: stores.length, active: count('active'), due: count('due'), overdue: count('overdue'),
          suspended: count('suspended'), cancelled: count('cancelled'),
          mrr_cents: billable.reduce((a, s) => a + Number(s.monthly_price_cents || 0), 0),
          received_month_cents: (pays || []).reduce((a, p) => a + Number(p.amount_cents || 0), 0),
          due_soon: billable.filter(s => s.state === 'active' && s.paid_until <= in7).length
        },
        stores
      });
    } catch (e) { next(e); }
  });

  app.post('/api/platform/stores', requirePlatform, platformCsrf, async (req, res) => {
    try {
      const data = validateStore(req.body || {});
      const token = randomToken(24), t = Date.now();
      const { data: store, error } = await supabase.from('stores').insert({ ...data, status: 'active', setup_token_hash: sha256(token), created_at: t, updated_at: t }).select(STORE_COLUMNS).single();
      if (error) throw friendlyDbError(error, 'Não foi possível criar a loja.');
      const { error: setErr } = await supabase.from('settings').insert([
        { store_id: store.id, key: 'brand', value: store.name, updated_at: t },
        { store_id: store.id, key: 'hero_description', value: DEFAULT_HERO, updated_at: t }
      ]);
      if (setErr) console.error('Falha ao criar configurações iniciais da loja', store.id, setErr.message);
      clearStoreCache();
      await platformAudit(req, { action: 'store_created', entity: 'store', entityId: store.id, details: { slug: store.slug, name: store.name } });
      const url = storeUrl(store);
      res.status(201).json({ store: { ...store, url, state: billingState(store) }, setupToken: token, setupUrl: url ? url + '/setup' : '' });
    } catch (e) { console.error('Falha ao criar loja:', e?.cause || e); res.status(400).json({ error: e.message || 'Não foi possível criar a loja.' }); }
  });

  app.put('/api/platform/stores/:id', requirePlatform, platformCsrf, async (req, res) => {
    try {
      const id = safeInt(req.params.id, 1, 2_000_000_000);
      const data = validateStore(req.body || {}, { partial: true });
      if (Number(id) === 1 && data.slug && data.slug !== 'principal' && !process.env.DEFAULT_STORE_SLUG) throw new Error('O endereço da loja principal não pode ser alterado.');
      const { data: store, error } = await supabase.from('stores').update({ ...data, updated_at: Date.now() }).eq('id', id).select(STORE_COLUMNS).maybeSingle();
      if (error) throw friendlyDbError(error, 'Não foi possível salvar a loja.');
      if (!store) return res.status(404).json({ error: 'Loja não encontrada.' });
      clearStoreCache();
      await platformAudit(req, { action: 'store_updated', entity: 'store', entityId: id, details: { fields: Object.keys(data) } });
      res.json({ store: { ...store, url: storeUrl(store), state: billingState(store) } });
    } catch (e) { console.error('Falha ao salvar loja:', e?.cause || e); res.status(400).json({ error: e.message || 'Não foi possível salvar a loja.' }); }
  });

  // Novo token de instalação: só enquanto a loja ainda não tem administrador.
  app.post('/api/platform/stores/:id/setup-token', requirePlatform, platformCsrf, async (req, res, next) => {
    try {
      const id = safeInt(req.params.id, 1, 2_000_000_000);
      const { data: store, error } = await supabase.from('stores').select(STORE_COLUMNS).eq('id', id).maybeSingle();
      if (error) throw dbError(error); if (!store) return res.status(404).json({ error: 'Loja não encontrada.' });
      const { count, error: cErr } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('store_id', id);
      if (cErr) throw dbError(cErr);
      if (count) return res.status(409).json({ error: 'Esta loja já tem administrador. O dono deve entrar pelo /login da loja.' });
      const token = randomToken(24);
      await supabase.from('stores').update({ setup_token_hash: sha256(token), updated_at: Date.now() }).eq('id', id);
      await platformAudit(req, { action: 'store_setup_token', entity: 'store', entityId: id });
      const url = storeUrl(store);
      res.json({ setupToken: token, setupUrl: url ? url + '/setup' : '' });
    } catch (e) { next(e); }
  });

  // ----- Mensalidades -----
  app.get('/api/platform/stores/:id/payments', requirePlatform, async (req, res, next) => {
    try {
      const id = safeInt(req.params.id, 1, 2_000_000_000);
      const { data, error } = await supabase.from('store_payments').select('*').eq('store_id', id).order('paid_at', { ascending: false }).order('id', { ascending: false }).limit(200);
      if (error) throw dbError(error); res.json(data || []);
    } catch (e) { next(e); }
  });
  app.post('/api/platform/stores/:id/payments', requirePlatform, platformCsrf, async (req, res) => {
    try {
      const id = safeInt(req.params.id, 1, 2_000_000_000);
      const { data: store, error } = await supabase.from('stores').select(STORE_COLUMNS).eq('id', id).maybeSingle();
      if (error) throw dbError(error); if (!store) return res.status(404).json({ error: 'Loja não encontrada.' });
      const months = safeInt(req.body?.months ?? 1, 1, 36);
      const amount = 'amount_reais' in (req.body || {}) && String(req.body.amount_reais).trim() !== '' ? reaisToCents(req.body.amount_reais) : Number(store.monthly_price_cents) * months;
      const paidAt = cleanDate(req.body?.paid_at, todayBR());
      const previous = String(store.paid_until).slice(0, 10), next = addMonths(previous, months), t = Date.now();
      // Atualização condicional evita estender duas vezes em cliques duplos.
      const { data: updated, error: upErr } = await supabase.from('stores').update({ paid_until: next, updated_at: t }).eq('id', id).eq('paid_until', previous).select('id').maybeSingle();
      if (upErr) throw dbError(upErr); if (!updated) return res.status(409).json({ error: 'O vencimento desta loja mudou. Atualize a página e tente novamente.' });
      const { data: pay, error: payErr } = await supabase.from('store_payments').insert({
        store_id: id, amount_cents: amount, paid_at: paidAt, months, method: cleanText(req.body?.method, 40) || null, note: cleanText(req.body?.note, 300) || null,
        previous_paid_until: previous, new_paid_until: next, created_by: req.platformUser.id, created_at: t
      }).select('*').single();
      if (payErr) { await supabase.from('stores').update({ paid_until: previous }).eq('id', id); throw dbError(payErr, 'Não foi possível registrar o pagamento.'); }
      clearStoreCache();
      await platformAudit(req, { action: 'payment_registered', entity: 'store', entityId: id, details: { amount, months, next } });
      res.status(201).json({ payment: pay, paid_until: next });
    } catch (e) { console.error('Falha ao registrar pagamento:', e?.cause || e); res.status(400).json({ error: e.message || 'Não foi possível registrar o pagamento.' }); }
  });
}
