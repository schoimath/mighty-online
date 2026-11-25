"""Fit a play-only residual actor using paired, full-game counterfactual returns."""
import argparse
import hashlib
import json
from pathlib import Path

import torch
import torch.nn.functional as F


def data(path):
    deals = json.loads(path.read_text(encoding="utf-8"))
    rows = [row for deal in deals for row in deal["examples"]]
    hidden = torch.tensor([row["hidden"]+[1.] for row in rows])
    features = torch.tensor([row["features"] for row in rows])
    x = (features[:, :, None]*hidden[:, None, :]).flatten(1)
    base = torch.tensor([r["logit"] for r in rows])
    utility = torch.tensor([r["utility"] for r in rows])
    points = torch.tensor([r["points"] for r in rows], dtype=torch.float32)
    # Small point differences also distinguish cards in settled wins/losses.
    reward = utility + .015*points
    info = dict(firstSeed=deals[0]["seed"], lastSeed=deals[-1]["seed"], deals=len(deals),
                continuations=sum(r["branches"] for r in deals), pairs=len(rows),
                decisivePairs=int((utility.abs() > .5).sum()), nonTies=int((reward != 0).sum()))
    return (x, base, reward, utility, points), info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("initial", "training", "validation", "out"):
        parser.add_argument("--"+name, required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if any(args.out.iterdir()):
        parser.error("Choose an empty output directory")
    torch.set_num_threads(1)
    torch.manual_seed(24300000)
    (x, base, reward, _, _), tr = data(args.training)
    (vx, vb, _, vu, vp), va = data(args.validation)
    if max(tr["firstSeed"], va["firstSeed"]) <= min(tr["lastSeed"], va["lastSeed"]):
        raise ValueError("Overlapping split")
    model = json.loads(args.initial.read_text(encoding="utf-8-sig"))
    delta = torch.nn.Parameter(torch.zeros(x.shape[1]))
    optimizer = torch.optim.Adam([delta], lr=.014)
    # Differences are oriented arbitrarily by incumbent rank. Paired logistic
    # loss is symmetric when both the direction and features are reversed.
    active = torch.where(reward.abs() > 1e-9)[0]
    if not len(active):
        raise ValueError("No differing action outcomes")
    history, steps = [], 0
    best_score, best = -float("inf"), None
    for epoch in range(1, 13):
        for batch in active[torch.randperm(len(active))].split(64):
            logits = base[batch]+x[batch]@delta
            w = reward[batch].abs()
            loss = (w * F.softplus(-reward[batch].sign()*logits)).sum()/w.sum()
            loss = loss + .004*delta.square().sum()
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            steps += 1
        with torch.no_grad():
            for scale in (.35, .7, 1.):
                change = (vb+vx@(scale*delta)) < 0
                gain = float((-vu*change).mean())
                card_gain = float((-vp*change).mean())
                record = dict(epoch=epoch, strength=scale, steps=steps, changed=int(change.sum()),
                              utilityPerPair=gain, cardPointsPerPair=card_gain)
                history.append(record)
                # Fix the checkpoint using new deals before a separate live-table benchmark.
                score = gain + .015*card_gain
                if score > best_score:
                    best_score, best, chosen = score, scale*delta.detach().clone(), record
    changes = best.reshape(len(model["actor"]), model["hidden"]+1).tolist()
    for a, row in enumerate(changes):
        model["actor"][a] = [v+d for v,d in zip(model["actor"][a], row[:-1], strict=True)]
        model["actorBias"][a] += row[-1]
    output = json.dumps(model, separators=(",", ":"), allow_nan=False).encode("utf-8")
    (args.out/"candidate.json").write_bytes(output)
    report = dict(method="counterfactual-returns-play-only-actor", torch=str(torch.__version__), train=tr, validation=va,
                  optimizerSteps=steps, selected=chosen, seed=24300000, validationHistory=history,
                  sourceSHA256=hashlib.sha256(args.initial.read_bytes()).hexdigest(),
                  candidateSHA256=hashlib.sha256(output).hexdigest())
    (args.out/"training.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(tr, va, chosen, report["candidateSHA256"], flush=True)


if __name__ == "__main__":
    main()
