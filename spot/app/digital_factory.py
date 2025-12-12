import concurrent.futures
import json
import logging
import os
from datetime import datetime
from threading import Thread
from time import sleep

import numpy as np
import tf_connector
import torch
from PIL import Image, ImageDraw, ImageFont
from ultralytics import YOLO

prediction_threshold = 0.5
BOX_WIDTH = 10
FONT_SIZE = 48
FONT = ImageFont.truetype("../frontend/fonts/NotoSans-Regular.ttf", FONT_SIZE)

LATEST_FOLDER_PATH = "../data/latest"

logging.info("loading models...")

model_1 = None
model_2 = None
model_3 = None


def load_model_1():
    global model_1
    model_1 = YOLO("../data/models/festotablev1.pt")


def load_model_2():
    global model_2
    model_2 = YOLO("../data/models/automatedstationv1.pt")


def load_model_3():
    global model_3
    model_3 = tf_connector.get_classifier("../data/models/Robotinov3.h5")


# Load YOLO models async
thread_1 = Thread(target=load_model_1)
thread_2 = Thread(target=load_model_2)
thread_3 = Thread(target=load_model_3)
thread_1.start()
thread_2.start()
thread_3.start()


def analyze(mission_name):
    logging.info("Analyze started")
    # Load images

    img_1 = Image.open("../data/images/DigitalFactory/Spot Cam - PTZ - 1 spot-cam-ptz.jpg")
    img_2 = Image.open("../data/images/DigitalFactory/Spot Cam - PTZ - 2 spot-cam-ptz.jpg")
    img_3 = Image.open("../data/images/DigitalFactory/Spot Cam - PTZ - 3 spot-cam-ptz.jpg")

    # create copy of the original image
    copy_1 = img_1.copy()
    copy_2 = img_2.copy()
    copy_3 = img_3.copy()
    copy_images = [copy_1, copy_2, copy_3]
    annotated_images, result_values_list, box_vectors_list, confidences_list, output_texts, output_booleans = run_ai_on_images(img_1, img_2, img_3, prediction_threshold)

    save_results(annotated_images, copy_images, result_values_list, box_vectors_list, confidences_list, output_texts, output_booleans, mission_name)

    logging.info("Analyze finished")
    return "Results saved successfully!"


def detect_objects(model, img, prediction_threshold):
    # Predict
    results = model.predict(img, save=False, conf=prediction_threshold)

    # Lists to store results
    result_values = []
    box_vectors = []
    confidences = []

    for result in results:
        for box in result.boxes:
            # Result
            result_value = model.names[int(box.cls[0])]

            # Box vector
            box_vector = box.xyxy

            # Confidence
            confidence = box.conf.item()

            # Append to lists
            result_values.append(result_value)
            box_vectors.append(box_vector)
            confidences.append(confidence)

    return result_values, box_vectors, confidences


def add_text_to_classified_image(image, result, classification_confidence):
    width, height = image.size
    confidence_percentage = round(classification_confidence * 100)  # Convert to rounded percentage
    text = f"Result: {result}\nProbability: {confidence_percentage}%"
    
    # Define colors based on binary classification
    color_mapping = {
        1: (0, 255, 0),
        0: (255, 0, 0)
    }
    text_color = color_mapping.get(result, (255, 255, 255))
    
    draw = ImageDraw.Draw(image)
    text_bbox = draw.textbbox((0, 0), text, font=FONT)
    text_width = text_bbox[2] - text_bbox[0]
    text_height = text_bbox[3] - text_bbox[1]
    text_x = width - text_width - 10
    text_y = 10

    draw.text((text_x, text_y), text, fill=text_color, font=FONT)
    del draw
    return image


