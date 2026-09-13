-- ============================================================================
-- NFL Pick'em — initial schema, RLS policies, and RPC functions
--
-- Run this whole file once in the Supabase SQL Editor (Dashboard > SQL Editor
-- > New query > paste > Run). Safe to re-run (uses IF NOT EXISTS / OR REPLACE
-- everywhere except the seed insert, which uses ON CONFLICT DO NOTHING).
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  claimed_by uuid unique references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists weeks (
  id uuid primary key default gen_random_uuid(),
  week_number int not null,
  season int not null,
  season_type int not null default 2, -- 1 = preseason, 2 = regular season, 3 = playoffs
  status text not null default 'open',
  pick_deadline timestamptz not null,
  created_at timestamptz not null default now(),
  unique (season, season_type, week_number)
);

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  week_id uuid not null references weeks(id) on delete cascade,
  external_game_id text not null,
  away_team text not null,
  home_team text not null,
  spread numeric,              -- away-team-relative: negative means the away team is favored
  spread_source text,          -- 'espn' | 'odds_api' | 'manual'
  spread_updated_at timestamptz,
  commence_time timestamptz,
  away_score int,
  home_score int,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (week_id, external_game_id)
);

create table if not exists picks (
  id uuid primary key default gen_random_uuid(),
  week_id uuid not null references weeks(id) on delete cascade,
  game_id uuid not null references games(id) on delete cascade,
  player_id uuid not null references players(id),
  selected_team text not null,
  spread_at_pick numeric,      -- snapshot so a later line move never rewrites history
  submitted_at timestamptz not null default now(),
  unique (game_id, player_id)
);

create index if not exists idx_games_week on games(week_id);
create index if not exists idx_picks_week on picks(week_id);
create index if not exists idx_picks_player on picks(player_id);

-- ----------------------------------------------------------------------------
-- Seed players — EDIT THESE NAMES if you want different players.
-- This is the "one obvious place" to configure the roster.
-- ----------------------------------------------------------------------------

insert into players (name) values ('Joe'), ('Mike'), ('Bryan')
on conflict (name) do nothing;

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------

alter table players enable row level security;
alter table weeks   enable row level security;
alter table games   enable row level security;
alter table picks   enable row level security;

-- players / weeks / games: readable by anyone (nothing sensitive in them)
drop policy if exists "players readable" on players;
create policy "players readable" on players for select using (true);

drop policy if exists "weeks readable" on weeks;
create policy "weeks readable" on weeks for select using (true);

drop policy if exists "games readable" on games;
create policy "games readable" on games for select using (true);

-- No insert/update/delete policies on players/weeks/games for anon/authenticated.
-- weeks & games are only ever written by the sync function using the service-role
-- key (which bypasses RLS entirely). players is only ever written via the
-- claim_player() function below.

grant select on players, weeks, games, picks to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Reveal logic: a week is "revealed" once all 3 players have a submission.
-- SECURITY DEFINER so it can count real rows even for a caller who (per the
-- policy below) can't yet see anyone else's picks.
-- ----------------------------------------------------------------------------

