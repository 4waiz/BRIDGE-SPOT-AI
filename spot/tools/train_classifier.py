"""Retrain an HSSE classifier on the labelled captures.

The architecture is copied from the model already in service rather than
chosen fresh, so the result is a drop-in replacement: same input size, same
head, same two outputs. Anything else would need the inference code to change
alongside it.

Two things this deliberately does:

*It holds out a validation split and scores the current model on exactly the
same images.* A training accuracy on its own says nothing about whether the
new model is better than the one it would replace. Both numbers are printed.

*It refuses to overwrite a model it did not beat.* Retraining that quietly
ships a worse detector is worse than not retraining, because the regression is
invisible until something is missed on site.

    python spot/tools/train_classifier.py --dataset emergency_exit
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

SPOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPOT / "app"))

import labeling  # noqa: E402

import numpy as np  # noqa: E402
import tensorflow as tf  # noqa: E402

logging.getLogger("tensorflow").setLevel(logging.ERROR)

IMAGE_SIZE = (220, 220)      # matches the deployed models
SEED = 1337                  # fixed so the held-out split is the same every run


def build(classes: int) -> tf.keras.Model:
    """The architecture the deployed classifiers use.

    DenseNet121 backbone, frozen. With roughly a thousand images the backbone
    has far more capacity than the data can constrain, and fine-tuning it on
    this much data overfits the capture conditions rather than learning the
    class.
    """
    base = tf.keras.applications.DenseNet121(
        include_top=False, weights="imagenet",
        input_shape=(*IMAGE_SIZE, 3))
    base.trainable = False

    return tf.keras.Sequential([
        base,
        tf.keras.layers.GaussianNoise(0.1),
        tf.keras.layers.GlobalAveragePooling2D(),
        tf.keras.layers.Dense(256, activation="relu"),
        tf.keras.layers.Dropout(0.5),
        tf.keras.layers.Dense(classes, activation="softmax"),
    ])


def datasets(root: Path, batch: int):
    common = dict(image_size=IMAGE_SIZE, batch_size=batch, seed=SEED,
                  validation_split=0.2, label_mode="categorical")
    train = tf.keras.utils.image_dataset_from_directory(root, subset="training", **common)
    val = tf.keras.utils.image_dataset_from_directory(root, subset="validation", **common)
    names = train.class_names

    # DenseNet expects its own preprocessing, not a plain 0-1 rescale.
    prep = tf.keras.applications.densenet.preprocess_input
    augment = tf.keras.Sequential([
        tf.keras.layers.RandomFlip("horizontal"),
        tf.keras.layers.RandomRotation(0.05),
        tf.keras.layers.RandomZoom(0.1),
        tf.keras.layers.RandomBrightness(0.15, value_range=(0, 255)),
    ])

    auto = tf.data.AUTOTUNE
    train = train.map(lambda x, y: (prep(augment(x, training=True)), y), auto).prefetch(auto)
    val = val.map(lambda x, y: (prep(x), y), auto).cache().prefetch(auto)
    return train, val, names


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="emergency_exit")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--batch", type=int, default=16)
    args = ap.parse_args()

    spec = labeling.DATASETS.get(args.dataset)
    if spec is None or spec["mode"] != "classify":
        print(f"{args.dataset} is not a classification dataset.")
        return 1

    root = labeling.EXPORT_DIR / args.dataset
    if not root.is_dir():
        print(f"Nothing exported yet. Export {args.dataset} from the Labelling page first.")
        return 1

    train, val, names = datasets(root, args.batch)
    print(f"classes: {names}")

    # The set is imbalanced; without this the model can score well by leaning
    # on the majority class, which for a safety check is the wrong bias.
    counts = np.array([len(list((root / n).glob("*"))) for n in names], dtype=float)
    weights = {i: counts.sum() / (len(names) * c) for i, c in enumerate(counts)}
    print(f"images : {counts.astype(int).tolist()}  class weights "
          f"{ {i: round(w, 2) for i, w in weights.items()} }")

    model = build(len(names))
    model.compile(optimizer=tf.keras.optimizers.Adam(1e-3),
                  loss="categorical_crossentropy", metrics=["accuracy"])

    print("\ntraining...")
    model.fit(train, validation_data=val, epochs=args.epochs,
              class_weight=weights, verbose=2,
              callbacks=[
                  tf.keras.callbacks.EarlyStopping(
                      monitor="val_accuracy", patience=4, restore_best_weights=True),
                  tf.keras.callbacks.ReduceLROnPlateau(
                      monitor="val_loss", factor=0.3, patience=2, min_lr=1e-5),
              ])

    fresh = model.evaluate(val, verbose=0)[1]

    # Score the model currently in service on the same held-out images.
    live_path = labeling.SPOT_ROOT / "data" / "models" / spec["model"]
    live = None
    if live_path.exists():
        try:
            current = tf.keras.models.load_model(live_path, compile=False)
            current.compile(loss="categorical_crossentropy", metrics=["accuracy"])
            live = current.evaluate(val, verbose=0)[1]
        except Exception as exc:
            print(f"Could not score the deployed model: {exc}")

    print()
    print(f"new model      : {fresh:.4f} val accuracy")
    print(f"deployed model : {live:.4f} val accuracy" if live is not None
          else "deployed model : could not be scored")

    out = live_path.with_name(live_path.stem + "_retrained.h5")
    model.save(out)
    print(f"\nsaved {out.name}")

    if live is None:
        print("Not promoted: nothing to compare against. Review before deploying.")
    elif fresh > live:
        print(f"Beats the deployed model by {fresh - live:+.4f}. "
              f"Promote by replacing {live_path.name} with this file.")
    else:
        print(f"Does NOT beat the deployed model ({fresh - live:+.4f}). "
              f"Left in place rather than shipped; {live_path.name} is unchanged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
