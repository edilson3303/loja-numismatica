'use strict';
let allProducts=[], products=[], cart=JSON.parse(localStorage.getItem('gn_cart_v2')||'{}'), csrf='', cfg={}, detailProduct=null;
const PRODUCTS_PER_PAGE=20;
let currentPage=1;
const $=s=>document.querySelector(s);
const money=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n/100);
const displayType=p=>{const v=String(p?.product_type_label||p?.product_type||'Peça numismática').trim();return v?v.charAt(0).toLocaleUpperCase('pt-BR')+v.slice(1):'Peça numismática';};
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function installImageFallback(img){
  if(!img)return;
  img.addEventListener('error',()=>{
    const thumb=img.closest('.thumb');
    if(thumb){thumb.remove();return;}
    const detail=img.closest('#detailMain');
    if(detail){detail.innerHTML='<div class="pic no-photo detail-fallback">SEM FOTO</div>';return;}
    const fallback=document.createElement('div');
    fallback.className='pic no-photo';
    fallback.textContent='SEM FOTO';
    img.replaceWith(fallback);
  },{once:true});
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(url,opt={}){
  const attempts=Number(opt.attempts||1);
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{
      const {attempts:_,...fetchOpt}=opt;
      const r=await fetch(new URL(url,location.origin),{cache:fetchOpt.cache||'no-store',...fetchOpt,headers:{'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{}),...(fetchOpt.headers||{})}});
      const j=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(j.error||`Falha na operação (${r.status})`);
      return j;
    }catch(e){
      lastError=e;
      if(attempt<attempts)await wait(650*attempt);
    }
  }
  throw lastError||new Error('Não foi possível conectar ao servidor.');
}
async function ensureCsrf(){if(csrf)return csrf;csrf=(await api('/api/csrf')).csrfToken;return csrf;}
function isSafeImageSrc(src){const v=String(src||'');if(/^\/media\/[A-Za-z0-9_-]{10,120}\.webp$/.test(v))return true;try{const u=new URL(v,location.origin);return u.protocol==='https:'&&/\.supabase\.co$/i.test(u.hostname)&&u.pathname.includes('/storage/v1/object/public/');}catch{return false;}}
function renderBrandName(name){
  const el=$('#brand');
  const raw=String(name||'Loja numismática').trim();
  const value=['Feira de Moedas','Feira Numismática'].includes(raw)?'Loja numismática':raw;
  const parts=value.split(/\s+/);
  el.textContent='';
  if(parts.length<=1){el.textContent=value;return;}
  const last=parts.pop();
  el.append(document.createTextNode(parts.join(' ')+' '));
  const accent=document.createElement('span');
  accent.className='coin-image-gold';
  accent.textContent=last;
  el.append(accent);
}
function renderFavicon(path){
  const src=String(path||'');
  if(!isSafeImageSrc(src))return;
  let link=document.querySelector('link[rel=\"icon\"]');
  if(!link){link=document.createElement('link');link.rel='icon';document.head.append(link);}
  link.type='image/webp';
  link.href=src;
}
function renderLogo(path,brand){
  const link=$('#siteLogoLink'), img=$('#siteLogo');
  if(!link||!img)return;
  const src=String(path||'');
  if(!isSafeImageSrc(src)){
    link.hidden=true; img.removeAttribute('src'); return;
  }
  img.src=src; img.alt=`Logomarca ${String(brand||'Loja numismática')}`; link.hidden=false;
}
function renderRichHtml(el,html,fallbackText,legacyFieldColor=''){
  if(!el)return;
  el.style.removeProperty('text-align');
  el.style.removeProperty('color');
  if(html){
    el.innerHTML=String(html);

    // Migração visual: versões antigas podiam gravar a cor no campo inteiro.
    // Removemos somente nós cuja cor legada cobre TODO o conteúdo; cores de
    // trechos parciais permanecem intactas.
    const legacy=String(legacyFieldColor||'').trim().toLowerCase();
    if(/^#[0-9a-f]{6}$/.test(legacy)){
      const allText=el.textContent.trim();
      el.querySelectorAll('[style]').forEach(node=>{
        const c=String(node.style?.color||'').trim().toLowerCase();
        if(c===legacy && node.textContent.trim()===allText)node.style.removeProperty('color');
        if(!node.getAttribute('style')?.trim())node.removeAttribute('style');
      });
    }

    // Alinhamento continua sendo do campo inteiro e responsivo.
    const aligned=[...el.querySelectorAll('[style]')].find(node=>{
      const a=String(node.style?.textAlign||'').toLowerCase();
      return a==='left'||a==='center'||a==='right'||a==='justify';
    });
    if(aligned)el.style.textAlign=aligned.style.textAlign;
    return;
  }
  el.textContent=String(fallbackText||'');
}
async function init(){
  let boot;
  try{
    boot=await api('/api/bootstrap',{cache:'no-store',attempts:3});
  }catch(firstError){
    // Compatibilidade e recuperação: se a rota combinada falhar durante o
    // despertar do Render, tenta as duas rotas públicas tradicionais.
    try{
      const [config,productsData]=await Promise.all([
        api('/api/config',{cache:'no-store',attempts:2}),
        api('/api/products',{cache:'no-store',attempts:2})
      ]);
      boot={config,products:productsData};
    }catch{
      throw new Error('Não foi possível conectar ao servidor. Aguarde alguns segundos e atualize a página.');
    }
  }
  cfg=boot.config||{}; allProducts=Array.isArray(boot.products)?boot.products:[];
  if(cfg.brand_html) renderRichHtml($('#brand'),cfg.brand_html,cfg.brand,cfg.brand_color); else renderBrandName(cfg.brand);
  renderRichHtml($('#heroDescription'),cfg.hero_description_html,cfg.hero_description||'Catálogo numismático com estoque controlado no servidor. O pedido é registrado com os preços vigentes e confirmado por atendimento.',cfg.hero_description_color);
  const footer=$('#siteFooter'),footerAddress=$('#footerAddress'); const footerText=String(cfg.footer_address||'').trim(),footerHtml=String(cfg.footer_address_html||'').trim(); if(footerText||footerHtml){renderRichHtml(footerAddress,footerHtml,footerText,'');footer.hidden=false;}else{footer.hidden=true;}
  document.title=String(cfg.brand||'Loja numismática');
  renderLogo(cfg.logo_url||cfg.logo_path,cfg.brand);
  renderFavicon(cfg.logo_url||cfg.logo_path);
  document.querySelector('.hero-dynamic')?.classList.add('is-ready');
  load(); renderCart();
  await settleInitialImages();
  document.body.classList.remove('app-loading');
  document.body.classList.add('app-ready');
}
function load({resetPage=false}={}){
  const type=$('#productTypeFilter')?.value||'todos', era=$('#era')?.value||'todas', q=$('#q')?.value.trim().toLowerCase()||'';
  products=allProducts.filter(p=>{
    if(type!=='todos'&&p.product_type!==type)return false;
    if(era!=='todas'&&p.era!==era)return false;
    if(q){const hay=[p.name,p.product_type_label,p.product_type,p.origin,p.year,p.denomination,p.catalog_reference,p.metal,p.grade].filter(Boolean).join(' ').toLowerCase();if(!hay.includes(q))return false;}
    return true;
  });
  const sort=$('#sort').value;
  products.sort((a,b)=>sort==='priceAsc'?a.price_cents-b.price_cents:sort==='priceDesc'?b.price_cents-a.price_cents:a.name.localeCompare(b.name,'pt-BR'));
  if(resetPage)currentPage=1;
  const totalPages=Math.max(1,Math.ceil(products.length/PRODUCTS_PER_PAGE));if(currentPage>totalPages)currentPage=totalPages;
  render();
}
async function refreshCatalog(){allProducts=await api('/api/products');load();}
async function settleInitialImages(){
  const imgs=[...document.querySelectorAll('#grid img.product-photo, #siteLogo[src]')];
  if(!imgs.length)return;
  const settled=Promise.allSettled(imgs.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true});})));
  await Promise.race([settled,new Promise(resolve=>setTimeout(resolve,1800))]);
}
function render(){
  const g=$('#grid'); g.textContent='';
  const totalPages=Math.max(1,Math.ceil(products.length/PRODUCTS_PER_PAGE));
  if(currentPage>totalPages)currentPage=totalPages;
  const start=(currentPage-1)*PRODUCTS_PER_PAGE;
  const pageProducts=products.slice(start,start+PRODUCTS_PER_PAGE);
  const first=products.length?start+1:0;
  const last=Math.min(start+PRODUCTS_PER_PAGE,products.length);
  $('#resultInfo').textContent=products.length?`${products.length} peça(s) no catálogo · exibindo ${first}–${last}`:'Nenhuma peça encontrada';
  for(const [pageIndex,p] of pageProducts.entries()){
    const c=document.createElement('article'); c.className='card';
    const pic=p.image_path?`<img class="pic product-photo" src="${p.image_path}" alt="${esc(p.name)}" loading="eager" decoding="async" fetchpriority="${pageIndex<6?'high':'auto'}">`:`<div class="pic no-photo">SEM FOTO</div>`;
    const photoCount=p.images?.length||0;
    c.innerHTML=`<button class="photo-open product-photo-frame" type="button" aria-label="Ver fotos e detalhes de ${esc(p.name)}">${pic}${photoCount>1?`<span class="photo-count">${photoCount} fotos</span>`:''}</button><div class="muted">${esc(displayType(p))}${p.year?` · ${esc(p.year)}`:''}${p.origin?` · ${esc(p.origin)}`:''}</div><h3>${esc(p.name)}</h3><div class="row">${p.denomination?`<span class="badge">${esc(p.denomination)}</span>`:''}${p.metal?`<span class="badge">${esc(p.metal)}</span>`:''}${p.grade?`<span class="badge">${esc(p.grade)}</span>`:''}</div><div class="price">${money(p.price_cents)}</div><div class="row between"><button class="btn details" type="button">Ver detalhes</button><button class="btn primary add" ${p.stock<1?'disabled':''}>Adicionar</button></div><div class="muted stock-line">Estoque: ${p.stock}</div>`;
    installImageFallback(c.querySelector('img.product-photo'));
    c.querySelector('.add').onclick=()=>add(p); c.querySelector('.details').onclick=()=>openProduct(p); c.querySelector('.photo-open').onclick=()=>openProduct(p); g.append(c);
  }
  renderPagination(totalPages);
}
function renderPagination(totalPages){
  const nav=$('#pagination');
  if(!nav)return;
  nav.textContent='';
  if(products.length<=PRODUCTS_PER_PAGE){nav.hidden=true;return;}
  nav.hidden=false;
  const makeButton=(label,page,{disabled=false,current=false,ariaLabel=''}={})=>{
    const b=document.createElement('button');
    b.type='button'; b.className='btn page-btn'+(current?' is-current':''); b.textContent=label; b.disabled=disabled;
    if(ariaLabel)b.setAttribute('aria-label',ariaLabel);
    if(current)b.setAttribute('aria-current','page');
    b.onclick=()=>{if(page===currentPage||disabled)return;currentPage=page;render();document.querySelector('main')?.scrollIntoView({behavior:'smooth',block:'start'});};
    nav.append(b);
  };
  makeButton('Anterior',Math.max(1,currentPage-1),{disabled:currentPage===1,ariaLabel:'Página anterior'});
  const pages=new Set([1,totalPages,currentPage-2,currentPage-1,currentPage,currentPage+1,currentPage+2]);
  const valid=[...pages].filter(n=>n>=1&&n<=totalPages).sort((a,b)=>a-b);
  let previous=0;
  for(const page of valid){
    if(previous&&page-previous>1){const dots=document.createElement('span');dots.className='page-ellipsis';dots.textContent='…';dots.setAttribute('aria-hidden','true');nav.append(dots);}
    makeButton(String(page),page,{current:page===currentPage,ariaLabel:`Ir para a página ${page}`});
    previous=page;
  }
  makeButton('Próxima',Math.min(totalPages,currentPage+1),{disabled:currentPage===totalPages,ariaLabel:'Próxima página'});
}
function openProduct(p){
  detailProduct=p; const images=p.images||[]; $('#detailTitle').textContent=p.name; $('#detailMeta').textContent=[displayType(p),p.origin,p.year,p.era_label].filter(Boolean).join(' · '); $('#detailDescription').textContent=p.description||''; $('#detailPrice').textContent=money(p.price_cents); $('#detailAdd').disabled=p.stock<1;
  $('#detailSpecs').innerHTML=`<div><span>Tipo</span><strong>${esc(displayType(p)||'—')}</strong></div>${p.denomination?`<div><span>Valor facial</span><strong>${esc(p.denomination)}</strong></div>`:''}${p.metal?`<div><span>Material</span><strong>${esc(p.metal)}</strong></div>`:''}${p.weight?`<div><span>Peso</span><strong>${esc(p.weight)}</strong></div>`:''}${p.diameter?`<div><span>Dimensões</span><strong>${esc(p.diameter)}</strong></div>`:''}${p.grade?`<div><span>Conservação</span><strong>${esc(p.grade)}</strong></div>`:''}${p.catalog_reference?`<div><span>Referência</span><strong>${esc(p.catalog_reference)}</strong></div>`:''}<div><span>Estoque</span><strong>${p.stock}</strong></div>`;
  const main=$('#detailMain'), thumbs=$('#detailThumbs'); main.classList.add('product-photo-frame'); main.textContent=''; thumbs.textContent='';
  const cover=p.image_path||images[0]||'';
  const detailImages=cover?[cover,...images.filter(src=>src&&src!==cover)]:[];
  if(detailImages.length){setMainImage(detailImages[0],p.name);detailImages.forEach((src,i)=>{const b=document.createElement('button');b.className='thumb'+(i===0?' active':'');b.type='button';b.innerHTML=`<img src="${src}" alt="Foto ${i+1} de ${esc(p.name)}" loading="lazy" decoding="async">`;installImageFallback(b.querySelector('img'));b.onclick=()=>{setMainImage(src,p.name);thumbs.querySelectorAll('.thumb').forEach(x=>x.classList.remove('active'));b.classList.add('active');};thumbs.append(b);});}
  else main.innerHTML=`<div class="pic no-photo detail-fallback">SEM FOTO</div>`;
  $('#productDialog').showModal();
}
function setMainImage(src,name){const main=$('#detailMain');main.innerHTML=`<img class="pic product-photo detail-product-photo" src="${src}" alt="${esc(name)}">`;installImageFallback(main.querySelector('img'));}
function add(p){cart[p.id]=Math.min(p.stock,(cart[p.id]||0)+1);save();renderCart();$('#cart').showModal();}
function save(){localStorage.setItem('gn_cart_v2',JSON.stringify(cart));}
function renderCart(){const list=$('#cartList');list.textContent='';let total=0,count=0;for(const [id,qty] of Object.entries(cart)){const p=products.find(x=>x.id==id);if(!p)continue;const q=Math.min(qty,p.stock);if(q<1){delete cart[id];continue;}total+=p.price_cents*q;count+=q;const r=document.createElement('div');r.className='cart-row';r.innerHTML=`<div><strong>${esc(p.name)}</strong><div class="muted">${money(p.price_cents)} × ${q}</div></div><div class="row"><button class="btn minus">−</button><span>${q}</span><button class="btn plus">+</button><button class="btn danger remove">Remover</button></div>`;r.querySelector('.minus').onclick=()=>{cart[id]=q-1;if(cart[id]<1)delete cart[id];save();renderCart();};r.querySelector('.plus').onclick=()=>{cart[id]=Math.min(p.stock,q+1);save();renderCart();};r.querySelector('.remove').onclick=()=>{delete cart[id];save();renderCart();};list.append(r);}$('#total').textContent=money(total);$('#count').textContent=count;const cartBtn=$('#cartBtn');if(cartBtn){cartBtn.classList.toggle('primary',count>0);cartBtn.classList.toggle('has-items',count>0);cartBtn.setAttribute('aria-label',count>0?`Carrinho com ${count} item(ns)`:'Carrinho vazio');}save();}
$('#cartBtn').onclick=()=>{$('#cart').showModal();renderCart();};document.querySelector('[data-close]').onclick=()=>$('#cart').close();$('#continueShopping').onclick=()=>{$('#cart').close();document.querySelector('main')?.scrollIntoView({behavior:'smooth',block:'start'});};$('#closeProduct').onclick=()=>$('#productDialog').close();$('#detailAdd').onclick=()=>{if(detailProduct){$('#productDialog').close();add(detailProduct);}};$('#q').oninput=()=>load({resetPage:true});if($('#productTypeFilter'))$('#productTypeFilter').onchange=()=>load({resetPage:true});$('#era').onchange=()=>load({resetPage:true});$('#sort').onchange=()=>load({resetPage:true});
$('#checkout').onclick=async()=>{const st=$('#cartStatus');st.textContent='';try{await ensureCsrf();const items=Object.entries(cart).map(([id,quantity])=>({id:Number(id),quantity}));const out=await api('/api/orders',{method:'POST',body:JSON.stringify({customer:{name:$('#customerName').value,phone:$('#customerPhone').value,email:$('#customerEmail').value,note:$('#customerNote').value},items})});cart={};save();await refreshCatalog();renderCart();st.textContent=`Pedido ${out.publicId} registrado com total ${money(out.totalCents)}.`;if(cfg.whatsapp){const text=`Olá! Registrei o pedido ${out.publicId} no valor de ${money(out.totalCents)}.`;window.open(`https://wa.me/${cfg.whatsapp}?text=${encodeURIComponent(text)}`,'_blank','noopener,noreferrer');}}catch(e){st.textContent=e.message;}};
init().catch(e=>{document.body.classList.remove('app-loading');document.body.classList.add('app-ready');$('#resultInfo').textContent=e.message;});
