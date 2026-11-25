"""Export the exact untrained or pre-selection teacher policies for controlled comparisons."""
import argparse
from pathlib import Path
import subprocess
import tempfile

import torch

from recurrent_train import GOALS, Policy, ROOT, WORKER, compact, distill, read, write


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint",type=Path,required=True)
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--teachers",type=Path)
    args=parser.parse_args()
    state=torch.load(args.checkpoint,map_location="cpu",weights_only=True)
    args.out.mkdir(parents=True,exist_ok=True)
    cfg=state["config"]
    torch.set_num_threads(cfg["threads"])
    torch.manual_seed(cfg["seed"])
    model=Policy(state["schema"],cfg["hidden"])
    write(args.out/"initial.json",compact(model.export())+"\n")
    if args.teachers:
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/"sequences.json"
            subprocess.run(["node",str(WORKER),"teachers",str(args.teachers.resolve()),str(target)],check=True,cwd=ROOT)
            sequences=read(target)
        for z in GOALS:
            model.from_export(state["best"][z]["weights"])
            distill(model,[s for s in sequences if s and s[-1]["objective"]==z],cfg["teacherTemperature"],cfg["teacherLR"])
            write(args.out/f"teacher-{z}.json",compact(model.export())+"\n")


if __name__=="__main__":
    main()
