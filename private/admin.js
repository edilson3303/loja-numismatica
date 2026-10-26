'use strict';
let csrf='', products=[], pendingImages=[], currentUser=null;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const money=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n/100);

async function api(url,opt={}){
  const headers={...(csrf?{'x-csrf-token':csrf}:{}),...(opt.headers||{})};
  if(!(opt.body instanceof FormData)) headers['content-type']='application/json';
  const r=await fetch(url,{cache:'no-store',...opt,headers});
  const j=await r.json().catch(()=>({}));
  if(r.status===401){location.href='/login';throw new Error('Sessão encerrada');}
  if(!r.ok) throw new Error(j.error||'Falha');
  return j;
}

async function init(){
  const me=await api('/api/auth/me'); csrf=me.csrfToken; currentUser=me.user;
  await Promise.all([loadProducts(),loadOrders(),loadAudit(),loadSettings(),loadAdmins()]);
}

document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.tabview').forEach(x=>x.classList.add('hidden'));
  $('#'+b.dataset.tab).classList.remove('hidden');
  document.querySelectorAll('[data-tab]').forEach(x=>x.classList.remove('primary'));
  b.classList.add('primary');
});

function adminDate(value){if(!value)return '—';const d=new Date(Number(value));return Number.isNaN(d.getTime())?'—':d.toLocaleString('pt-BR');}
async function loadAdmins(){
  const users=await api('/api/admin/users'),box=$('#adminList');if(!box)return;
  box.innerHTML=`<div class="admin-table-wrap"><table class="table admin-users-table"><thead><tr><th>Administrador</th><th>Status</th><th>2FA</th><th>Último acesso</th><th>Criado em</th><th>Ações</th></tr></thead><tbody>${users.map(u=>`<tr class="admin-user-row ${u.active?'is-active':'is-inactive'}"><td><strong>${esc(u.email)}</strong>${u.is_current?'<div class="muted">Você · sessão atual</div>':''}</td><td><span class="product-status-badge ${u.active?'active':'inactive'}">${u.active?'Ativo':'Desativado'}</span></td><td>${u.totp_enabled?'Ativo':'Pendente'}</td><td>${esc(adminDate(u.last_login_at))}</td><td>${esc(adminDate(u.created_at))}</td><td><div class="product-actions">${u.is_current?'<span class="muted">Conta atual protegida</span>':`<button class="btn toggle-admin ${u.active?'':'primary'}" type="button" data-id="${u.id}" data-active="${u.active?'1':'0'}">${u.active?'Desativar':'Ativar'}</button><button class="btn danger delete-admin" type="button" data-id="${u.id}" data-email="${esc(u.email)}">Excluir</button>`}</div></td></tr>`).join('')}</tbody></table></div>`;
  box.querySelectorAll('.toggle-admin').forEach(btn=>btn.onclick=async()=>{
    const adminPassword=$('#adminManagerPassword').value;if(!adminPassword){$('#adminStatus').textContent='Digite sua senha atual para autorizar a alteração.';return;}
    const active=btn.dataset.active!=='1';if(!confirm(`${active?'Ativar':'Desativar'} este administrador?${active?'':' As sessões dele serão encerradas imediatamente.'}`))return;
    try{await api('/api/admin/users/'+btn.dataset.id+'/active',{method:'PATCH',body:JSON.stringify({active,adminPassword})});$('#adminStatus').textContent=`Administrador ${active?'ativado':'desativado'} com sucesso.`;await Promise.all([loadAdmins(),loadAudit()]);}catch(e){$('#adminStatus').textContent=e.message;}
  });
  box.querySelectorAll('.delete-admin').forEach(btn=>btn.onclick=async()=>{
    const adminPassword=$('#adminManagerPassword').value;if(!adminPassword){$('#adminStatus').textContent='Digite sua senha atual para autorizar a exclusão.';return;}
    if(!confirm(`Excluir DEFINITIVAMENTE o administrador “${btn.dataset.email}”?\n\nEssa ação encerra todas as sessões dele e não pode ser desfeita.`))return;
    if(!confirm('Confirme novamente a exclusão desta conta administrativa.'))return;
    try{await api('/api/admin/users/'+btn.dataset.id,{method:'DELETE',body:JSON.stringify({adminPassword})});$('#adminStatus').textContent='Administrador excluído definitivamente.';await Promise.all([loadAdmins(),loadAudit()]);}catch(e){$('#adminStatus').textContent=e.message;}
  });
}

