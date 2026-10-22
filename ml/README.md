# RoadGuard detector: data, training, benchmark

## The data

**RDD2020, India subset.** D. Arya, H. Maeda, S. K. Ghosh, D. Toshniwal, Y. Sekimoto,
*"RDD2020: An annotated image dataset for automatic road damage detection using deep learning"*,
Data in Brief 36 (2021) 107133. University of Tokyo / IIT Roorkee. Licence: CC BY 4.0.

* 7,706 photos of Indian roads, 720 x 720, taken by smartphones mounted in cars. That is the same setup as RoadGuard's drive mode.
* Pascal VOC boxes for road damage classes.
* Retrieved from the GitHub mirror `ShixuanAn/train`. Its file counts match the paper exactly: India 7,706, Japan 10,506, Czech 2,829.
* All 15,412 India files were checked against their git SHA-1s, with 0 altered. The list is in `datasets/rdd2020_india/MANIFEST_git_sha1.txt`. Re-check any time with `python verify_dataset.py`.

`datasets/rdd2020_india/india_part1.tar` and `india_part2.tar` hold the images and annotations. They are git-ignored because of their size.

### Classes RoadGuard learns

| Model class | RDD codes | What it is | In the app |
|---|---|---|---|
| 0 Pothole | D40 | potholes | reported |
| 1 Alligator Crack | D20 | fatigue cracking, the stage before a pothole | reported as "Cracked surface" |
| 2 Longitudinal Crack | D00, D01 | cracks along the road | drawn only |
| 3 Transverse Crack | D10, D11 | cracks across the road | drawn only |

Paint wear (D43, D44) and the 28 manhole boxes are dropped.

### Split without leakage

The photos are consecutive frames from drives, so neighbouring frames are near-duplicates. A random split would put the same pothole in training and test and inflate the scores. `prepare_rdd.py` therefore splits by **blocks of 50 consecutive frames**: 80% train, 10% validation and 10% test, with seed 2026. The test split (800 images, 388 potholes) is never used for training or model selection.

## Scripts

| File | Does |
|---|---|
| `prepare_rdd.py` | Converts VOC to YOLO and makes the leak-free split |
| `verify_dataset.py` | Checks every file against its recorded SHA-1 |
| `evaluate.py` | Benchmarks any `.tflite` or `.pt` model on the test split, the way the app runs it |
| `train_mac.sh` | One command: unpack, verify, prepare, train on the Mac GPU, export, benchmark, install into the app only if it scores higher; resumes if interrupted |

## Results

See `RESULTS.md`, which `evaluate.py` fills in for each model.
