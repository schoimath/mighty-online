"""Compare the learning state of two trusted CPU uninterrupted/resumed runs."""
import argparse
from pathlib import Path
import torch


def equal(left, right, key):
    if isinstance(left,torch.Tensor):
        if not torch.equal(left,right):
            raise AssertionError(key)
    elif isinstance(left,dict):
        if left.keys()!=right.keys():
            raise AssertionError(key)
        for k,v in left.items():
            equal(v,right[k],f"{key}.{k}")
    elif isinstance(left,(tuple,list)):
        if len(left)!=len(right):
            raise AssertionError(key)
        for i,(a,b) in enumerate(zip(left,right)):
            equal(a,b,f"{key}[{i}]")
    elif left!=right:
        raise AssertionError(key)


if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("first",type=Path)
    p.add_argument("second",type=Path)
    args=p.parse_args()
    states=[torch.load(path,map_location="cpu",weights_only=True) for path in [args.first,args.second]]
    for s in states:
        for rec in s["log"]:
            rec.pop("seconds",None)
    equal(*states,"checkpoint")
    print("Complete checkpoint equality, excluding wall-clock duration.")
