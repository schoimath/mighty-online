import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve, basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {rngFor} from './game.js';
import {utility} from './scoring.js';
import {statistics, quantile} from './ratings.mjs';

const learned = ['win','score','balanced','downside_averse'];
const labels = {legacy:'탐색형',heuristic:'협력형',conservative:'신중형',aggressive:'공격형',random:'무작위형',win:'승리형',score:'정산점수형',balanced:'균형형',downside_averse:'손실회피형'};
const objectives = {legacy:'기존 탐색',heuristic:'팀 지원',conservative:'신중 입찰',aggressive:'적극 입찰',random:'합법수 추출',win:'팀 승률',score:'개인 정산점수',balanced:'균형 효용',downside_averse:'큰 손실 비용'};
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
const countBy = (rows,key) => {
  const counts = {};
  for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0)+1;
  return counts;
};
const grouped = (rows,key) => {
  const groups = new Map();
  for (const row of rows) {
    const k = key(row);
    if (!groups.has(k)) groups.set(k,[]);
    groups.get(k).push(row);
  }
  return groups;
};

export function checkClusters(rows, meta) {
  const {agents} = meta.config, spec = meta.config.splits[meta.split];
  if (rows.length !== spec.scenarios * 5 * agents.length) throw new Error('Missing or extra trials');
  const scenes = grouped(rows,row=>row.seed);
  const totals = [];
  const objectives = Object.entries(meta.selection ?? {});
  for (let index = 0; index < spec.scenarios; index++) {
    const seed = spec.startSeed+index;
    const games = scenes.get(seed) ?? [];
    const seats = new Map(), used = new Set();
    const scores = agents.map(()=>Array(2+objectives.length).fill(0));
    for (const row of games) {
      const i = agents.indexOf(row.agent), seat = row.focal_seat, key=i+'-'+seat;
      if (i<0 || !Number.isInteger(seat) || seat<0 || seat>4 || used.has(key) ||
          row.scenario_id!==meta.split+'-'+seed || row.split!==meta.split || row.benchmark_version!==meta.benchmark_version ||
          row.agent_checkpoint_hash!==meta.hashes[row.agent] || ![0,1].includes(row.team_win) ||
          !Number.isSafeInteger(row.net_settlement) || row.timeout_count!==0 || row.illegal_action_count!==0) throw new Error('Invalid trial: '+key);
      const signature = JSON.stringify([row.first_seat,row.policy_rng_seeds,row.background_agents,row.background_agent_hashes]);
      if (row.policy_rng_seeds?.length!==5 || row.background_agents?.length!==4 || row.background_agent_hashes?.length!==4 ||
          row.background_agents.some((id,j)=>meta.hashes[id]!==row.background_agent_hashes[j]) ||
          (seats.has(seat) && seats.get(seat)!==signature)) throw new Error('Unmatched scenario conditions');
      seats.set(seat,signature); used.add(key);
      scores[i][0]+=row.team_win; scores[i][1]+=row.net_settlement;
      for (const [j,[id,params]] of objectives.entries()) scores[i][2+j]+=utility(id,{win:row.team_win,settlement:row.net_settlement},params);
    }
    if (used.size!==5*agents.length) throw new Error('Incomplete scenario '+seed);
    totals.push(scores);
  }
  return totals;
}

function summarizeGroup(group) {
  return {games:group.length,team_win:mean(group.map(r=>r.team_win)),settlement:mean(group.map(r=>r.net_settlement)),
    contract_success:mean(group.map(r=>Number(r.contract_success)))};
}

function diagnostics(rows, id, params) {
  const decisions = rows.flatMap(r=>r.inference_ms);
  const groups = (key, extra={}) => Object.fromEntries([...grouped(rows,key)].map(([k,group])=>[k,
    {...summarizeGroup(group),fraction:group.length/rows.length,...extra}]));
  return {inference_ms:{p50:quantile(decisions,.5),p95:quantile(decisions,.95), decisions:decisions.length},
    background:groups(r=>r.composition), roles:groups(r=>r.terminal_role),
    final_contracts:countBy(rows,r=>r.contract.suit+r.contract.points),
    focal_contracts:countBy(rows.filter(r=>r.contract.seat===r.focal_seat),r=>r.contract.suit+r.contract.points),
    objective_mean:learned.includes(id)?mean(rows.map(r=>utility(id,{win:r.team_win,settlement:r.net_settlement},params))):null,
    checkpoint_sha256:rows[0].agent_checkpoint_hash, redeals:rows.reduce((sum,r)=>sum+r.redeal_count,0)};
}