create or replace function public.is_week_revealed(p_week_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select count(distinct player_id) = 3
  from picks
  where week_id = p_week_id;
$$;

grant execute on function public.is_week_revealed(uuid) to anon, authenticated;

-- Who has submitted for a week, WITHOUT exposing their selections.
create or replace function public.submission_status(p_week_id uuid)
returns table(player_id uuid, name text, submitted boolean)
language sql
security definer
set search_path = public
as $$
  select p.id, p.name,
    exists(select 1 from picks pk where pk.week_id = p_week_id and pk.player_id = p.id)
  from players p
  order by p.name;
$$;

grant execute on function public.submission_status(uuid) to anon, authenticated;

-- picks: you can always read your own picks (matched via your claimed identity,
-- verified through the server-signed auth.uid() — not a client-supplied id), or
-- everyone's picks once the week is revealed. This is enforced here, in the
-- database, not in the browser.
drop policy if exists "picks readable" on picks;
create policy "picks readable" on picks
  for select using (
    exists (
      select 1 from players p
      where p.id = picks.player_id and p.claimed_by = auth.uid()
    )
    or public.is_week_revealed(picks.week_id)
  );

-- No insert/update/delete policies on picks for anon/authenticated at all.
-- The ONLY way picks get written is through submit_picks() below, which does
-- its own authorization, deadline, and completeness checks.

-- ----------------------------------------------------------------------------
-- Claim a player identity. No passwords: this just ties the caller's anonymous
-- auth session to one of the 3 player rows, one time.
-- ----------------------------------------------------------------------------

create or replace function public.claim_player(p_player_id uuid)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  result players;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update players
    set claimed_by = auth.uid()
    where id = p_player_id
      and (claimed_by is null or claimed_by = auth.uid())
    returning * into result;

  if result.id is null then
    raise exception 'That name is already claimed on another device. Ask whoever set this up to clear it in Supabase if that''s wrong.';
  end if;

  return result;
end;
$$;

grant execute on function public.claim_player(uuid) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Submit a full week of picks atomically: checks identity, deadline,
-- completeness (every game must have a pick), and that this player hasn't
-- already submitted this week. Runs as one transaction so picks can't be
-- half-submitted.
-- ----------------------------------------------------------------------------

create or replace function public.submit_picks(p_week_id uuid, p_picks jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_deadline timestamptz;
  v_game_count int;
  v_pick_count int;
  v_item jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_picks is null or jsonb_array_length(p_picks) = 0 then
    raise exception 'no picks provided';
  end if;

  v_player_id := (p_picks->0->>'player_id')::uuid;

  if not exists (
    select 1 from players where id = v_player_id and claimed_by = auth.uid()
  ) then
    raise exception 'you can only submit picks for your own claimed name';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_picks) elem
    where (elem->>'player_id')::uuid <> v_player_id
  ) then
    raise exception 'invalid submission';
  end if;

  select pick_deadline into v_deadline from weeks where id = p_week_id;
  if v_deadline is null then
    raise exception 'unknown week';
  end if;
  if now() >= v_deadline then
    raise exception 'the pick deadline for this week has passed';
  end if;

  if exists (select 1 from picks where week_id = p_week_id and player_id = v_player_id) then
    raise exception 'you have already submitted picks for this week';
  end if;

  select count(*) into v_game_count from games where week_id = p_week_id;
  select jsonb_array_length(p_picks) into v_pick_count;
  if v_pick_count <> v_game_count then
    raise exception 'you must pick every game before submitting (% of % picked)', v_pick_count, v_game_count;
  end if;

  for v_item in select * from jsonb_array_elements(p_picks)
  loop
    insert into picks (week_id, game_id, player_id, selected_team, spread_at_pick, submitted_at)
    select
      p_week_id,
      (v_item->>'game_id')::uuid,
      v_player_id,
      v_item->>'selected_team',
      g.spread,
      now()
    from games g where g.id = (v_item->>'game_id')::uuid;
  end loop;
end;
$$;

grant execute on function public.submit_picks(uuid, jsonb) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Leaderboard views. These views are owned by the migration role (which
-- bypasses RLS on the underlying tables), so each view has its OWN
-- is_week_revealed() filter baked in — it never depends on the querying
-- user's RLS visibility, and it never leaks a non-revealed week.
-- ----------------------------------------------------------------------------

create or replace view public.v_pick_results as
select
  pk.id as pick_id,
  pk.week_id,
  pk.player_id,
  pk.game_id,
  pk.selected_team,
  pk.spread_at_pick,
  g.away_team,
  g.home_team,
  g.away_score,
  g.home_score,
  g.completed,
  case
    when not g.completed or g.away_score is null or g.home_score is null then null
    when (g.away_score - g.home_score) + coalesce(pk.spread_at_pick, 0) > 0 then g.away_team
    when (g.away_score - g.home_score) + coalesce(pk.spread_at_pick, 0) < 0 then g.home_team
    else 'push'
  end as covering_team,
  case
    when not g.completed or g.away_score is null or g.home_score is null then null
    when (g.away_score - g.home_score) + coalesce(pk.spread_at_pick, 0) = 0 then 'push'
    when (
      (g.away_score - g.home_score) + coalesce(pk.spread_at_pick, 0) > 0 and pk.selected_team = g.away_team
    ) or (
      (g.away_score - g.home_score) + coalesce(pk.spread_at_pick, 0) < 0 and pk.selected_team = g.home_team
    ) then 'win'
    else 'loss'
  end as result
from picks pk
join games g on g.id = pk.game_id
where public.is_week_revealed(pk.week_id);

create or replace view public.v_leaderboard as
select
  p.id as player_id,
  p.name,
  count(*) filter (where r.result = 'win')  as wins,
  count(*) filter (where r.result = 'loss') as losses,
  count(*) filter (where r.result = 'push') as pushes
from players p
left join v_pick_results r on r.player_id = p.id
group by p.id, p.name
order by wins desc, losses asc;

grant select on public.v_pick_results to anon, authenticated;
grant select on public.v_leaderboard to anon, authenticated;
