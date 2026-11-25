"""Fit + validate the belief teacher at its recorded per-information-set temperature."""
import argparse
import math
from pathlib import Path
import subprocess
import sys
import tempfile

import torch

from recurrent_train import ROOT, compact, write
import json


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint",type=Path,required=True)
    parser.add_argument("--teachers",type=Path,required=True)
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--ablation",type=Path,help="Export every candidate, including those rejected in validation")
    args=parser.parse_args()
    state=torch.load(args.checkpoint,map_location="cpu",weights_only=True)
    tau=state["config"]["teacherTemperature"]
    examples=[]
    for line in args.teachers.read_text(encoding="utf-8").splitlines():
        raw=json.loads(line)
        probs=raw["probabilities"]
        if len(probs)!=len(raw["actions"]) or not math.isclose(sum(probs),1,abs_tol=1e-7):
            raise ValueError("Malformed teacher distribution")
        if any(not 0<p<=1 for p in probs):
            raise ValueError("Teacher target must be a finite softmax")
        # The supervised trainer accepts softmax(Q / tau). These target logits
        # exactly preserve the teacher distribution for every recorded temperature.
        examples.append(dict(raw,teacherQ=[tau*math.log(p) for p in probs]))
    with tempfile.TemporaryDirectory() as folder:
        target=Path(folder)/args.teachers.name
        write(target,"".join(compact(row)+"\n" for row in examples))
        subprocess.run([sys.executable,"-B",str(ROOT/"lab/recurrent_train.py"),"--resume",str(args.checkpoint),
                        "--teachers",str(target),"--out",str(args.out)],check=True)
        if args.ablation:
            subprocess.run([sys.executable,"-B",str(ROOT/"lab/recurrent_ablation.py"),"--checkpoint",str(args.checkpoint),
                            "--teachers",str(target),"--out",str(args.ablation)],check=True)


if __name__=="__main__":
    main()
