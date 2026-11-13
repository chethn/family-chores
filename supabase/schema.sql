-- =============================================================================
-- Family Chores — Supabase backend (Postgres 15+; built on PG 17)
-- =============================================================================
-- Security model
--   * All data lives in schema `app`, which is NOT exposed by the Data API
--     (PostgREST exposes only `public` / `graphql_public` by default).
--   * Every table has RLS enabled with ZERO policies, and anon/authenticated
--     have NO table privileges. Nobody can read/write tables directly.
--   * Business logic = SECURITY DEFINER functions in `app` (owner: postgres),
--     each with `set search_path = ''` and fully-qualified names.
--   * The only things the browser can reach are thin SECURITY INVOKER SQL
--     wrappers in `public` (generated at the bottom of this file) that call the
--     matching `app.*` function. anon gets USAGE on `app` + EXECUTE on the API
--     functions only; helper functions (prefixed `_`) are not executable by
--     anon/authenticated.
--   * Identity: 4-digit PIN per profile (bcrypt via pgcrypto). login() returns
--     a random 256-bit session token; only its SHA-256 is stored. Every RPC
--     takes p_token and derives caller + role server-side.
--
-- Re-running this file DROPS AND RECREATES schema `app` (all data is lost).
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

drop schema if exists app cascade;   -- also drops the public wrappers (BEGIN ATOMIC deps)
create schema app;
revoke all on schema app from public;
grant usage on schema app to anon, authenticated;  -- needed so public wrappers can call app API fns

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table app.profiles (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  role            text not null check (role in ('parent','kid')),
  age             smallint,
  device          text,
  avatar          text,
  color           text,
  sort_order      smallint not null default 0,
  pin_hash        text,
  pin_set_at      timestamptz,
  failed_attempts smallint not null default 0,
  lockouts        smallint not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

create table app.settings (
  id           boolean primary key default true check (id),
  rate_points  integer not null default 10 check (rate_points > 0),
  rate_dollars numeric(10,2) not null default 1.00 check (rate_dollars > 0),
  currency     text not null default 'NZD',
  timezone     text not null default 'Pacific/Auckland',
  updated_at   timestamptz not null default now(),
  updated_by   uuid references app.profiles(id) on delete set null
);
create index on app.settings(updated_by);

create table app.sessions (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references app.profiles(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index on app.sessions(profile_id);

create table app.chores (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(btrim(title)) between 1 and 120),
  description text check (description is null or length(description) <= 2000),
  points      integer not null check (points between 1 and 100000),
  repeat      text not null default 'none' check (repeat in ('none','daily','weekly')),
  weekdays    smallint[] not null default '{}',   -- ISO: 1=Mon … 7=Sun (weekly only)
  start_date  date not null,                      -- first day recurring instances can exist
  due_date    date,                               -- one-off deadline (null = none)
  archived_at timestamptz,
  created_by  uuid references app.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on app.chores(created_by);

create table app.chore_assignees (
  chore_id    uuid not null references app.chores(id) on delete cascade,
  kid_id      uuid not null references app.profiles(id) on delete cascade,
  active_from date not null,     -- no recurring instances are generated before this
  primary key (chore_id, kid_id)
);
create index on app.chore_assignees(kid_id);

create table app.chore_instances (
  id           uuid primary key default gen_random_uuid(),
  chore_id     uuid not null references app.chores(id) on delete cascade,
  kid_id       uuid not null references app.profiles(id) on delete cascade,
  period_date  date not null,    -- recurring: the day it is for; one-off: day created
  due_date     date,             -- recurring: = period_date; one-off: chore.due_date
  points       integer not null,
  status       text not null default 'open'
               check (status in ('open','submitted','approved','rejected','lapsed')),
  kid_note     text check (kid_note is null or length(kid_note) <= 500),
  submitted_at timestamptz,
  reviewed_at  timestamptz,
  reviewed_by  uuid references app.profiles(id) on delete set null,
  review_note  text check (review_note is null or length(review_note) <= 500),
  lapsed_at    timestamptz,
  created_at   timestamptz not null default now(),
  unique (chore_id, kid_id, period_date)
);
create index on app.chore_instances(kid_id, period_date);
create index on app.chore_instances(status);
create index on app.chore_instances(reviewed_by);

create table app.instance_photos (
  instance_id uuid primary key references app.chore_instances(id) on delete cascade,
  mime        text not null check (mime in ('image/jpeg','image/png','image/webp')),
  data        bytea not null,
  bytes       integer not null check (bytes between 1 and 614400),
  created_at  timestamptz not null default now()
);

create table app.wishes (
  id            uuid primary key default gen_random_uuid(),
  kid_id        uuid not null references app.profiles(id) on delete cascade,
  title         text not null check (length(btrim(title)) between 1 and 120),
  link          text check (link is null or (link ~* '^https?://' and length(link) <= 1000)),
  price_dollars numeric(10,2) check (price_dollars is null or price_dollars > 0),
  points_cost   integer check (points_cost is null or points_cost > 0),
  status        text not null default 'active' check (status in ('active','redeemed','removed')),
  created_by    uuid references app.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  redeemed_at   timestamptz,
  check (price_dollars is not null or points_cost is not null)
);
create index on app.wishes(kid_id);
create index on app.wishes(created_by);

create table app.redeem_requests (
  id            uuid primary key default gen_random_uuid(),
  wish_id       uuid not null references app.wishes(id) on delete cascade,
  kid_id        uuid not null references app.profiles(id) on delete cascade,
  points        integer not null check (points > 0),
  dollars       numeric(10,2) not null,
  status        text not null default 'pending'
                check (status in ('pending','approved','declined','cancelled')),
  kid_note      text check (kid_note is null or length(kid_note) <= 500),
  decision_note text check (decision_note is null or length(decision_note) <= 500),
  decided_by    uuid references app.profiles(id) on delete set null,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create unique index redeem_one_pending_per_wish on app.redeem_requests(wish_id) where status = 'pending';
create index on app.redeem_requests(kid_id);
create index on app.redeem_requests(decided_by);

create table app.ledger (
  id          uuid primary key default gen_random_uuid(),
  kid_id      uuid not null references app.profiles(id) on delete cascade,
  delta       integer not null check (delta <> 0),
  kind        text not null check (kind in ('chore','redeem','bonus','adjust')),
  instance_id uuid unique references app.chore_instances(id) on delete set null,
  redeem_id   uuid unique references app.redeem_requests(id) on delete set null,
  note        text check (note is null or length(note) <= 500),
  created_by  uuid references app.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index on app.ledger(kid_id, created_at desc);
create index on app.ledger(created_by);

create table app.notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references app.profiles(id) on delete cascade,
  kind         text not null,
  title        text not null,
  body         text,
  instance_id  uuid references app.chore_instances(id) on delete cascade,
  redeem_id    uuid references app.redeem_requests(id) on delete cascade,
  wish_id      uuid references app.wishes(id) on delete cascade,
  actor_id     uuid references app.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index on app.notifications(recipient_id, created_at desc);
create index on app.notifications(instance_id);
create index on app.notifications(redeem_id);
create index on app.notifications(wish_id);
create index on app.notifications(actor_id);

-- Lock everything down: RLS on, no policies, no grants.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t.tablename);
    execute format('revoke all on table app.%I from public, anon, authenticated', t.tablename);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Seed
-- -----------------------------------------------------------------------------
insert into app.settings (id, rate_points, rate_dollars) values (true, 10, 1.00);

insert into app.profiles (slug, name, role, age, device, avatar, color, sort_order) values
  ('dad',  'Dad',  'parent', null, null,     '👨', '#2563eb', 1),
  ('mom',  'Mom',  'parent', null, null,     '👩', '#db2777', 2),
  ('akin', 'Akin', 'kid',    11,   'phone',  '🧒', '#16a34a', 3),
  ('niko', 'Niko', 'kid',    6,    'ipad',   '👦', '#f59e0b', 4);

-- -----------------------------------------------------------------------------
-- Internal helpers (prefixed `_`; NOT executable by anon/authenticated)
-- -----------------------------------------------------------------------------
create function app._err(p_code text, p_detail text default null)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_detail, '');
end $$;

create function app._tz() returns text language sql stable set search_path = '' as $$
  select timezone from app.settings where id
$$;

create function app._today() returns date language sql stable set search_path = '' as $$
  select (now() at time zone app._tz())::date
$$;

create function app._to_dollars(p_points bigint) returns numeric
language sql stable set search_path = '' as $$
  select round(p_points * s.rate_dollars / s.rate_points, 2) from app.settings s where s.id
$$;

create function app._wish_cost(p_points_cost integer, p_price_dollars numeric) returns integer
language sql stable set search_path = '' as $$
  select coalesce(p_points_cost, ceil(p_price_dollars * s.rate_points / s.rate_dollars)::integer)
  from app.settings s where s.id
$$;

create function app._balance(p_kid uuid) returns bigint
language sql stable set search_path = '' as $$
  select coalesce(sum(delta), 0) from app.ledger where kid_id = p_kid
$$;

create function app._pending_redeem(p_kid uuid, p_exclude_wish uuid default null) returns bigint
language sql stable set search_path = '' as $$
  select coalesce(sum(points), 0) from app.redeem_requests
  where kid_id = p_kid and status = 'pending'
    and (p_exclude_wish is null or wish_id <> p_exclude_wish)
$$;

create function app._profile_json(p app.profiles) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'slug', p.slug, 'name', p.name, 'role', p.role, 'age', p.age,
    'device', p.device, 'avatar', p.avatar, 'color', p.color,
    'has_pin', p.pin_hash is not null,
    'locked_until', case when p.locked_until > now() then p.locked_until end)
$$;

create function app._session(p_token text) returns app.profiles
language plpgsql set search_path = '' as $$
declare s app.sessions; v app.profiles;
begin
  if p_token is null or length(p_token) <> 64 then perform app._err('invalid_session'); end if;
  select * into s from app.sessions
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if not found or s.expires_at < now() then perform app._err('invalid_session'); end if;
  if s.last_seen_at < now() - interval '1 hour' then   -- sliding 30-day expiry
    update app.sessions set last_seen_at = now(),
           expires_at = greatest(expires_at, now() + interval '30 days')
     where id = s.id;
  end if;
  select * into v from app.profiles where id = s.profile_id;
  return v;
end $$;

create function app._require_parent(p_token text) returns app.profiles
language plpgsql set search_path = '' as $$
declare v app.profiles;
begin
  v := app._session(p_token);
  if v.role <> 'parent' then perform app._err('forbidden', 'parent only'); end if;
  return v;
end $$;

create function app._require_kid(p_token text) returns app.profiles
language plpgsql set search_path = '' as $$
declare v app.profiles;
begin
  v := app._session(p_token);
  if v.role <> 'kid' then perform app._err('forbidden', 'kid only'); end if;
  return v;
end $$;

-- Kid filter: kids are forced to themselves; parents may pass a kid id or null (= all kids).
create function app._scope_kid(p_caller app.profiles, p_kid uuid) returns uuid
language plpgsql set search_path = '' as $$
begin
  if p_caller.role = 'kid' then
    if p_kid is not null and p_kid <> p_caller.id then perform app._err('forbidden', 'kids can only see their own data'); end if;
    return p_caller.id;
  end if;
  if p_kid is not null and not exists (select 1 from app.profiles where id = p_kid and role = 'kid') then
    perform app._err('invalid_kid');
  end if;
  return p_kid;
end $$;

create function app._notify(p_recipient uuid, p_kind text, p_title text, p_body text,
                            p_actor uuid, p_instance uuid default null,
                            p_redeem uuid default null, p_wish uuid default null)
returns void language sql set search_path = '' as $$
  insert into app.notifications (recipient_id, kind, title, body, actor_id, instance_id, redeem_id, wish_id)
  values (p_recipient, p_kind, p_title, p_body, p_actor, p_instance, p_redeem, p_wish)
$$;

create function app._notify_parents(p_kind text, p_title text, p_body text, p_actor uuid,
                                    p_instance uuid default null, p_redeem uuid default null,
                                    p_wish uuid default null)
returns void language sql set search_path = '' as $$
  insert into app.notifications (recipient_id, kind, title, body, actor_id, instance_id, redeem_id, wish_id)
  select id, p_kind, p_title, p_body, p_actor, p_instance, p_redeem, p_wish
  from app.profiles where role = 'parent'
$$;

create function app._new_session(p_profile uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare v_token text := encode(extensions.gen_random_bytes(32), 'hex');
        v_exp timestamptz := now() + interval '30 days';
        v app.profiles;
begin
  delete from app.sessions where expires_at < now();
  insert into app.sessions (profile_id, token_hash, expires_at)
  values (p_profile, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_exp);
  select * into v from app.profiles where id = p_profile;
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_exp,
                            'profile', app._profile_json(v));
end $$;

-- Generates recurring instances up to today and lapses missed ones. Idempotent.
create function app._materialize() returns void
language plpgsql set search_path = '' as $$
declare v_today date := app._today(); v_tz text := app._tz();
begin
  insert into app.chore_instances (chore_id, kid_id, period_date, due_date, points)
  select c.id, a.kid_id, d::date, d::date, c.points
  from app.chores c
  join app.chore_assignees a on a.chore_id = c.id
  cross join lateral generate_series(
      greatest(c.start_date, a.active_from, v_today - 62)::timestamp,
      v_today::timestamp, interval '1 day') d
  where c.archived_at is null
    and c.repeat in ('daily','weekly')
    and (c.repeat = 'daily' or extract(isodow from d)::smallint = any (c.weekdays))
  on conflict (chore_id, kid_id, period_date) do nothing;

  -- missed: open past its due day; or rejected past its due day and the
  -- rejection happened before today (kid gets the rest of the rejection day to redo)
  update app.chore_instances i
     set status = 'lapsed', lapsed_at = now()
   where i.due_date < v_today
     and (i.status = 'open'
          or (i.status = 'rejected' and (i.reviewed_at at time zone v_tz)::date < v_today));
end $$;

create function app._chore_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'title', c.title, 'description', c.description, 'points', c.points,
    'dollars', app._to_dollars(c.points), 'repeat', c.repeat, 'weekdays', to_jsonb(c.weekdays),
    'start_date', c.start_date, 'due_date', c.due_date,
    'archived', c.archived_at is not null, 'archived_at', c.archived_at,
    'created_at', c.created_at, 'updated_at', c.updated_at,
    'assignees', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order)
                           from app.chore_assignees a join app.profiles p on p.id = a.kid_id
                           where a.chore_id = c.id), '[]'::jsonb))
  from app.chores c where c.id = p_id
