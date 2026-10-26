import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import sanitizeHtml from 'sanitize-html';
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase, storageBucket, supabaseUrl, publicMediaUrl, audit, dbError } from './cloud.mjs';
import {
  randomToken, sha256, constantEq, hashPassword, verifyPassword, validatePassword,
  encryptSecret, decryptSecret, newTotpSecret, verifyTotp, otpauthUri,
  cleanText, cleanMultiline, moneyToCents, safeInt
} from './security.mjs';
import { storeForHost, isPlatformHost, isStoreOpen, mediaPrefix, mediaBelongsToStore, platformDomain } from './tenant.mjs';
import { registerPlatformRoutes } from './platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const privateDir = path.join(root, 'private');
const app = express();
const isProd = process.env.NODE_ENV === 'production';
const port = safeInt(process.env.PORT || 3000, 1, 65535);
const cookieName = process.env.SESSION_COOKIE_NAME || 'lnsid';
const platformCookieName = cookieName + '_p';
const idleMs = safeInt(process.env.SESSION_IDLE_MINUTES || 30, 5, 240) * 60_000;
const absoluteMs = safeInt(process.env.SESSION_ABSOLUTE_HOURS || 12, 1, 168) * 3600_000;
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const supabaseOrigin = new URL(supabaseUrl).origin;
const RICH_TAGS=['span','strong','b','em','i','u','br','div','p'];
const RICH_ATTRIBUTES={span:['style'],strong:['style'],b:['style'],em:['style'],i:['style'],u:['style'],div:['style'],p:['style']};
const RICH_STYLES={
  '*':{
    // Browsers commonly serialize <input type="color"> values as rgb(r, g, b)
    // inside element.style/innerHTML even when the chosen value was #RRGGBB.
    // Accept both safe forms so partial text colors survive sanitization.
    color:[
      /^#[0-9a-fA-F]{6}$/,
      /^rgb\(\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*\)$/i
    ],
    'font-size':[/^(?:14|16|18|20|24|28|32|40|48|56|64|72)px$/],
    'text-align':[/^(?:left|center|right)$/],
    display:[/^block$/]
  }
};
function brMoney(cents){return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((Number(cents)||0)/100);}
function statusLabel(status){return ({pending:'Pendente',awaiting_payment:'Aguardando pagamento',paid:'Pago',confirmed:'Confirmado',preparing:'Em preparação',shipped:'Enviado',delivered:'Entregue',completed:'Concluído',cancelled:'Cancelado'})[status]||String(status||'');}
function cleanHexColor(value,fallback=''){const v=String(value||'').trim();return /^#[0-9a-fA-F]{6}$/.test(v)?v.toLowerCase():fallback;}
function normalizeBrandText(value,fallback='Loja numismática'){const v=cleanText(value||'',120);return ['Feira de Moedas','Feira Numismática','LOJA NUMISMÁTICA'].includes(v)?'Loja numismática':(v||fallback);}
function normalizeBrandHtml(value){let v=value?sanitizeRich(value,120):'';if(!v)return v;return v.replace(/Feira de Moedas/gi,'Loja numismática').replace(/Feira\s*<span([^>]*)>Numismática<\/span>/gi,'Loja <span$1>numismática</span>').replace(/Feira Numismática/gi,'Loja numismática');}
async function getOrderBy(storeId,field,value){
  const {data,error}=await supabase.from('orders').select('*,order_items(product_name,unit_price_cents,quantity)').eq('store_id',storeId).eq(field,value).maybeSingle();
  if(error)throw dbError(error,'Não foi possível carregar o pedido.');
  if(!data)return null;
  return {...data,items:data.order_items||[],order_items:undefined};
}
function formatDateTimeBR(value){
  const d=new Date(value);
  if(Number.isNaN(d.getTime()))return '-';
  return new Intl.DateTimeFormat('pt-BR',{
    timeZone:'America/Sao_Paulo',
    day:'2-digit',month:'2-digit',year:'numeric',
    hour:'2-digit',minute:'2-digit',second:'2-digit',
    hour12:false
  }).format(d);
}
function renderOrderPdf(res,order,{download=false,brand='Loja numismática'}={}){
  const safeId=String(order.public_id||'pedido').replace(/[^A-Za-z0-9_-]/g,'_');
  res.type('application/pdf');
  res.setHeader('Content-Disposition',`${download?'attachment':'inline'}; filename="pedido-${safeId}.pdf"`);
  res.setHeader('Cache-Control','no-store, private');
  const doc=new PDFDocument({size:'A4',margin:48,info:{Title:`Pedido ${order.public_id}`,Author:brand}});
  doc.pipe(res);
  doc.font('Helvetica-Bold').fontSize(20).text(brand);
  doc.moveDown(.25).fontSize(15).text(`Pedido ${order.public_id}`);
  doc.moveDown(.25).font('Helvetica').fontSize(10).fillColor('#555555').text(`Registrado em ${formatDateTimeBR(order.created_at)} (horário de Brasília)`);
  doc.moveDown(1).fillColor('#000000').font('Helvetica-Bold').fontSize(12).text('Cliente');
  doc.font('Helvetica').fontSize(10).text(`Nome: ${order.customer_name||'-'}`);
  if(order.customer_phone)doc.text(`Telefone: ${order.customer_phone}`);
  if(order.customer_email)doc.text(`E-mail: ${order.customer_email}`);
  if(order.note){doc.moveDown(.4).font('Helvetica-Bold').text('Observação:');doc.font('Helvetica').text(String(order.note));}
  doc.moveDown(1).font('Helvetica-Bold').fontSize(12).text('Itens');
  doc.moveDown(.35);
  for(const item of order.items||[]){
    const qty=Number(item.quantity)||0, unit=Number(item.unit_price_cents)||0, subtotal=qty*unit;
    doc.font('Helvetica-Bold').fontSize(10).text(`${item.product_name}  x ${qty}`,{continued:false});
    doc.font('Helvetica').fillColor('#555555').text(`${brMoney(unit)} cada - ${brMoney(subtotal)}`);
    doc.fillColor('#000000').moveDown(.35);
  }
  doc.moveDown(.5).font('Helvetica-Bold').fontSize(13).text(`Total: ${brMoney(order.total_cents)}`,{align:'right'});
  doc.moveDown(.45).font('Helvetica').fontSize(10).text(`Status: ${statusLabel(order.status)}`,{align:'right'});
  doc.moveDown(2).fillColor('#666666').fontSize(9).text(`Documento gerado eletronicamente pelo sistema ${brand}.`);
  doc.end();
}
function reaisToCents(value){
  if(value===null||value===undefined||String(value).trim()==='')throw new Error('O preço é obrigatório.');
  const raw=String(value).trim().replace(/\s/g,'').replace(/^R\$/i,'');
  let normalized=raw;
  if(raw.includes(',')&&raw.includes('.')) normalized=raw.lastIndexOf(',')>raw.lastIndexOf('.')?raw.replace(/\./g,'').replace(',','.') : raw.replace(/,/g,'');
  else if(raw.includes(',')) normalized=raw.replace(',','.');
  const n=Number(normalized);
  if(!Number.isFinite(n)||n<0||n>100000000)throw new Error('Preço inválido.');
  return Math.round(n*100);
}
function sanitizeRich(value,maxText=600){
  const raw=String(value??'');
  if(raw.length>12000)throw new Error('Conteúdo formatado muito extenso.');
  const clean=sanitizeHtml(raw,{allowedTags:RICH_TAGS,allowedAttributes:RICH_ATTRIBUTES,allowedStyles:RICH_STYLES,disallowedTagsMode:'discard'}).trim();
  const plain=sanitizeHtml(clean,{allowedTags:[],allowedAttributes:{}}).replace(/\s+/g,' ').trim();
  if(plain.length>maxText)throw new Error(`Texto excede o limite de ${maxText} caracteres.`);
  return clean;
}
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy:{useDefaults:false,directives:{
    defaultSrc:["'self'"], scriptSrc:["'self'"], styleSrc:["'self'"], styleSrcAttr:["'unsafe-inline'"],
    imgSrc:["'self'",'data:',supabaseOrigin], fontSrc:["'none'"], connectSrc:["'self'"],
    objectSrc:["'none'"], frameSrc:["'none'"], baseUri:["'none'"], formAction:["'self'"],
    frameAncestors:["'none'"], upgradeInsecureRequests:isProd?[]:null
  }},
  crossOriginEmbedderPolicy:false,
  referrerPolicy:{policy:'no-referrer'},
  hsts:isProd?{maxAge:31536000,includeSubDomains:true,preload:true}:false
}));
app.use((req,res,next)=>{
  res.setHeader('Permissions-Policy',"camera=(self), microphone=(), geolocation=(), payment=(), usb=()");
  if(req.path.startsWith('/media/')) res.setHeader('Cache-Control','public, max-age=31536000, immutable');
  else if(/\.(?:css|js|png|jpe?g|webp|svg|ico)$/i.test(req.path)) res.setHeader('Cache-Control','public, max-age=604800, stale-while-revalidate=86400');
  else res.setHeader('Cache-Control','no-store');
  next();
});
app.use(express.json({limit:'64kb',strict:true}));
app.use(express.urlencoded({extended:false,limit:'32kb'}));