def draw_rectangles_with_confidence(image, result_values, box_vectors, confidences):
    draw = ImageDraw.Draw(image)

    # Define colors for each class
    class_colors = {
        "boxes": (200, 255, 0),
        "AR Headset": (230, 0, 255),
        "Assembled Car": (0, 230, 255),
        "Axle Wheels": (255, 255, 0),
        "Car Body": (0, 255, 128),
        "Scratched Body": (255, 0, 70),
        "Wheels Box": (255, 120, 0),
    }

    # If coordinates of labels are present, label will not be at bounding box
    class_label_position = {
        "Assembled Car": (1200, 810),
        "Car Body": (1200, 990),
        "Scratched Body": (1200, 720),
        "Wheels Box": (1200, 900),
        "Axle Wheels": (1200, 1080),
    }

    # check if there are objects detected
    if not result_values:
        text = "No detections"
        text_bbox = draw.textbbox((10, 10), text, font=FONT)
        draw.text((10, 10), text, fill=(255, 0, 0), font=FONT)

    else:
        for result_value, box_vector, confidence in zip(result_values, box_vectors, confidences):
            # Assuming box_vector contains information about each detected object
            for box in box_vector:
                if result_value == "Axle Wheels":
                    # temporarily skip axle wheels until model is improved
                    continue
                x1, y1, x2, y2 = box.cpu().numpy().reshape(4)

                # Use the predefined color or default to black if not found
                outline_color = class_colors.get(result_value, (0, 0, 0))

                # Draw bounding box
                draw.rectangle(
                    (x1, y1, x2, y2),
                    fill=None,
                    outline=outline_color,
                    width=BOX_WIDTH,
                )

                # Draw background rectangle for text
                text = f"{result_value}: {confidence:.1%}"
                x_label, y_label = class_label_position.get(result_value, (x1, y1))
                text_bbox = draw.textbbox((x_label, y_label), text, font=FONT)

                # Adjust rectangle coordinates to be on top of the bounding box and proportionally scaled to the text
                rect_height = text_bbox[3] - text_bbox[1]
                rect_width = text_bbox[2] - text_bbox[0]
                rect_x1 = text_bbox[0]
                rect_y1 = text_bbox[1] - 1.25 * FONT_SIZE
                rect_x2 = rect_x1 + rect_width
                rect_y2 = rect_y1 + rect_height

                draw.rectangle(
                    (rect_x1, rect_y1, rect_x2, rect_y2),
                    fill=outline_color,
                )

                # Use the color of the detected class for the text
                text_color = (255 - outline_color[0], 255 - outline_color[1], 255 - outline_color[2])
                draw.text((text_bbox[0] + 3, text_bbox[1] - 1.5 * FONT_SIZE), text, fill=text_color, font=FONT)

    del draw
    return image


def run_ai_on_images(img_1, img_2, img_3, prediction_threshold):
    while True:
        if model_1 and model_2 and model_3:
            break
        sleep(1)

    # Create a ThreadPoolExecutor with 3 threads (one for each function)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        # Submit the functions for execution in parallel
        futures = [
            executor.submit(detect_objects, model_1, img_1, prediction_threshold),
            executor.submit(detect_objects, model_2, img_2, prediction_threshold),
            executor.submit(model_3, img_3),
        ]

    # Retrieve results from the futures
    result_1 = futures[0].result()
    result_2 = futures[1].result()
    result_3 = futures[2].result()

    # Unpack results
    result_values_1, box_vectors_1, confidences_1 = result_1
    result_values_2, box_vectors_2, confidences_2 = result_2
    result_classifier, box_vectors_3, p_classifier = result_3

    # Annotated images
    annotated_image_1 = draw_rectangles_with_confidence(
        img_1,
        result_values_1,
        box_vectors_1,
        confidences_1,
    )
    annotated_image_2 = draw_rectangles_with_confidence(
        img_2,
        result_values_2,
        box_vectors_2,
        confidences_2,
    )
    annotated_image_3 = add_text_to_classified_image(img_3, result_classifier, p_classifier)

    output_texts, output_booleans = generate_output_texts_and_booleans(result_values_1, result_values_2, result_classifier)

    return (
        [annotated_image_1, annotated_image_2, annotated_image_3],
        [result_values_1, result_values_2, result_classifier],
        [box_vectors_1, box_vectors_2, box_vectors_3],
        [confidences_1, confidences_2, p_classifier],
        output_texts,
        output_booleans,
    )


