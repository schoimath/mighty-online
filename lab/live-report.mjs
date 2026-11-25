import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const names = {legacy:'탐색형', heuristic:'협력형', contract_search:'공약 탐색형', win:'기존 승리형',
  score:'기존 정산점수형', balanced:'기존 균형형', recurrent_win:'GRU 승률형', recurrent_score:'GRU 득점형',
  recurrent_balanced:'GRU 균형형', belief_uniform:'제약 샘플 탐색', belief_learned:'학습 분포 탐색',
  gru_belief_uniform:'GRU 균형 + 제약 샘플 탐색', gru_belief_learned:'GRU 균형 + 학습 분포 탐색'};
function label(id) {
  const [stage,goal] = id.split('_');
  const stageNames = {initial:'학습 전', ppo:'PPO', teacher:'PPO + 교사'};
  if (stageNames[stage] && ['win','score','balanced'].includes(goal)) {
    return stageNames[stage] + ' · ' + {win:'승률',score:'득점',balanced:'균형'}[goal];
  }
  return names[id] ?? id;
}
const objectives = {win: '승률', score: '정산점수', balanced: '균형 효용'};
const roles = {solo:'노프렌드 주공', declarer:'주공', friend:'프렌드', opposition:'야당'};
function interval(stat, scale, digits) {
  return (scale * stat.mean).toFixed(digits) + ' [' + stat.ci95.map(v => (scale * v).toFixed(digits)).join(', ') + ']';
}
export function renderLiveReport(report) {
  const {config, split, agents, ranking} = report;
  const mode = config.mode === 'fixed_play' ? '계약·역할 고정 플레이' : '전체 게임';
  const prefix = {smoke:'실행 점검', validation:'모델 검증', final_test:'최종 평가', crossplay:'혼합 모델 교차 대국'}[split] ?? split;
  const lines = ['# 마이티 AI ' + prefix + ' · ' + mode, '',
    '독립 배분 ' + report.deals + '개에서 각 후보가 다섯 자리를 한 번씩 맡아 총 ' + report.games + '판을 마쳤습니다. ' +
    '첫 배분 seed는 ' + config.splits[split].startSeed + '이고, 같은 배분·같은 자리에서 교체할 때 다른 네 정책과 자리별 난수 seed를 고정했습니다.', '',
    config.mode === 'fixed_play' ? '협력형이 들어간 기준 라인업으로 합법적인 입찰·교환·프렌드 지정을 먼저 진행했습니다. 초구 프렌드이면 첫 트릭까지 진행해 팀을 확정했습니다. 후보는 자기 자리의 관측으로 순환 메모리를 복원한 뒤 남은 카드 플레이에 참여합니다.'
    : '실제 게임방과 같은 파토 및 정산 규칙을 적용했습니다. 공약, 주공, 기루다, 버림패, 프렌드는 매 판의 실제 행동으로 결정됩니다.', '',
    '## 전체 성적', '',
    '| AI | 팀 승률 % [95% 구간] | 개인 정산점수/판 [95% 구간] | 균형 효용 [95% 구간] | 승률 Elo | 추론 p95 (ms) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const [id, row] of Object.entries(agents)) {
    const u = row.utilities;
    lines.push('| ' + [label(id), interval(u.win.value,100,1), interval(u.score.value,config.reward.scoreScale,2),
      interval(u.balanced.value,1,4),row.winElo.toFixed(0),row.inference.p95ms.toFixed(2)].join(' | ') + ' |');
  }
  lines.push('', '## 목적에 따른 짝비교', '',
    '동일 배분과 자리에서 후보와 해당 기준을 교체한 차이입니다. 구간은 다섯 좌석과 모든 후보를 묶어 원본 배분 단위로 재표집했고, 상대군 구성별 표본 수를 보존했습니다. 여러 후보를 비교한 구간은 개별 95% 구간입니다.', '',
    '| 후보 | 기준 | 승률 차 (%p) | 개인 정산 차 (점/판) | 균형 효용 차 |', '| --- | --- | ---: | ---: | ---: |');
  for (const [id,row] of Object.entries(agents)) {
    const ref = config.referenceByAgent?.[id] ?? config.reference;
    if (!row.utilities.win.paired[ref]) continue;
    lines.push('| ' + [label(id),label(ref),interval(row.utilities.win.paired[ref],100,1),
      interval(row.utilities.score.paired[ref],config.reward.scoreScale,2),interval(row.utilities.balanced.paired[ref],1,4)].join(' | ') + ' |');
  }
  lines.push('', '## 목적별 표본 평균 순서', '');
  for (const [goal,ids] of Object.entries(ranking)) lines.push('- ' + objectives[goal] + ' 순서 · ' + ids.map(label).join(' → '));
  lines.push('', '점수형 효용은 실제 개인 정산을 ' + config.reward.scoreScale + '으로 나눈 값입니다. 균형 효용은 팀 승리 지표에 ' +
    config.reward.alpha + ', 정규화한 개인 정산에 ' + Number((1-config.reward.alpha).toFixed(6)) + '의 가중치를 주었습니다.', '',
    '승률 Elo는 한 원본 배분에서 다섯 자리의 팀 승리를 합산하고, ' + config.blockSize + '개 배분 블록별로 각 정책 쌍의 합을 비교한 보조 등급입니다. ' +
    '동률은 반승으로 반영하고 기준을 1500으로 둡니다. 모든 자리에 같은 비중을 주며, 실제 여당·야당의 승패로 각 자리의 승리를 판정합니다.', '',
    '## 역할별 성적과 정산 분포', '',
    '역할별 칸은 판수 / 팀 승률(%) / 평균 개인 정산(점)입니다. 전체 게임에서는 정책의 선택이 주공 또는 프렌드가 되는 빈도에도 영향을 줍니다.', '',
    '| AI | 노프렌드 주공 | 주공 | 프렌드 | 야당 | 정산 5% / 중앙 / 95% |', '| --- | --- | --- | --- | --- | --- |');
  for (const [id,row] of Object.entries(agents)) {
    const roleStats = Object.keys(roles).map(role => {
      const r = row.role[role];
      return r ? [r.games,(100*r.win).toFixed(1),r.settlement.toFixed(1)].join(' / ') : '0판';
    });
    const s = row.settlement;
    lines.push('| ' + [label(id),...roleStats,[s.p05,s.p50,s.p95].map(n => n.toFixed(1)).join(' / ')].join(' | ') + ' |');
  }
  const decisions = Object.values(agents).reduce((n,x) => n+x.inference.decisions,0);
  lines.push('', '후보의 의사결정 ' + decisions + '회에서 엔진이 거부한 행동은 0회였습니다. 추론 시간은 Node.js ' +
    report.node + '에서 후보가 한 행동을 반환하는 데 걸린 시간입니다.',
    '상대군별 및 실제 동료 조합별 성적, 모델 지문과 난수 설정은 [상세 결과](' + split + '.json)에 있습니다. 각 대국의 기록은 [압축 JSONL](' + split + '.games.jsonl.gz)에서 확인할 수 있습니다.', '');
  return lines.join('\n');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const file = resolve(process.argv[2]);
  if (!file.endsWith('.json')) throw Error('Supply a live evaluation JSON report.');
  writeFileSync(file.slice(0, -5) + '.md', renderLiveReport(JSON.parse(readFileSync(file, 'utf8'))));
}