$$;

create function app._instance_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id, 'chore_id', i.chore_id, 'kid_id', i.kid_id, 'kid_name', k.name,
    'title', c.title, 'description', c.description, 'repeat', c.repeat,
    'points', i.points, 'dollars', app._to_dollars(i.points),
    'period_date', i.period_date, 'due_date', i.due_date, 'status', i.status,
    'kid_note', i.kid_note, 'submitted_at', i.submitted_at,
    'reviewed_at', i.reviewed_at, 'reviewed_by_name', r.name, 'review_note', i.review_note,
    'lapsed_at', i.lapsed_at,
    'has_photo', exists (select 1 from app.instance_photos ph where ph.instance_id = i.id),
    'can_complete', i.status in ('open','rejected') and c.archived_at is null,
    'chore_archived', c.archived_at is not null)
  from app.chore_instances i
  join app.chores c on c.id = i.chore_id
  join app.profiles k on k.id = i.kid_id
  left join app.profiles r on r.id = i.reviewed_by
  where i.id = p_id
$$;

create function app._wish_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', w.id, 'kid_id', w.kid_id, 'kid_name', k.name, 'title', w.title, 'link', w.link,
    'price_dollars', w.price_dollars, 'points_cost', w.points_cost,
    'cost_points', app._wish_cost(w.points_cost, w.price_dollars),
    'cost_dollars', coalesce(w.price_dollars, app._to_dollars(app._wish_cost(w.points_cost, w.price_dollars))),
    'status', w.status, 'created_at', w.created_at, 'redeemed_at', w.redeemed_at,
    'available_points', app._balance(w.kid_id) - app._pending_redeem(w.kid_id, w.id),
    'eligible', w.status = 'active' and
                app._balance(w.kid_id) - app._pending_redeem(w.kid_id, w.id)
                  >= app._wish_cost(w.points_cost, w.price_dollars),
    'points_needed', greatest(0, app._wish_cost(w.points_cost, w.price_dollars)
                  - (app._balance(w.kid_id) - app._pending_redeem(w.kid_id, w.id))),
    'pending_request', (select jsonb_build_object('id', r.id, 'points', r.points, 'created_at', r.created_at)
                        from app.redeem_requests r where r.wish_id = w.id and r.status = 'pending'))
  from app.wishes w join app.profiles k on k.id = w.kid_id
  where w.id = p_id
