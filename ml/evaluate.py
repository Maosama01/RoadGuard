"""
Benchmark pothole detectors on the held-out RDD2020 India test split, the same way for every
model, so numbers are comparable.

    python evaluate.py --data data/rdd_india --model old_best.tflite --pothole-class 1 --imgsz 1024
    python evaluate.py --data data/rdd_india --model roadguard_v3.tflite --pothole-class 0 --imgsz 512

Reports, for the pothole class only (the thing RoadGuard reports):
  * AP50: average precision at IoU 0.5 (VOC all-point interpolation). Threshold-free quality.
  * AP30: the same at IoU 0.3, which forgives loose boxes (RDD boxes are drawn generously).
  * Precision / recall / F1 at confidence 0.55 (what the app draws) and 0.70 (what the app
    reports without a jolt).
  * Mean inference time per image on this CPU.

TFLite models are run exactly like the app does it: letterbox with grey (114) padding, RGB /255,
NCHW or NHWC taken from the model, YOLO head decode, class-wise NMS at IoU 0.45.
"""
import argparse
import json
import os
import time

import numpy as np
from PIL import Image


def load_gt(label_path, w, h, cls):
    boxes = []
    if os.path.exists(label_path):
        for line in open(label_path):
            p = line.split()
            if len(p) == 5 and int(p[0]) == cls:
                cx, cy, bw, bh = (float(v) for v in p[1:])
                boxes.append([(cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h])
    return np.array(boxes, dtype=np.float32).reshape(-1, 4)


def iou(a, b):
    x1 = np.maximum(a[0], b[:, 0]); y1 = np.maximum(a[1], b[:, 1])
    x2 = np.minimum(a[2], b[:, 2]); y2 = np.minimum(a[3], b[:, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1]) - inter
    return inter / np.maximum(ua, 1e-9)


def nms(boxes, scores, thr=0.45):
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break
        ious = iou(boxes[i], boxes[order[1:]])
        order = order[1:][ious <= thr]
    return keep


class TFLiteYolo:
    def __init__(self, path):
        try:
            from ai_edge_litert.interpreter import Interpreter
        except ImportError:
            try:
                from tflite_runtime.interpreter import Interpreter
            except ImportError:
                from tensorflow.lite import Interpreter
        self.it = Interpreter(model_path=path, num_threads=2)
        self.it.allocate_tensors()
        self.inp = self.it.get_input_details()[0]
        self.out = self.it.get_output_details()[0]
        s = self.inp["shape"]
        self.nchw = s[1] == 3
        self.size = s[2] if self.nchw else s[1]

    def __call__(self, img, cls, conf=0.001):
        w, h = img.size
        scale = min(self.size / w, self.size / h)
        nw, nh = int(w * scale), int(h * scale)
        padx, pady = (self.size - nw) / 2, (self.size - nh) / 2
        canvas = Image.new("RGB", (self.size, self.size), (114, 114, 114))
        canvas.paste(img.resize((nw, nh), Image.BILINEAR), (int(padx), int(pady)))
        x = np.asarray(canvas, dtype=np.float32) / 255.0
        x = x.transpose(2, 0, 1)[None] if self.nchw else x[None]
        self.it.set_tensor(self.inp["index"], x.astype(np.float32))
        self.it.invoke()
        o = self.it.get_tensor(self.out["index"])[0]
        if o.shape[0] < o.shape[1]:
            o = o.T  # -> [N, 4+C]
        boxes, scores_all = o[:, :4], o[:, 4:]
        best = scores_all.argmax(1)
        score = scores_all.max(1)
        m = (best == cls) & (score >= conf)
        b, s = boxes[m], score[m]
        if b.size == 0:
            return np.zeros((0, 4)), np.zeros(0)
        if np.abs(b).max() <= 2:
            b = b * self.size
        xy = np.stack([b[:, 0] - b[:, 2] / 2, b[:, 1] - b[:, 3] / 2, b[:, 0] + b[:, 2] / 2, b[:, 1] + b[:, 3] / 2], 1)
        xy[:, [0, 2]] = ((xy[:, [0, 2]] - padx) / scale).clip(0, w)
        xy[:, [1, 3]] = ((xy[:, [1, 3]] - pady) / scale).clip(0, h)
        k = nms(xy, s)
        return xy[k], s[k]


class TorchYolo:
    def __init__(self, path, imgsz):
        from ultralytics import YOLO
        self.m = YOLO(path)
        self.imgsz = imgsz

    def __call__(self, img, cls, conf=0.001):
        r = self.m.predict(img, imgsz=self.imgsz, conf=conf, iou=0.45, classes=[cls], verbose=False, device="cpu", max_det=300)[0]
        return r.boxes.xyxy.numpy(), r.boxes.conf.numpy()


def ap_voc(tp, conf, n_gt):
    if n_gt == 0:
        return 0.0
    order = np.argsort(-conf)
    tp = np.array(tp)[order]
    fp = 1 - tp
    tpc, fpc = np.cumsum(tp), np.cumsum(fp)
    rec = tpc / n_gt
    prec = tpc / np.maximum(tpc + fpc, 1e-9)
    mrec = np.concatenate([[0], rec, [1]])
    mpre = np.concatenate([[0], prec, [0]])
    for i in range(len(mpre) - 2, -1, -1):
        mpre[i] = max(mpre[i], mpre[i + 1])
    idx = np.where(mrec[1:] != mrec[:-1])[0]
    return float(np.sum((mrec[idx + 1] - mrec[idx]) * mpre[idx + 1]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--pothole-class", type=int, required=True)
    ap.add_argument("--gt-class", type=int, default=0, help="pothole class id in the dataset labels")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--split", default="test")
    ap.add_argument("--json", default=None)
    ap.add_argument("--at", default="0.55,0.70", help="comma-separated confidence thresholds to report")
    a = ap.parse_args()

    model = TFLiteYolo(a.model) if a.model.endswith(".tflite") else TorchYolo(a.model, a.imgsz)
    img_dir = os.path.join(a.data, "images", a.split)
    lbl_dir = os.path.join(a.data, "labels", a.split)
    files = sorted(f for f in os.listdir(img_dir) if f.endswith(".jpg"))

    records, records30, n_gt, times = [], [], 0, []
    for f in files:
        img = Image.open(os.path.join(img_dir, f)).convert("RGB")
        gt = load_gt(os.path.join(lbl_dir, f[:-4] + ".txt"), img.size[0], img.size[1], a.gt_class)
        n_gt += len(gt)
        t = time.perf_counter()
        boxes, scores = model(img, a.pothole_class)
        times.append(time.perf_counter() - t)
        used = np.zeros(len(gt), bool)
        for i in np.argsort(-scores):
            hit = 0
            if len(gt):
                ious = iou(boxes[i], gt)
                j = int(ious.argmax())
                if ious[j] >= 0.5 and not used[j]:
                    used[j] = True
                    hit = 1
            records.append((float(scores[i]), hit))
        used30 = np.zeros(len(gt), bool)
        for i in np.argsort(-scores):
            hit = 0
            if len(gt):
                ious = iou(boxes[i], gt)
                j = int(ious.argmax())
                if ious[j] >= 0.3 and not used30[j]:
                    used30[j] = True
                    hit = 1
            records30.append((float(scores[i]), hit))

    conf = np.array([r[0] for r in records])
    tp = np.array([r[1] for r in records])
    res = {"model": os.path.basename(a.model), "images": len(files), "potholes": int(n_gt),
           "AP50": round(ap_voc(tp, conf, n_gt), 4),
           "AP30": round(ap_voc(np.array([r[1] for r in records30]), np.array([r[0] for r in records30]), n_gt), 4), "ms_per_image": round(1000 * float(np.mean(times[3:] or times)), 1)}
    # Best-F1 operating point (choose it on --split val, then report test at that threshold).
    best = (0.0, 0.0)
    for th in np.arange(0.05, 0.96, 0.01):
        m = conf >= th
        tps = int(tp[m].sum()); fps = int(m.sum() - tps)
        p = tps / max(tps + fps, 1); r = tps / max(n_gt, 1)
        f1 = 2 * p * r / max(p + r, 1e-9)
        if f1 > best[0]:
            best = (f1, float(th))
    res["bestF1"] = {"f1": round(best[0], 3), "threshold": round(best[1], 2)}
    for th in (float(t) for t in a.at.split(",")):
        m = conf >= th
        tps = int(tp[m].sum()); fps = int(m.sum() - tps)
        p = tps / max(tps + fps, 1); r = tps / max(n_gt, 1)
        res[f"@{th}"] = {"precision": round(p, 3), "recall": round(r, 3), "f1": round(2 * p * r / max(p + r, 1e-9), 3),
                         "true_pos": tps, "false_pos": fps}
    print(json.dumps(res, indent=2))
    if a.json:
        json.dump(res, open(a.json, "w"), indent=2)


if __name__ == "__main__":
    main()
