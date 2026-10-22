"""
Write assets/model_config.json for a model: confidence thresholds chosen on the VALIDATION split.

    python calibrate.py --data work/data/rdd_india --model best.tflite --pothole-class 0 --out ../app/src/main/assets/model_config.json

detectThreshold     = best-F1 threshold for potholes on validation
reportThreshold     = detectThreshold + 0.10   (reported without a felt jolt above this)
singleHitThreshold  = detectThreshold + 0.20   (one frame alone is trusted above this)
"""
import argparse
import json
import subprocess
import sys
import os

ap = argparse.ArgumentParser()
ap.add_argument("--data", required=True)
ap.add_argument("--model", required=True)
ap.add_argument("--pothole-class", type=int, default=0)
ap.add_argument("--out", required=True)
a = ap.parse_args()

here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
tmp = a.out + ".val.json"
subprocess.run([sys.executable, os.path.join(here, "evaluate.py"), "--data", a.data, "--model", a.model,
                "--pothole-class", str(a.pothole_class), "--split", "val", "--json", tmp], check=True,
               stdout=subprocess.DEVNULL)
val = json.load(open(tmp))
os.remove(tmp)
# Floor at 0.10: a weak model's best-F1 point can sit near 0, which would flood the app with sightings.
t = max(0.10, val["bestF1"]["threshold"])
cfg = {
    "model": os.path.basename(a.model),
    "detectThreshold": round(t, 2),
    "reportThreshold": round(min(0.9, t + 0.10), 2),
    "singleHitThreshold": round(min(0.95, t + 0.20), 2),
    "calibratedOn": "RDD2020 India validation split",
    "validation": {"AP50": val["AP50"], "bestF1": val["bestF1"]},
}
json.dump(cfg, open(a.out, "w"), indent=2)
print(json.dumps(cfg, indent=2))
