import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';
import { supabase } from '../src/cloud.mjs';
import { hashPassword,validatePassword,newTotpSecret,encryptSecret,otpauthUri,cleanText } from '../src/security.mjs';
const rl=readline.createInterface({input,output});
const slug=cleanText(await rl.question('Endereço da loja (slug) [principal]: '),40).toLowerCase()||'principal';
const email=cleanText(await rl.question('E-mail do administrador: '),180).toLowerCase();
async function hiddenQuestion(prompt){if(process.platform!=='win32')spawnSync('stty',['-echo'],{stdio:['inherit','ignore','ignore']});try{const value=await rl.question(prompt);output.write('\n');return value;}finally{if(process.platform!=='win32')spawnSync('stty',['echo'],{stdio:['inherit','ignore','ignore']});}}
const password=await hiddenQuestion('Senha forte: '),confirm=await hiddenQuestion('Repita a senha: ');rl.close();
if(!email.includes('@'))throw new Error('E-mail inválido.');if(password!==confirm)throw new Error('As senhas não coincidem.');const errors=validatePassword(password);if(errors.length)throw new Error('Senha deve conter '+errors.join(', ')+'.');
const {data:store,error:storeError}=await supabase.from('stores').select('id,name').eq('slug',slug).maybeSingle();if(storeError)throw storeError;if(!store)throw new Error('Loja não encontrada: '+slug);
const {data:existing,error:findError}=await supabase.from('users').select('id').eq('store_id',store.id).ilike('email',email).maybeSingle();if(findError)throw findError;if(existing)throw new Error('Esse usuário já existe.');
const secret=newTotpSecret(),hash=await hashPassword(password),t=Date.now();const {error}=await supabase.from('users').insert({store_id:store.id,email,password_hash:hash,active:true,totp_secret_enc:encryptSecret(secret),totp_enabled:true,created_at:t,updated_at:t});if(error)throw error;
console.log('\nAdministrador criado. Cadastre imediatamente o 2FA:');console.log('SEGREDO:',secret);console.log('URI:',otpauthUri(secret,email,store.name));console.log('\nNão compartilhe esse segredo.');