$$;

create function app._redeem_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'wish_id', r.wish_id, 'wish_title', w.title, 'wish_link', w.link,
    'kid_id', r.kid_id, 'kid_name', k.name, 'points', r.points, 'dollars', r.dollars,
    'status', r.status, 'kid_note', r.kid_note, 'decision_note', r.decision_note,
    'decided_by_name', d.name, 'decided_at', r.decided_at, 'created_at', r.created_at,
    'kid_balance', app._balance(r.kid_id))
  from app.redeem_requests r
  join app.wishes w on w.id = r.wish_id
  join app.profiles k on k.id = r.kid_id
  left join app.profiles d on d.id = r.decided_by
  where r.id = p_id
$$;

create function app._clean_text(p text, p_max int) returns text
language sql immutable set search_path = '' as $$
  select case when p is null or btrim(p) = '' then null else left(btrim(p), p_max) end
$$;

-- =============================================================================
-- API (SECURITY DEFINER, exposed via public wrappers)
-- =============================================================================

-- ---------- Profiles & auth -------------------------------------------------
create function app.list_profiles() returns jsonb
language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(app._profile_json(p) order by p.sort_order), '[]'::jsonb) from app.profiles p
$$;

create function app.set_initial_pin(p_profile uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  select * into v from app.profiles where id = p_profile for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v.pin_hash is not null then return jsonb_build_object('ok', false, 'error', 'pin_already_set'); end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_pin_format');
  end if;
  update app.profiles
     set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), pin_set_at = now(),
         failed_attempts = 0, lockouts = 0, locked_until = null
   where id = v.id;
  return app._new_session(v.id);
end $$;

