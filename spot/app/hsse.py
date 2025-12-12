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

PREDICTION_THRESHOLD_IMG_2 = 0.35  # For direct object detection (img_2)
PREDICTION_THRESHOLD_IMG_3 = 0.25  # For classify_and_detect (img_3)
iou_threshold = 0.1
BOX_WIDTH = 10
FONT_SIZE = 48
FONT = ImageFont.truetype("../frontend/fonts/NotoSans-Regular.ttf", FONT_SIZE)

LATEST_FOLDER_PATH = "../data/latest/"

logging.info("loading models...")

model_1 = None
model_2 = None
model_3 = None


def load_model_1():
    global model_1
    model_1 = tf_connector.get_classifier("../data/models/emergency_exit.h5")


def load_model_2():
    global model_2
    model_2 = YOLO("../data/models/fireextinguisherv4.pt")


def load_model_3():
    global model_3
    model_3 = tf_connector.get_classifier("../data/models/server_room_door.h5")


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

    img_1 = Image.open("../data/images/HSSE/Spot Cam - PTZ - 1 spot-cam-ptz.jpg")
    img_2 = Image.open("../data/images/HSSE/Spot Cam - PTZ - 2 spot-cam-ptz.jpg")
    img_3 = Image.open("../data/images/HSSE/Spot Cam - PTZ - 3 spot-cam-ptz.jpg")

    # create copy of the original image
    copy_1 = img_1.copy()
    copy_2 = img_2.copy()
    copy_3 = img_3.copy()
    copy_images = [copy_1, copy_2, copy_3]
    annotated_images, result_values_list, box_vectors_list, confidences_list, output_texts, output_booleans = run_ai_on_images(img_1, img_2, img_3)

    save_results(annotated_images, copy_images, result_values_list, box_vectors_list, confidences_list, output_texts, output_booleans, mission_name)

    logging.info("Analyze finished")
    return "Results saved successfully!"


def detect_objects(model, img, prediction_threshold):
    # Predict
    results = model.predict(img, save=False, conf=prediction_threshold, iou=iou_threshold)

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
        "1": (0, 255, 0),
        "0": (255, 0, 0)
    }
    text_color = color_mapping.get(result, (0, 0, 0))
    
    draw = ImageDraw.Draw(image)
    text_bbox = draw.textbbox((0, 0), text, font=FONT)
    text_width = text_bbox[2] - text_bbox[0]
    text_height = text_bbox[3] - text_bbox[1]
    text_x = width - text_width - 10
    text_y = 10

    # Draw white background rectangle
    padding = 5
    draw.rectangle(
        [text_x - padding, text_y - padding, text_x + text_width + padding, text_y + text_height + padding],
        fill=(255, 255, 255),
        outline=(0, 0, 0)  # Optional: add a black border
    )

    # Draw the text on top of the white rectangle
    draw.text((text_x, text_y), text, fill=text_color, font=FONT)
    del draw
    return image


