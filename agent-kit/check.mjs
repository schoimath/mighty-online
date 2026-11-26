import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLiveEnv} from '../lab/live-game.js';
import {rngFor} from '../lab/game.js';
import {checkAgent, runAgent} from './protocol.js';
import cooperative from './cooperative.js';

function checkPhases(agent) {
  const env = createLiveEnv({seed:147});
  const check = () => runAgent(agent, env.observe(env.turn), 123);
  check();
  env.step({type:'bid', suit:'H', points:14});
  for (let n = 0; n < 4; n++) env.step({type:'pass'});
  for (const phase of ['discard','friend','play']) {
    if (env.observe(env.turn).phase !== phase) throw new Error('Unexpected fixture phase');
    env.step(check());
  }
}

function play(agent, seat, seed) {
  const env = createLiveEnv({seed});
  const streams = Array.from({length:5}, (_, i) => rngFor(8001 + i));
  while (!env.done) {
    if (env.dealNo > 50) throw new Error('재분배가 50회를 초과했습니다.');
    const turn = env.turn;
    env.step(runAgent(turn === seat ? agent : cooperative, env.observe(turn), Math.floor(streams[turn]() * 2 ** 32)));
  }
  return env.terminalReturns()[seat];
}

if (!isMainThread) {
  const {url, deals, firstSeed} = workerData;
  const agent = checkAgent((await import(url)).default);
  checkPhases(agent);
  let wins = 0, netChips = 0;
  for (let n = 0; n < deals; n++) {
    for (let seat = 0; seat < 5; seat++) {
      const result = play(agent, seat, (firstSeed + n) >>> 0);
      wins += result.win;
      netChips += result.settlement;
      parentPort.postMessage(null);
    }
  }
  parentPort.postMessage({model:agent.id, deals, games:deals * 5, firstSeed, wins, netChips});
} else {
  const [file, count = '1', seed = '42'] = process.argv.slice(2);
  const deals = Number(count), firstSeed = Number(seed);
  if (!Number.isSafeInteger(deals) || deals < 1 || !Number.isInteger(firstSeed) || firstSeed < 0 || firstSeed > 0xffffffff) {
    throw new Error('사용법: node agent-kit/check.mjs [모델 파일] [양의 배분 수] [0~4294967295 시드]');
  }
  const url = file ? pathToFileURL(resolve(file)).href : new URL('./starter.js', import.meta.url).href;
  const worker = new Worker(new URL(import.meta.url), {workerData:{url, deals, firstSeed}});
  const timer = setTimeout(() => {
    console.error('AI 검증 시간이 한 판에서 30초를 초과했습니다.');
    process.exitCode = 1;
    void worker.terminate();
  }, 30_000);
  let finished = false;
  worker.on('message', result => {
    timer.refresh();
    if (result) { finished = true; console.log(JSON.stringify(result)); }
  });
  worker.on('error', error => { console.error(error.message); process.exitCode = 1; });
  worker.on('exit', code => { clearTimeout(timer); if (code || !finished) process.exitCode = 1; });
}