create function app.login(p_profile uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles; v_until timestamptz; v_fail int;
begin
  select * into v from app.profiles where id = p_profile for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v.pin_hash is null then return jsonb_build_object('ok', false, 'error', 'pin_not_set'); end if;
  if v.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked', 'locked_until', v.locked_until);
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_pin_format');
  end if;
  if extensions.crypt(p_pin, v.pin_hash) <> v.pin_hash then
    v_fail := v.failed_attempts + 1;
    if v_fail >= 5 then
      -- 5 min, then 10, 20, … capped at 24 h; resets on a successful login
      v_until := now() + least(interval '5 minutes' * power(2, v.lockouts), interval '24 hours');
      update app.profiles set failed_attempts = 0, lockouts = lockouts + 1, locked_until = v_until
       where id = v.id;
      perform app._notify_parents('pin_locked', v.name || '''s code is locked',
        'Too many wrong codes. Locked until ' ||
        to_char(v_until at time zone app._tz(), 'HH24:MI') || '.', null);
      return jsonb_build_object('ok', false, 'error', 'locked', 'locked_until', v_until);
    end if;
    update app.profiles set failed_attempts = v_fail where id = v.id;
    return jsonb_build_object('ok', false, 'error', 'wrong_pin', 'attempts_left', 5 - v_fail);
  end if;
  update app.profiles set failed_attempts = 0, lockouts = 0, locked_until = null where id = v.id;
  return app._new_session(v.id);
end $$;

create function app.logout(p_token text) returns boolean
language sql security definer set search_path = '' as $$
  with d as (delete from app.sessions
             where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
             returning 1)
  select exists (select 1 from d)
$$;

create function app.whoami(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  v := app._session(p_token);
  return jsonb_build_object(
    'profile', app._profile_json(v),
    'settings', (select jsonb_build_object('rate_points', s.rate_points, 'rate_dollars', s.rate_dollars,
                   'currency', s.currency, 'timezone', s.timezone, 'today', app._today())
                 from app.settings s where s.id),
    'unread_count', (select count(*) from app.notifications where recipient_id = v.id and read_at is null));
end $$;

create function app.change_pin(p_token text, p_current_pin text, p_new_pin text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v app.profiles;
begin
  v := app._session(p_token);
  if p_new_pin is null or p_new_pin !~ '^[0-9]{4}$' then perform app._err('invalid_pin_format'); end if;
  if p_current_pin is null or extensions.crypt(p_current_pin, v.pin_hash) <> v.pin_hash then
    perform app._err('wrong_pin');
  end if;
  update app.profiles set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
         pin_set_at = now() where id = v.id;
  delete from app.sessions where profile_id = v.id
     and token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex');
  return true;
end $$;

create function app.reset_pin(p_token text, p_profile uuid, p_new_pin text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me app.profiles; t app.profiles;
begin
  me := app._require_parent(p_token);
  select * into t from app.profiles where id = p_profile for update;
  if not found then perform app._err('not_found'); end if;
  if p_new_pin is not null and p_new_pin !~ '^[0-9]{4}$' then perform app._err('invalid_pin_format'); end if;
  update app.profiles
     set pin_hash = case when p_new_pin is null then null
                         else extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)) end,
         pin_set_at = case when p_new_pin is null then null else now() end,
         failed_attempts = 0, lockouts = 0, locked_until = null
   where id = t.id;
  -- sign the profile out everywhere (except the caller's own current session)
  delete from app.sessions where profile_id = t.id
     and token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex');
  if t.id <> me.id then
    perform app._notify(t.id, 'pin_reset', 'Your code was reset',
      case when p_new_pin is null then me.name || ' cleared your code. Pick your name to set a new one.'
           else me.name || ' set a new code for you.' end, me.id);
  end if;
  select * into t from app.profiles where id = p_profile;
  return app._profile_json(t);
end $$;

-- ---------- Settings --------------------------------------------------------
create function app.get_settings(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app._session(p_token);
  return (select jsonb_build_object('rate_points', s.rate_points, 'rate_dollars', s.rate_dollars,
            'currency', s.currency, 'timezone', s.timezone, 'today', app._today(),
            'updated_at', s.updated_at)
          from app.settings s where s.id);
end $$;

create function app.update_settings(p_token text, p_rate_points integer, p_rate_dollars numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me app.profiles;
begin
  me := app._require_parent(p_token);
  if p_rate_points is null or p_rate_points < 1 or p_rate_points > 1000000
     or p_rate_dollars is null or p_rate_dollars <= 0 or p_rate_dollars > 100000 then
    perform app._err('invalid_rate');
  end if;
  update app.settings set rate_points = p_rate_points, rate_dollars = round(p_rate_dollars, 2),
         updated_at = now(), updated_by = me.id where id;
  return app.get_settings(p_token);
end $$;

-- ---------- Chores ----------------------------------------------------------
create function app._validate_chore(p_title text, p_points integer, p_assignees uuid[],
                                    p_repeat text, p_weekdays integer[])
returns void language plpgsql set search_path = '' as $$
begin
  if app._clean_text(p_title, 120) is null then perform app._err('invalid_title'); end if;
  if p_points is null or p_points < 1 or p_points > 100000 then perform app._err('invalid_points'); end if;
  if p_repeat is null or p_repeat not in ('none','daily','weekly') then perform app._err('invalid_repeat'); end if;
  if p_assignees is null or cardinality(p_assignees) = 0 then perform app._err('invalid_assignees', 'at least one kid'); end if;
  if exists (select 1 from unnest(p_assignees) a(id)
             where not exists (select 1 from app.profiles p where p.id = a.id and p.role = 'kid')) then
    perform app._err('invalid_assignees', 'assignees must be kid profiles');
  end if;
  if p_weekdays is not null and exists (select 1 from unnest(p_weekdays) d where d < 1 or d > 7) then
    perform app._err('invalid_weekdays', 'ISO weekdays 1=Mon..7=Sun');
  end if;
end $$;

create function app.create_chore(
  p_token text, p_title text, p_points integer, p_assignees uuid[],
  p_description text default null, p_repeat text default 'none',
  p_weekdays integer[] default null, p_due_date date default null, p_start_date date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; v_today date := app._today(); v_start date; v_wd smallint[]; v_id uuid; k uuid;
begin
  me := app._require_parent(p_token);
  perform app._validate_chore(p_title, p_points, p_assignees, p_repeat, p_weekdays);
  v_start := coalesce(p_start_date, v_today);
  if p_repeat = 'none' then
    if p_due_date is not null and p_due_date < v_today then perform app._err('invalid_due_date', 'due date is in the past'); end if;
    v_wd := '{}';
  else
    if p_due_date is not null then perform app._err('invalid_due_date', 'recurring chores use start_date, not due_date'); end if;
    v_wd := case when p_repeat = 'daily' then '{}'::smallint[]
                 when coalesce(cardinality(p_weekdays), 0) = 0 then array[extract(isodow from v_start)::smallint]
                 else (select array_agg(distinct d::smallint order by d::smallint) from unnest(p_weekdays) d) end;
  end if;

  insert into app.chores (title, description, points, repeat, weekdays, start_date, due_date, created_by)
  values (app._clean_text(p_title, 120), app._clean_text(p_description, 2000), p_points, p_repeat,
          v_wd, v_start, p_due_date, me.id)
  returning id into v_id;

  foreach k in array (select array_agg(distinct x) from unnest(p_assignees) x) loop
    insert into app.chore_assignees (chore_id, kid_id, active_from) values (v_id, k, v_today);
    if p_repeat = 'none' then
      insert into app.chore_instances (chore_id, kid_id, period_date, due_date, points)
      values (v_id, k, v_today, p_due_date, p_points);
    end if;
    perform app._notify(k, 'chore_assigned', 'New chore: ' || app._clean_text(p_title, 120),
      p_points || ' points' || case p_repeat when 'daily' then ', every day'
                                             when 'weekly' then ', weekly' else '' end, me.id);
  end loop;
  perform app._materialize();
  return app._chore_json(v_id);
end $$;

create function app.update_chore(
  p_token text, p_chore_id uuid, p_title text, p_points integer, p_assignees uuid[],
  p_description text default null, p_repeat text default 'none',
  p_weekdays integer[] default null, p_due_date date default null, p_start_date date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; c app.chores; v_today date := app._today(); v_start date; v_wd smallint[];
        k uuid; v_kids uuid[];
begin
  me := app._require_parent(p_token);
  select * into c from app.chores where id = p_chore_id for update;
  if not found then perform app._err('not_found'); end if;
  perform app._validate_chore(p_title, p_points, p_assignees, p_repeat, p_weekdays);
  if (c.repeat = 'none') <> (p_repeat = 'none') then
    perform app._err('repeat_change_not_allowed', 'cannot switch between one-off and recurring; create a new chore');
  end if;
  v_start := coalesce(p_start_date, c.start_date);
  if p_repeat = 'none' then
    if p_due_date is not null and p_due_date < v_today and p_due_date is distinct from c.due_date then
      perform app._err('invalid_due_date', 'due date is in the past');
    end if;
    v_wd := '{}';
  else
    if p_due_date is not null then perform app._err('invalid_due_date', 'recurring chores use start_date, not due_date'); end if;
    v_wd := case when p_repeat = 'daily' then '{}'::smallint[]
                 when coalesce(cardinality(p_weekdays), 0) = 0 then array[extract(isodow from v_start)::smallint]
                 else (select array_agg(distinct d::smallint order by d::smallint) from unnest(p_weekdays) d) end;
  end if;
  select array_agg(distinct x) into v_kids from unnest(p_assignees) x;

  update app.chores set title = app._clean_text(p_title, 120), description = app._clean_text(p_description, 2000),
         points = p_points, repeat = p_repeat, weekdays = v_wd, start_date = v_start,
         due_date = case when p_repeat = 'none' then p_due_date end, updated_at = now()
   where id = c.id;

  -- not-yet-final instances take the new points / due date
  update app.chore_instances set points = p_points,
         due_date = case when p_repeat = 'none' then p_due_date else due_date end
   where chore_id = c.id and status in ('open','submitted','rejected');

  -- remove no-longer-scheduled open recurring instances (today onward)
  if p_repeat <> 'none' then
    delete from app.chore_instances i
     where i.chore_id = c.id and i.status = 'open' and i.period_date >= v_today
       and (i.period_date < v_start
            or (p_repeat = 'weekly' and not (extract(isodow from i.period_date)::smallint = any (v_wd))));
  end if;

  -- removed assignees: drop their open (current/future or one-off) instances
  delete from app.chore_instances i
   where i.chore_id = c.id and i.status = 'open' and not (i.kid_id = any (v_kids))
     and (p_repeat = 'none' or i.period_date >= v_today);
  delete from app.chore_assignees a where a.chore_id = c.id and not (a.kid_id = any (v_kids));

  -- added assignees
  foreach k in array v_kids loop
    if not exists (select 1 from app.chore_assignees where chore_id = c.id and kid_id = k) then
      insert into app.chore_assignees (chore_id, kid_id, active_from) values (c.id, k, v_today);
      if p_repeat = 'none' and c.archived_at is null then
        insert into app.chore_instances (chore_id, kid_id, period_date, due_date, points)
        values (c.id, k, v_today, p_due_date, p_points) on conflict do nothing;
      end if;
      perform app._notify(k, 'chore_assigned', 'New chore: ' || app._clean_text(p_title, 120),
                          p_points || ' points', me.id);
    end if;
  end loop;
  perform app._materialize();
  return app._chore_json(c.id);
end $$;

create function app.set_chore_archived(p_token text, p_chore_id uuid, p_archived boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; c app.chores; v_today date := app._today();
begin
  me := app._require_parent(p_token);
  select * into c from app.chores where id = p_chore_id for update;
  if not found then perform app._err('not_found'); end if;
  if coalesce(p_archived, true) then
    if c.archived_at is null then
      update app.chores set archived_at = now(), updated_at = now() where id = c.id;
      delete from app.chore_instances i where i.chore_id = c.id and i.status = 'open'
         and (c.repeat = 'none' or i.period_date >= v_today);
    end if;
  elsif c.archived_at is not null then
    update app.chores set archived_at = null, updated_at = now() where id = c.id;
    update app.chore_assignees set active_from = v_today where chore_id = c.id;  -- no backfill of archived span
    if c.repeat = 'none' then
      insert into app.chore_instances (chore_id, kid_id, period_date, due_date, points)
      select c.id, a.kid_id, v_today, c.due_date, c.points from app.chore_assignees a
       where a.chore_id = c.id
         and not exists (select 1 from app.chore_instances i where i.chore_id = c.id and i.kid_id = a.kid_id)
      on conflict do nothing;
    end if;
    perform app._materialize();
  end if;
  return app._chore_json(c.id);
end $$;

create function app.list_chores(p_token text, p_include_archived boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app._require_parent(p_token);
  return coalesce((select jsonb_agg(app._chore_json(c.id) order by c.archived_at nulls first, c.created_at desc)
                   from app.chores c where coalesce(p_include_archived, false) or c.archived_at is null), '[]'::jsonb);
end $$;

create function app.list_instances(p_token text, p_from date default null, p_to date default null,
                                   p_kid uuid default null, p_statuses text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; v_kid uuid; v_today date := app._today(); v_from date; v_to date;
begin
  me := app._session(p_token);
  v_kid := app._scope_kid(me, p_kid);
  perform app._materialize();
  v_to := coalesce(p_to, v_today);
  v_from := coalesce(p_from, v_today - 7);
  return coalesce((
    select jsonb_agg(app._instance_json(i.id)
                     order by i.period_date desc,
                              array_position(array['rejected','open','submitted','approved','lapsed'], i.status),
                              i.created_at)
    from app.chore_instances i
    where (v_kid is null or i.kid_id = v_kid)
      and (p_statuses is null or i.status = any (p_statuses))
      and i.period_date <= v_to
      and (i.period_date >= v_from or i.status in ('open','submitted','rejected'))), '[]'::jsonb);
end $$;

create function app.complete_instance(p_token text, p_instance_id uuid, p_note text default null,
                                      p_photo_base64 text default null, p_photo_mime text default 'image/jpeg')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; i app.chore_instances; v_bytes bytea; v_archived boolean;
begin
  me := app._require_kid(p_token);
  perform app._materialize();
  select * into i from app.chore_instances where id = p_instance_id and kid_id = me.id for update;
  if not found then perform app._err('not_found'); end if;
  select archived_at is not null into v_archived from app.chores where id = i.chore_id;
  if i.status not in ('open','rejected') or v_archived then
    perform app._err('invalid_status', 'instance is ' || i.status);
  end if;
  if p_photo_base64 is not null and p_photo_base64 <> '' then
    if coalesce(p_photo_mime, 'image/jpeg') not in ('image/jpeg','image/png','image/webp') then
      perform app._err('invalid_photo', 'mime must be image/jpeg, image/png or image/webp');
    end if;
    if length(p_photo_base64) > 900000 then perform app._err('photo_too_large', 'max 600 KB'); end if;
    begin
      v_bytes := decode(regexp_replace(p_photo_base64, '^data:[^,]*,|\s', '', 'g'), 'base64');
    exception when others then
      perform app._err('invalid_photo', 'not valid base64');
    end;
    if length(v_bytes) > 614400 then perform app._err('photo_too_large', 'max 600 KB'); end if;
    if length(v_bytes) = 0 then perform app._err('invalid_photo', 'empty'); end if;
    insert into app.instance_photos (instance_id, mime, data, bytes)
    values (i.id, coalesce(p_photo_mime, 'image/jpeg'), v_bytes, length(v_bytes))
    on conflict (instance_id) do update set mime = excluded.mime, data = excluded.data,
                                            bytes = excluded.bytes, created_at = now();
  else
    delete from app.instance_photos where instance_id = i.id;
  end if;
  update app.chore_instances set status = 'submitted', submitted_at = now(),
         kid_note = app._clean_text(p_note, 500)
   where id = i.id;
  perform app._notify_parents('chore_submitted',
    me.name || ' finished: ' || (select title from app.chores where id = i.chore_id),
    case when v_bytes is not null then 'Photo attached. ' else '' end || 'Tap to review.', me.id, i.id);
  return app._instance_json(i.id);
end $$;

create function app.get_instance_photo(p_token text, p_instance_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me app.profiles; r jsonb;
begin
  me := app._session(p_token);
  select jsonb_build_object('instance_id', ph.instance_id, 'mime', ph.mime, 'bytes', ph.bytes,
                            'base64', encode(ph.data, 'base64'), 'created_at', ph.created_at)
    into r
    from app.instance_photos ph join app.chore_instances i on i.id = ph.instance_id
   where ph.instance_id = p_instance_id and (me.role = 'parent' or i.kid_id = me.id);
  if r is null then perform app._err('not_found'); end if;
  return r;
end $$;

create function app.approve_instance(p_token text, p_instance_id uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; i app.chore_instances; v_title text;
begin
  me := app._require_parent(p_token);
  perform app._materialize();
  select * into i from app.chore_instances where id = p_instance_id for update;
  if not found then perform app._err('not_found'); end if;
  if i.status not in ('submitted','open','rejected') then
    perform app._err('invalid_status', 'instance is ' || i.status);
  end if;
  select title into v_title from app.chores where id = i.chore_id;
  update app.chore_instances set status = 'approved', reviewed_at = now(), reviewed_by = me.id,
         review_note = app._clean_text(p_note, 500)
   where id = i.id;
  insert into app.ledger (kid_id, delta, kind, instance_id, note, created_by)
  values (i.kid_id, i.points, 'chore', i.id, v_title, me.id);
  update app.notifications set read_at = now()
   where instance_id = i.id and kind = 'chore_submitted' and read_at is null;
  perform app._notify(i.kid_id, 'chore_approved', 'Approved: ' || v_title || ' (+' || i.points || ')',
                      app._clean_text(p_note, 500), me.id, i.id);
  return app._instance_json(i.id) || jsonb_build_object('kid_balance', app._balance(i.kid_id));
end $$;

create function app.reject_instance(p_token text, p_instance_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; i app.chore_instances; v_title text;
begin
  me := app._require_parent(p_token);
  if app._clean_text(p_note, 500) is null then perform app._err('note_required'); end if;
  select * into i from app.chore_instances where id = p_instance_id for update;
  if not found then perform app._err('not_found'); end if;
  if i.status <> 'submitted' then perform app._err('invalid_status', 'instance is ' || i.status); end if;
  select title into v_title from app.chores where id = i.chore_id;
  update app.chore_instances set status = 'rejected', reviewed_at = now(), reviewed_by = me.id,
         review_note = app._clean_text(p_note, 500)
   where id = i.id;
  update app.notifications set read_at = now()
   where instance_id = i.id and kind = 'chore_submitted' and read_at is null;
  perform app._notify(i.kid_id, 'chore_rejected', 'Try again: ' || v_title,
                      app._clean_text(p_note, 500), me.id, i.id);
  return app._instance_json(i.id);
end $$;

-- ---------- Points ----------------------------------------------------------
create function app.get_balances(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me app.profiles;
begin
  me := app._session(p_token);
  perform app._materialize();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'kid_id', k.id, 'name', k.name, 'avatar', k.avatar, 'color', k.color,
      'points', app._balance(k.id),
      'dollars', app._to_dollars(app._balance(k.id)),
      'pending_redeem_points', app._pending_redeem(k.id),
      'available_points', app._balance(k.id) - app._pending_redeem(k.id),
      'available_dollars', app._to_dollars(app._balance(k.id) - app._pending_redeem(k.id)),
      'awaiting_approval_points', (select coalesce(sum(points), 0) from app.chore_instances
                                   where kid_id = k.id and status = 'submitted'),
      'awaiting_approval_count', (select count(*) from app.chore_instances
                                  where kid_id = k.id and status = 'submitted'))
      order by k.sort_order)
    from app.profiles k where k.role = 'kid' and (me.role = 'parent' or k.id = me.id)), '[]'::jsonb);
end $$;

create function app.list_ledger(p_token text, p_kid uuid default null, p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; v_kid uuid;
begin
  me := app._session(p_token);
  v_kid := app._scope_kid(me, p_kid);
  return coalesce((
    select jsonb_agg(x.j order by x.created_at desc) from (
      select l.created_at, jsonb_build_object(
        'id', l.id, 'kid_id', l.kid_id, 'kid_name', k.name, 'delta', l.delta,
        'dollars', app._to_dollars(l.delta), 'kind', l.kind, 'note', l.note,
        'instance_id', l.instance_id, 'redeem_id', l.redeem_id,
        'created_by_name', c.name, 'created_at', l.created_at) j
      from app.ledger l join app.profiles k on k.id = l.kid_id
      left join app.profiles c on c.id = l.created_by
      where v_kid is null or l.kid_id = v_kid
      order by l.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 500)) x), '[]'::jsonb);
end $$;

create function app.adjust_points(p_token text, p_kid uuid, p_delta integer, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles;
begin
  me := app._require_parent(p_token);
  if p_kid is null or not exists (select 1 from app.profiles where id = p_kid and role = 'kid') then
    perform app._err('invalid_kid');
  end if;
  if p_delta is null or p_delta = 0 or abs(p_delta) > 100000 then perform app._err('invalid_points'); end if;
  if app._clean_text(p_note, 500) is null then perform app._err('note_required'); end if;
  insert into app.ledger (kid_id, delta, kind, note, created_by)
  values (p_kid, p_delta, case when p_delta > 0 then 'bonus' else 'adjust' end, app._clean_text(p_note, 500), me.id);
  perform app._notify(p_kid, case when p_delta > 0 then 'points_bonus' else 'points_adjusted' end,
    case when p_delta > 0 then 'Bonus: +' || p_delta || ' points' else 'Points adjusted: ' || p_delta end,
    app._clean_text(p_note, 500), me.id);
  return jsonb_build_object('kid_id', p_kid, 'points', app._balance(p_kid),
                            'dollars', app._to_dollars(app._balance(p_kid)));
end $$;

-- ---------- Wish list & redeem ----------------------------------------------
create function app.list_wishes(p_token text, p_kid uuid default null, p_include_closed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; v_kid uuid;
begin
  me := app._session(p_token);
  v_kid := app._scope_kid(me, p_kid);
  return coalesce((
    select jsonb_agg(app._wish_json(w.id)
           order by (w.status = 'active') desc, app._wish_cost(w.points_cost, w.price_dollars), w.created_at)
    from app.wishes w
    where (v_kid is null or w.kid_id = v_kid)
      and (w.status = 'active' or (coalesce(p_include_closed, false) and w.status = 'redeemed'))), '[]'::jsonb);
end $$;

create function app._validate_wish(p_title text, p_link text, p_price_dollars numeric, p_points_cost integer)
returns void language plpgsql set search_path = '' as $$
begin
  if app._clean_text(p_title, 120) is null then perform app._err('invalid_title'); end if;
  if app._clean_text(p_link, 1000) is not null and app._clean_text(p_link, 1000) !~* '^https?://' then
    perform app._err('invalid_link', 'must start with http:// or https://');
  end if;
  if p_price_dollars is null and p_points_cost is null then perform app._err('invalid_cost', 'price_dollars or points_cost required'); end if;
  if (p_price_dollars is not null and (p_price_dollars <= 0 or p_price_dollars > 100000))
     or (p_points_cost is not null and (p_points_cost <= 0 or p_points_cost > 10000000)) then
    perform app._err('invalid_cost');
  end if;
end $$;

create function app.add_wish(p_token text, p_title text, p_link text default null,
                             p_price_dollars numeric default null, p_points_cost integer default null,
                             p_kid uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; v_kid uuid; v_id uuid;
begin
  me := app._session(p_token);
  v_kid := app._scope_kid(me, p_kid);
  if v_kid is null then perform app._err('invalid_kid', 'p_kid required for parents'); end if;
  perform app._validate_wish(p_title, p_link, p_price_dollars, p_points_cost);
  insert into app.wishes (kid_id, title, link, price_dollars, points_cost, created_by)
  values (v_kid, app._clean_text(p_title, 120), app._clean_text(p_link, 1000),
          round(p_price_dollars, 2), p_points_cost, me.id)
  returning id into v_id;
  if me.role = 'parent' then
    perform app._notify(v_kid, 'wish_added', me.name || ' added to your wish list: ' || app._clean_text(p_title, 120), null, me.id, null, null, v_id);
  end if;
  return app._wish_json(v_id);
end $$;

create function app.update_wish(p_token text, p_wish_id uuid, p_title text, p_link text default null,
                                p_price_dollars numeric default null, p_points_cost integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; w app.wishes;
begin
  me := app._session(p_token);
  select * into w from app.wishes where id = p_wish_id and (me.role = 'parent' or kid_id = me.id) for update;
  if not found then perform app._err('not_found'); end if;
  if w.status <> 'active' then perform app._err('invalid_status', 'wish is ' || w.status); end if;
  if exists (select 1 from app.redeem_requests where wish_id = w.id and status = 'pending') then
    perform app._err('request_pending', 'decide or cancel the pending request first');
  end if;
  perform app._validate_wish(p_title, p_link, p_price_dollars, p_points_cost);
  update app.wishes set title = app._clean_text(p_title, 120), link = app._clean_text(p_link, 1000),
         price_dollars = round(p_price_dollars, 2), points_cost = p_points_cost, updated_at = now()
   where id = w.id;
  return app._wish_json(w.id);
end $$;

create function app.remove_wish(p_token text, p_wish_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me app.profiles; w app.wishes;
begin
  me := app._session(p_token);
  select * into w from app.wishes where id = p_wish_id and (me.role = 'parent' or kid_id = me.id) for update;
  if not found then perform app._err('not_found'); end if;
  if w.status <> 'active' then perform app._err('invalid_status', 'wish is ' || w.status); end if;
  update app.redeem_requests set status = 'cancelled', decided_at = now(), decided_by = me.id
   where wish_id = w.id and status = 'pending';
  update app.notifications set read_at = now()
   where wish_id = w.id and kind = 'redeem_requested' and read_at is null;
  update app.wishes set status = 'removed', updated_at = now() where id = w.id;
  return true;
end $$;

create function app.request_redeem(p_token text, p_wish_id uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; w app.wishes; v_cost integer; v_avail bigint; v_id uuid;
begin
  me := app._require_kid(p_token);
  perform pg_advisory_xact_lock(hashtextextended(me.id::text, 0));  -- serialize a kid's requests
  select * into w from app.wishes where id = p_wish_id and kid_id = me.id for update;
  if not found then perform app._err('not_found'); end if;
  if w.status <> 'active' then perform app._err('invalid_status', 'wish is ' || w.status); end if;
  if exists (select 1 from app.redeem_requests where wish_id = w.id and status = 'pending') then
    perform app._err('request_pending');
  end if;
  v_cost := app._wish_cost(w.points_cost, w.price_dollars);
  v_avail := app._balance(me.id) - app._pending_redeem(me.id);
  if v_avail < v_cost then
    perform app._err('insufficient_points', 'need ' || v_cost || ', available ' || v_avail);
  end if;
  insert into app.redeem_requests (wish_id, kid_id, points, dollars, kid_note)
  values (w.id, me.id, v_cost, coalesce(w.price_dollars, app._to_dollars(v_cost)), app._clean_text(p_note, 500))
  returning id into v_id;
  perform app._notify_parents('redeem_requested', me.name || ' wants: ' || w.title,
    v_cost || ' points' || coalesce(' — "' || app._clean_text(p_note, 500) || '"', ''), me.id, null, v_id, w.id);
  return app._redeem_json(v_id);
end $$;

create function app.cancel_redeem(p_token text, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me app.profiles; r app.redeem_requests;
begin
  me := app._require_kid(p_token);
  select * into r from app.redeem_requests where id = p_request_id and kid_id = me.id for update;
  if not found then perform app._err('not_found'); end if;
  if r.status <> 'pending' then perform app._err('invalid_status', 'request is ' || r.status); end if;
  update app.redeem_requests set status = 'cancelled', decided_at = now(), decided_by = me.id where id = r.id;
  update app.notifications set read_at = now()
   where redeem_id = r.id and kind = 'redeem_requested' and read_at is null;
  return app._redeem_json(r.id);
end $$;

create function app.list_redeem_requests(p_token text, p_status text default null, p_kid uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; v_kid uuid;
begin
  me := app._session(p_token);
  v_kid := app._scope_kid(me, p_kid);
  return coalesce((
    select jsonb_agg(app._redeem_json(r.id) order by (r.status = 'pending') desc, r.created_at desc)
    from app.redeem_requests r
    where (v_kid is null or r.kid_id = v_kid) and (p_status is null or r.status = p_status)), '[]'::jsonb);
end $$;

create function app.decide_redeem(p_token text, p_request_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles; r app.redeem_requests; v_title text;
begin
  me := app._require_parent(p_token);
  if p_approve is null then perform app._err('invalid_decision'); end if;
  select * into r from app.redeem_requests where id = p_request_id for update;
  if not found then perform app._err('not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(r.kid_id::text, 0));
  if r.status <> 'pending' then perform app._err('invalid_status', 'request is ' || r.status); end if;
  select title into v_title from app.wishes where id = r.wish_id;
  if p_approve then
    if app._balance(r.kid_id) < r.points then
      perform app._err('insufficient_points', 'kid balance is ' || app._balance(r.kid_id));
    end if;
    insert into app.ledger (kid_id, delta, kind, redeem_id, note, created_by)
    values (r.kid_id, -r.points, 'redeem', r.id, v_title, me.id);
    update app.wishes set status = 'redeemed', redeemed_at = now(), updated_at = now() where id = r.wish_id;
  end if;
  update app.redeem_requests set status = case when p_approve then 'approved' else 'declined' end,
         decision_note = app._clean_text(p_note, 500), decided_by = me.id, decided_at = now()
   where id = r.id;
  update app.notifications set read_at = now()
   where redeem_id = r.id and kind = 'redeem_requested' and read_at is null;
  perform app._notify(r.kid_id, case when p_approve then 'redeem_approved' else 'redeem_declined' end,
    case when p_approve then 'Yes! ' || v_title || ' (−' || r.points || ' points)'
         else 'Not this time: ' || v_title end,
    app._clean_text(p_note, 500), me.id, null, r.id, r.wish_id);
  return app._redeem_json(r.id);
end $$;

-- ---------- Notifications ---------------------------------------------------
create function app.list_notifications(p_token text, p_unread_only boolean default false, p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me app.profiles;
begin
  me := app._session(p_token);
  return coalesce((
    select jsonb_agg(x.j order by x.created_at desc) from (
      select n.created_at, jsonb_build_object(
        'id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body,
        'instance_id', n.instance_id, 'redeem_id', n.redeem_id, 'wish_id', n.wish_id,
        'actor_id', n.actor_id, 'actor_name', a.name, 'created_at', n.created_at,
        'read_at', n.read_at, 'unread', n.read_at is null) j
      from app.notifications n left join app.profiles a on a.id = n.actor_id
      where n.recipient_id = me.id and (not coalesce(p_unread_only, false) or n.read_at is null)
      order by n.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200)) x), '[]'::jsonb);
end $$;

create function app.unread_count(p_token text) returns integer
language plpgsql security definer set search_path = '' as $$
declare me app.profiles;
begin
  me := app._session(p_token);
  return (select count(*) from app.notifications where recipient_id = me.id and read_at is null);
end $$;

create function app.mark_notifications_read(p_token text, p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare me app.profiles; v_n integer;
begin
  me := app._session(p_token);
  update app.notifications set read_at = now()
   where recipient_id = me.id and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- =============================================================================
-- Privileges + public wrappers
-- =============================================================================
revoke execute on all functions in schema app from public, anon, authenticated;

do $$
declare f record; v_args text;
begin
  for f in
    select p.oid, p.proname, p.proargnames, p.pronargs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname !~ '^_' and p.prokind = 'f'
  loop
    execute format('grant execute on function app.%I(%s) to anon, authenticated',
                   f.proname, pg_get_function_identity_arguments(f.oid));
    select coalesce(string_agg(quote_ident(a), ', ' order by o), '') into v_args
      from unnest(f.proargnames[1:f.pronargs]) with ordinality t(a, o);
    execute format(
      'create or replace function public.%I(%s) returns %s language sql volatile security invoker '
      'set search_path = '''' begin atomic select app.%I(%s); end',
      f.proname, pg_get_function_arguments(f.oid), pg_get_function_result(f.oid), f.proname, v_args);
    execute format('revoke execute on function public.%I(%s) from public',
                   f.proname, pg_get_function_identity_arguments(f.oid));
    execute format('grant execute on function public.%I(%s) to anon, authenticated',
                   f.proname, pg_get_function_identity_arguments(f.oid));
    execute format('comment on function public.%I(%s) is %L',
                   f.proname, pg_get_function_identity_arguments(f.oid),
                   'Family Chores API — see docs/API.md');
  end loop;
end $$;

notify pgrst, 'reload schema';
