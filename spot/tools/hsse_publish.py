"""Run the HSSE fire-safety model over the three site photos and publish the
results in the same layout the HSSE page already reads, so they appear with no
new UI: annotated_image_N.jpg + latest_text_N.json under data/latest/HSSE/."""
import json, os, warnings
warnings.filterwarnings("ignore")
from ultralytics import YOLO
from PIL import Image, ImageDraw, ImageFont

OUT = "spot/data/latest/HSSE"
os.makedirs(OUT, exist_ok=True)
FONT = ImageFont.truetype("spot/frontend/fonts/NotoSans-Regular.ttf", 26)
CONF = 0.25                      # below the 0.35 default: see the report
REQUIRED = {"Fire Extinguisher": 2, "First Aid": 1}
COLOURS = {"Fire Extinguisher": (255, 86, 34), "First Aid": (46, 160, 67)}

model = YOLO("spot/data/models/fireextinguisherv4.pt")
summary = {}

for i, src in enumerate(["ex1.jpeg", "ex2.jpeg", "ex3.jpeg"], start=1):
    res = model.predict(src, conf=CONF, verbose=False)[0]
    img = Image.open(src).convert("RGB")
    draw = ImageDraw.Draw(img)

    values, boxes, confs = [], [], []
    for b in res.boxes:
        name = model.names[int(b.cls[0])]
        conf = float(b.conf.item())
        x1, y1, x2, y2 = [float(v) for v in b.xyxy[0].tolist()]
        colour = COLOURS.get(name, (0, 0, 0))
        draw.rectangle((x1, y1, x2, y2), outline=colour, width=6)
        label = f"{name} {conf:.0%}"
        tb = draw.textbbox((x1, y1 - 30), label, font=FONT)
        draw.rectangle(tb, fill=colour)
        draw.text((x1 + 2, y1 - 30), label, fill=(255, 255, 255), font=FONT)
        values.append(name); boxes.append([x1, y1, x2, y2]); confs.append(conf)

    counts = {k: values.count(k) for k in REQUIRED}
    missing = [f"{REQUIRED[k] - counts[k]} {k}(s)" for k in REQUIRED if counts[k] < REQUIRED[k]]
    text = "All required equipment present" if not missing else ", ".join(missing) + " not detected"
    ok = "OK" if not missing else "NOK"

    banner = f"{text}"
    draw.rectangle((0, 0, img.width, 40), fill=(224, 72, 59) if ok == "NOK" else (22, 163, 74))
    draw.text((8, 6), banner, fill=(255, 255, 255), font=FONT)

    img.save(f"{OUT}/annotated_image_{i}.jpg", quality=88)
    json.dump({"result_values": values, "box_vectors": boxes, "confidences": confs,
               "output_text": text, "output_boolean": ok, "source": src},
              open(f"{OUT}/latest_text_{i}.json", "w"), indent=2)
    summary[src] = {"counts": counts, "verdict": ok, "text": text,
                    "confidences": [round(c, 3) for c in confs]}
    print(f"{src}: {counts}  -> {ok}  ({text})")

json.dump(summary, open(f"{OUT}/summary.json", "w"), indent=2)
print("\npublished to", OUT)
