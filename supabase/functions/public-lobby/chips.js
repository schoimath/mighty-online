import {operateHand, publicHandReceipt, startPublicLobbyHand} from '../chip-hand/hand.js';
import {repository} from '../chip-hand/handler.js';

export function lobbyChips(url, publicKey, serviceKey, send = fetch) {
  const db = repository(url, publicKey, serviceKey, null, send);
  return {
    start:spec => startPublicLobbyHand(spec, db),
    async read(handId) {
      const row = await db.read(handId);
      return row ? publicHandReceipt(row) : null;
    },
    async leave(handId, accountId, finishIfAlone = false) {
      await operateHand({op:'leave', handId, finishIfAlone}, accountId, db);
    },
    setting(handId, proof, key, value) {
      if (!['pace','autoPlay'].includes(key)) throw new Error('테이블 설정을 확인해 주세요.');
      if (!proof.effectId) throw new Error('테이블 설정 요청을 확인해 주세요.');
      const guarded = repository(url,publicKey,serviceKey,null,send,proof.effectId);
      return operateHand({op:key === 'pace' ? 'room-pace' : 'room-auto-play', handId,
        term:proof.controlTerm, credential:proof.controlKey, [key]:value}, proof.controllerId, guarded);
    }
  };
}