const generalLimiter=rateLimit({windowMs:15*60_000,limit:300,standardHeaders:'draft-8',legacyHeaders:false});
const authLimiter=rateLimit({windowMs:15*60_000,limit:12,standardHeaders:'draft-8',legacyHeaders:false,skipSuccessfulRequests:true});
const orderLimiter=rateLimit({windowMs:60*60_000,limit:25,standardHeaders:'draft-8',legacyHeaders:false});
const uploadLimiter=rateLimit({windowMs:60*60_000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});
app.use(generalLimiter);

app.get('/healthz',(req,res)=>res.status(200).json({ok:true,service:'loja-numismatica'}));

function parseCookies(req){
  const out={}; for(const part of String(req.headers.cookie||'').split(';')){ const i=part.indexOf('='); if(i<0)continue; try{out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}catch{} } return out;
}
function clientMeta(req){ const salt=process.env.APP_ENCRYPTION_KEY||'local-dev'; return {ipHash:sha256(salt+'|ip|'+String(req.ip||'')),uaHash:sha256(salt+'|ua|'+String(req.get('user-agent')||''))}; }

// ---------------------------------------------------------------------------
// Sessões: "store" (administrador de uma loja) e "platform" (dono da plataforma)
// usam cookies diferentes e nunca são aceitas uma no lugar da outra.
// ---------------------------------------------------------------------------
const cookieFor=scope=>scope==='platform'?platformCookieName:cookieName;
const sessionKey=scope=>scope==='platform'?'platformSession':'session';
function setSessionCookie(res,token,scope){res.cookie(cookieFor(scope),token,{httpOnly:true,secure:isProd,sameSite:'strict',path:'/',maxAge:absoluteMs});}
function clearSessionCookie(res,scope){res.clearCookie(cookieFor(scope),{httpOnly:true,secure:isProd,sameSite:'strict',path:'/'});}

async function createSession(req,res,{scope='store',userId=null,stage='anonymous'}={}){
  if(scope==='store'&&!req.store)throw new Error('Loja não identificada.');
  const token=randomToken(32),csrf=randomToken(24),t=Date.now(),{ipHash,uaHash}=clientMeta(req);
  const row={token_hash:sha256(token),scope,store_id:scope==='store'?req.store.id:null,user_id:scope==='store'?userId:null,platform_user_id:scope==='platform'?userId:null,csrf_token:csrf,created_at:t,last_seen_at:t,expires_at:t+idleMs,absolute_expires_at:t+absoluteMs,ip_hash:ipHash,ua_hash:uaHash,auth_stage:stage};
  const {error}=await supabase.from('sessions').insert(row); if(error) throw dbError(error,'Não foi possível criar a sessão.');
  setSessionCookie(res,token,scope); req[sessionKey(scope)]=row; return row;
}
async function destroySession(req,res,scope='store'){ const token=parseCookies(req)[cookieFor(scope)]; if(token) await supabase.from('sessions').delete().eq('token_hash',sha256(token)); clearSessionCookie(res,scope); req[sessionKey(scope)]=null; }
async function rotateSession(req,res,{scope='store',userId,stage}){ await destroySession(req,res,scope); return createSession(req,res,{scope,userId,stage}); }

function loadSession(scope){
  return async(req,res,next)=>{
    try{
      const key=sessionKey(scope);req[key]=null;
      const token=parseCookies(req)[cookieFor(scope)]; if(!token)return next();
      const hash=sha256(token),t=Date.now();
      const {data:s,error}=await supabase.from('sessions').select('*').eq('token_hash',hash).maybeSingle();
      if(error) throw dbError(error);
      const wrongOwner=s&&(s.scope!==scope||(scope==='store'&&Number(s.store_id)!==Number(req.store?.id)));
      if(!s||wrongOwner||Number(s.expires_at)<t||Number(s.absolute_expires_at)<t){if(s&&!wrongOwner)await supabase.from('sessions').delete().eq('token_hash',hash);clearSessionCookie(res,scope);return next();}
      const {uaHash}=clientMeta(req); if(s.ua_hash&&s.ua_hash!==uaHash){await supabase.from('sessions').delete().eq('token_hash',hash);clearSessionCookie(res,scope);return next();}
      const expires=Math.min(t+idleMs,Number(s.absolute_expires_at)); await supabase.from('sessions').update({last_seen_at:t,expires_at:expires}).eq('token_hash',hash);
      req[key]={...s,expires_at:expires,token_hash:hash}; next();
    }catch(e){next(e);}
  };
}
function ensureSessionFor(scope){return async(req,res,next)=>{try{if(!req[sessionKey(scope)])await createSession(req,res,{scope});next();}catch(e){next(e);}};}
const ensureSession=ensureSessionFor('store');

