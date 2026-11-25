"""Train a goal-conditioned, seat-local GRU on complete live-table episodes."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import random
import statistics
import subprocess
import tempfile
import time

import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "lab/recurrent-rollout.mjs"
GOALS = ("win", "score", "balanced")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def write(path, text):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def provenance():
    files = ["lab/recurrent_train.py", "lab/recurrent-rollout.mjs", "lab/recurrent.js",
             "lab/live-game.js", "lab/game.js", "lab/policy.js", "lab/partnership-policy.js",
             "lab/rules-agents.js", "lab/champions.js", "table-scoring.js", "table-deal.js",
             "engine.js", "bot-exchange.js", "bot-weights.js", "bot-sampling.js"]
    return {f: hashlib.sha256((ROOT / f).read_bytes().replace(b"\r\n", b"\n")).hexdigest() for f in files}


class Policy(nn.Module):
    def __init__(self, schema, hidden):
        super().__init__()
        self.schema = schema
        self.cell = nn.GRUCell(schema["inputSize"] + len(GOALS), hidden)
        self.actor = nn.Linear(hidden, schema["actionSize"])
        self.critic = nn.Linear(hidden, 1)
        nn.init.normal_(self.actor.weight, std=.045)
        nn.init.zeros_(self.actor.bias)

    def export(self):
        def numbers(t):
            if t.ndim > 0:
                return [numbers(v) for v in t.detach().cpu()]
            return round(t.item(), 8)
        return dict(schema=self.schema["recurrentSchema"], hidden=self.cell.hidden_size,
                    input=numbers(self.cell.weight_ih), inputBias=numbers(self.cell.bias_ih),
                    recurrent=numbers(self.cell.weight_hh), recurrentBias=numbers(self.cell.bias_hh),
                    actor=numbers(self.actor.weight), actorBias=numbers(self.actor.bias),
                    critic=numbers(self.critic.weight[0]), criticBias=numbers(self.critic.bias[0]))

    def from_export(self, w):
        if w["schema"]!=self.schema["recurrentSchema"] or w["hidden"]!=self.cell.hidden_size:
            raise ValueError("Incompatible exported GRU")
        pairs=[(self.cell.weight_ih,w["input"]),(self.cell.bias_ih,w["inputBias"]),
               (self.cell.weight_hh,w["recurrent"]),(self.cell.bias_hh,w["recurrentBias"]),
               (self.actor.weight,w["actor"]),(self.actor.bias,w["actorBias"]),
               (self.critic.weight,[w["critic"]]),(self.critic.bias,[w["criticBias"]])]
        with torch.no_grad():
            for parameter, values in pairs:
                parameter.copy_(torch.as_tensor(values))


def batch(sequences, device):
    # Each sequence contains only one player's successive decision times.
    b, t = len(sequences), max(map(len, sequences))
    d = len(sequences[0][0]["state"]) + len(GOALS)
    state = torch.zeros(b, t, d)
    keep = torch.zeros(b, t, 1)
    valid = torch.zeros(b, t, dtype=torch.bool)
    rows = []
    for i, seq in enumerate(sequences):
        for j, row in enumerate(seq):
            z = GOALS.index(row["objective"])
            state[i, j] = torch.tensor([*row["state"], *(int(g == z) for g in range(len(GOALS)))])
            keep[i, j] = int(j > 0 and not row.get("reset") and row.get("dealNo") == seq[j-1].get("dealNo"))
            valid[i, j] = True
            rows.append(row)
    max_a = max(len(row["priors"]) for row in rows)
    features = torch.zeros(len(rows), max_a, len(rows[0]["features"][0]))
    prior = torch.full((len(rows), max_a), -torch.inf)
    for i, row in enumerate(rows):
        n = len(row["priors"])
        if len(row["features"]) != n or not n:
            raise ValueError("Invalid legal mask")
        features[i,:n] = torch.tensor(row["features"])
        prior[i,:n] = torch.tensor(row["priors"])
    tensors = [state, keep, valid, features, prior]
    return [tensor.to(device) for tensor in tensors], rows


def forward(model, tensors):
    state, keep, valid, features, prior = tensors
    h = state.new_zeros((len(state), model.cell.hidden_size))
    hidden = []
    for j in range(state.shape[1]):
        h = model.cell(state[:, j], h * keep[:, j])
        hidden.append(h)
    h = torch.stack(hidden, dim=1)[valid]
    logits = prior + (features * model.actor(h).unsqueeze(1)).sum(-1)
    return logits, model.critic(h).squeeze(-1)


def fit(model, optimizer, episodes, cfg, device):
    sequences = []
    for episode in episodes:
        rows = episode["rows"]
        if not rows:
            raise ValueError("Missing learner decisions")
        next_value, gae = 0., 0.
        for j in reversed(range(len(rows))):
            r = rows[j]
            reward = episode["reward"] if j == len(rows)-1 else 0.
            # All-pass redeals reset GRU memory but have the same terminal payoff.
            gae = reward + next_value - r["value"] + cfg["lambda"] * gae
            r["adv"] = gae
            r["target"] = r["value"] + gae
            next_value = r["value"]
        sequences.append(rows)
    advantages = [r["adv"] for seq in sequences for r in seq]
    mean, scale = statistics.mean(advantages), max(1e-7, statistics.pstdev(advantages))
    prepared = []
    for i in range(0, len(sequences), cfg["batchEpisodes"]):
        tensors, rows = batch(sequences[i:i+cfg["batchEpisodes"]], device)
        def field(key):
            return torch.tensor([r[key] for r in rows], device=device)
        prepared.append((tensors, field("index"), field("logp"), field("value"),
                         field("target"), (field("adv")-mean)/scale))
    max_log_error, max_value_error = 0., 0.
    with torch.no_grad():
        for tensors, index, old, value, _, _ in prepared:
            logits, predicted = forward(model, tensors)
            logs = logits.log_softmax(-1).gather(1, index[:,None]).squeeze(1)
            max_log_error = max(max_log_error, (logs-old).abs().max().item())
            max_value_error = max(max_value_error, (predicted-value).abs().max().item())
    if max(max_log_error, max_value_error) > 3e-4:
        raise ValueError(f"Portable inference mismatch: {max_log_error}, {max_value_error}")
    before = nn.utils.parameters_to_vector(model.parameters()).detach().clone()
    losses = []
    for _ in range(cfg["epochs"]):
        for k in torch.randperm(len(prepared)).tolist():
            tensors, index, old, _, target, adv = prepared[k]
            logits, value = forward(model, tensors)
            logs = logits.log_softmax(-1)
            logp = logs.gather(1, index[:,None]).squeeze(1)
            ratio = (logp-old).exp()
            clipped = ratio.clamp(1-cfg["clip"], 1+cfg["clip"])
            entropy = -(logs.masked_fill(~torch.isfinite(logs),0)*logs.exp()).sum(1).mean()
            loss = (-torch.minimum(ratio*adv,clipped*adv).mean()
                    + cfg["valueWeight"]*(target-value).square().mean() - cfg["entropy"]*entropy)
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(),cfg["gradClip"],error_if_nonfinite=True)
            optimizer.step()
            losses.append(loss.item())
    delta = (nn.utils.parameters_to_vector(model.parameters()).detach()-before).norm().item()
    if not (math.isfinite(delta) and delta > 0):
        raise ValueError("No finite parameter update")
    return dict(decisions=len(advantages),meanLoss=statistics.mean(losses),parameterDelta=delta,
                maxLogpError=max_log_error,maxValueError=max_value_error)


def distill(model, sequences, temperature, learning_rate, epochs=3):
    """Separate supervised update using only positively weighted estimates."""
    eligible = [seq for seq in sequences if any(r.get("confidence",0)>0 and r.get("teacherQ") for r in seq)]
    if not eligible:
        return 0
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
    device = next(model.parameters()).device
    for _ in range(epochs):
        for seq in eligible:
            tensors, rows = batch([seq], device)
            logits, _ = forward(model, tensors)
            weighted, total_weight = [], 0.
            for i,row in enumerate(rows):
                w = row.get("confidence",0)
                if w <= 0 or not row.get("teacherQ"):
                    continue
                q = torch.tensor(row["teacherQ"],device=device)
                if not q.isfinite().all() or len(q)!=len(row["priors"]) or not math.isfinite(w):
                    raise ValueError("Nonfinite or mismatched teacher")
                target=(q/temperature).softmax(0)
                weighted.append(-w*(target*logits[i,:len(q)].log_softmax(0)).sum())
                total_weight+=w
            optimizer.zero_grad()
            (torch.stack(weighted).sum()/max(1.,total_weight)).backward()
            nn.utils.clip_grad_norm_(model.parameters(),.5,error_if_nonfinite=True)
            optimizer.step()
    return len(eligible)


def rollout(mode, weights, archive, specs, cfg):
    with tempfile.TemporaryDirectory(prefix="mighty-gru-") as folder:
        directory = Path(folder)
        model = directory/"current.json"
        write(model,compact(weights))
        paths=[]
        for i,m in enumerate(archive):
            path=directory/f"history-{i}.json"
            write(path,compact(m))
            paths.append(str(path))
        workers = min(cfg["parallelEnvs"],len(specs))
        def run(k):
            request, out=directory/f"req-{k}.json",directory/f"out-{k}.json"
            write(request,compact(dict(model=str(model),archive=paths,specs=specs[k::workers],config=cfg)))
            subprocess.run(["node",str(WORKER),mode,str(request),str(out)],cwd=ROOT,check=True)
            return read(out)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            groups=list(pool.map(run,range(workers)))
        return [groups[i%workers][i//workers] for i in range(len(specs))]


def validation(weights, cfg):
    specs=[dict(seed=cfg["validationSeed"]+i,seat=seat,objective=z)
           for i in range(cfg["validationDeals"]) for seat in range(5) for z in GOALS]
    results=rollout("validate",weights,[],specs,cfg)
    return {z:statistics.mean(r["reward"] for r in results if r["objective"]==z) for z in GOALS}, results


def selected_files(directory, best):
    models = {}
    references = {}
    for z, choice in best.items():
        model = compact(choice["weights"])
        key = hashlib.sha256(model.encode()).hexdigest()
        models[key] = model
        references[z] = key
        write(directory/f"best-{z}.json",model+"\n")
    names = {k:f"model{i}" for i,k in enumerate(models)}
    code = "".join(f"const {names[k]}={v};\n" for k,v in models.items())
    code += "export const recurrentModels={"+",".join(f"{z}:{names[k]}" for z,k in references.items())+"};\n"
    write(directory/"selected.js",code)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default=ROOT/"configs/recurrent.json")
    p.add_argument("--out",type=Path)
    p.add_argument("--resume",type=Path)
    p.add_argument("--seed",type=int,help="Independent initialization and training deals on a fresh run")
    p.add_argument("--external",type=Path,action="append",default=[],help="Extra frozen exported GRU from another run")
    p.add_argument("--updates",type=int,help="Additional complete PPO updates")
    p.add_argument("--budget-seconds",type=float)
    p.add_argument("--device",choices=["cpu","cuda"])
    p.add_argument("--teachers",type=Path,help="Independent auxiliary comparison from a trusted checkpoint")
    args=p.parse_args()
    state=torch.load(args.resume,map_location="cpu",weights_only=True) if args.resume else None
    cfg=state["config"] if state else read(args.config)
    if state and (args.seed is not None or args.external):
        p.error("Resume restores all RNGs and the checkpoint population")
    if args.seed is not None:
        cfg=dict(cfg, seed=args.seed)
    directory=(args.out or (args.resume.parent if args.resume else ROOT/"lab/local-runs/recurrent")).resolve()
    if directory.exists() and any(directory.iterdir()) and (not args.resume or directory!=args.resume.resolve().parent):
        p.error("Use an empty output directory or resume its checkpoint")
    if args.teachers and (not state or directory==args.resume.resolve().parent):
        p.error("Auxiliary fitting requires --resume and a fresh --out")
    directory.mkdir(parents=True,exist_ok=True)
    schema=json.loads(subprocess.check_output(["node",str(WORKER),"schema"],cwd=ROOT,text=True))
    code=provenance()
    if state and (state["code"]!=code or state["schema"]!=schema):
        raise ValueError("Checkpoint rules or training code differ from this checkout")
    if cfg["gamma"]!=1 or not (0 <= cfg["alpha"] <= 1 and cfg["scoreScale"]>0) or cfg["parallelEnvs"] < 1:
        raise ValueError("Invalid reward or rollout configuration")
    if cfg["validationSeed"]<1_000_000 or cfg["validationDeals"]<1 or cfg["episodesPerGoal"]<1:
        raise ValueError("Invalid split configuration")
    if any(cfg["league"][k]<0 for k in ("baseline","recent","history")) or cfg["league"]["baseline"]<=0:
        raise ValueError("League requires nonnegative weights and baseline support")
    device=torch.device(args.device or cfg["device"])
    torch.set_num_threads(cfg["threads"])
    torch.manual_seed(cfg["seed"])
    rng=random.Random(cfg["seed"])
    model=Policy(schema,cfg["hidden"]).to(device)
    optimizer=torch.optim.Adam(model.parameters(),lr=cfg["learningRate"])
    gen, games, decisions, archives, best, log = 0,0,0,[],{},[]
    external=state["external"] if state else [read(f) for f in args.external]
    if any(w["schema"]!=schema["recurrentSchema"] for w in external):
        raise ValueError("External opponent has an incompatible observation schema")
    if state:
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        rng.setstate(state["rng"])
        torch.set_rng_state(state["torchRng"])
        if device.type=="cuda" and state["cudaRng"] is not None:
            torch.cuda.set_rng_state_all(state["cudaRng"])
        gen,games,decisions,archives,best,log=(state[k] for k in ["generation","games","decisions","archives","best","log"])
    start=time.monotonic()
    def checkpoint():
        target=directory/"checkpoint.pt"
        tmp=target.with_suffix(".tmp")
        torch.save(dict(model=model.state_dict(),optimizer=optimizer.state_dict(),rng=rng.getstate(),
                        torchRng=torch.get_rng_state(),cudaRng=torch.cuda.get_rng_state_all() if device.type=="cuda" else None,
                        generation=gen,games=games,decisions=decisions,archives=archives,external=external,best=best,log=log,
                        schema=schema,code=code,config=cfg,objectives=list(GOALS),device=str(device),
                        torchVersion=str(torch.__version__)),tmp)
        os.replace(tmp,target)
        selected_files(directory,best)
        write(directory/"training.jsonl","".join(compact(e)+"\n" for e in log))
        write(directory/"validation.json",compact({z:{k:v for k,v in b.items() if k!="weights"} for z,b in best.items()})+"\n")
    if args.teachers:
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/"sequences.json"
            subprocess.run(["node",str(WORKER),"teachers",str(args.teachers.resolve()),str(output)],check=True,cwd=ROOT)
            sequences=read(output)
        off,on,used,accepted={},{},{},[]
        for z in GOALS:
            student=Policy(schema,cfg["hidden"]).to(device)
            student.from_export(best[z]["weights"])
            specs=[dict(seed=cfg["validationSeed"]+i,seat=seat,objective=z)
                   for i in range(cfg["validationDeals"]) for seat in range(5)]
            def measure(weights):
                return statistics.mean(r["reward"] for r in rollout("validate",weights,[],specs,cfg))
            off[z]=measure(student.export())
            used[z]=distill(student,[s for s in sequences if s and s[-1]["objective"]==z],
                            cfg["teacherTemperature"],cfg["teacherLR"])
            weights=student.export()
            on[z]=measure(weights) if used[z] else off[z]
            if on[z]>off[z]:
                best[z]=dict(utility=on[z],generation=gen,stage="teacher",weights=weights)
                accepted.append(z)
        # Continuing PPO uses fresh rollouts from the accepted student.
        chosen=max(accepted,key=lambda z:on[z]-off[z]) if accepted else None
        if chosen:
            model.from_export(best[chosen]["weights"])
            optimizer=torch.optim.Adam(model.parameters(),lr=cfg["learningRate"])
        log.append(dict(stage="teacher",file=args.teachers.name,examples=len(sequences),used=used,
                        off=off,on=on,selectedFor=accepted,continueFromTeacher=chosen))
        checkpoint()
        print(compact(log[-1]),flush=True)
        return
    limit=args.updates if args.updates is not None else cfg["updates"]
    budget=cfg["budgetSeconds"] if args.budget_seconds is None else args.budget_seconds
    if limit<1 or budget<=0:
        p.error("Set a positive update and time budget")
    for _ in range(limit):
        if time.monotonic()-start>=budget:
            break
        began=time.monotonic()
        old=model.export()
        specs=[dict(seed=rng.randrange(1,1_000_000),seat=(j+gen)%5,objective=z)
               for j in range(cfg["episodesPerGoal"]) for z in GOALS]
        rng.shuffle(specs)
        episodes=rollout("collect",old,archives+external,specs,cfg)
        metrics=fit(model,optimizer,episodes,cfg,device)
        new=model.export()
        val,val_rows=validation(new,cfg)
        gen+=1
        games+=len(episodes)
        decisions+=metrics["decisions"]
        for z in GOALS:
            if z not in best or val[z]>best[z]["utility"]:
                best[z]=dict(utility=val[z],generation=gen,stage="ppo",weights=new)
        archives=(archives+[old])[-cfg["historySize"]:]
        counts=Counter(id.split("/")[0] for e in episodes for id in e["lineup"] if not id.startswith("learner/"))
        rec=dict(stage="ppo",generation=gen,games=games,decisions=decisions,validation=val,
                 validationDeals=cfg["validationDeals"],leagueCounts=counts,metrics=metrics,
                 trainEpisodes=[{k:v for k,v in ep.items() if k!="rows"} for ep in episodes],
                 validationEpisodes=val_rows,seconds=round(time.monotonic()-began,3))
        log.append(rec)
        checkpoint()
        print("update",gen,"games",games,"decisions",decisions,"validation",val,"seconds",rec["seconds"],flush=True)
    print("elapsedSeconds",round(time.monotonic()-start,3),"checkpoint",directory/"checkpoint.pt",flush=True)


if __name__=="__main__":
    main()