def generate_output_texts_and_booleans(result_values_1, result_values_2, result_classifier):
    # Text for model 1
    desired_objects = ["AR Headset", "Assembled Car", "Car Body", "Scratched Body", "Wheels Box"]
    # Axle wheels temporarily removed desired_objects = ["AR Headset", "Assembled Car", "Axle Wheels", "Car Body", "Scratched Body", "Wheels Box"]

    missing_objects = [obj for obj in desired_objects if obj not in result_values_1]

    if not missing_objects:
        output_text_1 = "All objects present"
        output_boolean_1 = "OK"
    else:
        missing_objects_text = ", ".join(missing_objects)
        output_text_1 = f"{missing_objects_text} object(s) missing"
        output_boolean_1 = "NOK"

        # Text for model 2
    if "boxes" in result_values_2:
        output_text_2 = "Station is in operation"
        output_boolean_2 = "NOK"
    else:
        output_text_2 = "Station is idle"
        output_boolean_2 = "OK"

    # Text for model 3
    if result_classifier == "1":
        output_text_3 = "Robotino found"
        output_boolean_3 = "OK"
    else:
        output_text_3 = "Robotino not found"
        output_boolean_3 = "NOK"

    return [output_text_1, output_text_2, output_text_3], [output_boolean_1, output_boolean_2, output_boolean_3]


def convert_to_list(obj):
    if isinstance(obj, torch.Tensor):
        return obj.cpu().numpy().tolist()
    elif isinstance(obj, (list, tuple)):
        return [convert_to_list(item) for item in obj]
    elif isinstance(obj, dict):
        return {key: convert_to_list(value) for key, value in obj.items()}
    elif isinstance(obj, np.float32):
        return float(obj)
    else:
        return obj


def save_results(annotated_images, copy_images, result_value_lists, box_vectors_lists, confidences_lists, output_texts, output_booleans, mission_name):
    # Create timestamp
    timestamp = datetime.now().strftime("%d_%m_%Y-%H_%M_%S")

    # Folder with timestamp (used for historical data)
    folder_path = os.path.join("../data/results/", mission_name, timestamp)
    os.makedirs(folder_path)

    for i, (annotated_image, result_values, box_vectors, confidences, output_text, output_boolean) in enumerate(
        zip(annotated_images, result_value_lists, box_vectors_lists, confidences_lists, output_texts, output_booleans)
    ):
        annotated_image_name = f"annotated_image_{i + 1}_{timestamp}.jpg"
        annotated_image_path = os.path.join(folder_path, annotated_image_name)
        annotated_image.save(annotated_image_path)

        # Convert tensors to lists
        result_values = convert_to_list(result_values)
        box_vectors = convert_to_list(box_vectors)
        confidences = convert_to_list(confidences)

        # Save results in JSON file
        json_data = {"result_values": result_values, "box_vectors": box_vectors, "confidences": confidences, "output_text": output_text, "output_boolean": output_boolean}
        json_name = f"detections_{i + 1}_{timestamp}.json"
        json_path = os.path.join(folder_path, json_name)
        with open(json_path, "w") as json_file:
            json.dump(json_data, json_file, indent=4)

        # Save unannotated original images
        copy_image = copy_images[i]
        original_image_name = f"original_image_{i + 1}_{timestamp}.jpg"
        original_image_path = os.path.join(folder_path, original_image_name)
        copy_image.save(original_image_path)

    for i, (annotated_image, result_values, box_vectors, confidences, output_text, output_boolean) in enumerate(
        zip(annotated_images, result_value_lists, box_vectors_lists, confidences_lists, output_texts, output_booleans)
    ):
        annotated_image_name_latest = f"annotated_image_{i + 1}.jpg"
        latest_folder_path_with_mission = os.path.join(LATEST_FOLDER_PATH, mission_name)  # Directory path
        annotated_image_path_latest = os.path.join(latest_folder_path_with_mission, annotated_image_name_latest)  # Full file path

        # Ensure the directory exists
        os.makedirs(latest_folder_path_with_mission, exist_ok=True)  # Create the mission-specific directory if it doesn't exist

        # Save the image
        annotated_image.save(annotated_image_path_latest)

        # Save results in JSON file in 'latest' folder
        json_data_latest = {
            "result_values": convert_to_list(result_values),
            "box_vectors": convert_to_list(box_vectors),
            "confidences": convert_to_list(confidences),
            "output_text": output_text,
            "output_boolean": output_boolean,
        }
        json_name_latest = f"latest_text_{i + 1}.json"
        json_path_latest = os.path.join(LATEST_FOLDER_PATH, mission_name, json_name_latest)
        with open(json_path_latest, "w") as json_file_latest:
            json.dump(json_data_latest, json_file_latest, indent=4)