function csrfFor(scope){
  return (req,res,next)=>{
    const session=req[sessionKey(scope)];
    if(!session)return res.status(403).json({error:'Sessão CSRF ausente.'});
    const supplied=String(req.get('x-csrf-token')||''); if(supplied.length<20||!constantEq(supplied,session.csrf_token))return res.status(403).json({error:'Token CSRF inválido.'});
    const origin=req.get('origin'); if(origin){try{if(new URL(origin).origin!==`${req.protocol}://${req.get('host')}`)return res.status(403).json({error:'Origem não permitida.'});}catch{return res.status(403).json({error:'Origem inválida.'});}}
    next();
  };
}
const csrf=csrfFor('store');

// ---------------------------------------------------------------------------
// Plataforma (painel do dono) — registrada antes das rotas das lojas.
// ---------------------------------------------------------------------------
registerPlatformRoutes(app,{
  publicDir,privateDir,authLimiter,clientMeta,
  loadPlatformSession:loadSession('platform'),
  ensurePlatformSession:ensureSessionFor('platform'),
  platformCsrf:csrfFor('platform'),
  createSession,destroySession,rotateSession
});

// ---------------------------------------------------------------------------
// Lojas: identifica a loja pelo endereço e bloqueia lojas suspensas/vencidas.
// ---------------------------------------------------------------------------
const STORE_PATHS=['/api','/admin','/login','/setup','/como-comprar','/favicon.ico'];
function sendUnavailable(req,res,status,message){
  if(req.originalUrl.startsWith('/api/'))return res.status(status).json({error:message});
  res.status(status).sendFile(path.join(publicDir,'indisponivel.html'));
}
async function resolveStore(req,res,next){
  try{
    req.store=await storeForHost(req.hostname);
    if(!req.store)return sendUnavailable(req,res,404,'Loja não encontrada.');
    if(!isStoreOpen(req.store))return sendUnavailable(req,res,423,'Esta loja está temporariamente indisponível.');
    next();
  }catch(e){next(e);}
}
// Página de divulgação da plataforma: /conheca nos hosts da plataforma e a raiz do PLATFORM_DOMAIN.
const landingTemplate=fs.readFileSync(path.join(privateDir,'vitrine.html'),'utf8');
const escHtml=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const isLandingHost=host=>!!platformDomain&&(host===platformDomain||host==='www.'+platformDomain);
async function renderLanding(req,res,next){
  try{
    const name=cleanText(process.env.PLATFORM_NAME||'Vitrine Numismática',60);
    let wa=String(process.env.PLATFORM_WHATSAPP||'').replace(/\D/g,'');
    if(!wa){const cfg=await readSettings(1).catch(()=>({}));wa=String(cfg.whatsapp||process.env.WHATSAPP_NUMBER||'').replace(/\D/g,'');}
    if(wa.length===10||wa.length===11)wa='55'+wa;
    const local=wa.startsWith('55')?wa.slice(2):wa;
    const waText=local.length===11?`(${local.slice(0,2)}) ${local.slice(2,7)}-${local.slice(7)}`:local.length===10?`(${local.slice(0,2)}) ${local.slice(2,6)}-${local.slice(6)}`:local;
    const values={
      NOME:name,
      WHATSAPP_URL:wa?`https://wa.me/${wa}?text=${encodeURIComponent(`Olá! Quero saber mais sobre a ${name} para a minha loja numismática.`)}`:'#',
      WHATSAPP_TEXTO:waText,
      PRECO:cleanText(process.env.PLATFORM_PRICE||'R$ 99',30),
      PRECO_NOTA:cleanText(process.env.PLATFORM_PRICE_NOTE||'30 dias grátis para testar. Sem fidelidade.',160),
      DEMO_URL:process.env.PLATFORM_DEMO_URL||baseUrl,
      SITE_URL:`${req.protocol}://${req.get('host')}`,
      ANO:String(new Date().getFullYear())
    };
    res.setHeader('Cache-Control','public, max-age=300');
    res.type('html').send(landingTemplate.replace(/\{\{([A-Z_]+)\}\}/g,(m,k)=>k in values?escHtml(values[k]):m));
  }catch(e){next(e);}
}
app.get('/conheca',(req,res,next)=>isPlatformHost(req.hostname)?renderLanding(req,res,next):next());

app.use(STORE_PATHS,resolveStore,loadSession('store'));
app.get('/',(req,res,next)=>isLandingHost(req.hostname)?renderLanding(req,res,next):next(),resolveStore,loadSession('store'),(req,res)=>res.sendFile(path.join(publicDir,'index.html')));

async function requireAuth(req,res,next){
  try{
    if(!req.session||req.session.auth_stage!=='authenticated'||!req.session.user_id)return res.status(401).json({error:'Autenticação necessária.'});
    const {data:user,error}=await supabase.from('users').select('id,email,role,active,totp_enabled').eq('id',req.session.user_id).eq('store_id',req.store.id).maybeSingle();
    if(error)throw dbError(error);
    if(!user||user.active===false){await destroySession(req,res);return res.status(401).json({error:'Sessão inválida ou administrador desativado.'});}
    req.user=user;next();
  }catch(e){next(e);}
}
const storeAudit=(req,entry)=>audit({storeId:req.store?.id||null,...clientMeta(req),...entry});

app.get('/api/csrf',ensureSession,(req,res)=>res.json({csrfToken:req.session.csrf_token}));
async function storeAdminCount(storeId){
  const {count,error}=await supabase.from('users').select('id',{count:'exact',head:true}).eq('store_id',storeId);
  if(error)throw dbError(error,'Execute primeiro supabase/setup.sql e supabase/migrate-multi-loja.sql.');
  return Number(count||0);
}
app.get('/api/setup/status',async(req,res,next)=>{try{res.json({setupRequired:!(await storeAdminCount(req.store.id))});}catch(e){next(e);}});
app.post('/api/setup/admin',authLimiter,ensureSession,csrf,async(req,res,next)=>{try{
  if(await storeAdminCount(req.store.id))return res.status(409).json({error:'A instalação inicial já foi concluída.'});
  // Token de instalação: gerado pela plataforma para cada loja. A loja nº 1 também aceita o SETUP_TOKEN antigo.
  const {data:storeRow,error:storeErr}=await supabase.from('stores').select('setup_token_hash').eq('id',req.store.id).single();if(storeErr)throw dbError(storeErr);
  const supplied=sha256(String(req.get('x-setup-token')||''));
  const legacy=String(process.env.SETUP_TOKEN||'');
  const okToken=(storeRow.setup_token_hash&&constantEq(storeRow.setup_token_hash,supplied))||(Number(req.store.id)===1&&legacy.length>=24&&constantEq(sha256(legacy),supplied));
  if(!okToken)return res.status(403).json({error:'Token de instalação inválido.'});
  const email=cleanText(req.body?.email,180).toLowerCase(),password=String(req.body?.password||'');if(!email.includes('@'))return res.status(400).json({error:'E-mail inválido.'});const errors=validatePassword(password);if(errors.length)return res.status(400).json({error:'Senha deve conter '+errors.join(', ')+'.'});
  const secret=newTotpSecret(),hash=await hashPassword(password),t=Date.now();const {data:user,error}=await supabase.from('users').insert({store_id:req.store.id,email,password_hash:hash,totp_secret_enc:encryptSecret(secret),totp_enabled:true,created_at:t,updated_at:t}).select('id').single();if(error)throw dbError(error,'Não foi possível criar o administrador.');
  await supabase.from('stores').update({setup_token_hash:null,updated_at:t}).eq('id',req.store.id);
  await storeAudit(req,{userId:user.id,action:'setup.admin_created'});res.status(201).json({ok:true,secret,otpauthUri:otpauthUri(secret,email,req.store.name)});
}catch(e){next(e);}});

