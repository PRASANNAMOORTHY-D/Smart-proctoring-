# ai/train.py
from ultralytics import YOLO

# Start from pretrained YOLOv8n (transfer learning — much faster)
model = YOLO('yolov8n.pt')

results = model.train(
    data    = 'datasets/exam_objects/data.yaml',
    epochs  = 50,          # increase to 100 for better accuracy
    imgsz   = 640,         # image size
    batch   = 8,           # reduce to 4 if RAM is low
    name    = 'exam_model',
    project = 'runs/train',
    patience= 10,          # stop if no improvement for 10 epochs
    device  = 'cpu',       # use 'cuda' if you have NVIDIA GPU
    workers = 2,
    verbose = True,
)

print("Training complete!")
print(f"Best model saved at: runs/train/exam_model/weights/best.pt")
