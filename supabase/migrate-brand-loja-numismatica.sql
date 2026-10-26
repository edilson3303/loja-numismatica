-- Execute UMA VEZ em bancos já existentes.
-- Atualiza somente o nome antigo da loja, preservando as demais configurações.

update public.settings
set value = 'Loja numismática',
    updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
where key = 'brand'
  and lower(trim(value)) in ('feira de moedas', 'feira numismática');

update public.settings
set value = regexp_replace(
              regexp_replace(value, 'Feira de Moedas', 'Loja numismática', 'gi'),
              'Feira\s*(<span[^>]*>)Numismática(</span>)',
              'Loja \1numismática\2',
              'gi'
            ),
    updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
where key = 'brand_html'
  and value ~* 'Feira';

update public.settings
set value = regexp_replace(value, 'Feira Numismática', 'Loja numismática', 'gi'),
    updated_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
where key = 'brand_html'
  and value ~* 'Feira Numismática';
