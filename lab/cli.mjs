import {existsSync, mkdirSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DEFAULT_RULES} from '../engine.js';
import {SCORE_SCALE} from './scoring.js';
import {rulesHash,scoringHash} from './version.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const [command,...args]=process.argv.slice(2);
const help=`Mighty AI lab (run from the repository root)
  node lab/cli.mjs train-recurrent --config configs/recurrent-smoke.json --out lab/local-runs/gru-smoke
  node lab/cli.mjs train-recurrent --config configs/recurrent.json --out lab/local-runs/gru
  node lab/cli.mjs evaluate-live --config configs/live-eval.json --split validation --out lab/local-runs/eval
  node lab/cli.mjs analyze-move --input examples/observation.json --checkpoint lab/artifacts/recurrent-aux/best-balanced.json --objective balanced
  node lab/cli.mjs validate-rules [--config configs/rules.json]
  node lab/cli.mjs smoke [--device cpu] [--seed 1] [--out DIRECTORY]
  node lab/cli.mjs train [--objective win|score|balanced|downside_averse|all] [--seed 731]
      [--device cpu|cuda] [--config configs/train.json] [--budget-minutes 60] [--out DIRECTORY]
  node lab/cli.mjs train --resume latest-checkpoint.pt --budget-minutes 60
  node lab/cli.mjs evaluate --manifest configs/benchmark.json --split validation|final_test
  node lab/cli.mjs rate --results lab/results/final_test.jsonl
  node lab/cli.mjs diagnose --suite configs/endgames.json --agent win --objective win
Training uses MIGHTY_PYTHON, the repository .venv, an activated virtualenv, or python on PATH.
See lab/README.md for dependencies, checkpoint selection, seeds and full commands.`;

function python() {
  const bin=process.platform==='win32'?['Scripts','python.exe']:['bin','python'];
  if (process.env.MIGHTY_PYTHON) return process.env.MIGHTY_PYTHON;
  for (const dir of [resolve(root,'.venv'),process.env.VIRTUAL_ENV].filter(Boolean)) {
    const file=join(dir,...bin);
    if(existsSync(file)) return file;
  }
  return process.platform==='win32'?'python':'python3';
}
function run(cmd,argv) {
  const child=spawnSync(cmd,argv,{cwd:root,stdio:'inherit',windowsHide:true});
  if(child.error)throw child.error;
  if(child.status!==0)process.exit(child.status??1);
}
const get=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
if (!command || command==='--help' || command==='help') console.log(help);
else if(command==='validate-rules'){
  const spec=JSON.parse(readFileSync(get('--config',resolve(root,'configs/rules.json')),'utf8'));
  const preset=JSON.parse(readFileSync(resolve(root,'configs/rules.json'),'utf8'));
  const {isDeepStrictEqual}=await import('node:util');
  if (!isDeepStrictEqual(spec,preset)||!isDeepStrictEqual(spec.defaults,DEFAULT_RULES)||spec.scoring.scale!==SCORE_SCALE)
    throw new Error('This build implements the mighty_online_5 preset in configs/rules.json.');
  run(process.execPath,['--test','tests/engine.test.mjs','tests/lab-game.test.mjs']);
  console.log(JSON.stringify({ruleset:spec.ruleset_id,rulesHash,scoringHash,scale:SCORE_SCALE}));
} else if(command==='smoke'){
  const out=get('--out',null)??mkdtempSync(join(tmpdir(),'mighty-ppo-smoke-'));
  mkdirSync(out,{recursive:true});
  run(process.execPath,['--test','tests/lab-game.test.mjs','tests/neural-policy.test.mjs','tests/benchmark.test.mjs']);
  run(python(),['lab/test_training.py']);
  run(python(),['lab/train.py','--smoke','--objective','win','--device',get('--device','cpu'),'--seed',get('--seed','1'),'--out',resolve(out)]);
  console.log('Smoke checkpoint and logs:',resolve(out));
} else if(command==='train-recurrent') run(python(),['lab/recurrent_train.py',...args]);
else if(command==='evaluate-live') run(process.execPath,['lab/live-evaluate.mjs',...args]);
else if(command==='analyze-move') run(process.execPath,['lab/analyze-move.mjs',...args]);
else if(command==='train') run(python(),['lab/train.py',...args]);
else if(['evaluate','rate'].includes(command))run(process.execPath,['lab/'+command+'.mjs',...args]);
else if(command==='diagnose')run(process.execPath,['lab/diagnostic.mjs',...args]);
else {console.error(help);process.exitCode=2;}
