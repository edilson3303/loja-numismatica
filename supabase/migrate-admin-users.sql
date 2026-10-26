-- Adiciona suporte a ativação/desativação de administradores.
-- Execute UMA VEZ no Supabase SQL Editor em uma instalação já existente.

alter table public.users
  add column if not exists active boolean not null default true;

update public.users set active=true where active is null;

create index if not exists users_active_idx on public.users(active,id);
