import fs from 'node:fs/promises';
import path from 'node:path';
import { supabase } from '../src/cloud.mjs';
const tables=['stores','store_payments','settings','products','product_images','orders','order_items','audit_logs'];
const backup={format:'loja-numismatica-cloud-backup',version:2,createdAt:new Date().toISOString(),tables:{}};
for(const table of tables){const {data,error}=await supabase.from(table).select('*');if(error)throw error;backup.tables[table]=data||[];}
await fs.mkdir('backups',{recursive:true});const file=path.join('backups',`loja-numismatica-cloud-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);await fs.writeFile(file,JSON.stringify(backup,null,2));console.log('Backup de dados criado:',file);console.log('Observação: as imagens permanecem no Supabase Storage; use o painel do Supabase para exportá-las se necessário.');
