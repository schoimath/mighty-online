"""Select exported goal specialists on a common second validation split."""
import argparse
import hashlib
import statistics
from pathlib import Path

import torch

from recurrent_train import GOALS, compact, provenance, rollout, selected_files, write


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoints",type=Path,nargs="+")
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--deals",type=int,default=72)
    parser.add_argument("--seed",type=int,default=1381600)
    args=parser.parse_args()
    if args.deals<1 or args.seed<1_000_000 or args.seed+args.deals>=2_000_000:
        parser.error("Select a validation range between one and two million")
    args.out.mkdir(parents=True,exist_ok=True)
    states=[torch.load(p,map_location="cpu",weights_only=True) for p in args.checkpoints]
    first=states[0]
    config=dict(first["config"],validationSeed=args.seed,validationDeals=args.deals)
    scores={z:[] for z in GOALS}
    summary=[]
    for path,state in zip(args.checkpoints,states):
        if state["schema"]!=first["schema"] or state["code"]!=provenance():
            raise ValueError("Checkpoint provenance differs")
        for key in ("rules","scoreScale","alpha","validationBackground","hidden"):
            if state["config"][key]!=first["config"][key]:
                raise ValueError(f"Cannot compare mismatched {key}")
        prior=state["config"]["validationSeed"]
        if max(prior,args.seed)<min(prior+state["config"]["validationDeals"],args.seed+args.deals):
            raise ValueError("Second validation overlaps first validation")
        report=dict(seed=state["config"]["seed"],checkpoint=path.parent.name+"/"+path.name,
                    sha256=hashlib.sha256(path.read_bytes()).hexdigest(),games=state["games"],goals={})
        for z in GOALS:
            specs=[dict(seed=args.seed+i,seat=j,objective=z) for i in range(args.deals) for j in range(5)]
            runs=rollout("validate",state["best"][z]["weights"],[],specs,config)
            values=[statistics.mean(r["reward"] for r in runs[i:i+5]) for i in range(0,len(runs),5)]
            utility=statistics.mean(values)
            scores[z].append(utility)
            report["goals"][z]=dict(meanUtility=utility,dealMeans=values,generation=state["best"][z]["generation"])
        summary.append(report)
    selected={}
    choices={}
    for z in GOALS:
        i=max(range(len(states)),key=lambda i:scores[z][i])
        selected[z]=dict(states[i]["best"][z],utility=scores[z][i],sourceSeed=states[i]["config"]["seed"])
        choices[z]=dict(seed=selected[z]["sourceSeed"],generation=selected[z]["generation"],utility=selected[z]["utility"])
    metadata=dict(validationSeed=args.seed,validationDeals=args.deals,sources=summary,selected=choices)
    selected_files(args.out,selected)
    write(args.out/"validation.json",compact(choices)+"\n")
    write(args.out/"selection.json",compact(metadata)+"\n")
    # The continuation source is explicit; the per-objective best can come from any run.
    state=dict(first,best=selected,config=config,selection=metadata)
    state["log"]=[*state["log"],dict(stage="seed-selection",sources=[s["seed"] for s in summary],
                                    validationSeed=args.seed,validationDeals=args.deals,selected=choices,
                                    continuationSeed=first["config"]["seed"])]
    write(args.out/"training.jsonl","".join(compact(r)+"\n" for r in state["log"]))
    torch.save(state,args.out/"checkpoint.pt")
    print(compact(choices))


if __name__=="__main__":
    main()
