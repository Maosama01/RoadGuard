#!/bin/bash
# Full-quality RoadGuard detector training on a Mac (uses the Apple GPU via MPS when there is one).
#
#   bash ml/train_mac.sh                          # continues from the shipped model, 60 more epochs at 512 px
#   MODEL=yolo11n.pt bash ml/train_mac.sh         # start fresh from the COCO-pretrained nano model instead
#   MODEL=yolo11s.pt EPOCHS=100 bash ml/train_mac.sh   # bigger: more accurate, about 2.5x slower on the phone
#   FRESH=1 bash ml/train_mac.sh                  # ignore an interrupted run instead of resuming it
#
# Safe to leave alone: it keeps the Mac awake, logs everything to ml/work/train.log, writes its
# progress to ml/work/STATUS, and if it is interrupted (lid closed, power cut) running it again
# resumes where it stopped.
#
# At the end the new model is benchmarked on the held-out Indian test set against the model in
# the app. It replaces app/src/main/assets/best.tflite ONLY if it scores higher. The previous model
# is kept in ml/weights/previous_best.tflite so you can roll back.
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SCRIPT")"
mkdir -p work

# Keep the Mac awake for as long as this runs (display may sleep; the lid must stay open).
if command -v caffeinate >/dev/null 2>&1 && [ -z "${RG_AWAKE:-}" ]; then
  export RG_AWAKE=1
  exec caffeinate -ims bash "$SCRIPT" "$@"
fi

exec > >(tee -a work/train.log) 2>&1
status() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a work/STATUS; }
fail() { status "FAILED: $*"; exit 1; }

MODEL="${MODEL:-roadguard_v3_e5.pt}"
EPOCHS="${EPOCHS:-60}"
IMGSZ="${IMGSZ:-512}"
BATCH="${BATCH:-8}"
WORKERS="${WORKERS:-2}"
status "START model=$MODEL epochs=$EPOCHS imgsz=$IMGSZ"

# 0. Python 3.9 or newer.
PY=""
for c in python3.12 python3.11 python3.13 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
[ -z "$PY" ] && fail "no Python 3.9+ found. Install it from python.org and run again."
[ -d .venv ] || "$PY" -m venv .venv || fail "could not create the Python environment"
source .venv/bin/activate
status "STAGE install ($(python --version 2>&1))"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet "ultralytics==8.4.183" pillow numpy \
  || python -m pip install --quiet ultralytics pillow numpy \
  || fail "could not install ultralytics (check the internet connection)"
# Only needed to export and benchmark the phone model. If they don't install on this Mac,
# training still runs and Claude can export the result.
python -m pip install --quiet ai-edge-litert || echo "note: ai-edge-litert unavailable here"
python -m pip install --quiet litert-torch || echo "note: litert-torch unavailable here"

DEVICE="${DEVICE:-$(python -c 'import torch; print("mps" if torch.backends.mps.is_available() else "cpu")')}"
status "device=$DEVICE"
[ "$DEVICE" = "cpu" ] && echo "WARNING: no Apple GPU found; CPU training will take many hours."

# 1. Unpack the verified RDD2020 India data (15,412 files, checked against GitHub SHA-1s).
if [ ! -f work/src/.verified ]; then
  status "STAGE unpack dataset"
  rm -rf work/src && mkdir -p work/src
  for p in datasets/rdd2020_india/india_part*.tar; do tar -xf "$p" -C work/src || fail "could not unpack $p"; done
  python verify_dataset.py work/src datasets/rdd2020_india/MANIFEST_git_sha1.txt || fail "dataset check failed"
  touch work/src/.verified
fi

# 2. YOLO format, leak-free block split.
if [ ! -f work/data/rdd_india/rdd_india.yaml ]; then
  status "STAGE prepare split"
  python prepare_rdd.py --src work/src --out work/data/rdd_india || fail "prepare_rdd failed"
fi

