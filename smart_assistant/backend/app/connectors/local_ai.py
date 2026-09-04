"""Offline answer engine.

The assistant is demoed on a laptop that regularly has no working OpenAI key
(expired, out of quota) and sometimes no internet at all. Rather than showing
"There has been an error", every question falls through to this module, which
answers entirely from software already on the machine:

  1. A local LLM, if one is listening on an OpenAI-compatible endpoint
     (Ollama / LM Studio / llama.cpp server). Optional -- nothing is installed
     or downloaded for it; if the port is dead we never mention it again.
  2. Semantic retrieval over the bundled knowledge base, using the
     all-MiniLM-L6-v2 sentence embedder that already ships in the HuggingFace
     cache for the online RAG path. This is the path that actually runs today.
  3. Token overlap, for the case where the embedder itself cannot be loaded.

Retrieval is the honest fallback for a fixed knowledge base: it either has an
answer or it says so, instead of inventing one. Everything here is import-safe
and never raises into the request path.
"""

import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request

import numpy as np

_DATA_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"
)
_QA_PATH = os.path.join(_DATA_DIR, "local_qa.json")
_KNOWLEDGE_PATH = os.path.join(_DATA_DIR, "local_knowledge.json")

# Cosine similarity below this and we would be guessing. Tuned against the
# bundled corpus: real paraphrases of a known question land at 0.6-0.9, an
# off-topic question against its nearest neighbour lands around 0.2-0.35.
_SEMANTIC_THRESHOLD = 0.48
# Token-overlap threshold for the no-embedder path. Jaccard, so a two-word
# question matching a two-word entry with one word shared scores 0.33.
_LEXICAL_THRESHOLD = 0.34

_FALLBACK_ANSWER = (
    "I do not have that one yet. I can talk about Spot, this facility, "
    "Industry 4.0 and 5.0, AI and inspection work - try me on any of those."
)

_WORD_RE = re.compile(r"[a-z0-9]+")


def _tokens(text):
    return set(_WORD_RE.findall((text or "").lower()))


# ---------------------------------------------------------------------------
# Knowledge base
# ---------------------------------------------------------------------------


