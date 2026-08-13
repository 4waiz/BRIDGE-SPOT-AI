import tensorflow as tf
import numpy as np
import logging
import warnings
import os
import PIL
from PIL import Image
from typing import Any, Tuple


def tf_init():
    tf.get_logger().setLevel("ERROR")  # Suppress TensorFlow logging (2)
    warnings.filterwarnings("ignore")  # Suppress Matplotlib warnings
    # Keras emits "Compiled the loaded model, but the compiled metrics have yet
    # to be built" through absl for every .h5 we load. We never train these
    # models here, so it is expected noise rather than a warning worth showing.
    try:
        from absl import logging as absl_logging

        absl_logging.set_verbosity(absl_logging.ERROR)
    except ImportError:
        pass
    # Enable GPU dynamic memory allocation
    for gpu in tf.config.experimental.list_physical_devices("GPU"):
        tf.config.experimental.set_memory_growth(gpu, True)


tf_init()


def _load_classification_model(abs_path_to_saved_model: str):
    """
    Loads and returns a classification model from absolute path.
    """
    try:
        model = tf.keras.models.load_model(os.path.join(abs_path_to_saved_model, "model.h5"))
    except IOError:
        # Legacy case
        model = tf.keras.models.load_model(abs_path_to_saved_model)

    logging.info("Classification model loaded: %s", abs_path_to_saved_model)
    return model


def get_classifier(model_path: str):
    """
    Loads a classification model and returns both the model and a callable for classifying images.
    """
    model = _load_classification_model(model_path)

    # Return both the model and the classifier function
    return lambda image: _classify_image(model, image)


def _classify_image(model: Any, image: Image) -> Tuple[str, float]:
    """
    Classify an image using a precompiled model. Returns result label and probability.
    """
    # Preprocessing image
    image = image.resize((220, 220), resample=PIL.Image.LANCZOS)
    image = np.array(image)
    image = image / 255.0
    image = np.expand_dims(image, axis=0)

    # Predict
    predictions = model.predict(image)

    class_index = np.argmax(predictions)
    label = str(class_index)
    probability = max(predictions[0])
    logging.debug("classification %s -> %s (%.3f)", predictions, label, probability)

    image_width, image_height = image.shape[1], image.shape[2]
    image_coordinates = (0, 0, image_width, image_height)
    return label, image_coordinates, probability
