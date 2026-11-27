-- These profiles exist only in the public standings. Each balance is a fixed
-- reference value, independent of member wallets and game settlements.
create table mighty_private.virtual_leaderboard_profiles (
  nickname text primary key check (length(nickname) between 1 and 16 and nickname = btrim(nickname)),
  balance bigint not null check (balance >= 0)
);
alter table mighty_private.virtual_leaderboard_profiles enable row level security;
revoke all on table mighty_private.virtual_leaderboard_profiles from public, anon, authenticated, service_role;

insert into mighty_private.virtual_leaderboard_profiles(nickname, balance) values
  ('달빛여우', 1248), ('구름다리', 1183), ('고요한숲', 1157), ('은하수달', 1136),
  ('작은도토리', 1115), ('노을고래', 1096), ('호두한알', 1078), ('모래시계', 1062),
  ('바람개비', 1048), ('흰동백', 1035), ('귤한조각', 1024), ('여름소나기', 1013),
  ('별빛산책', 1005), ('파란우산', 1000), ('보름달토끼', 992), ('골목참새', 982),
  ('느린거북', 970), ('라일락향', 951), ('솔잎바람', 927), ('아침물결', 886);

create or replace function mighty_private.chip_leaderboard(p_page integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  with profiles as materialized (
    select w.user_id, w.balance, null::text as virtual_name
    from mighty_private.wallets w join auth.users u on u.id = w.user_id
    where u.email_confirmed_at is not null and coalesce(u.email,'') <> '' and u.deleted_at is null
    union all
    select null::uuid, v.balance, v.nickname from mighty_private.virtual_leaderboard_profiles v
  ), bounds as (
    select count(*) as total,
      least(greatest(coalesce(p_page,1),1), greatest(1,(count(*)+4)/5)) as page
    from profiles
  ), page_rows as (
    select user_id, balance, virtual_name, rank() over (order by balance desc) as rank,
      count(*) over (partition by balance) > 1 as tied
    from profiles
    order by balance desc, user_id nulls last, virtual_name
    limit 5 offset (select (page-1)*5 from bounds)
  )
  select jsonb_build_object('page',page,'pageSize',5,'total',total,'items',coalesce((
    select jsonb_agg(jsonb_build_object('rank',r.rank,'tied',r.tied,'isVirtual',r.virtual_name is not null,
      'nickname',coalesce(r.virtual_name,mighty_private.community_nickname(r.user_id)),'balance',r.balance::text)
      order by r.balance desc, r.user_id nulls last, r.virtual_name) from page_rows r
  ),'[]'::jsonb)) from bounds;
$$;
