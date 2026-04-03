# ai/mediapipe_face.py
"""
MediaPipe Face Detection module
Replaces face-api.js for server-side face analysis
Called from ai_server.py /detect endpoint
"""

import mediapipe as mp
import cv2
import numpy as np

# Initialize MediaPipe face detection once at module load
mp_face_detection = mp.solutions.face_detection
mp_face_mesh     = mp.solutions.face_mesh
mp_drawing       = mp.solutions.drawing_utils

# Short-range model (model_selection=0) — best for webcam (< 2 meters)
face_detector = mp_face_detection.FaceDetection(
    model_selection=0,
    min_detection_confidence=0.5
)

# Face mesh for gaze/landmark analysis
face_mesh = mp_face_mesh.FaceMesh(
    static_image_mode=True,
    max_num_faces=5,           # detect up to 5 faces
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)


def detect_faces_mediapipe(img_bgr: np.ndarray) -> dict:
    """
    Run MediaPipe face detection on a BGR image.
    Returns face count, bounding boxes, and gaze direction.
    """
    # MediaPipe needs RGB
    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    h, w    = img_bgr.shape[:2]

    # ── Face Detection ──
    det_result = face_detector.process(img_rgb)
    faces = []

    if det_result.detections:
        for det in det_result.detections:
            bbox  = det.location_data.relative_bounding_box
            score = det.score[0]
            faces.append({
                "x":          int(bbox.xmin * w),
                "y":          int(bbox.ymin * h),
                "w":          int(bbox.width * w),
                "h":          int(bbox.height * h),
                "confidence": round(float(score), 3),
            })

    # ── Face Mesh for gaze estimation ──
    gaze_direction = "CENTER"
    landmarks_list = []

    mesh_result = face_mesh.process(img_rgb)
    if mesh_result.multi_face_landmarks:
        # Use first face for gaze
        lm  = mesh_result.multi_face_landmarks[0].landmark
        gaze_direction = estimate_gaze(lm, w, h)

        # Key landmark points (nose tip, eyes)
        landmarks_list = [
            {"x": int(lm[1].x * w),   "y": int(lm[1].y * h),   "name": "nose_tip"},
            {"x": int(lm[33].x * w),  "y": int(lm[33].y * h),  "name": "left_eye"},
            {"x": int(lm[263].x * w), "y": int(lm[263].y * h), "name": "right_eye"},
            {"x": int(lm[61].x * w),  "y": int(lm[61].y * h),  "name": "mouth_left"},
            {"x": int(lm[291].x * w), "y": int(lm[291].y * h), "name": "mouth_right"},
        ]

    face_count = len(faces)

    return {
        "count":        face_count,
        "faces":        faces,
        "multi_person": face_count > 1,
        "gaze":         gaze_direction,
        "gaze_away":    gaze_direction != "CENTER",
        "landmarks":    landmarks_list,
        "engine":       "mediapipe",
    }


def estimate_gaze(landmarks, img_w: int, img_h: int) -> str:
    """
    Estimate gaze direction from MediaPipe face mesh landmarks.
    Uses nose tip relative to eye midpoint.
    """
    try:
        # Eye landmark indices in MediaPipe 468-point mesh
        LEFT_EYE_IDX  = [33, 7, 163, 144, 145, 153, 154, 155, 133]
        RIGHT_EYE_IDX = [362, 382, 381, 380, 374, 373, 390, 249, 263]
        NOSE_TIP_IDX  = 1

        left_eye_x  = np.mean([landmarks[i].x for i in LEFT_EYE_IDX])
        right_eye_x = np.mean([landmarks[i].x for i in RIGHT_EYE_IDX])
        left_eye_y  = np.mean([landmarks[i].y for i in LEFT_EYE_IDX])
        right_eye_y = np.mean([landmarks[i].y for i in RIGHT_EYE_IDX])

        eye_mid_x = (left_eye_x + right_eye_x) / 2
        eye_mid_y = (left_eye_y + right_eye_y) / 2

        nose_x = landmarks[NOSE_TIP_IDX].x
        nose_y = landmarks[NOSE_TIP_IDX].y

        face_width = abs(right_eye_x - left_eye_x) or 0.01

        yaw   = (nose_x - eye_mid_x) / face_width
        pitch = (nose_y - eye_mid_y) / face_width

        if   yaw > 0.22:   return "RIGHT"
        elif yaw < -0.22:  return "LEFT"
        elif pitch < -0.18: return "UP"
        elif pitch > 0.18:  return "DOWN"
        else:               return "CENTER"

    except Exception:
        return "CENTER"
    