async function readSettings(storeId){
  const {data,error}=await supabase.from('settings').select('key,value').eq('store_id',storeId);
  if(error)throw dbError(error);
  return Object.fromEntries((data||[]).map(x=>[x.key,x.value]));
}
async function readPublicConfig(store){
  const cfg=await readSettings(store.id);
  const brand=normalizeBrandText(cfg.brand,store.name);
  const hero=cleanText(cfg.hero_description||'Catálogo numismático com estoque controlado no servidor. O pedido é registrado com os preços vigentes e confirmado por atendimento.',600);
  const logoPath=/^\/media\/[A-Za-z0-9_-]{10,120}\.webp$/.test(cfg.logo_path||'')?cfg.logo_path:'';
  return {brand,brand_html:normalizeBrandHtml(cfg.brand_html),brand_color:cleanHexColor(cfg.brand_color,''),hero_description:hero,hero_description_html:cfg.hero_description_html?sanitizeRich(cfg.hero_description_html,600):'',hero_description_color:cleanHexColor(cfg.hero_description_color,''),footer_address:cleanText(cfg.footer_address||'',500),footer_address_html:cfg.footer_address_html?sanitizeRich(cfg.footer_address_html,500):'',whatsapp:cfg.whatsapp||(Number(store.id)===1?process.env.WHATSAPP_NUMBER:'')||'',email:cfg.email||'',instagram:cfg.instagram||'',logo_path:logoPath,logo_url:logoPath?publicMediaUrl(mediaObjectName(logoPath)):''};
}
function normalizeProducts(rows){return (rows||[]).map(r=>{const valid=x=>/^\/media\/[A-Za-z0-9_-]{10,120}\.webp$/.test(String(x||''));const images=[...(r.product_images||[])].sort((a,b)=>a.position-b.position||a.id-b.id).map(x=>x.image_path).filter(valid);const legacy=valid(r.image_path)?r.image_path:null;if(!images.length&&legacy)images.push(legacy);return {...r,product_images:undefined,image_path:images[0]||legacy||null,images};});}
function publicImageUrl(mediaPath){const name=mediaObjectName(mediaPath);return name?publicMediaUrl(name):null;}
function publicProductImages(rows){return normalizeProducts(rows).map(p=>{const images=(p.images||[]).map(publicImageUrl).filter(Boolean);return {...p,image_path:images[0]||null,images};});}
async function readPublicProducts(storeId){
  const {data,error}=await supabase.from('products').select('id,name,product_type,product_type_label,origin,era,era_label,metal,year,denomination,catalog_reference,weight,diameter,grade,price_cents,legend,description,image_path,stock,version,product_images(id,image_path,position)').eq('store_id',storeId).eq('active',true).order('name');
  if(error)throw dbError(error);
  return publicProductImages(data);
}
app.get('/api/config',async(req,res,next)=>{try{res.json(await readPublicConfig(req.store));}catch(e){next(e);}});
app.get('/api/products',async(req,res,next)=>{try{
  const era=cleanText(req.query.era,30),type=cleanText(req.query.type,40),q=cleanText(req.query.q,100).toLowerCase();
  let rows=await readPublicProducts(req.store.id);
  if(type&&type!=='todos')rows=rows.filter(x=>x.product_type===type);
  if(era&&era!=='todas')rows=rows.filter(x=>x.era===era);
  if(q)rows=rows.filter(x=>([x.name,x.product_type_label,x.product_type,x.origin,x.year,x.denomination,x.catalog_reference,x.metal,x.grade].filter(Boolean).join(' ')).toLowerCase().includes(q));
  res.json(rows);
}catch(e){next(e);}});
// Carregamento público em uma única requisição: configurações e catálogo são
// consultados em paralelo e as imagens já saem com a URL direta do Storage.
app.get('/api/bootstrap',async(req,res,next)=>{try{
  const [config,products]=await Promise.all([readPublicConfig(req.store),readPublicProducts(req.store.id)]);
  res.setHeader('Cache-Control','private, max-age=15, stale-while-revalidate=30');
  res.json({config,products});
}catch(e){next(e);}});

app.post('/api/orders',orderLimiter,ensureSession,csrf,async(req,res,next)=>{try{
  const name=cleanText(req.body?.customer?.name,120),phone=cleanText(req.body?.customer?.phone,40),email=cleanText(req.body?.customer?.email,160),note=cleanMultiline(req.body?.customer?.note,1500),items=Array.isArray(req.body?.items)?req.body.items:[];
  if(name.length<2||items.length<1||items.length>30)return res.status(400).json({error:'Pedido inválido.'});
  const grouped=new Map();for(const item of items){const id=safeInt(item.id,1,2_000_000_000),qty=safeInt(item.quantity,1,20);grouped.set(id,Math.min(20,(grouped.get(id)||0)+qty));}
  const payload=[...grouped].map(([id,quantity])=>({id,quantity})); const publicId='LN-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+randomToken(5).toUpperCase();
  const {data,error}=await supabase.rpc('create_order',{p_store_id:req.store.id,p_public_id:publicId,p_customer_name:name,p_customer_phone:phone,p_customer_email:email,p_note:note,p_items:payload});
  if(error){if(String(error.message).includes('STOCK')||String(error.message).includes('ITEM_UNAVAILABLE'))return res.status(409).json({error:'Um item ficou indisponível ou não há estoque suficiente. Atualize o catálogo.'});throw dbError(error,'Não foi possível criar o pedido.');}
  await storeAudit(req,{action:'order.created',entity:'order',entityId:data.id,details:{publicId,total:data.total_cents}});res.status(201).json({publicId,totalCents:data.total_cents});
}catch(e){next(e);}});