async function loadProducts(){
  products=await api('/api/admin/products');
  products.sort((a,b)=>Number(b.active===true)-Number(a.active===true)||String(a.name||'').localeCompare(String(b.name||''),'pt-BR',{sensitivity:'base'}));
  const box=$('#productList');
  box.innerHTML=`<div class="admin-table-wrap"><table class="table product-admin-table"><thead><tr><th>Peça</th><th>Status</th><th>Fotos</th><th>Preço</th><th>Estoque</th><th>Ações</th></tr></thead><tbody>${products.map(p=>`<tr class="product-admin-row ${p.active?'is-active':'is-inactive'}" data-id="${p.id}"><td>${esc(p.name)}<div class="muted">${esc(p.product_type_label||p.product_type||'Peça numismática')}${p.year?` · ${esc(p.year)}`:''}${p.origin?` · ${esc(p.origin)}`:''}</div></td><td><span class="product-status-badge ${p.active?'active':'inactive'}">${p.active?'Ativo':'Desativado'}</span></td><td>${p.images?.length||0}</td><td>${money(p.price_cents)}</td><td>${p.stock}</td><td><div class="product-actions"><button class="btn edit" data-id="${p.id}">Editar</button><button class="btn toggle-active ${p.active?'':'primary'}" data-id="${p.id}" data-active="${p.active?'1':'0'}">${p.active?'Desativar':'Ativar'}</button><button class="btn danger delete-product" data-id="${p.id}">Excluir</button></div></td></tr>`).join('')}</tbody></table></div>`;
  box.querySelectorAll('.edit').forEach(b=>b.onclick=()=>fill(products.find(p=>p.id==b.dataset.id)));
  box.querySelectorAll('.toggle-active').forEach(b=>b.onclick=async()=>{
    const activating=b.dataset.active!=='1';
    const verb=activating?'ativar':'desativar';
    if(!confirm(`Deseja ${verb} esta peça?`))return;
    try{
      await api('/api/admin/products/'+b.dataset.id+'/active',{method:'PATCH',body:JSON.stringify({active:activating})});
      $('#productStatus').textContent=`Peça ${activating?'ativada':'desativada'} com sucesso.`;
      await loadProducts();
    }catch(e){$('#productStatus').textContent=e.message;}
  });
  box.querySelectorAll('.delete-product').forEach(b=>b.onclick=async()=>{
    const p=products.find(x=>x.id==b.dataset.id);
    const label=p?.name?` “${p.name}”`:'';
    if(!confirm(`EXCLUIR DEFINITIVAMENTE a peça${label}?\n\nEssa ação não pode ser desfeita.`))return;
    if(!confirm('Confirme novamente: deseja realmente excluir este produto e suas fotos?'))return;
    try{
      await api('/api/admin/products/'+b.dataset.id,{method:'DELETE'});
      if($('#pid').value==b.dataset.id)clear();
      $('#productStatus').textContent='Produto excluído definitivamente.';
      await loadProducts();
    }catch(e){$('#productStatus').textContent=e.message;}
  });
}
function fill(p){
  for(const k of ['id','name','product_type','origin','year','era','metal','denomination','catalog_reference','weight','diameter','grade','stock','legend','description']){
    const id=k==='id'?'pid':k, el=$('#'+id); if(el) el.value=p[k]??'';
  }
  $('#price_reais').value=(Number(p.price_cents||0)/100).toFixed(2);
  $('#activeProduct').checked=p.active!==false;
  pendingImages=[...(p.images||[])]; renderAdminGallery();
  scrollTo({top:0,behavior:'smooth'});
}

