'use strict';
let csrf = '', platformDomain = '', stores = [], paymentStore = null;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const money = c => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((Number(c) || 0) / 100);
const reais = c => ((Number(c) || 0) / 100).toFixed(2).replace('.', ',');
const brDate = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—';
const brDateTime = ms => ms ? new Date(Number(ms)).toLocaleDateString('pt-BR') : '—';
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

const STATE = {
  active: ['Em dia', 'active'],
  due: ['Vencida — tolerância', 'due'],
  overdue: ['Bloqueada por atraso', 'overdue'],
  suspended: ['Suspensa', 'suspended'],
  cancelled: ['Cancelada', 'cancelled']
};

async function api(url, opt = {}) {
  const r = await fetch(url, { cache: 'no-store', ...opt, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/plataforma/entrar'; throw new Error('Sessão encerrada.'); }
  if (!r.ok) throw new Error(j.error || 'Falha na operação.');
  return j;
}

function addMonthsISO(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 12)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
function slugify(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}
function storeAddress(s) {
  if (s.url) return s.url.replace(/^https?:\/\//, '');
  return platformDomain ? `${s.slug}.${platformDomain}` : s.slug;
}

// ---------------------------------------------------------------------------
// Visão geral
// ---------------------------------------------------------------------------
async function loadOverview() {
  const o = await api('/api/platform/overview');
  stores = o.stores;
  const t = o.totals;
  $('#kpiOnline').textContent = t.active + t.due;
  $('#kpiOnlineSub').textContent = `${t.stores} loja(s) cadastrada(s)`;
  $('#kpiDue').textContent = t.due;
  $('#kpiDueSoon').textContent = `${t.due_soon} vence(m) nos próximos 7 dias`;
  $('#kpiBlocked').textContent = t.overdue + t.suspended;
  $('#kpiMrr').textContent = money(t.mrr_cents);
  $('#kpiReceived').textContent = `Recebido este mês: ${money(t.received_month_cents)}`;
  renderStores();
}

function renderStores() {
  const q = $('#search').value.trim().toLowerCase(), st = $('#stateFilter').value;
  const rows = stores.filter(s => (!st || s.state === st) &&
    (!q || [s.name, s.slug, s.custom_domain, s.owner_name, s.owner_email, s.owner_phone, s.document].filter(Boolean).join(' ').toLowerCase().includes(q)));
  const box = $('#storeList');
  if (!rows.length) { box.innerHTML = `<p class="muted">${stores.length ? 'Nenhuma loja encontrada com esses filtros.' : 'Nenhuma loja cadastrada ainda. Clique em “+ Nova loja”.'}</p>`; return; }
  box.innerHTML = `<table class="table platform-table"><thead><tr><th>Loja</th><th>Dono</th><th>Plano</th><th>Vencimento</th><th>Uso</th><th>Ações</th></tr></thead><tbody>${rows.map(s => {
    const [label, cls] = STATE[s.state] || [s.state, ''];
    const stats = s.stats || {};
    const addr = storeAddress(s);
    return `<tr>
      <td><strong>${esc(s.name)}</strong><div class="muted">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(addr)}</a>` : esc(addr)}</div></td>
      <td>${esc(s.owner_name || '—')}<div class="muted">${esc([s.owner_email, s.owner_phone].filter(Boolean).join(' · '))}</div></td>
      <td>${esc(s.plan_name || '—')}<div class="muted">${money(s.monthly_price_cents)}/mês</div></td>
      <td>${brDate(s.paid_until)}<div><span class="state-badge ${cls}">${label}</span></div></td>
      <td><span class="muted">${Number(stats.active_products || 0)} peças · ${Number(stats.orders || 0)} pedidos</span><div class="muted">${Number(stats.admins || 0) ? 'Último acesso: ' + brDateTime(stats.last_admin_login_at) : '<b class="text-warn">Dono ainda não configurou o acesso</b>'}</div></td>
      <td><div class="product-actions">
        <button class="btn primary" type="button" data-pay="${s.id}">Pagamento</button>
        <button class="btn" type="button" data-edit="${s.id}">Editar</button>
        ${Number(stats.admins || 0) ? '' : `<button class="btn" type="button" data-token="${s.id}">Novo token</button>`}
      </div></td>
    </tr>`;
  }).join('')}</tbody></table>`;
  box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openStore(stores.find(s => String(s.id) === b.dataset.edit)));
  box.querySelectorAll('[data-pay]').forEach(b => b.onclick = () => openPayments(stores.find(s => String(s.id) === b.dataset.pay)));
  box.querySelectorAll('[data-token]').forEach(b => b.onclick = () => newToken(b.dataset.token));
}

// ---------------------------------------------------------------------------
// Cadastro / edição de loja
// ---------------------------------------------------------------------------
let slugTouched = false;
function updateSlugPreview() {
  const slug = $('#storeSlug').value.trim();
  $('#slugPreview').textContent = slug ? (platformDomain ? `Endereço: ${slug}.${platformDomain}` : 'Defina PLATFORM_DOMAIN no Render para usar subdomínios.') : '';
}
function openStore(store = null) {
  const s = store || {};
  slugTouched = !!store;
  $('#storeDialogTitle').textContent = store ? `Editar: ${store.name}` : 'Nova loja';
  $('#storeId').value = s.id || '';
  $('#storeName').value = s.name || '';
  $('#storeSlug').value = s.slug || '';
  $('#storeDomain').value = s.custom_domain || '';
  $('#storeStatus').value = s.status || 'active';
  $('#storeStatus').closest('.field').hidden = !store;
  $('#ownerName').value = s.owner_name || '';
  $('#ownerDocument').value = s.document || '';
  $('#ownerEmail').value = s.owner_email || '';
  $('#ownerPhone').value = s.owner_phone || '';
  $('#planName').value = s.plan_name || 'Mensal';
  $('#monthlyPrice').value = store ? reais(s.monthly_price_cents) : '';
  $('#paidUntil').value = s.paid_until ? String(s.paid_until).slice(0, 10) : addMonthsISO(todayISO(), 1);
  $('#graceDays').value = s.grace_days ?? 5;
  $('#storeNotes').value = s.notes || '';
  $('#storeStatusMsg').textContent = '';
  updateSlugPreview();
  $('#storeDialog').showModal();
  $('#storeName').focus();
}
$('#storeName').addEventListener('input', () => { if (!slugTouched) { $('#storeSlug').value = slugify($('#storeName').value); updateSlugPreview(); } });
$('#storeSlug').addEventListener('input', () => { slugTouched = true; $('#storeSlug').value = $('#storeSlug').value.toLowerCase().replace(/[^a-z0-9-]/g, ''); updateSlugPreview(); });

$('#storeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('#storeId').value;
  const body = {
    name: $('#storeName').value, slug: $('#storeSlug').value, custom_domain: $('#storeDomain').value,
    owner_name: $('#ownerName').value, document: $('#ownerDocument').value, owner_email: $('#ownerEmail').value, owner_phone: $('#ownerPhone').value,
    plan_name: $('#planName').value, monthly_price_reais: $('#monthlyPrice').value, paid_until: $('#paidUntil').value,
    grace_days: $('#graceDays').value, notes: $('#storeNotes').value
  };
  if (id) body.status = $('#storeStatus').value;
  if (id && body.status !== 'active' && !confirm('A loja ficará FORA DO AR para os clientes dela. Confirmar?')) return;
  $('#storeStatusMsg').textContent = 'Salvando…';
  try {
    if (id) {
      await api('/api/platform/stores/' + id, { method: 'PUT', body: JSON.stringify(body) });
      $('#storeDialog').close();
    } else {
      const j = await api('/api/platform/stores', { method: 'POST', body: JSON.stringify(body) });
      $('#storeDialog').close();
      showToken(j.store, j.setupUrl, j.setupToken);
    }
    await loadOverview();
  } catch (err) { $('#storeStatusMsg').textContent = err.message; }
});

// ---------------------------------------------------------------------------
// Token de instalação
// ---------------------------------------------------------------------------
let tokenMessage = '';
function showToken(store, url, token) {
  $('#tokenUrl').value = url || '(defina PLATFORM_DOMAIN ou um domínio próprio para a loja)';
  $('#tokenValue').value = token;
  $('#tokenStatus').textContent = '';
  tokenMessage = `Olá${store.owner_name ? ', ' + store.owner_name : ''}! Sua loja "${store.name}" está pronta.\n\n` +
    `1) Acesse: ${url || '(endereço da loja)/setup'}\n2) Informe o token de instalação: ${token}\n` +
    `3) Crie seu e-mail e uma senha forte (14+ caracteres, maiúscula, minúscula, número e símbolo).\n` +
    `4) Cadastre a chave mostrada no Google Authenticator.\n\nDepois, o painel da loja fica em ${url ? url.replace(/\/setup$/, '/login') : '/login'}.`;
  $('#tokenDialog').showModal();
}
$('#copyToken').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(tokenMessage); $('#tokenStatus').textContent = 'Mensagem copiada. Cole no WhatsApp ou e-mail do cliente.'; }
  catch { $('#tokenStatus').textContent = 'Não foi possível copiar automaticamente. Selecione e copie os campos acima.'; }
});
async function newToken(id) {
  const store = stores.find(s => String(s.id) === String(id));
  if (!confirm(`Gerar um novo token de instalação para "${store.name}"? O token anterior deixa de funcionar.`)) return;
  try { const j = await api(`/api/platform/stores/${id}/setup-token`, { method: 'POST' }); showToken(store, j.setupUrl, j.setupToken); }
  catch (err) { alert(err.message); }
}

// ---------------------------------------------------------------------------
// Pagamentos
// ---------------------------------------------------------------------------
function updatePayPreview() {
  if (!paymentStore) return;
  const months = Math.max(1, Math.min(36, Number($('#payMonths').value) || 1));
  $('#payPreview').textContent = `Novo vencimento: ${brDate(addMonthsISO(String(paymentStore.paid_until).slice(0, 10), months))}`;
}
async function openPayments(store) {
  paymentStore = store;
  $('#paymentTitle').textContent = `Pagamentos: ${store.name}`;
  const [label] = STATE[store.state] || [store.state];
  $('#paymentInfo').textContent = `Mensalidade ${money(store.monthly_price_cents)} · pago até ${brDate(store.paid_until)} · ${label}`;
  $('#payMonths').value = 1;
  $('#payAmount').value = reais(store.monthly_price_cents);
  $('#payDate').value = todayISO();
  $('#payNote').value = '';
  $('#payStatus').textContent = '';
  updatePayPreview();
  $('#paymentList').innerHTML = '<p class="muted">Carregando…</p>';
  $('#paymentDialog').showModal();
  await loadPayments();
}
async function loadPayments() {
  const list = await api(`/api/platform/stores/${paymentStore.id}/payments`);
  $('#paymentList').innerHTML = list.length
    ? `<table class="table"><thead><tr><th>Data</th><th>Valor</th><th>Meses</th><th>Forma</th><th>Vencimento</th><th>Obs.</th></tr></thead><tbody>${list.map(p =>
        `<tr><td>${brDate(p.paid_at)}</td><td>${money(p.amount_cents)}</td><td>${p.months}</td><td>${esc(p.method || '—')}</td><td>${brDate(p.previous_paid_until)} → ${brDate(p.new_paid_until)}</td><td>${esc(p.note || '')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nenhum pagamento registrado.</p>';
}
$('#payMonths').addEventListener('input', () => {
  const months = Math.max(1, Math.min(36, Number($('#payMonths').value) || 1));
  $('#payAmount').value = reais(Number(paymentStore.monthly_price_cents) * months);
  updatePayPreview();
});
$('#paymentForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#payStatus').textContent = 'Registrando…';
  try {
    const j = await api(`/api/platform/stores/${paymentStore.id}/payments`, { method: 'POST', body: JSON.stringify({
      months: $('#payMonths').value, amount_reais: $('#payAmount').value, paid_at: $('#payDate').value, method: $('#payMethod').value, note: $('#payNote').value
    }) });
    paymentStore = { ...paymentStore, paid_until: j.paid_until };
    $('#payStatus').textContent = `Pagamento registrado. Pago até ${brDate(j.paid_until)}.`;
    await Promise.all([loadPayments(), loadOverview()]);
    paymentStore = stores.find(s => s.id === paymentStore.id) || paymentStore;
    const [label] = STATE[paymentStore.state] || [paymentStore.state];
    $('#paymentInfo').textContent = `Mensalidade ${money(paymentStore.monthly_price_cents)} · pago até ${brDate(paymentStore.paid_until)} · ${label}`;
    updatePayPreview();
  } catch (err) { $('#payStatus').textContent = err.message; }
});

// ---------------------------------------------------------------------------
document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
$('#newStore').addEventListener('click', () => openStore());
$('#search').addEventListener('input', renderStores);
$('#stateFilter').addEventListener('change', renderStores);
$('#logout').addEventListener('click', async () => {
  try { await api('/api/platform/auth/logout', { method: 'POST' }); } catch {}
  location.href = '/plataforma/entrar';
});

(async () => {
  const me = await api('/api/platform/me');
  csrf = me.csrfToken; platformDomain = me.platformDomain || '';
  await loadOverview();
})().catch(err => { $('#storeList').innerHTML = `<p class="status">${esc(err.message)}</p>`; });
