-- Rugo: tabla de perfiles (nombre de usuario de cada cuenta)
-- Pegar en Supabase → SQL Editor → Run

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  avatar_url text,
  created_at timestamptz not null default now()
);

-- Nombres únicos sin importar mayúsculas (Xavi = xavi)
create unique index if not exists profiles_username_lower on public.profiles (lower(username));

-- Seguridad: cualquiera puede ver nombres; solo el servidor de Rugo puede crearlos
alter table public.profiles enable row level security;
drop policy if exists "Perfiles visibles para todos" on public.profiles;
create policy "Perfiles visibles para todos" on public.profiles for select using (true);

-- Permisos (necesario si "Automatically expose new tables" está desactivado)
grant usage on schema public to anon, authenticated, service_role;
grant select on public.profiles to anon, authenticated;
grant select, insert, update, delete on public.profiles to service_role;