app.post('/api/auth/login',authLimiter,ensureSession,csrf,async(req,res,next)=>{try{
  const email=cleanText(req.body?.email,180).toLowerCase(),password=String(req.body?.password||''),t=Date.now();
  const {data:user,error}=await supabase.from('users').select('*').eq('store_id',req.store.id).ilike('email',email).maybeSingle();if(error)throw dbError(error);
  const fakeHash='$argon2id$v=19$m=65536,t=3,p=1$QnJvd25Gb3hKdW1wczEyMzQ1Ng$X+J1u9wR98K6A/pxvO7h2H4Rx9DioalK4ss0JvQ8fWw';
  const usable=!!user&&user.active!==false;
  if(usable&&user.locked_until>t)return res.status(429).json({error:'Conta temporariamente bloqueada.'});
  const ok=await verifyPassword(usable?user.password_hash:fakeHash,password);
  if(!usable||!ok){if(usable){const fails=Number(user.failed_logins||0)+1,lock=fails>=5?t+15*60_000:0;await supabase.from('users').update({failed_logins:lock?0:fails,locked_until:lock,updated_at:t}).eq('id',user.id);}await storeAudit(req,{userId:user?.id||null,action:'auth.login_failed'});return res.status(401).json({error:'Credenciais inválidas.'});}
  await supabase.from('users').update({failed_logins:0,locked_until:0,updated_at:t}).eq('id',user.id);await rotateSession(req,res,{userId:user.id,stage:'password'});if(!user.totp_enabled)return res.status(403).json({error:'2FA obrigatório e ainda não configurado.'});res.json({requires2fa:true,csrfToken:req.session.csrf_token});
}catch(e){next(e);}});
app.post('/api/auth/2fa',authLimiter,ensureSession,csrf,async(req,res,next)=>{try{
  if(req.session.auth_stage!=='password'||!req.session.user_id)return res.status(401).json({error:'Faça login primeiro.'});const {data:user,error}=await supabase.from('users').select('*').eq('id',req.session.user_id).eq('store_id',req.store.id).maybeSingle();if(error)throw dbError(error);if(!user||user.active===false||!user.totp_enabled||!user.totp_secret_enc)return res.status(401).json({error:'2FA indisponível.'});
  if(!verifyTotp(decryptSecret(user.totp_secret_enc),req.body?.code)){await storeAudit(req,{userId:user.id,action:'auth.2fa_failed'});return res.status(401).json({error:'Código 2FA inválido.'});}const t=Date.now();await supabase.from('users').update({last_login_at:t,updated_at:t}).eq('id',user.id);await rotateSession(req,res,{userId:user.id,stage:'authenticated'});await storeAudit(req,{userId:user.id,action:'auth.login_success'});res.json({ok:true,csrfToken:req.session.csrf_token});
}catch(e){next(e);}});
app.post('/api/auth/logout',ensureSession,csrf,async(req,res,next)=>{try{const uid=req.session?.user_id;await destroySession(req,res);await storeAudit(req,{userId:uid,action:'auth.logout'});res.json({ok:true});}catch(e){next(e);}});
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({user:req.user,store:{name:req.store.name,slug:req.store.slug},csrfToken:req.session.csrf_token}));
app.post('/api/auth/change-password',requireAuth,csrf,async(req,res,next)=>{try{const current=String(req.body?.currentPassword||''),nextPwd=String(req.body?.newPassword||''),errors=validatePassword(nextPwd);if(errors.length)return res.status(400).json({error:'Nova senha deve conter '+errors.join(', ')+'.'});const {data:u,error}=await supabase.from('users').select('*').eq('id',req.user.id).eq('store_id',req.store.id).single();if(error)throw dbError(error);if(!await verifyPassword(u.password_hash,current))return res.status(401).json({error:'Senha atual incorreta.'});const h=await hashPassword(nextPwd);await supabase.from('users').update({password_hash:h,updated_at:Date.now()}).eq('id',u.id);await supabase.from('sessions').delete().eq('user_id',u.id).neq('token_hash',req.session.token_hash);await storeAudit(req,{userId:u.id,action:'auth.password_changed'});res.json({ok:true});}catch(e){next(e);}});
app.post('/api/auth/rotate-2fa',requireAuth,csrf,async(req,res,next)=>{try{const password=String(req.body?.password||'');const {data:u,error}=await supabase.from('users').select('*').eq('id',req.user.id).eq('store_id',req.store.id).single();if(error)throw dbError(error);if(!await verifyPassword(u.password_hash,password))return res.status(401).json({error:'Senha incorreta.'});const secret=newTotpSecret();await supabase.from('users').update({totp_secret_enc:encryptSecret(secret),totp_enabled:true,updated_at:Date.now()}).eq('id',u.id);await supabase.from('sessions').delete().eq('user_id',u.id).neq('token_hash',req.session.token_hash);await storeAudit(req,{userId:u.id,action:'auth.2fa_rotated'});res.json({secret,otpauthUri:otpauthUri(secret,u.email,req.store.name)});}catch(e){next(e);}});