# 3. Train (or resume an interrupted run).
status "STAGE train"
MODEL="$MODEL" EPOCHS="$EPOCHS" IMGSZ="$IMGSZ" BATCH="$BATCH" WORKERS="$WORKERS" DEVICE="$DEVICE" python - <<'PY' || fail "training stopped with an error (see work/train.log)"
import os
from ultralytics import YOLO
run = "work/runs/roadguard"
last = f"{run}/weights/last.pt"
args = dict(data="work/data/rdd_india/rdd_india.yaml", epochs=int(os.environ["EPOCHS"]), imgsz=int(os.environ["IMGSZ"]),
            batch=int(os.environ["BATCH"]), workers=int(os.environ["WORKERS"]), device=os.environ["DEVICE"], project=os.path.abspath("work/runs"), name="roadguard",
            exist_ok=True, close_mosaic=10, patience=30, seed=2026, plots=True)
import torch


def interrupted(path):
    """True only for a checkpoint of a run that stopped midway (a finished run strips its optimizer)."""
    try:
        ck = torch.load(path, map_location="cpu", weights_only=False)
        return ck.get("epoch", -1) >= 0 and ck.get("optimizer") is not None
    except Exception:
        return False


fresh = os.environ.get("FRESH") == "1"
if not fresh and os.path.exists(last) and interrupted(last):
    print("Resuming the interrupted run from", last)
    YOLO(last).train(resume=True)
elif not fresh and os.path.exists(f"{run}/weights/best.pt"):
    print("Training already finished earlier; using it. Run with FRESH=1 to train again from scratch.")
else:
    YOLO("weights/" + os.environ["MODEL"]).train(**args)
PY
BEST=work/runs/roadguard/weights/best.pt
[ -f "$BEST" ] || fail "no trained model found at ml/$BEST"
cp "$BEST" weights/roadguard_mac_best.pt
status "TRAINED $(tail -1 work/runs/roadguard/results.csv 2>/dev/null)"

# 4. Export for the phone.
status "STAGE export"
rm -rf work/runs/roadguard/weights/*.tflite work/runs/roadguard/weights/*_saved_model
IMGSZ="$IMGSZ" python -c 'import os; from ultralytics import YOLO; print(YOLO("work/runs/roadguard/weights/best.pt").export(format="tflite", imgsz=int(os.environ["IMGSZ"])))' \
  || fail "EXPORT: training worked (ml/weights/roadguard_mac_best.pt) but this Mac could not convert it for the phone. Ask Claude to export it."
NEW=$(find work/runs/roadguard -name "*float32*.tflite" | head -1)
[ -z "$NEW" ] && NEW=$(find work/runs/roadguard -name "*.tflite" | head -1)
[ -z "$NEW" ] && fail "EXPORT: no .tflite produced. Ask Claude to export ml/weights/roadguard_mac_best.pt."

# 5. Benchmark on the test split (never used for training or calibration), then keep the better model.
status "STAGE benchmark"
ASSETS=../app/src/main/assets
python evaluate.py --data work/data/rdd_india --model "$NEW" --pothole-class 0 --json work/eval_new.json || fail "EVAL: benchmark of the new model failed"
python evaluate.py --data work/data/rdd_india --model "$ASSETS/best.tflite" --pothole-class 0 --json work/eval_shipped.json || fail "EVAL: benchmark of the shipped model failed"
VERDICT=$(python -c 'import json; n=json.load(open("work/eval_new.json"))["AP50"]; o=json.load(open("work/eval_shipped.json"))["AP50"]; print(("BETTER" if n > o else "WORSE") + f" new AP50 {n:.3f} vs shipped {o:.3f}")')
status "$VERDICT"

if [[ "$VERDICT" == BETTER* ]]; then
  # Keep rollback copies outside assets/ (anything in assets/ is packed into the APK).
  cp "$ASSETS/best.tflite" weights/previous_best.tflite
  cp "$ASSETS/model_config.json" weights/previous_model_config.json 2>/dev/null || true
  cp "$NEW" "$ASSETS/best.tflite"
  python calibrate.py --data work/data/rdd_india --model "$ASSETS/best.tflite" --pothole-class 0 --out "$ASSETS/model_config.json" || fail "CALIBRATE failed (new model is installed; thresholds were not updated)"
  status "DONE installed the new model and its thresholds. Rebuild the app in Android Studio."
  echo "To roll back: copy ml/weights/previous_best.tflite and previous_model_config.json back into app/src/main/assets (as best.tflite and model_config.json)."
else
  status "DONE kept the shipped model; the new one did not beat it. It is saved at ml/$NEW."
fi
