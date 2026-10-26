-- Migração: cadastro genérico para todos os produtos numismáticos
-- Execute UMA VEZ no SQL Editor do Supabase. Não apaga os produtos existentes.

alter table public.products add column if not exists product_type text not null default 'moeda';
alter table public.products add column if not exists product_type_label text not null default 'Moeda';
alter table public.products add column if not exists origin text;
alter table public.products add column if not exists denomination text;
alter table public.products add column if not exists catalog_reference text;

-- Remove restrições antigas que limitavam período e metal somente a moedas.
alter table public.products drop constraint if exists products_era_check;
alter table public.products drop constraint if exists products_metal_check;
alter table public.products alter column era set default 'outro';
alter table public.products alter column metal set default '';
alter table public.products alter column year set default '';

update public.products set product_type='moeda', product_type_label='Moeda' where product_type is null or product_type='';

create or replace function public.save_product(p_id bigint,p_data jsonb,p_images jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_img text;
  v_pos integer := 0;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if jsonb_typeof(coalesce(p_images,'[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_images,'[]'::jsonb)) > 12 then raise exception 'INVALID_IMAGES'; end if;
  if p_id is null then
    insert into public.products(name,product_type,product_type_label,origin,era,era_label,metal,year,denomination,catalog_reference,weight,diameter,grade,price_cents,legend,description,image_path,stock,active,created_at,updated_at)
    values(p_data->>'name',coalesce(nullif(p_data->>'product_type',''),'outro'),coalesce(nullif(p_data->>'product_type_label',''),'Outro item numismático'),nullif(p_data->>'origin',''),coalesce(nullif(p_data->>'era',''),'outro'),coalesce(nullif(p_data->>'era_label',''),'Outra / não se aplica'),coalesce(p_data->>'metal',''),coalesce(p_data->>'year',''),nullif(p_data->>'denomination',''),nullif(p_data->>'catalog_reference',''),p_data->>'weight',p_data->>'diameter',p_data->>'grade',(p_data->>'price_cents')::bigint,p_data->>'legend',p_data->>'description',nullif(p_data->>'image_path',''),(p_data->>'stock')::integer,coalesce((p_data->>'active')::boolean,true),v_now,v_now)
    returning id into v_id;
  else
    update public.products set
      name=p_data->>'name',product_type=coalesce(nullif(p_data->>'product_type',''),'outro'),product_type_label=coalesce(nullif(p_data->>'product_type_label',''),'Outro item numismático'),origin=nullif(p_data->>'origin',''),era=coalesce(nullif(p_data->>'era',''),'outro'),era_label=coalesce(nullif(p_data->>'era_label',''),'Outra / não se aplica'),metal=coalesce(p_data->>'metal',''),year=coalesce(p_data->>'year',''),denomination=nullif(p_data->>'denomination',''),catalog_reference=nullif(p_data->>'catalog_reference',''),
      weight=p_data->>'weight',diameter=p_data->>'diameter',grade=p_data->>'grade',price_cents=(p_data->>'price_cents')::bigint,
      legend=p_data->>'legend',description=p_data->>'description',image_path=nullif(p_data->>'image_path',''),stock=(p_data->>'stock')::integer,
      active=coalesce((p_data->>'active')::boolean,true),version=version+1,updated_at=v_now
    where id=p_id returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND'; end if;
    delete from public.product_images where product_id=v_id;
  end if;

  for v_img in select * from jsonb_array_elements_text(coalesce(p_images,'[]'::jsonb))
  loop
    if v_img !~ '^/media/[A-Za-z0-9_-]{10,120}\.webp$' then raise exception 'INVALID_IMAGE_PATH'; end if;
    insert into public.product_images(product_id,image_path,position,created_at) values(v_id,v_img,v_pos,v_now);
    v_pos := v_pos + 1;
  end loop;
  return v_id;
end;
$$;
