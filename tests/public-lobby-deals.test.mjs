import test from 'node:test';
import assert from 'node:assert/strict';
import {HostSession} from '../session.js';
import {beginOffer, acknowledgeOffer, advanceDeals, offerFor, controlNext} from '../supabase/functions/public-lobby/deals.js';
import {startPublicLobbyHand} from '../supabase/functions/chip-hand/hand.js';

function table() {
  const host = crypto.randomUUID(), guest = crypto.randomUUID();
  const session = new HostSession('방장', undefined, undefined, 10, {publicRoom:true, hostSpectator:true});
  session.addGuest('g', '참가자');
  const state = {roomCode:'PUB002', host:'h', members:{h:{accountId:host},g:{accountId:guest}}};
  beginOffer(state, session, 0);
  return {state, session, spec:state.offer.spec, guest, host};
}

test('a spectator host and a seated guest both confirm the same offer; retry recovers that deal with no private projection', async () => {
  const {state,session,spec,guest,host} = table();
  assert.equal(offerFor(state,crypto.randomUUID()),null);
  assert.equal(offerFor(state,host).handId,spec.handId);
  await acknowledgeOffer(state,session,guest,spec.handId,true,100);
  await advanceDeals(state,session,{start:assert.fail},110);
  assert.equal(offerFor(state,guest),null);
  await acknowledgeOffer(state,session,host,spec.handId,true,200);
  assert.equal(state.offer.status,'starting');
  let row, calls = 0;
  const db = {async start(hand,deal,raw) {
    assert.equal(raw.manifest,state.offer.manifest);
    row ??= {hand,room:deal.room,host:deal.host,seats:deal.seats,state:raw,revision:0};
    if (++calls === 1) throw new TypeError('response lost');
    return row;
  }};
  const chips = {start:offer => startPublicLobbyHand(offer,db)};
  await assert.rejects(advanceDeals(state,session,chips,300),/response lost/);
  assert.equal(state.offer.spec.handId,spec.handId);
  await advanceDeals(state,session,chips,400);
  assert.equal(session.chipHandId,spec.handId);
  assert.equal(state.offer,null);
  assert.equal(session.handoffState().round.seat,-1);
  assert.deepEqual(session.handoffState().round.hand,[]);
  assert.ok(!('hands' in session.handoffState().round));
});

test('a declined or expired public offer never starts a hand and a paused timer preserves time remaining', async () => {
  const {state,session,spec,guest} = table();
  await acknowledgeOffer(state,session,guest,spec.handId,false,1000);
  assert.equal(state.offer,null);
  beginOffer(state,session,2000);
  await advanceDeals(state,session,{start:assert.fail},32000);
  assert.equal(state.offer,null);
  assert.match(state.dealNotice,/시간/);
  const finished = {chipHandId:spec.handId,round:{phase:'result'}};
  state.nextRound = {key:spec.handId,status:'running',deadline:45000,remainingMs:10000};
  controlNext(state,finished,'pause',39000);
  assert.equal(state.nextRound.remainingMs,6000);
  controlNext(state,finished,'resume',60000);
  assert.equal(state.nextRound.deadline,66000);
});