function renderAdminGallery(){
  const box=$('#imageGalleryAdmin'); box.textContent='';
  if(!pendingImages.length){box.innerHTML='<div class="muted gallery-empty">Nenhuma foto adicionada.</div>';return;}
  pendingImages.forEach((src,i)=>{
    const item=document.createElement('div'); item.className='admin-photo';
    item.innerHTML=`<img src="${src}" alt="Foto ${i+1}"><div class="photo-label">${i===0?'CAPA':`Foto ${i+1}`}</div><div class="photo-actions"><button class="btn up" type="button" ${i===0?'disabled':''}>←</button><button class="btn down" type="button" ${i===pendingImages.length-1?'disabled':''}>→</button><button class="btn danger remove" type="button">Remover</button></div>`;
    item.querySelector('.up').onclick=()=>{[pendingImages[i-1],pendingImages[i]]=[pendingImages[i],pendingImages[i-1]];renderAdminGallery();};
    item.querySelector('.down').onclick=()=>{[pendingImages[i+1],pendingImages[i]]=[pendingImages[i],pendingImages[i+1]];renderAdminGallery();};
    item.querySelector('.remove').onclick=()=>{pendingImages.splice(i,1);renderAdminGallery();};
    box.append(item);
  });
}

function body(){
  return {name:$('#name').value,product_type:$('#product_type').value,origin:$('#origin').value,year:$('#year').value,era:$('#era').value,metal:$('#metal').value,denomination:$('#denomination').value,catalog_reference:$('#catalog_reference').value,weight:$('#weight').value,diameter:$('#diameter').value,grade:$('#grade').value,price_reais:$('#price_reais').value,stock:$('#stock').value,legend:$('#legend').value,description:$('#description').value,images:pendingImages,active:$('#activeProduct').checked};
}
function validateRequiredProductFields(){
  const required=[['#name','Nome / título da peça'],['#price_reais','Preço (Reais)'],['#stock','Estoque']];
  document.querySelectorAll('#products .required-field').forEach(x=>x.classList.remove('has-error'));
  for(const [sel,label] of required){
    const el=$(sel);
    const empty=String(el?.value??'').trim()==='';
    if(empty){el?.closest('.required-field')?.classList.add('has-error');el?.focus();throw new Error(`${label} é obrigatório.`);}
  }
  const price=Number($('#price_reais').value);
  if(!Number.isFinite(price)||price<0){$('#price_reais').closest('.required-field')?.classList.add('has-error');$('#price_reais').focus();throw new Error('Informe um preço válido em Reais.');}
  const stock=Number($('#stock').value);
  if(!Number.isInteger(stock)||stock<0){$('#stock').closest('.required-field')?.classList.add('has-error');$('#stock').focus();throw new Error('Informe um estoque inteiro igual ou maior que zero.');}
}

$('#saveProduct').onclick=async()=>{
  try{
    validateRequiredProductFields();
    const id=$('#pid').value;
    await api(id?'/api/admin/products/'+id:'/api/admin/products',{method:id?'PUT':'POST',body:JSON.stringify(body())});
    $('#productStatus').textContent='Salvo com '+pendingImages.length+' foto(s).'; clear(); await loadProducts();
  }catch(e){$('#productStatus').textContent=e.message;}
};

function clear(){
  document.querySelectorAll('#products input,#products textarea').forEach(x=>{if(x.type!=='file')x.value='';});
  $('#image').value=''; $('#cameraImage').value=''; $('#price_reais').value=''; $('#stock').value=1; $('#activeProduct').checked=true; $('#product_type').value='moeda'; $('#era').value='outro'; pendingImages=[]; renderAdminGallery();
}
$('#clearProduct').onclick=clear;

async function uploadPhotoFiles(input,sourceLabel='foto'){
  const files=[...input.files];
  if(!files.length)return;

  const room=12-pendingImages.length;
  if(room<=0){
    input.value='';
    $('#productStatus').textContent='O produto já possui o máximo de 12 fotos.';
    return;
  }

  const selected=files.slice(0,room);
  const ignored=files.length-selected.length;
  $('#upload').disabled=true;
  $('#takePhoto').disabled=true;
  $('#productStatus').textContent=`Enviando ${selected.length} ${sourceLabel}(s)...`;

  let sent=0;
  try{
    for(const f of selected){
      const fd=new FormData();
      fd.append('image',f);
      const j=await api('/api/admin/upload',{method:'POST',body:fd});
      pendingImages.push(j.path);
      sent++;
      renderAdminGallery();
      $('#productStatus').textContent=`Enviando fotos... ${sent}/${selected.length}`;
    }
    $('#productStatus').textContent=`${sent} foto(s) adicionada(s).${ignored?` ${ignored} ignorada(s) por causa do limite de 12.`:''} Salve a peça para confirmar a galeria.`;
  }catch(e){
    $('#productStatus').textContent=`${sent?`${sent} foto(s) enviada(s). `:''}${e.message}`;
  }finally{
    input.value='';
    $('#upload').disabled=false;
    $('#takePhoto').disabled=false;
  }
}

