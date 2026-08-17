"""Labelling store: path safety, label round-trips and export layout.

Runs against a temporary dataset rather than the real captures, so the tests
never write to `spot data 2025/` or the real sidecars.
"""

from __future__ import annotations

import json

import pytest
from PIL import Image

import labeling
from labeling import LabelingError


@pytest.fixture
def temp_dataset(tmp_path, monkeypatch):
    """A miniature dataset on disk, wired into the module's paths."""
    data_root = tmp_path / "data"
    label_dir = tmp_path / "labels"
    export_dir = tmp_path / "export"
    folder = data_root / "demo set"
    (folder / "yes").mkdir(parents=True)
    folder.mkdir(exist_ok=True)

    # Two loose images, one already sorted into a class folder.
    for name in ("a.jpg", "b.jpg"):
        Image.new("RGB", (32, 24), "grey").save(folder / name)
    Image.new("RGB", (32, 24), "grey").save(folder / "yes" / "c.jpg")
    # A file that is not an image, to confirm it is ignored and unreachable.
    (folder / "secret.env").write_text("PASSWORD=hunter2", encoding="utf-8")

    spec = {
        "id": "demo",
        "title": "Demo",
        "folder": "demo set",
        "mode": "classify",
        "model": "demo.h5",
        "question": "Yes or no?",
        "classes": [{"id": "yes", "label": "Yes", "hint": ""},
                    {"id": "no", "label": "No", "hint": ""}],
    }

    monkeypatch.setattr(labeling, "DATA_ROOT", data_root)
    monkeypatch.setattr(labeling, "LABEL_DIR", label_dir)
    monkeypatch.setattr(labeling, "EXPORT_DIR", export_dir)
    monkeypatch.setattr(labeling, "DATASETS", {"demo": spec})
    monkeypatch.setattr(labeling, "_cache", {})
    return spec


# -- path safety -------------------------------------------------------------


@pytest.mark.parametrize("attack", [
    "../../config.env",
    "../../../config.env",
    "..\\..\\config.env",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "a.jpg/../../../config.env",
    "yes/../../secret.env",
])
def test_image_names_cannot_escape_the_dataset(temp_dataset, attack):
    """`name` comes from the client. config.env holds the robot password, so
    this is the property that keeps it unreachable."""
    with pytest.raises(LabelingError):
        labeling.image_path("demo", attack)


def test_non_image_files_are_not_served(temp_dataset):
    with pytest.raises(LabelingError, match="Not an image"):
        labeling.image_path("demo", "secret.env")


def test_legitimate_names_resolve(temp_dataset):
    assert labeling.image_path("demo", "a.jpg").name == "a.jpg"
    assert labeling.image_path("demo", "yes/c.jpg").name == "c.jpg"


def test_unknown_dataset_is_refused(temp_dataset):
    with pytest.raises(LabelingError, match="Unknown dataset"):
        labeling.queue("nope")


# -- labels ------------------------------------------------------------------


def test_folder_layout_is_imported_as_labels(temp_dataset):
    """Sorting already done by hand must not have to be redone."""
    stats = labeling.stats("demo")
    assert stats["counts"]["yes"] == 1      # yes/c.jpg
    assert stats["labelled"] == 1


def test_queue_only_offers_undecided_images(temp_dataset):
    result = labeling.queue("demo")
    names = [i["name"] for i in result["items"]]
    assert "yes/c.jpg" not in names, "already-labelled image was offered again"
    assert set(names) == {"a.jpg", "b.jpg"}


def test_label_then_undo_round_trips(temp_dataset):
    labeling.set_label("demo", "a.jpg", label="no")
    assert labeling.stats("demo")["counts"]["no"] == 1

    labeling.undo("demo")
    assert labeling.stats("demo")["counts"]["no"] == 0


def test_undo_restores_an_overwritten_label(temp_dataset):
    """Undo must put back the previous value, not just delete the entry."""
    labeling.set_label("demo", "yes/c.jpg", label="no")   # overwrite the import
    labeling.undo("demo")
    assert labeling.stats("demo")["counts"]["yes"] == 1


def test_undo_with_no_history_is_refused(temp_dataset):
    with pytest.raises(LabelingError, match="Nothing to undo"):
        labeling.undo("demo")


