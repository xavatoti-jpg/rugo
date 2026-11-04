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

-- ============ My Chats (favoritos) ============
create table if not exists public.favorites (
  user_id uuid not null references auth.users (id) on delete cascade,
  room_id text not null,
  title text not null,
  genre text,
  start_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, room_id)
);
alter table public.favorites enable row level security;
grant select, insert, update, delete on public.favorites to service_role;

-- ============ Mensajes del chat (se guardan 7 días) ============
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  room_id text not null,
  user_id uuid references auth.users (id) on delete set null,
  name text not null,
  avatar text,
  text text not null check (char_length(text) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists messages_room_time on public.messages (room_id, created_at desc);
create index if not exists messages_time on public.messages (created_at);
alter table public.messages enable row level security;
grant select, insert, delete on public.messages to service_role;

-- ============ Moderación ============
-- Rol de cada cuenta: user, mod o admin
alter table public.profiles add column if not exists role text not null default 'user'
  check (role in ('user', 'mod', 'admin'));

-- Silenciados y baneados (room_id vacío = baneado de todos los chats)
create table if not exists public.moderation (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  username text,
  room_id text,
  kind text not null check (kind in ('mute', 'ban')),
  until timestamptz,
  reason text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists moderation_user on public.moderation (user_id);
alter table public.moderation enable row level security;
grant select, insert, update, delete on public.moderation to service_role;

-- Identificador de cada mensaje (para poder borrarlos)
alter table public.messages add column if not exists mid text;
create index if not exists messages_mid on public.messages (mid);

-- ============ Settings del perfil ============
alter table public.profiles add column if not exists name_color text;
alter table public.profiles add column if not exists show_photo boolean not null default true;
alter table public.messages add column if not exists color text;
