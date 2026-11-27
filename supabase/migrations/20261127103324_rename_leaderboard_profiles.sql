update mighty_private.virtual_leaderboard_profiles as p
set nickname = names.new_name
from (values
  ('달빛여우', 'jun_92'), ('구름다리', '한겜만'), ('고요한숲', 'mellow'), ('은하수달', '콩'),
  ('작은도토리', 'JH'), ('노을고래', '달수'), ('호두한알', '0range'), ('모래시계', '막차'),
  ('바람개비', 'mori'), ('흰동백', '옆집형'), ('귤한조각', 'slowhand'), ('여름소나기', '진'),
  ('별빛산책', 'bbang2'), ('파란우산', '일단패스'), ('보름달토끼', 'tuna'), ('골목참새', '감자전'),
  ('느린거북', 'min.j'), ('라일락향', '오후반차'), ('솔잎바람', 'rookie7'), ('아침물결', '소금')
) as names(old_name, new_name)
where p.nickname = names.old_name;
