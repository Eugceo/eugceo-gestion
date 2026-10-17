-- EUGCEO Gestion : tables, droits d'accès, temps réel, fichiers

create table if not exists public.membres (
  email text primary key,
  nom text
);

create or replace function public.est_membre() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.membres m where lower(m.email) = lower(auth.jwt() ->> 'email'));
$$;

do $$
declare t text;
begin
  foreach t in array array['produits','ventes','achats','depenses','financement','abonnements','mouvements','reglages','suppressions'] loop
    execute format('create table if not exists public.%I (
      id text primary key default gen_random_uuid()::text,
      data jsonb not null default ''{}''::jsonb,
      updated_at timestamptz not null default now(),
      updated_by uuid default auth.uid()
    )', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists membres_tout on public.%I', t);
    execute format('create policy membres_tout on public.%I for all to authenticated using (public.est_membre()) with check (public.est_membre())', t);
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;

alter table public.membres enable row level security;
drop policy if exists soi_meme on public.membres;
create policy soi_meme on public.membres for select to authenticated using (lower(email) = lower(auth.jwt() ->> 'email'));

-- temps réel
do $$
declare t text;
begin
  foreach t in array array['produits','ventes','achats','depenses','financement','abonnements','mouvements','reglages','suppressions'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- fichiers (justificatifs), privés
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('justificatifs', 'justificatifs', false, 20971520, array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict (id) do nothing;

drop policy if exists justificatifs_membres on storage.objects;
create policy justificatifs_membres on storage.objects for all to authenticated
  using (bucket_id = 'justificatifs' and public.est_membre())
  with check (bucket_id = 'justificatifs' and public.est_membre());

-- matières premières (ajout du 17/10/2026)
create table if not exists public.matieres (
  id text primary key default gen_random_uuid()::text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.matieres enable row level security;
create policy membres_tout on public.matieres for all to authenticated using ((select public.est_membre())) with check ((select public.est_membre()));
alter table public.matieres replica identity full;
alter publication supabase_realtime add table public.matieres;
