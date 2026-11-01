-- EUGCEO : codes de parrainage et cagnotte
-- Chaque cliente a un code unique. Une autre cliente qui l'utilise a -10 %
-- (à partir d'un minimum d'achat). La propriétaire gagne 10 % de cagnotte par
-- commande payée, une fois le délai de rétractation passé. La cagnotte se
-- vide quand elle est utilisée. Réglages : table reglages, ligne 'prix'.

create table if not exists public.codes_promo (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.codes_promo enable row level security;
drop policy if exists membres_tout on public.codes_promo;
create policy membres_tout on public.codes_promo for all to authenticated
  using (public.est_membre()) with check (public.est_membre());
alter table public.codes_promo replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.codes_promo;
exception when others then null; end $$;

-- nom simplifié (minuscules, sans accents, sans [TEST])
create or replace function public.nom_simple(p text) returns text
language sql immutable set search_path = public as $$
  select btrim(regexp_replace(translate(lower(regexp_replace(coalesce(p,''), '^\s*\[test\]\s*', '', 'i')),
    'àâäáãåçéèêëíìîïñóòôöõúùûüýÿœ', 'aaaaaaceeeeiiiinooooouuuuyyo'), '\s+', ' ', 'g'));
$$;

-- réglages du parrainage
create or replace function public.parrainage_reglages() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pct',      coalesce((select nullif(data->>'parrainPct','')::numeric from reglages where id='prix'), 10),
    'min',      coalesce((select nullif(data->>'parrainMin','')::numeric from reglages where id='prix'), 150),
    'plafond',  coalesce((select nullif(data->>'parrainPlafond','')::numeric from reglages where id='prix'), 250),
    'delai',    coalesce((select nullif(data->>'parrainDelai','')::numeric from reglages where id='prix'), 14));
$$;

-- état complet d'un code (usage interne : app et paiement)
create or replace function public._parrainage_etat(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c record; R jsonb := parrainage_reglages(); dern date; nb int; att int; tot int; pct numeric;
begin
  select id, data into c from codes_promo where id = upper(btrim(coalesce(p_code,'')));
  if not found then return null; end if;
  select max(nullif(data->>'cagnotteLe','')::date) into dern
    from ventes where data->>'cagnotteCode' = c.id and data->>'statut' in ('Payée','En attente de paiement');
  -- une commande = un paiementId (ou une vente seule) ; acquise quand payée + délai passé
  with cmd as (
    select coalesce(nullif(data->>'paiementId',''), id) k,
           bool_and(data->>'statut' = 'Payée') payee,
           max(coalesce(nullif(data->>'dateEncaissement',''), data->>'date')::date) + (R->>'delai')::int acquis
    from ventes
    where data->>'codePromo' = c.id and data->>'statut' in ('Payée','En attente de paiement')
      and coalesce(data->>'client','') !~* '^\s*\[test\]'
    group by 1)
  select count(*) filter (where payee and acquis <= current_date and (dern is null or acquis > dern)),
         count(*) filter (where not payee or acquis > current_date),
         count(*)
    into nb, att, tot from cmd;
  pct := least(100, nb * (R->>'pct')::numeric);
  return jsonb_build_object('code', c.id, 'cliente', c.data->>'cliente', 'email', c.data->>'email',
    'pct', pct, 'filleules', tot, 'enAttente', att, 'derniereUtilisation', dern,
    'plafond', (R->>'plafond')::numeric, 'min', (R->>'min')::numeric, 'remise', (R->>'pct')::numeric);
end $$;
revoke all on function public._parrainage_etat(text) from public, anon, authenticated;

-- pour l'app (membres seulement)
create or replace function public.parrainage_infos(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not est_membre() then raise exception 'interdit'; end if;
  return _parrainage_etat(p_code);
end $$;

-- code d'une cliente : le retrouve ou le crée (app et paiement)
create or replace function public.code_cliente(p_nom text, p_email text default '', p_tel text default '')
returns text language plpgsql security definer set search_path = public as $$
declare
  em text := lower(btrim(coalesce(p_email,''))); nm text := nom_simple(p_nom);
  ex text; pre text; cand text; i int := 0;
begin
  if not (est_membre() or coalesce(auth.role(),'') = 'service_role') then raise exception 'interdit'; end if;
  if nm = '' and em = '' then return null; end if;
  if coalesce(p_nom,'') ~* '^\s*\[test\]' then return null; end if;
  select id into ex from codes_promo
    where (em <> '' and lower(data->>'email') = em) or (nm <> '' and nom_simple(data->>'cliente') = nm and (em = '' or coalesce(data->>'email','') = ''))
    order by (em <> '' and lower(data->>'email') = em) desc limit 1;
  if ex is not null then
    if em <> '' then
      update codes_promo set data = data || jsonb_build_object('email', em), updated_at = now()
        where id = ex and coalesce(data->>'email','') = '';
    end if;
    return ex;
  end if;
  pre := upper(left(regexp_replace(split_part(nm, ' ', 1), '[^a-z]', '', 'g'), 8));
  if pre = '' then pre := upper(left(regexp_replace(split_part(em,'@',1), '[^a-z]', '', 'g'), 8)); end if;
  if pre = '' then pre := 'EUG'; end if;
  loop
    i := i + 1;
    cand := pre || lpad((floor(random() * case when i < 60 then 100 else 1000 end))::int::text,
                        case when i < 60 then 2 else 3 end, '0');
    exit when not exists (select 1 from codes_promo where id = cand);
    if i > 200 then raise exception 'code'; end if;
  end loop;
  insert into codes_promo(id, data) values (cand, jsonb_build_object(
    'cliente', btrim(p_nom), 'email', em, 'telephone', btrim(coalesce(p_tel,'')), 'creeLe', now()));
  return cand;
end $$;

-- pour le site : vérifie un code ; la cagnotte n'est montrée qu'à sa propriétaire (même e-mail)
create or replace function public.code_verifier(p_code text, p_email text default '', p_nom text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare e jsonb; em text := lower(btrim(coalesce(p_email,'')));
begin
  e := _parrainage_etat(p_code);
  if e is null then return jsonb_build_object('valide', false); end if;
  if (em <> '' and lower(e->>'email') = em)
     or (coalesce(e->>'email','') = '' and nom_simple(p_nom) <> '' and nom_simple(p_nom) = nom_simple(e->>'cliente')) then
    return jsonb_build_object('valide', true, 'proprio', true, 'code', e->>'code',
      'pct', e->'pct', 'plafond', e->'plafond');
  end if;
  return jsonb_build_object('valide', true, 'proprio', false, 'code', e->>'code',
    'remise', e->'remise', 'min', e->'min');
end $$;
grant execute on function public.code_verifier(text, text, text) to anon, authenticated;

-- page merci : code de la cliente après un paiement (l'identifiant de session Stripe sert de clé)
create or replace function public.code_de_session(p_session text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('code', p.data->>'codeCliente', 'prenom', split_part(p.data#>>'{client,nom}', ' ', 1))
  from paiements p where p.id = p_session and length(p_session) > 20 and p.data->>'statut' = 'payé'
    and coalesce(p.data->>'codeCliente','') <> '';
$$;
grant execute on function public.code_de_session(text) to anon, authenticated;

revoke all on function public.code_cliente(text,text,text) from public, anon;
grant execute on function public.code_cliente(text,text,text) to authenticated, service_role;
revoke all on function public.parrainage_infos(text) from public, anon;
grant execute on function public.parrainage_infos(text) to authenticated;
