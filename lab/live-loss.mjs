import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {position} from './belief-experiment.mjs';
import {actionKey, assessMove, heuristicContinuation} from './belief-policy.js';
import {parseOptions} from './evaluate.mjs';
import {rngFor} from './game.js';
import {freezeLiveRoster, loadLiveConfig} from './live-evaluate.mjs';
import {quantile} from './ratings.mjs';

const options = parseOptions(process.argv.slice(2)), config = loadLiveConfig(options);
const {factories, hashes} = await freezeLiveRoster(config, 'final_test');
const model = JSON.parse(readFileSync(resolve(config.belief.model), 'utf8'));
const {startSeed, positions, selectN, confirmN} = config.actionLoss;
const groups = Object.fromEntries(config.agents.map(id => [id, []]));
const observations = [];
for (let i = 0; i < positions; i++) {
  const seed = startSeed + i;
  const p = position(seed, 5 + i % 5, {branch:true, withHistory:true});
  if (!p) continue;
  // The simulator also holds full hands for its own bookkeeping. The chooser
  // gets only this seat's observations/actions; assessMove resamples all unknowns.
  const {observation:v, histories} = p;
  const history = histories[v.seat], cache = new Map();
  const rows = [];
  for (const id of config.agents) {
    const objective = config.objectives[id] ?? (['win','score'].includes(id) ? id : 'balanced');
    const chosen = factories[id](history)(v, rngFor(seed ^ 0x2fae7731));
    const key = objective + '/' + actionKey(chosen);
    if (!cache.has(key)) {
      cache.set(key, assessMove(v, {model, seed, selectN, confirmN, objective, chosen, reward:config.reward}));
    }
    const r = cache.get(key);
    const row = {id, objective, seed, seat:v.seat, trick:v.trickNo, chosen, nominee:r.nominee,
      loss:r.estimatedLoss, confirmationGap:r.confirmationGap, decision:r.decision, sampler:r.sampler};
    rows.push(row);
    groups[id].push(row);
  }
  observations.push(rows);
}
const agents = {};
for (const [id,rows] of Object.entries(groups)) {
  const valid = rows.filter(r => r.loss != null);
  if (!valid.length) throw Error('No sampled position for ' + id);
  const losses = valid.map(r => r.loss), n = valid.length;
  const mean = xs => xs.reduce((s,v) => s + v, 0) / xs.length;
  const rng = rngFor(config.bootstrapSeed);
  const estimates = Array.from({length:512}, () => mean(losses.map(() => losses[Math.floor(n*rng())])));
  const confirmed = valid.filter(r => r.decision !== '판단 보류').length;
  agents[id] = {objective:valid[0].objective, positions:rows.length, validPositions:n,
    meanEstimatedLoss:mean(losses), positionBootstrap95:[quantile(estimates,.025),quantile(estimates,.975)],
    confirmed, abstentionFraction:1-confirmed/n};
}
const dir = resolve(options.out ?? 'lab/results-live');
mkdirSync(dir, {recursive:true});
writeFileSync(resolve(dir,'action-loss.json'),JSON.stringify({metric:'모형에 따른 추정 행동 손실',
  continuation:heuristicContinuation.id, sampler:'learned constrained joint proposal', config:config.actionLoss,
  hashes, reward:config.reward, agents, observations}, null, 2) + '\n');
const lines = ['# 모형에 따른 추정 행동 손실','',
  '독립 보류 배분에서 여러 합법수가 있는 5~9번째 트릭을 골랐습니다. 각 모델은 같은 자리에 앉아 그 자리의 관측과 과거 행동만으로 수를 골랐습니다. 같은 정보에서 학습된 제약부 공동 패 분포와 협력형 후속 정책을 사용했습니다.', '',
  '관측마다 공동 배분 ' + selectN + '개에서 최선 후보를 정하고 독립 배분 ' + confirmN +
  '개에서 후보와 선택 수의 차이를 확인했습니다. 추정 손실은 탐색 표본의 최댓값을 사용해 과대 추정될 수 있습니다. 표본별 확인은 짝비교한 95% 구간의 하한이 양수일 때 집계합니다. 구간은 가정한 모형의 샘플링 오차를 나타냅니다.', '',
  '| 후보 | 목표 | 관측 수 | 평균 추정 효용 손실 | 확인 | 판단 보류 |','| --- | --- | ---: | ---: | ---: | ---: |'];
for (const [id,r] of Object.entries(agents)) lines.push('| '+[id,r.objective,r.validPositions,r.meanEstimatedLoss.toFixed(5),
  r.confirmed,(100*r.abstentionFraction).toFixed(1)+'%'].join(' | ')+' |');
lines.push('','[관측별 수와 불확실성](action-loss.json)','');
writeFileSync(resolve(dir,'action-loss.md'),lines.join('\n'));
console.table(agents);
