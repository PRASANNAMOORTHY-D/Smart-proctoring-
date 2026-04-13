# ai/test_detection.py
import requests, cv2, time

cap = cv2.VideoCapture(0)
print("Camera opened. Testing detection...")

for i in range(3):
    ret, frame = cap.read()
    if not ret:
        print("Camera failed"); break

    # Save frame as temp image
    cv2.imwrite('test_frame.jpg', frame)

    # Send to AI server
    with open('test_frame.jpg', 'rb') as f:
        res = requests.post(
            'http://localhost:8000/detect',
            files={'file': ('frame.jpg', f, 'image/jpeg')}
        )

    data = res.json()
    print(f"\nTest {i+1}:")
    print(f"  Inference time : {data['inference_ms']}ms")
    print(f"  Faces found    : {data['person_count']}")
    print(f"  Gaze direction : {data.get('gaze', 'N/A')}")
    print(f"  All detections : {[d['class'] for d in data['detections']]}")
    print(f"  Banned objects : {[d['label'] for d in data['banned']]}")
    time.sleep(2)

cap.release()
print("\nTest complete!")