// Keep exact five-seat totals until the signs of the two block comparisons are known.
export function virtualMatches(scenarios, ids, size, axis) {
  if (!Number.isSafeInteger(size) || size < 1 || !scenarios.length || scenarios.length % size) {
    throw new Error('Elo requires complete, equal-size blocks');
  }
  const matches = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      let wins = 0, ties = 0, losses = 0;
      for (let k = 0; k < scenarios.length; k += size) {
        let difference = 0;
        for (let d = k; d < k + size; d++) difference += scenarios[d][i][axis] - scenarios[d][j][axis];
        if (difference > 0) wins++;
        else if (difference < 0) losses++;
        else ties++;
      }
      matches.push({a:ids[i], b:ids[j], wins, ties, losses});
    }
  }
  return matches;
}

function solve(matrix, rhs) {
  // The regularized, reference-pinned Hessian is positive definite.
  const n = rhs.length;
  for (let k = 0; k < n; k++) {
    for (let i = k + 1; i < n; i++) {
      const factor = matrix[i][k] / matrix[k][k];
      for (let j = k + 1; j < n; j++) matrix[i][j] -= factor * matrix[k][j];
      rhs[i] -= factor * rhs[k];
    }
  }
  const result = Array(n).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    let sum = rhs[k];
    for (let j = k + 1; j < n; j++) sum -= matrix[k][j] * result[j];
    result[k] = sum / matrix[k][k];
  }
  return result;
}

export function fitRatings(ids, matches, reference, ridge = .2) {
  if (!ids.includes(reference) || new Set(ids).size !== ids.length || !(ridge > 0)) throw new Error('Invalid rating settings');
  const free = ids.filter(id => id !== reference);
  const neighbors = new Map(ids.map(id => [id, []]));
  const pairs = [];
  for (const {a,b,wins,ties,losses} of matches) {
    if (!neighbors.has(a) || !neighbors.has(b) || a === b ||
      ![wins,ties,losses].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid matchup');
    const games = wins + ties + losses;
    if (!games) continue;
    neighbors.get(a).push(b); neighbors.get(b).push(a);
    pairs.push({i:free.indexOf(a), j:free.indexOf(b), games, score:wins + ties / 2});
  }
  const reached = new Set([reference]);
  for (const id of reached) for (const neighbor of neighbors.get(id)) reached.add(neighbor);
  if (reached.size !== ids.length) throw new Error('Comparison graph disconnected from reference');
  const x = free.map(() => 0);
  for (let step = 0; step < 40; step++) {
    const gradient = x.map(v => ridge * v);
    const hessian = x.map((_, i) => x.map((_, j) => i === j ? ridge : 0));
    for (const {i,j,games,score} of pairs) {
      const p = 1 / (1 + Math.exp((x[j] ?? 0) - (x[i] ?? 0)));
      const residual = games * p - score, curvature = games * p * (1 - p);
      if (i >= 0) { gradient[i] += residual; hessian[i][i] += curvature; }
      if (j >= 0) { gradient[j] -= residual; hessian[j][j] += curvature; }
      if (i >= 0 && j >= 0) { hessian[i][j] -= curvature; hessian[j][i] -= curvature; }
    }
    const delta = solve(hessian, gradient);
    const largest = Math.max(0, ...delta.map(Math.abs));
    for (let i = 0; i < x.length; i++) x[i] -= delta[i] / Math.max(1, largest / 3);
    if (largest < 1e-9) break;
  }
  return Object.fromEntries(ids.map(id => [id, 1500 + (x[free.indexOf(id)] ?? 0) * 400 / Math.log(10)]));
}

export function quantile(values, p) {
  const sorted = [...values].sort((a,b) => a - b);
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p, left = Math.floor(pos);
  return sorted[left] + (sorted[Math.ceil(pos)] - sorted[left]) * (pos - left);
}

export function statistics(scenarios, ids, {reference, blockSize, ridge, bootstrapDraws}, random, strata = scenarios.map(() => 0), objectiveAxes = {}) {
  if (strata.length!==scenarios.length) throw new Error('Invalid scenario strata');
  const pools=new Map();
  for (let i=0;i<strata.length;i++) {
    if (!pools.has(strata[i])) pools.set(strata[i],[]);
    pools.get(strata[i]).push(i);
  }
  const ref = ids.indexOf(reference);
  function calculate(sample) {
    const matches = [0,1].map(axis => virtualMatches(sample, ids, blockSize, axis));
    const ratings = matches.map(list => fitRatings(ids, list, reference, ridge));
    const totals = ids.map((_,i) => [0,1].map(axis => sample.reduce((sum,d) => sum + d[i][axis], 0) / (5 * sample.length)));
    const measures = ids.map((id,i) => ({
      win:totals[i][0], score:totals[i][1], winDifference:totals[i][0] - totals[ref][0],
      scoreDifference100:100 * (totals[i][1] - totals[ref][1]), winElo:ratings[0][id], scoreElo:ratings[1][id]
    }));
    for (const [id,axis] of Object.entries(objectiveAxes)) {
      const i=ids.indexOf(id);
      const unit=5*sample.length;
      measures[i].objective=sample.reduce((sum,d)=>sum+d[i][axis],0)/unit;
      measures[i].objectiveDifference=sample.reduce((sum,d)=>sum+d[i][axis]-d[ref][axis],0)/unit;
    }
    return {measures, matches};
  }
  const point = calculate(scenarios);
  const samples = ids.map((_,i) => Object.fromEntries(Object.keys(point.measures[i]).map(k => [k, []])));
  for (let b = 0; b < bootstrapDraws; b++) {
    // All seats, arms and axes of a scenario always move together.
    const sample = strata.map(label => {
      const pool=pools.get(label);
      return scenarios[pool[Math.floor(random()*pool.length)]];
    });
    const {measures} = calculate(sample);
    for (const [i, row] of measures.entries()) for (const [key, value] of Object.entries(row)) samples[i][key].push(value);
  }
  const agents = Object.fromEntries(ids.map((id,i) => [id, Object.fromEntries(Object.entries(point.measures[i])
    .map(([key,value]) => [key,{value,ci95:[quantile(samples[i][key],.025),quantile(samples[i][key],.975)]}]))]));
  return {agents, matches:{win:point.matches[0],score:point.matches[1]}};
}