$('#upload').onclick=()=>{
  if(pendingImages.length>=12){
    $('#productStatus').textContent='O produto já possui o máximo de 12 fotos.';
    return;
  }
  $('#image').click();
};
$('#image').addEventListener('change',()=>uploadPhotoFiles($('#image'),'foto'));

$('#takePhoto').onclick=()=>{
  if(pendingImages.length>=12){
    $('#productStatus').textContent='O produto já possui o máximo de 12 fotos.';
    return;
  }
  $('#cameraImage').click();
};
$('#cameraImage').addEventListener('change',()=>uploadPhotoFiles($('#cameraImage'),'foto'));

async function loadOrders(){
  const rows=await api('/api/admin/orders');
  $('#orderList').innerHTML=`<table class="table"><thead><tr><th>Pedido</th><th>Cliente</th><th>Itens</th><th>Total</th><th>Status</th><th>Ações</th></tr></thead><tbody>${rows.map(o=>`<tr><td>${esc(o.public_id)}<div class="muted">${new Date(o.created_at).toLocaleString()}</div></td><td>${esc(o.customer_name)}<div class="muted">${esc(o.customer_phone||'')} ${esc(o.customer_email||'')}</div></td><td>${o.items.map(i=>`${esc(i.product_name)} × ${i.quantity}`).join('<br>')}</td><td>${money(o.total_cents)}</td><td><select class="orderStatus" data-id="${o.id}">${[['pending','Pendente'],['awaiting_payment','Aguardando pagamento'],['paid','Pago'],['confirmed','Confirmado'],['preparing','Em preparação'],['shipped','Enviado'],['delivered','Entregue'],['completed','Concluído'],['cancelled','Cancelado']].map(([value,label])=>`<option value="${value}" ${value===o.status?'selected':''}>${label}</option>`).join('')}</select></td><td><div class="order-actions"><a class="btn orderPdf" href="/api/admin/orders/${o.id}/pdf" target="_blank" rel="noopener">Gerar PDF</a></div></td></tr>`).join('')}</tbody></table>`;
  document.querySelectorAll('.orderStatus').forEach(s=>s.onchange=async()=>{try{await api('/api/admin/orders/'+s.dataset.id+'/status',{method:'PATCH',body:JSON.stringify({status:s.value})});await Promise.all([loadOrders(),loadProducts(),loadAudit()]);}catch(e){alert(e.message);await loadOrders();}});
}
async function loadAudit(){const rows=await api('/api/admin/audit');$('#auditList').innerHTML=`<table class="table"><thead><tr><th>Quando</th><th>Ação</th><th>Entidade</th><th>Detalhes</th></tr></thead><tbody>${rows.map(a=>`<tr><td>${new Date(a.created_at).toLocaleString()}</td><td>${esc(a.action)}</td><td>${esc(a.entity||'')} ${esc(a.entity_id||'')}</td><td><code>${esc(a.details_json||'')}</code></td></tr>`).join('')}</tbody></table>`;}
let logoPath='';
function renderLogoAdmin(){
  const box=$('#logoPreview'),img=$('#logoPreviewImg'),remove=$('#removeLogo');
  if(logoPath){img.src=logoPath;box.hidden=false;remove.disabled=false;}
  else{img.removeAttribute('src');box.hidden=true;remove.disabled=true;}
}
const richSelections=new Map();
const richColorSelections=new Map();
function rememberSelection(editor){
  const sel=getSelection(); if(!sel||!sel.rangeCount)return; const r=sel.getRangeAt(0); if(editor.contains(r.commonAncestorContainer))richSelections.set(editor.id,r.cloneRange());
}
function rememberColorSelection(editor){
  const sel=getSelection();
  if(!sel||!sel.rangeCount)return false;
  const r=sel.getRangeAt(0);
  if(r.collapsed||!editor.contains(r.commonAncestorContainer))return false;
  richColorSelections.set(editor.id,r.cloneRange());
  return true;
}
function restoreColorSelection(editor){
  const r=richColorSelections.get(editor.id);
  if(!r||r.collapsed)return false;
  editor.focus({preventScroll:true});
  const sel=getSelection();
  sel.removeAllRanges();
  sel.addRange(r.cloneRange());
  return true;
}
function restoreSelection(editor){
  const r=richSelections.get(editor.id);
  if(!r)return false;
  editor.focus({preventScroll:true});
  const sel=getSelection();
  sel.removeAllRanges();
  sel.addRange(r.cloneRange());
  return true;
}