def draw_rectangles_with_confidence(image, result_values, box_vectors, confidences):
    draw = ImageDraw.Draw(image)

    # Define colors for each class
    class_colors = {
        "Fire Extinguisher": (0, 255, 0),
        "First Aid": (0, 255, 0),
    }

    # If coordinates of labels are present, label will not be at bounding box
    class_label_position = {
        "Fire Extinguisher": (1200, 810),
        "First Aid": (1200, 630),
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


def classify_and_detect(img_3, prediction_threshold_img):
    global model_3
    if model_3 is None:
        raise AttributeError("model_3 is not properly initialized.")

    # Use model_3 directly to classify the image
    classification_result_3_1 = model_3(img_3)  # Classify the image with model_3

    result_classifier_3_1 = classification_result_3_1[0]  # The predicted class

    # Detect objects using model_2
    result_values_3_2, box_vectors_3_2, confidences_3_2 = detect_objects(model_2, img_3, prediction_threshold_img)

    return result_classifier_3_1, result_values_3_2, box_vectors_3_2, confidences_3_2


def run_ai_on_images(img_1, img_2, img_3):
    while True:
        if model_1 and model_2 and model_3:
            break
        sleep(1)

    # Create a ThreadPoolExecutor with 3 threads (one for each function)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        # Submit the functions for execution in parallel
        futures = [
            executor.submit(model_1, img_1),
            executor.submit(detect_objects, model_2, img_2, PREDICTION_THRESHOLD_IMG_2),
            executor.submit(classify_and_detect, img_3, PREDICTION_THRESHOLD_IMG_3),
        ]

    # Retrieve results from the futures
    result_1 = futures[0].result()
    result_2 = futures[1].result()
    result_3 = futures[2].result()

    # Unpack results
    result_values_1, box_vectors_1, confidences_1 = result_1
    result_values_2, box_vectors_2, confidences_2 = result_2
    result_classifier_3_1, result_values_3_2, box_vectors_3_2, confidences_3_2 = result_3

    # Annotated images
    annotated_image_1 = add_text_to_classified_image(img_1, result_values_1, confidences_1)
    annotated_image_2 = draw_rectangles_with_confidence(
        img_2,
        result_values_2,
        box_vectors_2,
        confidences_2,
    )
    annotated_image_3 = draw_rectangles_with_confidence(img_3, result_values_3_2, box_vectors_3_2, confidences_3_2)
    output_texts, output_booleans = generate_output_texts_and_booleans(result_values_1, result_values_2, result_classifier_3_1, result_values_3_2)

    return (
        [annotated_image_1, annotated_image_2, annotated_image_3],
        [result_values_1, result_values_2, result_values_3_2, result_classifier_3_1],
        [box_vectors_1, box_vectors_2, box_vectors_3_2],
        [confidences_1, confidences_1, confidences_3_2],
        output_texts,
        output_booleans,
    )


def generate_output_texts_and_booleans(result_values_1, result_values_2, result_classifier_3_1, result_values_3_2):
    # For model 1 (classification model)
    if result_values_1 == "0":
        output_text_1 = "Emergency exit path blocked"
        output_boolean_1 = "NOK"
    else:
        output_text_1 = "Emergency exit path is unblocked"
        output_boolean_1 = "OK"

    # For model 2 (object detection)
    required_objects = {
        "Fire Extinguisher": 2,
        "First Aid": 1,
    }

    # Count occurrences of each required object in result_values_2
    object_counts_model_2 = {key: result_values_2.count(key) for key in required_objects.keys()}

    missing_objects = []
    present_objects = []

    for obj, required_count in required_objects.items():
        actual_count = object_counts_model_2.get(obj, 0)
        if actual_count < required_count:
            missing_objects.append(f"{required_count - actual_count} {obj}(s)")
        else:
            present_objects.append(f"{obj}(s)")

    if not missing_objects:
        output_text_2 = "All required objects are present"
        output_boolean_2 = "OK"
    else:
        # Constructing a full sentence for missing and present objects
        missing_text = " and ".join(missing_objects)
        if present_objects:
            present_text = " and ".join(present_objects)
            output_text_2 = f"{missing_text} missing, while {present_text} present."
        else:
            output_text_2 = f"{missing_text} are missing."
        output_boolean_2 = "NOK"

    # For model 3 (Server Room Door + Fire Extinguisher Detection)
    # Classification result for the server room door
    if result_classifier_3_1 == "0":
        door_text = "Server room door is closed."
    else:
        door_text = "Server room door is open."

    # Object detection for Fire Extinguishers
    object_counts_model_3 = {key: result_values_3_2.count(key) for key in required_objects.keys()}
    fire_extinguisher_count = object_counts_model_3.get("Fire Extinguisher", 0)
    if fire_extinguisher_count <= 0:
        fire_extinguisher_text = "No fire extinguisher found."
    elif fire_extinguisher_count == 1:
        fire_extinguisher_text = "Only 1 fire extinguisher found - 1 is missing."
    elif fire_extinguisher_count == 2:
        fire_extinguisher_text = "2 fire extinguishers found."
    elif fire_extinguisher_count >= 3:
        fire_extinguisher_text = "All fire extinguishers found."

    # Output boolean for model 3: OK only if door is closed and 2 fire extinguishers are present
    output_text_3 = f"{door_text} {fire_extinguisher_text}"
    if result_classifier_3_1 == "0" and fire_extinguisher_count >= 2:
        output_boolean_3 = "OK"
    else:
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
