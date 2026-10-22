# Benchmark: pothole detection on Indian roads

## Current model in the app: RoadGuard v4 (YOLO11n, 512 px, 60 epochs on the Mac GPU)

Trained on 21 Oct 2026 with `bash ml/train_mac.sh`, continuing from v3. Same held out test split as below (800 images, 388 potholes), same evaluator, threshold chosen on validation.

| | v3 (5 CPU epochs) | **v4 (60 GPU epochs, in the app now)** |
|---|---|---|
| AP50, pothole | 0.186 | **0.417** (2.2x) |
| AP30, pothole | 0.276 | **0.552** (2.0x) |
| Best F1 | 0.258 | **0.452** |
| Validation mAP50, all 4 classes | 0.121 | **0.339** (best epoch 59) |
| Time per frame, Mac CPU | 34 ms | 32 ms |
| Thresholds (model_config.json) | 0.16 / 0.26 / 0.36 | 0.10 / 0.20 / 0.30 |

Against the original v2 model (AP50 0.033) v4 is about 12x better. v3 is kept as `ml/weights/previous_best.tflite` with `previous_model_config.json`; the v4 PyTorch weights are `ml/weights/roadguard_mac_best.pt`. Raw numbers: `work/eval_new.json`, `work/eval_shipped.json`, training curve `work/runs/roadguard/results.csv`.

v4's confidence scores run low (best F1 sits at 0.07 to 0.10), so its thresholds are low too. In the app a report still needs two sightings or one at 0.30+, plus a jolt or 3 drivers on the server, but the real world false alarm rate has to be checked on a test drive.

## Earlier benchmark: v2 vs v3

**Test set:** 800 RDD2020 India images, with 388 potholes. They come from whole blocks of consecutive frames that never appear in training or validation, so near-duplicate frames can't leak in.

**Method:** both models run as `.tflite` files the way the app runs them, scored by `evaluate.py`. Each model is scored at its own best threshold, chosen on the **validation** split, never the test split.

| | Original model (`best.tflite`, v2) | RoadGuard v3 (YOLO11n, 5 CPU epochs) |
|---|---|---|
| Input size | 1024 px | 512 px |
| AP50, pothole | 0.033 | **0.186** (5.6x) |
| AP30, pothole (looser boxes) | 0.076 | **0.276** (3.6x) |
| Threshold chosen on validation | 0.41 | 0.16 |
| Potholes found (of 388) | 25 | **82** (3.3x) |
| False alarms | 166 | 171 |
| Precision / recall | 0.13 / 0.06 | **0.32 / 0.21** |
| F1 | 0.086 | **0.256** (3x) |
| Time per frame, 2 x86 CPU threads | 228 to 407 ms | **54 ms** (about 4 to 7x faster) |
| Classes | drain hole, pothole, sewer cover | pothole, alligator crack, longitudinal crack, transverse crack |

The scores are for single frames. In the app a report also needs two sightings, or one very confident sighting. It is confirmed by a felt jolt where possible, and verified by 3 different drivers on the server. So false alarms that reach the city are far fewer than the per-frame numbers above.

## Honest limits

* **v3 is under-trained.** CPU training stopped after 5 of 15 planned epochs, at the compute limit of the build machine. Validation mAP rose every epoch: 0.029, 0.053, 0.057, 0.077 and 0.121, across all four classes.
* **Continue on the Mac GPU.** `bash ml/train_mac.sh` picks up from this model and trains 60 more epochs at 512 px on the GPU. The validation curve was still climbing steeply, so expect a clear improvement. It benchmarks the new model on the test split and installs it only if it beats the shipped one.
* **Open drains are no longer detected.** v3 does not detect open drains: RDD has no drain class, and the original model's drain data source is unknown. The original model is kept as `ml/weights/best_v2_original.tflite`. To bring drains back, add a verified drain dataset with the same class names and retrain.
* **One region.** RDD India images come from a few north Indian cities in daylight. Night, rain and hill roads (Dehradun) are under-represented. Collect your own photos from the app's reports, review them in the dashboard, and add them to training.

Raw numbers: `eval_old.json` and `eval_v3_e5.json`.
