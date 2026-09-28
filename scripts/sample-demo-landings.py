"""Independent M0 coordinate evidence: uv run --with demoparser2==0.42.0 python ..."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import random

from demoparser2 import DemoParser

arguments = argparse.ArgumentParser()
arguments.add_argument("demo", type=Path)
arguments.add_argument("output", type=Path)
arguments.add_argument("--seed", type=int, default=20260929)
options = arguments.parse_args()
parser = DemoParser(str(options.demo))
header = parser.parse_header()
deaths = parser.parse_event("player_death")
last_tick = int(deaths["tick"].max())
rng = random.Random(options.seed)
# Choose windows before inspecting player positions or any map geometry.
starts = sorted(rng.sample(range(1024, last_tick - 256), 32))
ticks = sorted({tick for start in starts for tick in range(start, start + 256)})
states = parser.parse_ticks(
    ["X", "Y", "Z", "CCSPlayerPawn.m_fFlags", "is_alive"], ticks=ticks
)
landings = []
for player_id, player in states.groupby("steamid"):
    previous = None
    for row in player.sort_values("tick").to_dict("records"):
        flags = int(row["CCSPlayerPawn.m_fFlags"])
        if previous is not None:
            before_flags = int(previous["CCSPlayerPawn.m_fFlags"])
            if (row["tick"] == previous["tick"] + 1 and row["is_alive"]
                    and previous["is_alive"] and flags & 1 and not before_flags & 1):
                landings.append({
                    "tick": int(row["tick"]), "steam_id": str(player_id),
                    "position": [float(row[axis]) for axis in ["X", "Y", "Z"]],
                    "flags_before": before_flags, "flags": flags,
                })
        previous = row
assert len(landings) >= 32, f"only {len(landings)} grounded transitions found"
samples = sorted(rng.sample(landings, 32), key=lambda sample: (sample["tick"], sample["steam_id"]))
with options.demo.open("rb") as demo:
    fingerprint = hashlib.file_digest(demo, "sha256").hexdigest()
evidence = {
    "demo_sha256": fingerprint, "map_name": header["map_name"],
    "parser_version": importlib.metadata.version("demoparser2"),
    "seed": options.seed, "window_starts": starts,
    "landing_count": len(landings), "samples": samples,
}
options.output.parent.mkdir(parents=True, exist_ok=True)
options.output.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
print(f"sampled {len(samples)} of {len(landings)} grounded transitions; map={header['map_name']}; sha256={fingerprint}")
