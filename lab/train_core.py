"""Train four independent observation-only residual policies with masked PPO."""
import argparse
import hashlib
import json
import math
import os
import platform
import random
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "lab/train-rollout.mjs"
OBJECTIVES = ("win", "score", "balanced", "downside_averse")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def save(path, data):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    os.replace(tmp, path)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def node(*args):
    return subprocess.check_output(["node", str(WORKER), *map(str, args)], cwd=ROOT, text=True, encoding="utf-8").strip()


def meta_hash():
    files = [Path(__file__), WORKER, ROOT/"lab/policy.js", ROOT/"lab/game.js", ROOT/"lab/rules-agents.js",
             ROOT/"lab/scoring.js", ROOT/"engine.js", ROOT/"bot-weights.js", ROOT/"bot-exchange.js", ROOT/"configs/population.json"]
    return hashlib.sha256("".join(sha(f) for f in files).encode()).hexdigest()


class Policy(nn.Module):
    def __init__(self, schema, hidden):
        super().__init__()
        self.context = nn.Linear(schema["input"], hidden)
        self.actor = nn.Linear(hidden, schema["actions"])
        self.critic = nn.Linear(hidden, 1)
        nn.init.normal_(self.actor.weight, std=0.035)
        nn.init.zeros_(self.actor.bias)

    def forward(self, state, actions, prior):
        h = torch.tanh(self.context(state))
        logits = (actions * self.actor(h).unsqueeze(1)).sum(-1) + prior
        return logits, self.critic(h).squeeze(1)

    def export(self):
        get = lambda v: v.detach().cpu().tolist()
        return {"context":get(self.context.weight), "contextBias":get(self.context.bias),
                "actor":get(self.actor.weight), "actorBias":get(self.actor.bias),
                "critic":get(self.critic.weight[0]), "criticBias":get(self.critic.bias[0])}


def trajectory(episodes, gae_lambda):
    rows = []
    for ep in episodes:
        if not ep["rows"]:
            raise ValueError("Focal player never acted")
        advantage, next_value = 0, 0
        for i in reversed(range(len(ep["rows"]))):
            r = ep["rows"][i]
            reward = ep["reward"] if i == len(ep["rows"])-1 else 0
            advantage = reward + next_value - r["value"] + gae_lambda * advantage
            r.update(advantage=advantage, target=advantage+r["value"])
            next_value = r["value"]
        rows.extend(ep["rows"])
    return rows


def tensors(rows, device):
    n, a, k = len(rows), max(len(r["priors"]) for r in rows), len(rows[0]["features"][0])
    actions = torch.zeros(n,a,k)
    priors = torch.full((n,a), -torch.inf)
    for i,r in enumerate(rows):
        m=len(r["priors"])
        if not (m==len(r["features"]) and 0<=r["index"]<m and m==len(r["legal"])):
            raise ValueError("Invalid stored legal-action mask")
        actions[i,:m,:] = torch.tensor(r["features"])
        priors[i,:m] = torch.tensor(r["priors"])
    return tuple(t.to(device) for t in (torch.tensor([r["state"] for r in rows]),
        actions,priors,torch.tensor([r["index"] for r in rows]),
        torch.tensor([r["logp"] for r in rows]), torch.tensor([r["teacher"] for r in rows]),
        torch.tensor([r["target"] for r in rows]),torch.tensor([r["advantage"] for r in rows])))


def fit(model,opt,episodes,cfg,device,imitation=False):
    rows=trajectory(episodes,cfg["gae_lambda"])
    # Similar-length groups keep 286-card-triplet masks out of small play minibatches.
    rows.sort(key=lambda r:len(r["priors"]))
    batches=[tensors(rows[i:i+cfg["batch_size"]],device) for i in range(0,len(rows),cfg["batch_size"])]
    with torch.no_grad():
        errors=[]
        for s,a,p,chosen,old,*_ in batches:
            logits,_=model(s,a,p)
            actual=logits.log_softmax(1).gather(1,chosen[:,None]).squeeze(1)
            errors.append((actual-old).abs().max().item())
    if max(errors)>2e-4:
        raise ValueError(f"Stored/portable policy log-probability mismatch {max(errors)}")
    advs=torch.cat([b[-1] for b in batches])
    mean,std=advs.mean(),advs.std(unbiased=False).clamp_min(1e-7)
    before=torch.nn.utils.parameters_to_vector(model.parameters()).detach().clone()
    loss_log=[]
    for _ in range(cfg["imitation_epochs"] if imitation else cfg["epochs"]):
        for bi in torch.randperm(len(batches)).tolist():
            s,a,p,chosen,old,teacher,target,adv=batches[bi]
            logits,value=model(s,a,p)
            if imitation:
                loss=nn.functional.cross_entropy(logits,teacher)
            else:
                logs=logits.log_softmax(1)
                logp=logs.gather(1,chosen[:,None]).squeeze(1)
                ratio=(logp-old).exp()
                adv=(adv-mean)/std
                clipped=ratio.clamp(1-cfg["clip_ratio"],1+cfg["clip_ratio"])
                entropy=-(logs.masked_fill(~torch.isfinite(logs),0)*logs.exp()).sum(1).mean()
                loss=-torch.minimum(ratio*adv,clipped*adv).mean()+cfg["value_coefficient"]*(value-target).square().mean()-cfg["entropy_coefficient"]*entropy
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(),cfg["max_grad_norm"],error_if_nonfinite=True)
            opt.step()
            loss_log.append(loss.item())
    diff=torch.nn.utils.parameters_to_vector(model.parameters()).detach()-before
    if not torch.isfinite(diff).all() or diff.norm().item()==0:
        raise ValueError("Optimizer failed to produce a finite nonzero update")
    return {"decisions":len(rows),"parameter_delta_l2":diff.norm().item(),
            "mean_loss":statistics.mean(loss_log),"max_logp_error":max(errors)}


