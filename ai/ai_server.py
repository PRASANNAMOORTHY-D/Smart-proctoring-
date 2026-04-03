"""
ProctorAI — Python AI Server
Runs alongside the Node.js backend on port 8000.

Provides:
  POST /detect          — YOLOv8 object detection (phone, book, laptop, etc.)
  POST /face            — face count + basic analysis via OpenCV
  GET  /health          — health check
  GET  /classes         — list all detectable YOLO classes

Install:
  pip install fastapi uvicorn opencv-python ultralytics python-multipart numpy

Run:
  uvicorn ai_server:app --host 0.0.0.0 --port 8000 --reload
"""
from mediapipe_face import detect_faces_mediapipe
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import cv2
import numpy as np
import base64
import io
import logging
import time
import os

# ── Optional: suppress YOLO verbose output ──
os.environ["YOLO_VERBOSE"] = "False"
logging.getLogger("ultralytics").setLevel(logging.WARNING)

# ── Load YOLO model once at startup (downloads yolov8n.pt on first run ~6MB) ──
try:
    from ultralytics import YOLO
    model = YOLO("runs/train/exam_model/weights/best.pt")
    YOLO_AVAILABLE = True
    print("✅ YOLOv8n model loaded")
except Exception as e:
    model = None
    YOLO_AVAILABLE = False
    print(f"⚠️  YOLOv8 not available: {e}. Object detection will be skipped.")

# ── Exam-relevant banned object classes (COCO dataset names) ──
BANNED_OBJECTS = {
    "book":  {"icon": "📱", "sev": "crit", "deduct": 15, "label": "Mobile Phone"},
    "cell phone":  {"icon": "📚", "sev": "high", "deduct": 10, "label": "Reference Book"},
    "laptop":      {"icon": "💻", "sev": "crit", "deduct": 15, "label": "Laptop"},
    "earphone":    {"icon": "🎧", "sev": "high", "deduct": 10, "label": "Earphone"},
    "person":      {"icon": "👤", "sev": "info", "deduct": 0,  "label": "Person"},
}

# ── FastAPI app ──
app = FastAPI(
    title="ProctorAI — AI Detection Server",
    description="YOLOv8 object detection + OpenCV face analysis for exam proctoring",
    version="1.0.0"
)

# Allow requests from the Node.js frontend (localhost:3000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # restrict in production
    allow_methods=["*"],
    allow_headers=["*"],
)


# ════════════════════════════════════════════════════
#  HELPERS
# ════════════════════════════════════════════════════

def decode_image(file_bytes: bytes) -> np.ndarray:
    """Decode uploaded image bytes to OpenCV BGR array."""
    arr = np.frombuffer(file_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    return img


def run_yolo(img: np.ndarray, conf_threshold: float = 0.45) -> list:
    """Run YOLOv8 inference and return raw detections list."""
    if not YOLO_AVAILABLE:
        return []
    results = model(img, conf=conf_threshold, verbose=False)
    detections = []
    for r in results:
        for box in r.boxes:
            cls_id   = int(box.cls[0])
            cls_name = model.names[cls_id]
            conf     = float(box.conf[0])
            xyxy     = box.xyxy[0].tolist()   # [x1, y1, x2, y2]
            detections.append({
                "class":      cls_name,
                "confidence": round(conf, 3),
                "bbox":       [round(v, 1) for v in xyxy],
            })
    return detections


def classify_detections(detections: list) -> dict:
    """
    Split detections into:
      - banned_found : exam violations (phone, book, etc.)
      - persons      : all person boxes
      - all          : every detection
    """
    banned_found = []
    persons      = []

    for d in detections:
        cls = d["class"].lower()

        if cls == "person":
            persons.append(d)

        if cls in BANNED_OBJECTS:
            meta = BANNED_OBJECTS[cls]
            if meta["deduct"] > 0:        # skip "allowed" items like cup/bottle
                banned_found.append({
                    **d,
                    "label":  meta["label"],
                    "icon":   meta["icon"],
                    "sev":    meta["sev"],
                    "deduct": meta["deduct"],
                })

    return {
        "banned": banned_found,
        "persons": persons,
        "all": detections,
    }


def opencv_face_count(img: np.ndarray) -> dict:
    """
    Fast OpenCV Haar-cascade face count.
    Used as a lightweight companion to face-api.js.
    """
    gray      = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cascade   = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces     = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
    face_list = []
    for (x, y, w, h) in faces:
        face_list.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h)})
    return {
        "count": len(face_list),
        "faces": face_list,
        "multi_person": len(face_list) > 1,
    }


# ════════════════════════════════════════════════════
#  ROUTES
# ════════════════════════════════════════════════════

@app.get("/health")
def health():
    return {
        "status": "ok",
        "yolo_available": YOLO_AVAILABLE,
        "model": "yolov8n" if YOLO_AVAILABLE else None,
        "banned_classes": list(BANNED_OBJECTS.keys()),
    }


@app.get("/classes")
def get_classes():
    """Return all YOLO-detectable classes + which ones are exam-banned."""
    all_classes = list(model.names.values()) if YOLO_AVAILABLE else []
    return {
        "all_classes":    all_classes,
        "banned_classes": BANNED_OBJECTS,
    }


@app.post("/detect")
async def detect(file: UploadFile = File(...)):
    """
    Main detection endpoint called from app.js every 3 seconds during exam.

    Returns:
      detections      — all YOLO detections
      banned          — only exam-violating objects
      persons         — person detections (multi-person check)
      person_count    — total faces via OpenCV
      multi_person    — bool: more than one face
      inference_ms    — how long YOLO took
      timestamp       — server-side ISO timestamp
    """
    try:
        file_bytes = await file.read()
        img        = decode_image(file_bytes)

        t0 = time.time()

        # ── YOLOv8 object detection ──
        raw_dets = run_yolo(img)
        classified = classify_detections(raw_dets)

        # ── OpenCV face count ──
        face_info = detect_faces_mediapipe(img)

        elapsed_ms = round((time.time() - t0) * 1000, 1)

        return {
            "ok":           True,
            "detections":   classified["all"],
            "banned":       classified["banned"],
            "persons":      classified["persons"],
            "person_count": face_info["count"],
            "multi_person": face_info["multi_person"],
            "faces":        face_info["faces"],
            "gaze":         face_info["gaze"],        # NEW
            "gaze_away":    face_info["gaze_away"],   # NEW
            "landmarks":    face_info["landmarks"],   # NEW
            "inference_ms": elapsed_ms,
            "timestamp":    time.strftime("%H:%M:%S"),
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Detection failed: {str(e)}")


@app.post("/face")
async def face_only(file: UploadFile = File(...)):
    """
    Lightweight face-only endpoint (OpenCV only, no YOLO).
    Faster than /detect — use this when you only need face count.
    """
    try:
        file_bytes = await file.read()
        img        = decode_image(file_bytes)
        face_info  = opencv_face_count(img)
        return {"ok": True, **face_info}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Entry point for direct execution ──
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("ai_server:app", host="0.0.0.0", port=8000, reload=True)