function render(report, file) {
  const {agents:ids, reference, blockSize, bootstrapDraws, ridge} = report.config;
  const p = (x,d=1) => x.toFixed(d);
  const interval = (metric,scale=1,d=1) => p(metric.value*scale,d)+' ['+metric.ci95.map(n=>p(n*scale,d)).join(', ')+']';
  const out = [];
  out.push('# 마이티 AI 성적표','',report.split==='final_test'?'모델 선발을 마친 뒤 사용한 최종 평가입니다.':'이 표는 검증 또는 개발용 대국 결과입니다.','',
    '기본 테이블 규칙에서 독립 배분 '+report.scenarios+'개를 사용했습니다. 각 배분에서 모든 AI가 다섯 자리 각각을 맡았습니다. 기준 정책은 '+labels[reference]+'입니다. 두 Elo는 이 벤치마크 안에서 비교하는 잠정 등급입니다.','',
    '| AI | 판단 기준 | 승률 Elo [95% CI] | 정산 Elo [95% CI] | 개인 승률 % [95% CI] | 판당 개인 정산 [95% CI] | 추론 p50 / p95 (ms) |',
    '|---|---|---:|---:|---:|---:|---:|');
  for (const id of ids) {
    const m=report.agents[id], t=m.inference_ms;
    out.push('| '+[labels[id],objectives[id],interval(m.winElo,1,0),interval(m.scoreElo,1,0),interval(m.win,100),
      interval(m.score),p(t.p50,3)+' / '+p(t.p95,3)].join(' | ')+' |');
  }
  out.push('','## 같은 패의 기준 AI 대비 성적','','양수는 같은 좌석에서 기준 AI보다 높은 결과를 뜻합니다. 구간은 같은 배분의 모든 자리와 모델을 함께 재표집해 계산했습니다. 개별 95% 구간이며 다중 비교 보정을 적용하지 않았습니다.','',
    '| AI | 승률 차이 %p [95% CI] | 100판당 정산 차이 [95% CI] | 학습 목적의 평균 효용 [95% CI] | 기준 대비 효용 차이 [95% CI] |','|---|---:|---:|---:|---:|');
  for (const id of ids) {
    const m=report.agents[id];
    out.push('| '+[labels[id],interval(m.winDifference,100),interval(m.scoreDifference100),m.objective?interval(m.objective,1,4):'—',m.objectiveDifference?interval(m.objectiveDifference,1,4):'—'].join(' | ')+' |');
  }
  if (Object.keys(report.selection).length) {
    out.push('','## 학습 체크포인트','','각 정책은 선택용 검증 패에서 자기 목적의 평균 효용으로 선발됐습니다. 이 검증값에는 후보 선택 효과가 포함됩니다. 위 표의 대국은 별도의 배분에서 실행했습니다.','',
      '| AI | 선택 체크포인트 | seed | 선택용 배분 수 | 선택용 검증 효용 | 별도 배분의 같은 목적에서 기준 대비 |','|---|---|---:|---:|---:|---|');
    for (const [id,s] of Object.entries(report.selection)) {
      const ci=report.agents[id].objectiveDifference.ci95;
      const interpretation=ci[0]>0?'높음':ci[1]<0?'낮음':'구분 불가';
      const checkpoint=s.run_path ? '['+s.checkpoint+'](../../'+s.run_path+'/'+s.checkpoint+')' : s.checkpoint;
      out.push('| '+[labels[id],checkpoint,s.training_seed,s.selection_scenarios,p(s.validation_utility,5),interpretation].join(' | ')+' |');
    }
  }
  out.push('','## 배경 조합별 결과','','각 칸은 개인 승률(%)과 판당 개인 정산점수입니다. heldout_search에는 학습·모델 선발 당시에 등장하지 않은 기존 탐색형 상대가 포함됩니다.','');
  const groups=[...new Set(report.config.backgroundCycle[report.split])];
  out.push('| AI | '+groups.map(g=>g+' ('+report.agents[ids[0]].background[g].games/5+'개 패)').join(' | ')+' |','|---|'+groups.map(()=>'---:').join('|')+'|');
  for (const id of ids) out.push('| '+labels[id]+' | '+groups.map(g=>{const v=report.agents[id].background[g];return p(100*v.team_win)+' / '+p(v.settlement);}).join(' | ')+' |');
  out.push('','## 역할과 공약','','주공·솔로 횟수는 해당 AI가 경매에서 이긴 횟수입니다. 경매와 프렌드 선택도 정책마다 달라지므로 역할별 수치는 기술 통계입니다.','',
    '| AI | 주공 단독 / 프렌드 동반 / 프렌드 / 야당 (판) | 주공 공약 성공률 |','|---|---:|---:|');
  for (const id of ids) {
    const roles=report.agents[id].roles;
    const n=(roles.solo?.games??0)+(roles.declarer?.games??0);
    const won=['solo','declarer'].reduce((s,r)=>s+(roles[r]?.games??0)*(roles[r]?.contract_success??0),0);
    out.push('| '+labels[id]+' | '+['solo','declarer','friend','opposition'].map(r=>roles[r]?.games??0).join(' / ')+' | '+(n?p(100*won/n)+'%':'—')+' |');
  }
  out.push('','## 두 등급 계산','','미리 정한 연속 '+blockSize+'개 배분이 한 블록입니다. 다섯 자리의 승리 수 또는 정산 총합이 높은 쪽이 블록을 이깁니다. 승리 1점, 무승부 0.5점, 패배 0점을 양쪽 축에서 별도로 집계했습니다. 다음 표의 각 칸은 행 모델이 열 모델을 상대로 얻은 블록 대국점수입니다. 한 축에서 '+report.scenarios/blockSize+'점이 만점입니다.','');
  for (const [axis, title] of [['win','승률'],['score','정산']]) {
    out.push('### '+title+' 대국점수','','| AI | '+ids.map(id=>labels[id]).join(' | ')+' |','|---|'+ids.map(()=>'---:').join('|')+'|');
    for(const id of ids) {
      const cells=ids.map(other=>{
        if(id===other)return '—';
        const pair=report.matches[axis].find(m=>(m.a===id && m.b===other)||(m.b===id && m.a===other));
        return String((pair.a===id?pair.wins:pair.losses)+pair.ties/2);});
      out.push('| '+labels[id]+' | '+cells.join(' | ')+' |');
    }
    out.push('');
  }
  out.push('동결한 '+labels[reference]+'을 1500으로 고정한 Bradley–Terry 일괄 적합입니다. 자유 계수의 자연 로그 오즈에 L2 계수 '+ridge+'를 사용했습니다. 무승부 0.5는 적합 규약입니다. Elo의 대상은 유한 블록의 승점이며, 개인 승률과 평균 정산점수는 위 원시 성능 열에 표시했습니다.','',
    '95% 구간은 배경 조합별로 원래 배분 전체를 '+bootstrapDraws+'회 복원 추출하고 블록의 승점과 등급을 매번 다시 계산한 백분위 구간입니다. 기준 등급 구간 [1500, 1500]은 기준점을 고정한 결과입니다. 표본과 상대 구성이 제한되어 사람과 대국했을 때의 등급은 알 수 없습니다.','',
    '## 실행 기록','',
    '최초 배분 '+report.scenarios+'개, 정책·자리 교체로 시작한 판 '+report.games+'개, 전원 패스로 재배분한 횟수 '+report.redeals+'회, 완결한 판 '+report.games+'개입니다. 불법수 '+report.illegal+'건, 제한시간 초과 '+report.timeouts+'건입니다. Node '+report.node+', '+report.workers+'개 워커에서 '+p(report.wall_seconds)+'초 ('+p(report.games/report.wall_seconds)+'판/초)가 걸렸습니다. 추론 시간은 각 초점 좌석의 개인 관측이 준비된 직후부터 행동을 반환할 때까지의 경과시간입니다.','',
    '평가 버전 `'+report.benchmark_version+'`. 규칙·정산, 고정 모델 해시, 정책별 난수 시드, 재배분·추론 예산과 배경 혼합 구성을 저장했습니다. [배분·모델별 원시 기록]('+file+'.jsonl) · [고정 평가 조건]('+file+'.manifest.json) · [역할·공약 분포와 승/무/패 원자료]('+file+'.summary.json)','');
  return out.join('\n');
}