def exchange(mode,params,directory):
    with tempfile.TemporaryDirectory(dir=directory) as tmp:
        req,out=Path(tmp)/"request.json",Path(tmp)/"output.json"
        save(req,params)
        node(mode,req,out)
        return read(out)


def collect(model,objective,cfg,rng,archives,count,directory):
    file=directory/"collector.json"
    save(file,model.export())
    seats=[i%5 for i in range(count)]
    rng.shuffle(seats)
    return exchange("collect",{"model":str(file),"objective":objective,"config":cfg,
        "seeds":[rng.randrange(1,1000000) for _ in range(count)],"focalSeats":seats,
        "archives":archives,"episodes":count},directory)


def train(args):
    start=time.monotonic()
    state = torch.load(args.resume,map_location="cpu",weights_only=True) if args.resume else None
    if state:
        cfg=state["config"]
        objectives=[state["objective"]]
        init_seed=state["base_seed"]
        directory=Path(args.resume).resolve().parent
    else:
        cfg=read(args.config)
        objectives=OBJECTIVES if args.objective=="all" else [args.objective]
        init_seed=args.seed
        directory=Path(args.out or ROOT/f"lab/artifacts/run-{init_seed}").resolve()
    directory.mkdir(parents=True,exist_ok=True)
    if args.smoke and not state:
        cfg=dict(cfg,episodes_per_update=10,imitation_episodes=5,validation_scenarios=2,updates=1)
    if args.alpha is not None: cfg=dict(cfg,alpha=args.alpha)
    if args.lambda_risk is not None: cfg=dict(cfg,lambdaRisk=args.lambda_risk)
    if state and cfg!=state["config"]: raise ValueError("Cannot change the checkpoint utility on resume")
    if not 0<=cfg["alpha"]<=1 or cfg["lambdaRisk"]<0 or cfg["gamma"]!=1: raise ValueError("Invalid utility/discount")
    if cfg["validation_seed"]<1000000 or cfg["validation_seed"]+cfg["validation_scenarios"]>2000000: raise ValueError("Validation seed range")
    schema=json.loads(node("schema"))
    if state and (state["schema"]!=schema or state["code_hash"]!=meta_hash()):
        raise ValueError("Checkpoint uses different rules, scoring, schemas or training code")
    device=torch.device(args.device)
    if device.type=="cuda" and not torch.cuda.is_available(): raise RuntimeError("Install the CUDA PyTorch wheel or choose --device cpu")
    torch.set_num_threads(1)
    records_path=directory/"selection.json"
    records=read(records_path) if records_path.exists() else {}
    profiles={}
    updates=args.updates or (10**9 if args.budget_minutes else cfg["updates"])
    for objective in objectives:
        seed=init_seed+1009*OBJECTIVES.index(objective)
        torch.manual_seed(seed)
        if device.type=="cuda": torch.cuda.manual_seed_all(seed)
        rng=random.Random(seed)
        model=Policy(schema,cfg["hidden"]).to(device)
        opt=torch.optim.Adam(model.parameters(),lr=cfg["learning_rate"])
        profile={"games":0,"decisions":0,"elapsed_seconds":0,"torch_rng":None}
        if not state and any(directory.glob(f"{objective}-step*.pt")):
            raise ValueError(f"Existing {objective} run; use --resume or a different --out")
        if state:
            model.load_state_dict(state["model"])
            opt.load_state_dict(state["optimizer"])
            profile.update({k:state[k] for k in ("games","decisions","elapsed_seconds")})
            rng.setstate(state["python_rng"])
            torch.set_rng_state(state["torch_rng"])
            if device.type=="cuda" and state["cuda_rng"] is not None: torch.cuda.set_rng_state_all(state["cuda_rng"])
        else:
            warm_start=time.monotonic()
            data=collect(model,objective,cfg,rng,[],cfg["imitation_episodes"],directory)
            warm=fit(model,opt,data,cfg,device,imitation=True)
            profile.update(games=len(data),decisions=warm["decisions"],elapsed_seconds=time.monotonic()-warm_start)
            print(objective,"imitation",json.dumps(warm),flush=True)
            with (directory/"training.jsonl").open("a",encoding="utf-8") as log:
                log.write(json.dumps({"objective":objective,"stage":"imitation","seed":seed,**warm,"episodes":len(data)})+"\n")
        profile.update(model=model,opt=opt,rng=rng,torch_rng=torch.get_rng_state())
        profiles[objective]=profile
    for iteration in range(updates):
        gen=(state["generation"] if state else 0)+iteration+1
        population=read(ROOT/"configs/population.json")
        archives=sorted(directory.glob("*-step*.json"),key=lambda f:(int(f.stem.rsplit("step",1)[1]),f.name))[-population["max_archived"]:]
        archives=[str(p) for p in archives]
        for objective in objectives:
            profile=profiles[objective]
            began=time.monotonic()
            model,opt,rng=profile["model"],profile["opt"],profile["rng"]
            torch.set_rng_state(profile["torch_rng"])
            data=collect(model,objective,cfg,rng,archives,cfg["episodes_per_update"],directory)
            metrics=fit(model,opt,data,cfg,device)
            profile["games"]+=len(data); profile["decisions"]+=metrics["decisions"]
            base=directory/f"{objective}-step{gen:03}"
            weights=base.with_suffix(".json")
            checkpoint=base.with_suffix(".pt")
            save(weights,model.export())
            vals=exchange("validate",{"model":str(weights),"objective":objective,"config":cfg,"archives":[],
                "episodes":cfg["validation_scenarios"]},directory)
            utility=statistics.mean(v["reward"] for v in vals)
            by_scenario=[statistics.mean(v["reward"] for v in vals if v["seed"]==seed) for seed in sorted({v["seed"] for v in vals})]
            train_meta=[{k:v for k,v in ep.items() if k!="rows"} for ep in data]
            profile["elapsed_seconds"]+=time.monotonic()-began
            profile["torch_rng"]=torch.get_rng_state()
            meta={"objective":objective,"base_seed":init_seed,"training_seed":init_seed+1009*OBJECTIVES.index(objective),
                "generation":gen,"games":profile["games"],"decisions":profile["decisions"],
                "elapsed_seconds":round(profile["elapsed_seconds"],3),"schema":schema,"config":cfg,
                "code_hash":meta_hash(),"architecture":"tanh public state encoder; legal-action residual scorer; value head",
                "torch":str(torch.__version__),"python":platform.python_version(),"device":str(device),
                "training_archive":[Path(a).name for a in archives],"training_rules":population["rules"]}
            torch.save({**meta,"model":model.state_dict(),"optimizer":opt.state_dict(),"python_rng":rng.getstate(),
              "torch_rng":profile["torch_rng"],"cuda_rng":torch.cuda.get_rng_state_all() if device.type=="cuda" else None},checkpoint)
            entry={**meta,**metrics,"checkpoint":checkpoint.name,"file":weights.name,"weight_hash":node("hash",weights),
                "checkpoint_hash":sha(checkpoint),"validation_utility":utility,"scenario_utilities":by_scenario}
            with (directory/"training.jsonl").open("a",encoding="utf-8") as log:
                log.write(json.dumps(dict(entry,episodes=train_meta),separators=(",",":"))+"\n")
            with (directory/"validation.jsonl").open("a",encoding="utf-8") as log:
                log.write(json.dumps({"objective":objective,"generation":gen,"scenarios":vals},separators=(",",":"))+"\n")
            if objective not in records or utility>records[objective]["validation_utility"]:
                records[objective]=entry
            save(records_path,records)
            print(objective,gen,"games",entry["games"],"validation",round(utility,5),"selected",records[objective]["generation"],flush=True)
        if args.budget_minutes and time.monotonic()-start >= args.budget_minutes*60: break
    if args.publish:
        if set(records)!=set(OBJECTIVES): raise ValueError("Publishing requires four selected objectives")
        destination=ROOT/"lab/artifacts"
        destination.mkdir(exist_ok=True,parents=True)
        with tempfile.TemporaryDirectory() as tmp:
            paths=Path(tmp)/"models.json"
            save(paths,{k:{"file":str(directory/v["file"])} for k,v in records.items()})
            node("publish",paths,ROOT/"lab/champions.js")
        save(destination/"champions.json",{k:{**v,"run_path":os.path.relpath(directory,ROOT).replace(os.sep,"/")} for k,v in records.items()})
    print("Elapsed",round(time.monotonic()-start,2),"seconds;",records_path,flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--objective",choices=["all",*OBJECTIVES],default="all")
    parser.add_argument("--config",default=ROOT/"configs/train.json")
    parser.add_argument("--seed",type=int,default=731)
    parser.add_argument("--device",choices=["cpu","cuda"],default="cpu")
    parser.add_argument("--updates",type=int)
    parser.add_argument("--budget-minutes",type=float)
    parser.add_argument("--out")
    parser.add_argument("--alpha",type=float)
    parser.add_argument("--lambda-risk",type=float)
    parser.add_argument("--resume",help="Trusted local .pt from this trainer")
    parser.add_argument("--smoke",action="store_true")
    parser.add_argument("--publish",action="store_true")
    args=parser.parse_args()
    if (args.updates is not None and args.updates<=0) or (args.budget_minutes is not None and args.budget_minutes<=0):
        parser.error("budget and updates must be positive")
    train(args)
