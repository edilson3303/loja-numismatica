-- Amplia os status disponíveis para pedidos existentes.
-- Execute uma vez no Supabase SQL Editor.

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check(status in ('pending','awaiting_payment','paid','confirmed','preparing','shipped','delivered','completed','cancelled'));

create or replace function public.change_order_status(p_order_id bigint,p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_line record;
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if p_status not in ('pending','awaiting_payment','paid','confirmed','preparing','shipped','delivered','completed','cancelled') then raise exception 'INVALID_STATUS'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_order.status='cancelled' and p_status<>'cancelled' then raise exception 'FINAL'; end if;
  if v_order.status<>'cancelled' and p_status='cancelled' then
    for v_line in select product_id,quantity from public.order_items where order_id=p_order_id
    loop
      update public.products set stock=stock+v_line.quantity,version=version+1,updated_at=v_now where id=v_line.product_id;
    end loop;
  end if;
  update public.orders set status=p_status,updated_at=v_now where id=p_order_id;
  return jsonb_build_object('from_status',v_order.status,'to_status',p_status);
end;
$$;