def _load_corpus():
    """Every (prompt, answer) pair from both data files, flattened so each
    alias is its own retrievable prompt pointing at the shared answer."""
    corpus = []

    try:
        with open(_QA_PATH, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        for entry in payload.get("conversations", []):
            question = (entry.get("question") or "").strip()
            answer = (entry.get("answer") or "").strip()
            if question and answer:
                corpus.append((question, answer))
    except Exception as exc:
        logging.warning("Local Q&A unavailable (%s): %s", _QA_PATH, exc)

    try:
        with open(_KNOWLEDGE_PATH, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        for entry in payload.get("entries", []):
            answer = (entry.get("answer") or "").strip()
            if not answer:
                continue
            prompts = [entry.get("question") or ""] + list(entry.get("aliases") or [])
            for prompt in prompts:
                prompt = prompt.strip()
                if prompt:
                    corpus.append((prompt, answer))
    except Exception as exc:
        logging.warning("Local knowledge unavailable (%s): %s", _KNOWLEDGE_PATH, exc)

    logging.info("Local knowledge base: %d prompts", len(corpus))
    return corpus


_CORPUS = _load_corpus()
_CORPUS_TOKENS = [_tokens(prompt) for prompt, _ in _CORPUS]


# ---------------------------------------------------------------------------
# Sentence embedder (shared)
# ---------------------------------------------------------------------------

_embedder = None
_embedder_tried = False
_embedder_lock = threading.Lock()


def get_embedder():
    """The process-wide all-MiniLM-L6-v2 instance, or None if it will not
    load. Shared rather than per-session: it is ~90 MB of weights and every
    websocket connection used to construct its own copy.

    Tries the HuggingFace cache first (`local_files_only`) so an offline
    machine loads in a couple of seconds instead of waiting out a DNS
    timeout on every hub call."""
    global _embedder, _embedder_tried
    with _embedder_lock:
        if _embedder_tried:
            return _embedder
        _embedder_tried = True
        name = "sentence-transformers/all-MiniLM-L6-v2"
        try:
            from sentence_transformers import SentenceTransformer
        except Exception as exc:
            logging.warning("sentence-transformers unavailable: %s", exc)
            return None
        for local_only in (True, False):
            try:
                t0 = time.time()
                _embedder = SentenceTransformer(name, local_files_only=local_only)
                logging.info(
                    "Sentence embedder loaded in %.1fs (cache_only=%s)",
                    time.time() - t0,
                    local_only,
                )
                return _embedder
            except Exception as exc:
                logging.info("Embedder load failed (cache_only=%s): %s", local_only, exc)
        logging.warning("Sentence embedder unavailable; local answers fall back to token overlap.")
        return None


_index = None
_index_lock = threading.Lock()


def _get_index():
    """L2-normalised embeddings of every corpus prompt, so retrieval is a
    single matrix-vector product. Built once, on the first local answer."""
    global _index
    with _index_lock:
        if _index is not None:
            return _index
        model = get_embedder()
        if model is None or not _CORPUS:
            _index = False
            return _index
        try:
            t0 = time.time()
            vectors = model.encode(
                [prompt for prompt, _ in _CORPUS],
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            _index = np.asarray(vectors, dtype=np.float32)
            logging.info(
                "Local retrieval index built: %s in %.1fs", _index.shape, time.time() - t0
            )
        except Exception as exc:
            logging.warning("Could not build local retrieval index: %s", exc)
            _index = False
        return _index


def _lexical_match(question):
    q_tokens = _tokens(question)
    if not q_tokens:
        return None, 0.0
    best_score, best_answer = 0.0, None
    for (_prompt, answer), tokens in zip(_CORPUS, _CORPUS_TOKENS):
        if not tokens:
            continue
        overlap = len(q_tokens & tokens)
        if not overlap:
            continue
        score = overlap / len(q_tokens | tokens)
        if score > best_score:
            best_score, best_answer = score, answer
    return best_answer, best_score


def retrieve(question):
    """(answer, score) for the closest knowledge-base entry, or (None, score)
    when nothing is close enough to be worth saying."""
    index = _get_index()
    if index is not False and index is not None:
        try:
            vector = get_embedder().encode(
                question,
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            scores = index @ np.asarray(vector, dtype=np.float32)
            best = int(np.argmax(scores))
            score = float(scores[best])
            if score >= _SEMANTIC_THRESHOLD:
                return _CORPUS[best][1], score
            # Below threshold semantically, but an exact-ish wording match is
            # still trustworthy -- short greetings ("hey") embed poorly.
            answer, lex = _lexical_match(question)
            if lex >= 0.6:
                return answer, lex
            return None, score
        except Exception as exc:
            logging.warning("Semantic retrieval failed, using token overlap: %s", exc)

    answer, score = _lexical_match(question)
    if score >= _LEXICAL_THRESHOLD:
        return answer, score
    return None, score


# ---------------------------------------------------------------------------
# Optional local LLM (Ollama / LM Studio / any OpenAI-compatible server)
# ---------------------------------------------------------------------------

_LLM_URL = os.getenv("LOCAL_LLM_URL", "http://127.0.0.1:11434/v1/chat/completions")
_LLM_MODEL = os.getenv("LOCAL_LLM_MODEL", "qwen2.5:3b")
_LLM_TIMEOUT = float(os.getenv("LOCAL_LLM_TIMEOUT", "20"))
_LLM_SYSTEM = (
    "You are the BRIDGE Spot assistant. BRIDGE (bridgeuae.com) is an entity of "
    "EDGE Group, the UAE advanced technology and defence conglomerate based in "
    "Abu Dhabi. BRIDGE is EDGE's function for innovation, operational excellence "
    "and industrialisation, focused on Industry 4.0 upskilling and reshaping "
    "defence manufacturing (formerly Learning & Innovation Factory, LIF). Spot "
    "is the Boston Dynamics robot dog used at BRIDGE. "
    "Answer in at most two short sentences. Never mention being an AI model."
)

# None = not probed yet, True/False = the answer from the one probe we do.
_llm_available = None
_llm_lock = threading.Lock()


def _probe_llm():
    """One cheap reachability check, cached forever. A demo machine either has
    a local model server running or it does not; retrying a dead port on every
    question would add a timeout to every answer."""
    global _llm_available
    with _llm_lock:
        if _llm_available is not None:
            return _llm_available
        if os.getenv("LOCAL_LLM_DISABLED", "").strip().lower() in ("1", "true", "yes"):
            _llm_available = False
            return _llm_available
        # /v1/chat/completions -> /v1/models on the same server.
        root = _LLM_URL.split("/chat/completions")[0].rstrip("/")
        try:
            with urllib.request.urlopen(root + "/models", timeout=1.5) as response:
                _llm_available = response.status == 200
        except Exception as exc:
            logging.info("No local LLM at %s (%s); using retrieval only.", root, exc)
            _llm_available = False
        if _llm_available:
            logging.info("Local LLM detected at %s (model %s).", root, _LLM_MODEL)
        return _llm_available


def _llm_answer(question, history=None):
    """Ask the local model server. Returns None on any problem so the caller
    just carries on to retrieval."""
    if not _probe_llm():
        return None
    messages = [{"role": "system", "content": _LLM_SYSTEM}]
    for turn in (history or [])[-6:]:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({"role": "user", "content": question})

    body = json.dumps(
        {
            "model": _LLM_MODEL,
            "messages": messages,
            "temperature": 0.4,
            "max_tokens": 160,
            "stream": False,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        _LLM_URL, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=_LLM_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8"))
        text = payload["choices"][0]["message"]["content"].strip()
        return text or None
    except Exception as exc:
        logging.warning("Local LLM call failed (%s); using retrieval.", exc)
        return None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def answer(question, history=None):
    """Best offline answer for `question`. Never raises, never returns empty."""
    question = (question or "").strip()
    if not question:
        return _FALLBACK_ANSWER

    text = _llm_answer(question, history)
    if text:
        return text

    text, score = retrieve(question)
    if text:
        logging.info("Local answer matched at score %.2f", score)
        return text
    logging.info("No local match (best score %.2f); using fallback line.", score)
    return _FALLBACK_ANSWER
