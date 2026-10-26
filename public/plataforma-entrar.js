'use strict';
let csrf = '';
const $ = s => document.querySelector(s);
const show = (...ids) => ['#setupStep', '#setupResult', '#loginStep', '#twoStep'].forEach(id => $(id).classList.toggle('hidden', !ids.includes(id)));
const status = msg => { $('#status').textContent = msg || ''; };

async function api(url, opt = {}) {
  const r = await fetch(url, { cache: 'no-store', ...opt, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Falha na operação.');
  return j;
}

async function init() {
  try { await api('/api/platform/me'); location.href = '/plataforma'; return; } catch {}
  csrf = (await api('/api/platform/csrf')).csrfToken;
  const { setupRequired } = await api('/api/platform/setup/status');
  if (setupRequired) show('#setupStep'); else { show('#loginStep'); $('#email').focus(); }
}

$('#setupStep').addEventListener('submit', async e => {
  e.preventDefault(); status('');
  if ($('#setupPassword').value !== $('#setupConfirm').value) return status('As senhas não coincidem.');
  try {
    const j = await api('/api/platform/setup', {
      method: 'POST', headers: { 'x-setup-token': $('#setupToken').value },
      body: JSON.stringify({ email: $('#setupEmail').value, password: $('#setupPassword').value })
    });
    $('#setupSecret').value = j.secret;
    show('#setupResult');
    status('Administrador criado.');
  } catch (err) { status(err.message); }
});

$('#goLogin').addEventListener('click', () => { status(''); $('#email').value = $('#setupEmail').value; show('#loginStep'); $('#password').focus(); });

$('#loginStep').addEventListener('submit', async e => {
  e.preventDefault(); status('');
  try {
    const j = await api('/api/platform/auth/login', { method: 'POST', body: JSON.stringify({ email: $('#email').value, password: $('#password').value }) });
    csrf = j.csrfToken; show('#twoStep'); $('#code').focus();
  } catch (err) { status(err.message); }
});

$('#twoStep').addEventListener('submit', async e => {
  e.preventDefault(); status('');
  try {
    await api('/api/platform/auth/2fa', { method: 'POST', body: JSON.stringify({ code: $('#code').value }) });
    location.href = '/plataforma';
  } catch (err) { status(err.message); }
});

init().catch(err => status(err.message));