def test_unknown_class_is_refused(temp_dataset):
    with pytest.raises(LabelingError, match="not a class"):
        labeling.set_label("demo", "a.jpg", label="maybe")


def test_labels_survive_a_reload(temp_dataset, monkeypatch):
    """The sidecar is the store, not the in-memory cache."""
    labeling.set_label("demo", "a.jpg", label="no")
    monkeypatch.setattr(labeling, "_cache", {})           # simulate a restart
    assert labeling.stats("demo")["counts"]["no"] == 1


def test_source_images_are_never_moved(temp_dataset):
    """The whole point of the sidecar: captures stay where they were taken."""
    before = sorted(p.name for p in (labeling.DATA_ROOT / "demo set").iterdir())
    labeling.set_label("demo", "a.jpg", label="no")
    after = sorted(p.name for p in (labeling.DATA_ROOT / "demo set").iterdir())
    assert before == after


# -- detection ---------------------------------------------------------------


@pytest.fixture
def detect_dataset(temp_dataset, monkeypatch):
    spec = dict(temp_dataset)
    spec["mode"] = "detect"
    monkeypatch.setattr(labeling, "DATASETS", {"demo": spec})
    monkeypatch.setattr(labeling, "_cache", {})
    return spec


def test_boxes_are_clamped_to_the_frame(detect_dataset):
    """A box dragged past the edge must not become invalid training data."""
    labeling.set_label("demo", "a.jpg", boxes=[
        {"cls": "yes", "x": 1.8, "y": -0.4, "w": 2.0, "h": -1.0},
    ])
    store = json.loads((labeling.LABEL_DIR / "demo.json").read_text(encoding="utf-8"))
    box = store["items"]["a.jpg"]["boxes"][0]
    assert 0.0 <= box["x"] <= 1.0
    assert 0.0 <= box["y"] <= 1.0
    assert 0.0 <= box["w"] <= 1.0
    assert 0.0 <= box["h"] <= 1.0


def test_empty_box_list_is_a_real_answer(detect_dataset):
    """"Nothing in this frame" is a negative example, which YOLO needs."""
    labeling.set_label("demo", "a.jpg", boxes=[])
    stats = labeling.stats("demo")
    assert stats["labelled"] == 1
    assert stats["empty_frames"] == 1


def test_box_with_unknown_class_is_refused(detect_dataset):
    with pytest.raises(LabelingError, match="not a class"):
        labeling.set_label("demo", "a.jpg", boxes=[{"cls": "cat", "x": .5, "y": .5, "w": .1, "h": .1}])


# -- export ------------------------------------------------------------------


def test_classify_export_builds_class_folders(temp_dataset):
    labeling.set_label("demo", "a.jpg", label="no")
    result = labeling.export("demo")

    out = labeling.EXPORT_DIR / "demo"
    assert (out / "no" / "a.jpg").is_file()
    assert (out / "yes" / "c.jpg").is_file()      # the imported one comes too
    assert result["exported"] == 2


def test_detect_export_writes_yolo_files(detect_dataset):
    labeling.set_label("demo", "a.jpg", boxes=[
        {"cls": "yes", "x": 0.5, "y": 0.5, "w": 0.2, "h": 0.4},
    ])
    labeling.export("demo")

    out = labeling.EXPORT_DIR / "demo"
    assert (out / "images" / "a.jpg").is_file()
    line = (out / "labels" / "a.txt").read_text(encoding="utf-8").strip()
    index, x, y, w, h = line.split()
    assert index == "0"                            # class order, not name
    assert float(x) == pytest.approx(0.5)
    assert float(w) == pytest.approx(0.2)
    assert "names:" in (out / "data.yaml").read_text(encoding="utf-8")


def test_export_leaves_the_source_untouched(temp_dataset):
    labeling.set_label("demo", "a.jpg", label="no")
    labeling.export("demo")
    assert (labeling.DATA_ROOT / "demo set" / "a.jpg").is_file()


def test_export_refuses_when_nothing_is_labelled(detect_dataset):
    with pytest.raises(LabelingError, match="Nothing labelled"):
        labeling.export("demo")
