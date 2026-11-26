import {createInterface} from 'node:readline';
import {validateRules} from '../engine.js';
import {rngFor} from '../lab/game.js';
import {createLiveEnv} from '../lab/live-game.js';
import {API_VERSION, legalAction, turnRequest} from './protocol.js';

let env, actionRandom, request;
function handle(command) {
  if (command?.op === 'reset') {
    const {seed = 42, firstSeat = 0, policySeed = 123} = command;
    if (![seed, policySeed].every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff) ||
        !Number.isInteger(firstSeat) || firstSeat < 0 || firstSeat > 4) throw new Error('시드 또는 좌석이 잘못되었습니다.');
    env = createLiveEnv({seed, firstSeat, rules:validateRules(command.rules)});
    actionRandom = rngFor(policySeed);
  } else if (command?.op === 'step') {
    if (!env || env.done) throw new Error('먼저 reset으로 판을 시작하세요.');
    const action = legalAction(request.observation, command.action);
    if (!action) throw new Error('지금 낼 수 없는 수입니다.');
    env.step(action);
  } else {
    throw new Error('reset 또는 step을 지정하세요.');
  }
  if (env.done) return {apiVersion:API_VERSION, done:true, outcomes:env.terminalReturns(), result:env.result};
  request = turnRequest(env.observe(env.turn), Math.floor(actionRandom() * 2 ** 32));
  return {done:false, ...request};
}

for await (const line of createInterface({input:process.stdin, crlfDelay:Infinity})) {
  try {
    console.log(JSON.stringify(handle(JSON.parse(line))));
  } catch (error) {
    console.log(JSON.stringify({apiVersion:API_VERSION, error:error.message}));
  }
}