export function rate(results) {
  if (!results.endsWith('.jsonl')) throw new Error('Expected a JSONL evaluation file');
  const prefix = results.slice(0,-6), raw = readFileSync(results,'utf8').replaceAll('\r\n','\n');
  const meta = JSON.parse(readFileSync(prefix+'.manifest.json','utf8'));
  if (createHash('sha256').update(raw).digest('hex')!==meta.results_sha256) throw new Error('Raw results digest mismatch');
  const rows = raw.trim().split('\n').map(line=>JSON.parse(line));
  const clusters=checkClusters(rows,meta);
  const cycle=meta.config.backgroundCycle[meta.split];
  const strata=clusters.map((_,i)=>cycle[i%cycle.length]);
  const axes=Object.fromEntries(Object.keys(meta.selection).map((id,i)=>[id,2+i]));
  const stats=statistics(clusters,meta.config.agents,meta.config,rngFor(meta.config.bootstrapSeed),strata,axes);
  for (const [id,group] of grouped(rows,r=>r.agent)) Object.assign(stats.agents[id],diagnostics(group,id,meta.selection[id]));
  const report={...meta,provisional:true,scenarios:clusters.length,games:rows.length,redeals:rows.reduce((s,r)=>s+r.redeal_count,0),
    illegal:rows.reduce((s,r)=>s+r.illegal_action_count,0),timeouts:rows.reduce((s,r)=>s+r.timeout_count,0),...stats};
  writeFileSync(prefix+'.summary.json',JSON.stringify(report,null,2)+'\n');
  writeFileSync(prefix+'.md',render(report,basename(prefix)));
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const i=process.argv.indexOf('--results');
  if (process.argv.includes('--help')) console.log('node lab/rate.mjs --results lab/results/final_test.jsonl');
  else if (i<0 || !process.argv[i+1]) throw new Error('Specify --results FILE.jsonl');
  else {const report=rate(resolve(process.argv[i+1]));console.log(report.benchmark_version,report.games+' games');}
}
