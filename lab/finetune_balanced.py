"""Fine-tune an exported table GRU for its balanced objective using fresh self-play."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import time

import torch

from recurrent_train import Policy, ROOT, WORKER, compact, fit, provenance, read, rollout, write


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--initial", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--train-seed", type=int, default=22_000_000)
    parser.add_argument("--validation-seed", type=int, default=23_000_000)
    parser.add_argument("--updates", type=int, default=6)
    parser.add_argument("--episodes", type=int, default=180)
    parser.add_argument("--validation-deals", type=int, default=48)
    args = parser.parse_args()
    if min(args.updates, args.episodes, args.validation_deals) < 1:
        parser.error("Provide positive update and game counts")
    train = range(args.train_seed, args.train_seed + args.updates * args.episodes)
    valid = range(args.validation_seed, args.validation_seed + args.validation_deals)
    if max(train.start, valid.start) < min(train.stop, valid.stop):
        parser.error("Training and validation deals must be disjoint")
    args.out.mkdir(parents=True, exist_ok=True)
    if any(args.out.iterdir()):
        parser.error("Choose an empty output directory")

    cfg = read(ROOT / "configs/recurrent.json")
    cfg.update(learningRate=0.0008, batchEpisodes=12, epochs=3)
    cfg["league"] = dict(baseline=0.25, recent=0.45, history=0.30,
                         rules=["heuristic", "aggressive", "conservative"])
    torch.set_num_threads(cfg["threads"])
    torch.manual_seed(args.train_seed)
    schema = json.loads(subprocess.check_output(["node", str(WORKER), "schema"], cwd=ROOT))
    initial = read(args.initial)
    model = Policy(schema, initial["hidden"])
    model.from_export(initial)
    optimizer = torch.optim.Adam(model.parameters(), lr=cfg["learningRate"])
    validation = [dict(seed=s, seat=i, objective="balanced") for s in valid for i in range(5)]
    history = [initial]
    source = provenance()
    source["lab/finetune_balanced.py"] = hashlib.sha256(Path(__file__).read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    write(args.out / "settings.json", compact(dict(initialSHA256=hashlib.sha256(args.initial.read_bytes()).hexdigest(),
          trainStart=train.start, trainStop=train.stop, validationStart=valid.start, validationStop=valid.stop,
          episodes=args.episodes, updates=args.updates, config=cfg, torch=str(torch.__version__), source=source)))
    for generation in range(args.updates + 1):
        begin = time.monotonic()
        metrics = {}
        if generation:
            first = train.start + (generation - 1) * args.episodes
            specs = [dict(seed=first + i, seat=(i + generation) % 5, objective="balanced")
                     for i in range(args.episodes)]
            current = model.export()
            episodes = rollout("collect", current, history, specs, cfg)
            metrics = fit(model, optimizer, episodes, cfg, torch.device("cpu"))
            metrics["gradientSteps"] = cfg["epochs"] * ((len(episodes) + cfg["batchEpisodes"] - 1)//cfg["batchEpisodes"])
            metrics["seatCounts"] = dict(Counter(e["seat"] for e in episodes))
            metrics["roleCounts"] = dict(Counter(e["role"] for e in episodes))
            metrics["opponentCounts"] = dict(Counter(id.split("/")[0] for e in episodes for id in e["lineup"]
                                                       if not id.startswith("learner/")))
            history = [initial] + (history[1:] + [current])[-3:]
        weights = initial if not generation else model.export()
        path = args.out / f"generation-{generation}.json"
        write(path, compact(weights))
        rows = rollout("validate", weights, [], validation, cfg)
        write(args.out / f"validation-{generation}.json", compact(rows))
        record = dict(generation=generation, games=generation*args.episodes, metrics=metrics,
                      validationWin=statistics.mean(r["win"] for r in rows),
                      validationScore=statistics.mean(r["settlement"] for r in rows),
                      validationUtility=statistics.mean(r["reward"] for r in rows),
                      seconds=round(time.monotonic() - begin, 2))
        with (args.out / "training.jsonl").open("a", encoding="utf-8") as log:
            log.write(compact(record)+"\n")
        print(compact(record), flush=True)
        if generation:
            torch.save(dict(weights=model.state_dict(), optimizer=optimizer.state_dict(), rng=torch.get_rng_state(),
                            generation=generation, history=history), args.out / "checkpoint.pt")


if __name__ == "__main__":
    main()
