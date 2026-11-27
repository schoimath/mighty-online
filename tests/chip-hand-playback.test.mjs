import test from 'node:test';
import assert from 'node:assert/strict';
import {chipHandler} from '../supabase/functions/chip-hand/handler.js';
import {liveTrickPlayback} from '../supabase/functions/chip-hand/playback.js';
import {applyAction, createGame} from '../table-deal.js';
import {legalPlays} from '../engine.js';

test('watch skips over a covered trick and receives only its actual plays, separate from the masked game',async () => {
  const round = createGame({firstSeat:0});
  const play = action => applyAction(round,round.turn,action);
  play({type:'bid',suit:'H',points:14});
  for (let i = 0; i < 4; i++) play({type:'pass'});
  const own = round.hands[0];
  if (!own.includes('SA')) {
    const other = round.hands.find(hand => hand.includes('SA'));
    const index = other.indexOf('SA');
    [other[index],own[0]] = [own[0],other[index]];
  }
  play({type:'prepare',cards:own.filter(card => card !== 'SA').slice(0,3),friend:{kind:'none'}});
  const hand = crypto.randomUUID(), host = crypto.randomUUID();
  const row = {hand,room:'PUB002',host,seats:[host,null,null,null,null],revision:0,
    state:{round,pace:'normal',dueAt:Date.now()+120_000,autoPlay:false,names:['A','B','C','D','E'],bots:[false,true,true,true,true]}};
  const handler = chipHandler({url:'https://game.test',publicKey:'p',serviceKey:'s',send:async url => {
    assert.ok(url.endsWith('/rpc/chips_read_hand'));
    return Response.json(row);
  }});
  async function watch(playCursor) {
    const response = await handler(new Request('https://game.test/functions/v1/chip-hand',{method:'POST',
      body:JSON.stringify({op:'watch',handId:hand,playCursor})}));
    assert.equal(response.status,200);
    return response.json();
  }
  const before = await watch();
  assert.equal(typeof before.playCursor,'string');
  assert.equal(before.recentTricks,undefined);
  play({type:'play',card:'SA'});
  for (let i = 0; i < 4; i++) play({type:'play',...legalPlays(round,round.hands[round.turn])[0]});
  const completed = structuredClone(round.lastTrick);
  play({type:'play',...legalPlays(round,round.hands[round.turn])[0]});
  row.revision = 6;
  const next = await watch(before.playCursor);
  assert.deepEqual(next.recentTricks,[{number:1,winner:0,cards:completed.cards}]);
  assert.deepEqual(next.game.lastTrick.cards,[]);
  assert.deepEqual(next.game.captured[0],[]);
  assert.deepEqual(next.game.discarded,[]);
  assert.deepEqual(next.game.hand,[]);
  assert.deepEqual(next.game.trick,round.trick);
  assert.ok(!('playedTricks' in next.game));
  assert.equal((await watch()).recentTricks,undefined);
  assert.equal((await watch(next.playCursor)).recentTricks,undefined);
});

test('live receipts limit catch-up to three tricks and fence hand, seat, deal, expiry and edits',async () => {
  const decorate = liveTrickPlayback('server-side signing key');
  const receipt = {handId:crypto.randomUUID(),seat:-1,serverNow:1000};
  const round = {dealNo:3,lastTrick:null,playedTricks:[]};
  const {playCursor} = await decorate(receipt,round);
  for (let number = 1; number <= 4; number++) {
    round.lastTrick = {number,winner:2,cards:[{seat:2,card:'JK',suit:'D'},{seat:3,card:'C3',jokerCall:true}],points:2};
    round.playedTricks.push(round.lastTrick);
  }
  const next = {...receipt,serverNow:2000};
  const delta = await decorate(next,round,playCursor);
  assert.deepEqual(delta.recentTricks.map(t => t.number),[2,3,4]);
  assert.deepEqual(delta.recentTricks[0].cards,round.lastTrick.cards);
  assert.equal((await decorate({...next,handId:crypto.randomUUID()},round,playCursor)).recentTricks,undefined);
  assert.equal((await decorate({...next,seat:2},round,playCursor)).recentTricks,undefined);
  assert.equal((await decorate({...next,serverNow:32_000},round,playCursor)).recentTricks,undefined);
  assert.equal((await decorate(next,{...round,dealNo:4},playCursor)).recentTricks,undefined);
  assert.equal((await decorate(next,round,playCursor.replace('0.1000.','0.1500.'))).recentTricks,undefined);
  const claim = {...round,playedTricks:undefined,result:{setting:{success:true,line:[{card:'HA'}]}}};
  assert.deepEqual((await decorate(next,claim,playCursor)).recentTricks,[delta.recentTricks.at(-1)]);
});
