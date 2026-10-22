"""
Prepare the RDD2020 India road damage dataset for YOLO training.

Source: RDD2020 (Arya et al., "RDD2020: An annotated image dataset for automatic road damage
detection using deep learning", Data in Brief 36, 2021). India subset: 7,706 smartphone
images (720x720) captured from cars on Indian roads, Pascal VOC boxes.

Usage:
    python prepare_rdd.py --src <folder containing India/images and India/annotations/xmls> --out data/rdd_india

Class mapping (RDD code -> RoadGuard class):
    D40 pothole                         -> 0 Pothole
    D20 alligator (fatigue) crack       -> 1 Alligator Crack
    D00/D01 longitudinal crack/joint    -> 2 Longitudinal Crack
    D10/D11 transverse crack/joint      -> 3 Transverse Crack
    D43/D44 paint wear, D50 manhole     -> dropped

Split: images are consecutive frames from drives, so neighbours are near-duplicates. A random
split would leak them across train and test and inflate scores. Instead frames are grouped in
blocks of 50 consecutive images and whole blocks are assigned to train (80%), val (10%) or
test (10%) with a fixed seed.
"""
import argparse
import os
import random
import shutil
import xml.etree.ElementTree as ET

NAMES = ["Pothole", "Alligator Crack", "Longitudinal Crack", "Transverse Crack"]
CODE_TO_CLASS = {"D40": 0, "D20": 1, "D00": 2, "D01": 2, "D10": 3, "D11": 3}
BLOCK = 50


def convert(xml_path):
    root = ET.parse(xml_path).getroot()
    w = float(root.findtext("size/width"))
    h = float(root.findtext("size/height"))
    lines = []
    for obj in root.findall("object"):
        cls = CODE_TO_CLASS.get((obj.findtext("name") or "").strip())
        if cls is None:
            continue
        b = obj.find("bndbox")
        x1, y1, x2, y2 = (float(b.findtext(k)) for k in ("xmin", "ymin", "xmax", "ymax"))
        x1, x2 = max(0.0, min(x1, x2)), min(w, max(x1, x2))
        y1, y2 = max(0.0, min(y1, y2)), min(h, max(y1, y2))
        if x2 - x1 < 2 or y2 - y1 < 2:
            continue
        lines.append(f"{cls} {(x1 + x2) / 2 / w:.6f} {(y1 + y2) / 2 / h:.6f} {(x2 - x1) / w:.6f} {(y2 - y1) / h:.6f}")
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=2026)
    a = ap.parse_args()

    img_dir = os.path.join(a.src, "India", "images")
    xml_dir = os.path.join(a.src, "India", "annotations", "xmls")
    names = sorted(f[:-4] for f in os.listdir(img_dir) if f.endswith(".jpg"))
    blocks = [names[i:i + BLOCK] for i in range(0, len(names), BLOCK)]
    rng = random.Random(a.seed)
    rng.shuffle(blocks)
    n = len(blocks)
    splits = {"train": blocks[: int(n * 0.8)], "val": blocks[int(n * 0.8): int(n * 0.9)], "test": blocks[int(n * 0.9):]}

    stats = {}
    for split, bl in splits.items():
        os.makedirs(os.path.join(a.out, "images", split), exist_ok=True)
        os.makedirs(os.path.join(a.out, "labels", split), exist_ok=True)
        counts = [0] * len(NAMES)
        imgs = 0
        for block in bl:
            for stem in block:
                lines = convert(os.path.join(xml_dir, stem + ".xml"))
                for ln in lines:
                    counts[int(ln.split()[0])] += 1
                shutil.copy(os.path.join(img_dir, stem + ".jpg"), os.path.join(a.out, "images", split, stem + ".jpg"))
                with open(os.path.join(a.out, "labels", split, stem + ".txt"), "w") as f:
                    f.write("\n".join(lines) + ("\n" if lines else ""))
                imgs += 1
        stats[split] = (imgs, counts)

    with open(os.path.join(a.out, "rdd_india.yaml"), "w") as f:
        f.write(f"path: {os.path.abspath(a.out)}\ntrain: images/train\nval: images/val\ntest: images/test\n")
        f.write("names:\n" + "".join(f"  {i}: {n}\n" for i, n in enumerate(NAMES)))
    for split, (imgs, counts) in stats.items():
        print(f"{split:5s} images={imgs:5d} " + " ".join(f"{NAMES[i]}={c}" for i, c in enumerate(counts)))


if __name__ == "__main__":
    main()
