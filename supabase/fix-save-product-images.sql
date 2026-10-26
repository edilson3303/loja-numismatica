-- CORREÇÃO: salvamento de peças com fotos
-- Execute este arquivo UMA VEZ no Supabase > SQL Editor.
-- Ele apenas recria a função save_product com a validação correta de /media/*.webp.

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
    insert into public.products(name,era,era_label,metal,year,weight,diameter,grade,price_cents,legend,description,image_path,stock,active,created_at,updated_at)
    values(p_data->>'name',p_data->>'era',p_data->>'era_label',p_data->>'metal',p_data->>'year',p_data->>'weight',p_data->>'diameter',p_data->>'grade',(p_data->>'price_cents')::bigint,p_data->>'legend',p_data->>'description',nullif(p_data->>'image_path',''),(p_data->>'stock')::integer,coalesce((p_data->>'active')::boolean,true),v_now,v_now)
    returning id into v_id;
  else
    update public.products set
      name=p_data->>'name',era=p_data->>'era',era_label=p_data->>'era_label',metal=p_data->>'metal',year=p_data->>'year',
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

revoke all on function public.save_product(bigint,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.save_product(bigint,jsonb,jsonb) to service_role;