async function verifyAdminManagementPassword(req,password){
  const {data:user,error}=await supabase.from('users').select('password_hash,active').eq('id',req.user.id).eq('store_id',req.store.id).maybeSingle();
  if(error)throw dbError(error);
  if(!user||user.active===false||!await verifyPassword(user.password_hash,String(password||'')))return false;
  return true;
}
async function activeAdminCount(storeId){
  const {count,error}=await supabase.from('users').select('id',{count:'exact',head:true}).eq('store_id',storeId).eq('active',true);
  if(error)throw dbError(error);
  return Number(count||0);
}
app.get('/api/admin/users',requireAuth,async(req,res,next)=>{try{
  const {data,error}=await supabase.from('users').select('id,email,role,active,totp_enabled,last_login_at,created_at,updated_at').eq('store_id',req.store.id).order('created_at',{ascending:true});
  if(error)throw dbError(error,'Não foi possível carregar os administradores.');
  res.json((data||[]).map(u=>({...u,is_current:u.id===req.user.id})));
}catch(e){next(e);}});
app.post('/api/admin/users',requireAuth,csrf,async(req,res,next)=>{try{
  if(!await verifyAdminManagementPassword(req,req.body?.adminPassword))return res.status(403).json({error:'Sua senha atual está incorreta.'});
  const email=cleanText(req.body?.email,180).toLowerCase(),password=String(req.body?.password||'');
  if(!email.includes('@')||email.length<5)return res.status(400).json({error:'E-mail inválido.'});
  const errors=validatePassword(password);if(errors.length)return res.status(400).json({error:'A senha do novo administrador deve conter '+errors.join(', ')+'.'});
  const {data:existing,error:findError}=await supabase.from('users').select('id').eq('store_id',req.store.id).ilike('email',email).maybeSingle();if(findError)throw dbError(findError);if(existing)return res.status(409).json({error:'Já existe um administrador com esse e-mail.'});
  const secret=newTotpSecret(),hash=await hashPassword(password),t=Date.now();
  const {data:user,error}=await supabase.from('users').insert({store_id:req.store.id,email,password_hash:hash,role:'admin',active:true,totp_secret_enc:encryptSecret(secret),totp_enabled:true,created_at:t,updated_at:t}).select('id,email,role,active,totp_enabled,created_at').single();
  if(error)throw dbError(error,'Não foi possível criar o administrador.');
  await storeAudit(req,{userId:req.user.id,action:'admin.created',entity:'user',entityId:user.id,details:{email:user.email}});
  res.status(201).json({user,secret,otpauthUri:otpauthUri(secret,email,req.store.name)});
}catch(e){next(e);}});
app.patch('/api/admin/users/:id/active',requireAuth,csrf,async(req,res,next)=>{try{
  if(!await verifyAdminManagementPassword(req,req.body?.adminPassword))return res.status(403).json({error:'Sua senha atual está incorreta.'});
  const id=safeInt(req.params.id,1,2_000_000_000),active=req.body?.active===true;
  if(id===req.user.id&&!active)return res.status(409).json({error:'Você não pode desativar a própria conta.'});
  const {data:target,error}=await supabase.from('users').select('id,email,active').eq('id',id).eq('store_id',req.store.id).maybeSingle();if(error)throw dbError(error);if(!target)return res.status(404).json({error:'Administrador não encontrado.'});
  if(!active&&target.active!==false&&(await activeAdminCount(req.store.id))<=1)return res.status(409).json({error:'Não é possível desativar o último administrador ativo.'});
  const {error:updateError}=await supabase.from('users').update({active,updated_at:Date.now(),failed_logins:0,locked_until:0}).eq('id',id).eq('store_id',req.store.id);if(updateError)throw dbError(updateError,'Não foi possível alterar o administrador.');
  if(!active)await supabase.from('sessions').delete().eq('user_id',id);
  await storeAudit(req,{userId:req.user.id,action:active?'admin.activated':'admin.deactivated',entity:'user',entityId:id,details:{email:target.email}});
  res.json({ok:true});
}catch(e){next(e);}});
app.delete('/api/admin/users/:id',requireAuth,csrf,async(req,res,next)=>{try{
  if(!await verifyAdminManagementPassword(req,req.body?.adminPassword))return res.status(403).json({error:'Sua senha atual está incorreta.'});
  const id=safeInt(req.params.id,1,2_000_000_000);if(id===req.user.id)return res.status(409).json({error:'Você não pode excluir a própria conta.'});
  const {data:target,error}=await supabase.from('users').select('id,email,active').eq('id',id).eq('store_id',req.store.id).maybeSingle();if(error)throw dbError(error);if(!target)return res.status(404).json({error:'Administrador não encontrado.'});
  if(target.active!==false&&(await activeAdminCount(req.store.id))<=1)return res.status(409).json({error:'Não é possível excluir o último administrador ativo.'});
  const {error:deleteError}=await supabase.from('users').delete().eq('id',id).eq('store_id',req.store.id);if(deleteError)throw dbError(deleteError,'Não foi possível excluir o administrador.');
  await storeAudit(req,{userId:req.user.id,action:'admin.deleted',entity:'user',entityId:id,details:{email:target.email}});
  res.json({ok:true});
}catch(e){next(e);}});

