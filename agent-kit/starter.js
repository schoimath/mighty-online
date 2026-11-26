// A dependency-free example. Copy this file and change the ID and policy.
export default {
  apiVersion:1,
  id:'first_legal',
  label:'첫 합법수 예제',
  description:'첫 공약을 부르고 각 단계에서 가능한 수를 하나 고릅니다.',
  decide({observation: v}) {
    switch (v.phase) {
      case 'bid':
        return !v.bid && v.choices.bids.length ? {type:'bid', ...v.choices.bids[0]} : {type:'pass'};
      case 'discard':
        return {type:'discard', cards:v.hand.slice(-3)};
      case 'friend':
        return {type:'friend', kind:'none'};
      case 'play':
        return {type:'play', ...v.choices.plays[0]};
    }
  }
};
