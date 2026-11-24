"""A restart from an older generation requires an isolated training branch."""
import argparse
import re
import runpy
import subprocess
import sys
from pathlib import Path

if __name__ != "__main__":
    from train_core import Policy, fit, trajectory
else:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--resume")
    parser.add_argument("--out")
    flags, _ = parser.parse_known_args()
    if flags.resume:
        checkpoint = Path(flags.resume).resolve()
        match = re.fullmatch(r"(.+)-step(\d+)\.pt", checkpoint.name)
        if not match or not checkpoint.is_file():
            parser.error("Choose an existing objective-stepNNN.pt checkpoint")
        if flags.out:
            branch = Path(flags.out).resolve()
            command = Path(__file__).with_name("league.mjs")
            subprocess.run(["node", str(command), "fork", str(checkpoint), str(branch)], check=True)
            checkpoint = branch / checkpoint.name
            for index, value in enumerate(sys.argv):
                if value == "--resume":
                    sys.argv[index+1] = str(checkpoint)
                elif value.startswith("--resume="):
                    sys.argv[index] = "--resume=" + str(checkpoint)
        else:
            generation = int(match.group(2))
            for candidate in checkpoint.parent.glob("*-step*.json"):
                other = re.search(r"-step(\d+)\.json$", candidate.name)
                if other and int(other.group(1)) > generation:
                    parser.error("This run contains later checkpoints. Use --out NEW_EMPTY_DIR to branch safely.")
    # The optimizer implementation also serves as the provenance of archived checkpoints.
    runpy.run_path(str(Path(__file__).with_name("train_core.py")), run_name="__main__")