function validateProduct(body,storeId){
  const name=cleanText(body.name,180);if(name.length<2)throw new Error('O nome do produto é obrigatório.');
  const type=cleanText(body.product_type||'outro',40);const types={moeda:'Moeda',cedula:'Cédula',medalha:'Medalha',ficha:'Ficha',token:'Token',jeton:'Jeton',vale:'Vale / dinheiro particular',padrao:'Padrão / prova / ensaio',conjunto:'Conjunto / série',blister:'Blister / embalagem oficial',sache:'Sachê / saco / lote',certificado:'Certificado / encarte / material oficial',acessorio:'Acessório numismático',outro:'Outro item numismático'};if(!types[type])throw new Error('Tipo de item inválido.');
  const era=cleanText(body.era||'outro',30);const labels={colonia:'Brasil Colônia',imperio:'Império do Brasil',republica:'República',mundo:'Numismática mundial',outro:'Outra / não se aplica'};if(!labels[era])throw new Error('Classificação histórica inválida.');
  const rawImages=Array.isArray(body.images)?body.images:[];if(rawImages.length>12)throw new Error('Máximo de 12 fotos por produto.');const images=[];for(const raw of rawImages){const image=cleanText(raw,300);if(!/^\/media\/[A-Za-z0-9_-]{10,120}\.webp$/.test(image)||!mediaBelongsToStore(mediaObjectName(image),storeId))throw new Error('Imagem inválida.');if(!images.includes(image))images.push(image);}
  return {name,product_type:type,product_type_label:types[type],origin:cleanText(body.origin,160),era,era_label:labels[era],metal:cleanText(body.metal,120),year:cleanText(body.year,80),denomination:cleanText(body.denomination,120),catalog_reference:cleanText(body.catalog_reference,160),weight:cleanText(body.weight,80),diameter:cleanText(body.diameter,100),grade:cleanText(body.grade,160),price_cents:('price_reais' in body?reaisToCents(body.price_reais):moneyToCents(body.price_cents)),legend:cleanText(body.legend,60),description:cleanMultiline(body.description,5000),image_path:images[0]||null,images,stock:safeInt(body.stock,0,10000),active:!(body.active===false||body.active===0)};
}
app.get('/api/admin/products',requireAuth,async(req,res,next)=>{try{const {data,error}=await supabase.from('products').select('*,product_images(id,image_path,position)').eq('store_id',req.store.id).order('updated_at',{ascending:false});if(error)throw dbError(error);res.json(normalizeProducts(data));}catch(e){next(e);}});
app.post('/api/admin/products',requireAuth,csrf,async(req,res)=>{try{const p=validateProduct(req.body||{},req.store.id);const {data,error}=await supabase.rpc('save_product',{p_store_id:req.store.id,p_id:null,p_data:{...p,images:undefined},p_images:p.images});if(error)throw dbError(error,'Não foi possível salvar o produto.');await storeAudit(req,{userId:req.user.id,action:'product.created',entity:'product',entityId:data,details:{name:p.name,images:p.images.length}});res.status(201).json({id:data});}catch(e){console.error('Falha ao cadastrar produto:',e?.cause||e);res.status(400).json({error:e?.message||'Não foi possível cadastrar o produto.'});}});
app.put('/api/admin/products/:id',requireAuth,csrf,async(req,res)=>{try{const id=safeInt(req.params.id,1,2_000_000_000),p=validateProduct(req.body||{},req.store.id);const {data,error}=await supabase.rpc('save_product',{p_store_id:req.store.id,p_id:id,p_data:{...p,images:undefined},p_images:p.images});if(error){if(String(error.message).includes('NOT_FOUND'))return res.status(404).json({error:'Peça não encontrada.'});throw dbError(error,'Não foi possível salvar o produto.');}await storeAudit(req,{userId:req.user.id,action:'product.updated',entity:'product',entityId:id,details:{name:p.name,images:p.images.length}});res.json({ok:true,id:data});}catch(e){console.error('Falha ao atualizar produto:',e?.cause||e);res.status(400).json({error:e?.message||'Não foi possível atualizar o produto.'});}});
app.patch('/api/admin/products/:id/active',requireAuth,csrf,async(req,res,next)=>{try{
  const id=safeInt(req.params.id,1,2_000_000_000),active=req.body?.active===true;
  const {data:current,error:currentErr}=await supabase.from('products').select('id,version').eq('id',id).eq('store_id',req.store.id).maybeSingle();
  if(currentErr)throw dbError(currentErr);if(!current)return res.status(404).json({error:'Peça não encontrada.'});
  const {data,error}=await supabase.from('products').update({active,version:Number(current.version||1)+1,updated_at:Date.now()}).eq('id',id).eq('store_id',req.store.id).select('id,active').maybeSingle();
  if(error)throw dbError(error);
  await storeAudit(req,{userId:req.user.id,action:active?'product.activated':'product.deactivated',entity:'product',entityId:id});res.json({ok:true,active:data.active});
}catch(e){next(e);}});
app.delete('/api/admin/products/:id',requireAuth,csrf,async(req,res,next)=>{try{
  const id=safeInt(req.params.id,1,2_000_000_000);
  const {data:product,error:productErr}=await supabase.from('products').select('id,name,product_images(image_path)').eq('id',id).eq('store_id',req.store.id).maybeSingle();
  if(productErr)throw dbError(productErr);if(!product)return res.status(404).json({error:'Peça não encontrada.'});
  const {count,error:orderErr}=await supabase.from('order_items').select('id',{count:'exact',head:true}).eq('product_id',id);
  if(orderErr)throw dbError(orderErr);
  if((count||0)>0)return res.status(409).json({error:'Este produto já faz parte de um pedido e não pode ser excluído. Desative-o para preservar o histórico.'});
  const imagePaths=(product.product_images||[]).map(x=>x.image_path).filter(Boolean);
  const {error:deleteErr}=await supabase.from('products').delete().eq('id',id).eq('store_id',req.store.id);
  if(deleteErr)throw dbError(deleteErr,'Não foi possível excluir a peça.');
  const objects=imagePaths.map(mediaObjectName).filter(name=>name&&mediaBelongsToStore(name,req.store.id));
  if(objects.length){const {error:storageErr}=await supabase.storage.from(storageBucket).remove(objects);if(storageErr)console.error('Falha ao remover fotos do produto excluído:',storageErr.message);}
  await storeAudit(req,{userId:req.user.id,action:'product.deleted',entity:'product',entityId:id,details:{name:product.name,images:objects.length}});
  res.json({ok:true});
}catch(e){next(e);}});

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024,files:1}});
app.post('/api/admin/upload',uploadLimiter,requireAuth,csrf,upload.single('image'),async(req,res)=>{if(!req.file)return res.status(400).json({error:'Selecione uma imagem.'});try{const img=sharp(req.file.buffer,{failOn:'warning',limitInputPixels:80_000_000}),meta=await img.metadata();if(!['jpeg','png','webp','heif','avif'].includes(meta.format))return res.status(415).json({error:'Use JPG, PNG, WEBP, HEIC/HEIF ou AVIF.'});const name=mediaPrefix(req.store.id)+randomToken(18)+'.webp',buffer=await img.rotate().resize({width:1800,height:1800,fit:'inside',withoutEnlargement:true}).webp({quality:88,effort:5}).toBuffer();const {error}=await supabase.storage.from(storageBucket).upload(name,buffer,{contentType:'image/webp',cacheControl:'31536000',upsert:false});if(error)throw dbError(error,'Falha ao enviar a imagem.');await storeAudit(req,{userId:req.user.id,action:'image.uploaded',entity:'media',entityId:name,details:{bytes:req.file.size,format:meta.format}});res.status(201).json({path:'/media/'+name});}catch(e){console.error(e);res.status(400).json({error:e.message||'Imagem inválida ou corrompida.'});}});

const logoUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:1}});
function mediaObjectName(mediaPath){const m=String(mediaPath||'').match(/^\/media\/([A-Za-z0-9_-]{10,120}\.webp)$/);return m?m[1]:null;}
async function currentLogoPath(storeId){const {data}=await supabase.from('settings').select('value').eq('store_id',storeId).eq('key','logo_path').maybeSingle();return data?.value||'';}
app.post('/api/admin/logo',uploadLimiter,requireAuth,csrf,logoUpload.single('logo'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Selecione uma imagem.'});
  try{
    const img=sharp(req.file.buffer,{failOn:'warning',limitInputPixels:16_000_000}),meta=await img.metadata();
    if(!['jpeg','png','webp','heif','avif'].includes(meta.format))return res.status(415).json({error:'Use JPG, PNG, WEBP, HEIC/HEIF ou AVIF.'});
    const name=mediaPrefix(req.store.id)+'logo-'+randomToken(18)+'.webp';
    const buffer=await img.rotate().resize({width:1000,height:500,fit:'inside',withoutEnlargement:true}).webp({quality:90,effort:5}).toBuffer();
    const {error:upErr}=await supabase.storage.from(storageBucket).upload(name,buffer,{contentType:'image/webp',cacheControl:'31536000',upsert:false});
    if(upErr)throw dbError(upErr,'Falha ao enviar a logomarca.');
    const old=await currentLogoPath(req.store.id),path='/media/'+name;
    const {error:setErr}=await supabase.from('settings').upsert({store_id:req.store.id,key:'logo_path',value:path,updated_at:Date.now()},{onConflict:'store_id,key'});
    if(setErr){await supabase.storage.from(storageBucket).remove([name]);throw dbError(setErr,'Falha ao salvar a logomarca.');}
    const oldName=mediaObjectName(old);if(oldName&&oldName!==name&&mediaBelongsToStore(oldName,req.store.id))await supabase.storage.from(storageBucket).remove([oldName]);
    await storeAudit(req,{userId:req.user.id,action:'logo.updated',entity:'settings',entityId:'logo_path',details:{bytes:req.file.size,format:meta.format}});
    res.status(201).json({path});
  }catch(e){console.error(e);res.status(400).json({error:e.message||'Logomarca inválida ou corrompida.'});}
});
app.delete('/api/admin/logo',requireAuth,csrf,async(req,res,next)=>{try{
  const old=await currentLogoPath(req.store.id);
  const {error}=await supabase.from('settings').upsert({store_id:req.store.id,key:'logo_path',value:'',updated_at:Date.now()},{onConflict:'store_id,key'});if(error)throw dbError(error);
  const oldName=mediaObjectName(old);if(oldName&&mediaBelongsToStore(oldName,req.store.id))await supabase.storage.from(storageBucket).remove([oldName]);
  await storeAudit(req,{userId:req.user.id,action:'logo.removed',entity:'settings',entityId:'logo_path'});res.json({ok:true});
}catch(e){next(e);}});