function getSavedSelection(editor,{requireNonCollapsed=true}={}){
  let r=richSelections.get(editor.id);
  if(!r){
    const sel=getSelection();
    if(sel&&sel.rangeCount){
      const current=sel.getRangeAt(0);
      if(editor.contains(current.commonAncestorContainer))r=current.cloneRange();
    }
  }
  if(!r||!editor.contains(r.commonAncestorContainer)||(requireNonCollapsed&&r.collapsed))return null;
  return r.cloneRange();
}
function restoreSavedRange(editor,range){
  if(!range)return false;
  editor.focus({preventScroll:true});
  const sel=getSelection();
  if(!sel)return false;
  sel.removeAllRanges();
  sel.addRange(range);
  richSelections.set(editor.id,range.cloneRange());
  return true;
}
function wrapSavedSelection(editor,tagName,styleProp='',styleValue=''){
  const range=getSavedSelection(editor);
  if(!range){
    $('#settingsStatus').textContent='Selecione primeiro o trecho do texto que deseja formatar.';
    return false;
  }
  const wrapper=document.createElement(tagName);
  if(styleProp)wrapper.style[styleProp]=styleValue;
  const frag=range.extractContents();
  wrapper.appendChild(frag);
  range.insertNode(wrapper);
  const next=document.createRange();
  next.selectNodeContents(wrapper);
  restoreSavedRange(editor,next);
  rememberSelection(editor);
  rememberColorSelection(editor);
  return true;
}
function applyInlineStyle(editor,prop,value,{requireSelection=true}={}){
  if(!requireSelection){
    const r=getSavedSelection(editor,{requireNonCollapsed:false});
    if(r&&!r.collapsed)return wrapSavedSelection(editor,'span',prop,value);
  }
  return wrapSavedSelection(editor,'span',prop,value);
}
function applyInlineCommand(editor,cmd){
  const tags={bold:'strong',italic:'em',underline:'u'};
  const tag=tags[cmd];
  if(!tag)return false;
  const ok=wrapSavedSelection(editor,tag);
  if(ok)$('#settingsStatus').textContent='Formatação aplicada ao trecho selecionado. Clique em Salvar configurações para gravar.';
  return ok;
}
function clearSelectedFormatting(editor){
  const range=getSavedSelection(editor);
  if(!range){
    $('#settingsStatus').textContent='Selecione primeiro o trecho do texto cuja formatação deseja limpar.';
    return false;
  }
  const text=range.toString();
  if(!text)return false;
  range.deleteContents();
  const node=document.createTextNode(text);
  range.insertNode(node);
  const next=document.createRange();
  next.selectNodeContents(node);
  restoreSavedRange(editor,next);
  rememberSelection(editor);
  rememberColorSelection(editor);
  $('#settingsStatus').textContent='Formatação removida do trecho selecionado. Clique em Salvar configurações para gravar.';
  return true;
}
function ensureEditorStyleBlock(editor){
  let block=null;
  if(editor.childNodes.length===1 && editor.firstElementChild &&
     editor.firstElementChild.tagName==='SPAN' &&
     editor.firstElementChild.style.display==='block'){
    block=editor.firstElementChild;
  }
  if(!block){
    block=document.createElement('span');
    block.style.display='block';
    while(editor.firstChild)block.appendChild(editor.firstChild);
    editor.appendChild(block);
  }
  return block;
}
function applyAlignment(editor,align){
  if(!['left','center','right'].includes(align))return;

  /*
   * O alinhamento é uma propriedade do campo inteiro (título ou descrição).
   * Isso evita depender de uma seleção ativa, que era perdida ao clicar
   * nos botões da barra de ferramentas em alguns navegadores.
   * O <span> em bloco é permitido pelo sanitizador e, por isso, o
   * alinhamento também permanece salvo depois de recarregar a página.
   */
  const block=ensureEditorStyleBlock(editor);

  block.style.textAlign=align;
  editor.dataset.alignment=align;
  editor.focus({preventScroll:true});
  rememberSelection(editor);
}
function cleanEditorHtml(editor){
  editor.querySelectorAll('script,style,iframe,object,embed,link,meta,img,a').forEach(n=>n.remove());
  editor.querySelectorAll('*').forEach(el=>{[...el.attributes].forEach(a=>{if(a.name!=='style')el.removeAttribute(a.name);});});
  return editor.innerHTML.trim();
}
function initRichEditors(){
  document.querySelectorAll('[data-rich-editor]').forEach(box=>{
    const editor=$('#'+box.dataset.richEditor); if(!editor)return;
    ['keyup','mouseup','input'].forEach(ev=>editor.addEventListener(ev,()=>{rememberSelection(editor);rememberColorSelection(editor);}));
    editor.addEventListener('touchend',()=>{rememberSelection(editor);rememberColorSelection(editor);});
    editor.addEventListener('blur',()=>{});
    box.querySelectorAll('[data-cmd]').forEach(btn=>{
      btn.addEventListener('pointerdown',e=>{rememberSelection(editor);e.preventDefault();});
      btn.onclick=()=>applyInlineCommand(editor,btn.dataset.cmd);
    });
    box.querySelectorAll('[data-align]').forEach(btn=>{btn.addEventListener('mousedown',e=>e.preventDefault());btn.onclick=()=>{applyAlignment(editor,btn.dataset.align);box.querySelectorAll('[data-align]').forEach(b=>b.classList.toggle('is-active',b===btn));};});
    const size=box.querySelector('[data-font-size]');
    if(size){
      size.addEventListener('pointerdown',()=>rememberSelection(editor));
      size.onchange=()=>{
        if(size.value){
          const ok=applyInlineStyle(editor,'fontSize',size.value,{requireSelection:true});
          if(ok)$('#settingsStatus').textContent='Tamanho aplicado ao trecho selecionado. Clique em Salvar configurações para gravar.';
        }
        size.value='';
      };
    }
    const colorToggle=box.querySelector('[data-color-toggle]');
    const colorPalette=box.querySelector('[data-color-palette]');
    const customColor=box.querySelector('[data-text-color-custom]');
    const applyChosenColor=(value)=>{
      // Cor é aplicada exclusivamente ao trecho que o usuário selecionou.
      // A seleção é salva antes da paleta abrir para sobreviver a cliques/toques
      // na barra de ferramentas, inclusive no Safari/Chrome móvel.
      const saved=richColorSelections.get(editor.id);
      if(!saved || saved.collapsed){
        $('#settingsStatus').textContent='Selecione primeiro o trecho do texto que deseja colorir.';
        return false;
      }
      richSelections.set(editor.id,saved.cloneRange());
      const ok=applyInlineStyle(editor,'color',value,{requireSelection:true});
      if(!ok){
        $('#settingsStatus').textContent='Selecione novamente o trecho do texto e escolha a cor.';
      }else{
        rememberColorSelection(editor);
        $('#settingsStatus').textContent='Cor aplicada ao trecho selecionado. Clique em Salvar configurações para gravar.';
        if(colorToggle){
          const preview=colorToggle.querySelector('.editor-color-preview');
          if(preview)preview.style.background=value;
        }
      }
      return ok;
    };
    if(colorToggle && colorPalette){
      // Evita perder a seleção ao abrir a paleta e mostra as cores imediatamente.
      colorToggle.addEventListener('pointerdown',e=>{rememberColorSelection(editor);e.preventDefault();});
      const positionColorPalette=()=>{
        const r=colorToggle.getBoundingClientRect();
        const margin=8;
        const width=Math.min(190,window.innerWidth-margin*2);
        colorPalette.style.width=`${width}px`;
        colorPalette.hidden=false;
        const ph=colorPalette.offsetHeight||150;
        let left=r.left;
        if(left+width>window.innerWidth-margin)left=window.innerWidth-width-margin;
        if(left<margin)left=margin;
        let top=r.bottom+6;
        if(top+ph>window.innerHeight-margin && r.top-ph-6>=margin)top=r.top-ph-6;
        if(top<margin)top=margin;
        colorPalette.style.left=`${Math.round(left)}px`;
        colorPalette.style.top=`${Math.round(top)}px`;
      };
      colorToggle.onclick=()=>{
        const opening=colorPalette.hidden;
        document.querySelectorAll('[data-color-palette]').forEach(p=>{if(p!==colorPalette)p.hidden=true;});
        if(opening){
          positionColorPalette();
          colorToggle.setAttribute('aria-expanded','true');
        }else{
          colorPalette.hidden=true;
          colorToggle.setAttribute('aria-expanded','false');
        }
      };
      window.addEventListener('resize',()=>{if(!colorPalette.hidden)positionColorPalette();});
      window.addEventListener('scroll',()=>{if(!colorPalette.hidden)positionColorPalette();},{passive:true});
      colorPalette.querySelectorAll('[data-color]').forEach(btn=>{
        btn.addEventListener('pointerdown',e=>e.preventDefault());
        btn.onclick=()=>{applyChosenColor(btn.dataset.color);colorPalette.hidden=true;colorToggle.setAttribute('aria-expanded','false');};
      });
      const more=colorPalette.querySelector('[data-color-custom-btn]');
      if(more && customColor){
        more.addEventListener('pointerdown',e=>{rememberColorSelection(editor);e.preventDefault();});
        more.onclick=()=>customColor.click();
        customColor.oninput=()=>{applyChosenColor(customColor.value);colorPalette.hidden=true;colorToggle.setAttribute('aria-expanded','false');};
      }
    }
    const clear=box.querySelector('[data-clear-format]');
    if(clear){
      clear.addEventListener('pointerdown',e=>{rememberSelection(editor);e.preventDefault();});
      clear.onclick=()=>clearSelectedFormatting(editor);
    }
    editor.addEventListener('paste',e=>{e.preventDefault();const text=e.clipboardData?.getData('text/plain')||'';document.execCommand('insertText',false,text);});
  });
}
function stripLegacyWholeColor(editor,legacyColor){
  const legacy=String(legacyColor||'').trim().toLowerCase();
  if(!/^#[0-9a-f]{6}$/.test(legacy))return;
  const allText=editor.textContent.trim();
  editor.querySelectorAll('[style]').forEach(node=>{
    const color=String(node.style.color||'').trim().toLowerCase();
    if(color===legacy && node.textContent.trim()===allText)node.style.removeProperty('color');
    if(!node.getAttribute('style')?.trim())node.removeAttribute('style');
  });
}
async function loadSettings(){const s=await api('/api/admin/settings');const title=$('#brandEditor'),desc=$('#heroDescriptionEditor'),footer=$('#footerAddressEditor');title.innerHTML=s.brand_html||esc(s.brand||'');desc.innerHTML=s.hero_description_html||esc(s.hero_description||'');footer.innerHTML=s.footer_address_html||esc(s.footer_address||'');title.style.removeProperty('color');desc.style.removeProperty('color');footer.style.removeProperty('color');stripLegacyWholeColor(title,s.brand_color);stripLegacyWholeColor(desc,s.hero_description_color);$('#whatsapp').value=s.whatsapp||'';$('#emailCfg').value=s.email||'';$('#instagram').value=s.instagram||'';logoPath=s.logo_path||'';renderLogoAdmin();}
$('#saveSettings').onclick=async()=>{try{const title=$('#brandEditor'),desc=$('#heroDescriptionEditor'),footer=$('#footerAddressEditor');const body={brand:title.innerText.trim(),brand_html:cleanEditorHtml(title),brand_color:'',hero_description:desc.innerText.trim(),hero_description_html:cleanEditorHtml(desc),hero_description_color:'',footer_address:footer.innerText.trim(),footer_address_html:cleanEditorHtml(footer),whatsapp:$('#whatsapp').value,email:$('#emailCfg').value,instagram:$('#instagram').value};await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(body)});$('#settingsStatus').textContent='Título, descrição, endereço do rodapé, formatação e configurações salvos.';}catch(e){$('#settingsStatus').textContent=e.message;}};
async function uploadSelectedLogo(){
  const input=$('#logoFile');
  const file=input.files?.[0]; if(!file)return;
  const fd=new FormData(); fd.append('logo',file); $('#settingsStatus').textContent='Enviando logomarca...';
  $('#uploadLogo').disabled=true;
  try{const j=await api('/api/admin/logo',{method:'POST',body:fd});logoPath=j.path;renderLogoAdmin();$('#settingsStatus').textContent='Logomarca atualizada.';}catch(e){$('#settingsStatus').textContent=e.message;}
  finally{input.value='';$('#uploadLogo').disabled=false;}
}
$('#uploadLogo').onclick=()=>$('#logoFile').click();
$('#logoFile').addEventListener('change',uploadSelectedLogo);
$('#removeLogo').onclick=async()=>{
  if(!logoPath||!confirm('Remover a logomarca do site?'))return;
  try{await api('/api/admin/logo',{method:'DELETE',body:'{}'});logoPath='';$('#logoFile').value='';renderLogoAdmin();$('#settingsStatus').textContent='Logomarca removida. A página inicial não reservará espaço para ela.';}catch(e){$('#settingsStatus').textContent=e.message;}
};
$('#createAdmin').onclick=async()=>{
  const status=$('#adminStatus'),out=$('#newAdminTotp');status.textContent='';out.hidden=true;out.textContent='';
  const email=$('#newAdminEmail').value.trim(),password=$('#newAdminPassword').value,confirmPassword=$('#newAdminPasswordConfirm').value,adminPassword=$('#adminManagerPassword').value;
  if(!adminPassword){status.textContent='Digite sua senha atual para autorizar a criação.';return;}
  if(password!==confirmPassword){status.textContent='As senhas do novo administrador não coincidem.';return;}
  try{
    const j=await api('/api/admin/users',{method:'POST',body:JSON.stringify({email,password,adminPassword})});
    status.textContent='Administrador criado. Cadastre o 2FA abaixo antes de entregar o acesso.';
    out.textContent=`NOVO ADMINISTRADOR: ${j.user.email}\n\nSEGREDO 2FA: ${j.secret}\n\nURI: ${j.otpauthUri}\n\nEssas informações são exibidas apenas agora. Cadastre-as no autenticador do novo administrador.`;out.hidden=false;
    $('#newAdminEmail').value='';$('#newAdminPassword').value='';$('#newAdminPasswordConfirm').value='';
    await Promise.all([loadAdmins(),loadAudit()]);
  }catch(e){status.textContent=e.message;}
};
$('#changePassword').onclick=async()=>{try{await api('/api/auth/change-password',{method:'POST',body:JSON.stringify({currentPassword:$('#currentPassword').value,newPassword:$('#newPassword').value})});$('#securityStatus').textContent='Senha alterada. Outras sessões foram encerradas.';}catch(e){$('#securityStatus').textContent=e.message;}};
$('#rotate2fa').onclick=async()=>{if(!confirm('Gerar novo segredo 2FA?'))return;try{const j=await api('/api/auth/rotate-2fa',{method:'POST',body:JSON.stringify({password:$('#rotatePassword').value})});$('#totpOut').textContent=`SEGREDO: ${j.secret}\n\nURI: ${j.otpauthUri}\n\nCadastre agora no autenticador.`;}catch(e){$('#totpOut').textContent=e.message;}};
$('#logout').onclick=async()=>{await api('/api/auth/logout',{method:'POST',body:'{}'});location.href='/login';};
renderAdminGallery();
initRichEditors();
init().catch(e=>{alert(e.message);location.href='/login';});