app.get('/api/admin/orders',requireAuth,async(req,res,next)=>{try{const {data,error}=await supabase.from('orders').select('*,order_items(product_name,unit_price_cents,quantity)').eq('store_id',req.store.id).order('created_at',{ascending:false}).limit(500);if(error)throw dbError(error);res.json((data||[]).map(o=>({...o,items:o.order_items||[],order_items:undefined})));}catch(e){next(e);}});
app.patch('/api/admin/orders/:id/status',requireAuth,csrf,async(req,res,next)=>{try{const id=safeInt(req.params.id,1,2_000_000_000),status=cleanText(req.body?.status,20);if(!['pending','awaiting_payment','paid','confirmed','preparing','shipped','delivered','completed','cancelled'].includes(status))return res.status(400).json({error:'Status inválido.'});const {data,error}=await supabase.rpc('change_order_status',{p_store_id:req.store.id,p_order_id:id,p_status:status});if(error){if(String(error.message).includes('NOT_FOUND'))return res.status(404).json({error:'Pedido não encontrado.'});if(String(error.message).includes('FINAL'))return res.status(409).json({error:'Pedido cancelado não pode ser reativado automaticamente.'});throw dbError(error);}await storeAudit(req,{userId:req.user.id,action:'order.status_changed',entity:'order',entityId:id,details:{from:data.from_status,to:status}});res.json({ok:true});}catch(e){next(e);}});
app.get('/api/admin/orders/:id/pdf',requireAuth,async(req,res,next)=>{try{
  const id=safeInt(req.params.id,1,2_000_000_000),order=await getOrderBy(req.store.id,'id',id);
  if(!order)return res.status(404).json({error:'Pedido não encontrado.'});
  const cfg=await readSettings(req.store.id);
  await storeAudit(req,{userId:req.user.id,action:'order.pdf_generated',entity:'order',entityId:id,details:{publicId:order.public_id}});
  renderOrderPdf(res,order,{download:true,brand:normalizeBrandText(cfg.brand,req.store.name)});
}catch(e){next(e);}});
app.get('/api/admin/audit',requireAuth,async(req,res,next)=>{try{const {data,error}=await supabase.from('audit_logs').select('id,user_id,action,entity,entity_id,details_json,created_at').eq('store_id',req.store.id).order('id',{ascending:false}).limit(500);if(error)throw dbError(error);res.json(data||[]);}catch(e){next(e);}});
app.get('/api/admin/settings',requireAuth,async(req,res,next)=>{try{const cfg=await readSettings(req.store.id);cfg.brand=normalizeBrandText(cfg.brand,req.store.name);cfg.brand_html=normalizeBrandHtml(cfg.brand_html);if(cfg.hero_description_html)cfg.hero_description_html=sanitizeRich(cfg.hero_description_html,600);res.json(cfg);}catch(e){next(e);}});
app.put('/api/admin/settings',requireAuth,csrf,async(req,res,next)=>{try{const rows=[];const body=req.body||{};const store_id=req.store.id;const plainLimits={brand:120,hero_description:600,footer_address:500,whatsapp:180,email:180,instagram:180};for(const [k,max] of Object.entries(plainLimits))if(k in body)rows.push({store_id,key:k,value:cleanText(body[k],max),updated_at:Date.now()});if('brand_html' in body)rows.push({store_id,key:'brand_html',value:sanitizeRich(body.brand_html,120),updated_at:Date.now()});if('hero_description_html' in body)rows.push({store_id,key:'hero_description_html',value:sanitizeRich(body.hero_description_html,600),updated_at:Date.now()});if('footer_address_html' in body)rows.push({store_id,key:'footer_address_html',value:sanitizeRich(body.footer_address_html,500),updated_at:Date.now()});if('brand_color' in body)rows.push({store_id,key:'brand_color',value:cleanHexColor(body.brand_color,''),updated_at:Date.now()});if('hero_description_color' in body)rows.push({store_id,key:'hero_description_color',value:cleanHexColor(body.hero_description_color,''),updated_at:Date.now()});if(rows.length){const {error}=await supabase.from('settings').upsert(rows,{onConflict:'store_id,key'});if(error)throw dbError(error);}await storeAudit(req,{userId:req.user.id,action:'settings.updated',entity:'settings'});res.json({ok:true});}catch(e){next(e);}});

app.get('/media/:name',(req,res)=>{const url=publicMediaUrl(req.params.name);if(!url)return res.status(404).end();res.setHeader('Cache-Control','public, max-age=31536000, immutable');res.redirect(302,url);});
app.get('/favicon.ico',async(req,res)=>{
  try{
    const logoPath=await currentLogoPath(req.store.id);
    const name=mediaObjectName(logoPath);
    const url=name?publicMediaUrl(name):'';
    res.setHeader('Cache-Control','no-cache, max-age=0, must-revalidate');
    if(!url)return res.status(204).end();
    return res.redirect(302,url);
  }catch{
    res.setHeader('Cache-Control','no-cache, max-age=0, must-revalidate');
    return res.status(204).end();
  }
});

app.get('/setup',(req,res)=>res.sendFile(path.join(publicDir,'setup.html')));
app.get('/login',(req,res)=>res.sendFile(path.join(publicDir,'login.html')));
app.get('/como-comprar',(req,res)=>res.sendFile(path.join(publicDir,'como-comprar.html')));
app.get('/admin',requireAuth,(req,res)=>res.sendFile(path.join(privateDir,'admin.html')));
app.get('/admin/admin.js',requireAuth,(req,res)=>res.sendFile(path.join(privateDir,'admin.js')));
app.use(express.static(publicDir,{index:false,dotfiles:'deny',etag:true,maxAge:'7d',setHeaders:(res,filePath)=>{if(/\.(?:css|js|png|jpe?g|webp|svg|ico)$/i.test(filePath)){res.setHeader('Cache-Control','public, max-age=604800, stale-while-revalidate=86400');res.removeHeader('Pragma');res.removeHeader('Expires');}}}));
app.use('/api',(req,res)=>res.status(404).json({error:'Endpoint não encontrado.'}));
app.use((err,req,res,next)=>{console.error(err);void audit({storeId:req.store?.id||null,userId:req.user?.id||null,action:'server.error',...clientMeta(req),details:{path:req.path,name:err?.name}});if(res.headersSent)return next(err);if(err instanceof multer.MulterError){if(err.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:'A foto é muito grande. O limite é 20 MB por foto.'});return res.status(400).json({error:'Não foi possível receber a foto: '+err.message});}res.status(500).json({error:'Erro interno.'});});

async function cleanup(){const t=Date.now();try{await supabase.from('sessions').delete().or(`expires_at.lt.${t},absolute_expires_at.lt.${t}`);}catch{}}
setInterval(cleanup,15*60_000).unref();void cleanup();

app.listen(port,()=>console.log(`Loja numismática Cloud em ${baseUrl} (porta ${port})`));
