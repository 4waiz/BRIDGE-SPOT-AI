import logging
import time
import openai
import tiktoken
import pandas as pd
import numpy as np
from sentence_transformers import CrossEncoder
import settings
from . import local_ai


# When OpenAI is unreachable (no internet, invalid key, hit quota) the answer
# comes from connectors/local_ai.py instead of an error banner. See that module
# for the offline chain: local LLM if one is running, otherwise semantic
# retrieval over the bundled knowledge base.


language_names = {"en": "english", "ar": "arabic", "hi": "hindi", "de": "german", "es": "spanish", "pt": "portuguese", "sv": "swedish", "nl": "dutch", "ru": "russian", "fr": "french", "zh": "chinese"}


class GPT_Chat:
    def __init__(self, user_session):
        self.session = user_session
        self.websocket = self.session.websocket
        self.dialogue = []
        self.name = ""
        self.user_prompt = ""
        self.base_prompt = (
            "You are the BRIDGE Spot assistant. BRIDGE (bridgeuae.com) is an entity of EDGE Group, "
            "the UAE advanced technology and defence conglomerate based in Abu Dhabi. BRIDGE is EDGE's "
            "function for innovation, operational excellence and industrialisation, focused on Industry "
            "4.0 upskilling and reshaping defence manufacturing (formerly Learning & Innovation Factory, LIF). "
            "Spot is the Boston Dynamics robot dog used at BRIDGE. Answer only questions related to BRIDGE or Spot. "
            "If a question is unrelated, say you can help with BRIDGE or Spot and ask a concise follow-up. "
            "Keep replies very short (1-2 sentences)."
        )
        self.update_prompt()
        self.model = "gpt-4.1-nano"
        self.maxtoken = 8000  # all three models have very high max tokens, 16k for gpt3, 128k for gpt4 and gpt4o, limits do not need to be exhausted
        self.max_response_tokens = 256
        self.temperature = 0.5
        self.content = "none"
        # Shared across sessions -- every websocket connection used to load its
        # own 90 MB copy of the same weights.
        self.embeddings_model = local_ai.get_embedder()
        self.crossencoder = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
        self.token_encoding = tiktoken.get_encoding("cl100k_base")
        self.new_sentence: list  # sentences to be sent to frontend
        self.ready_sentence: list  # sentences to be sent to speech as list
        self.complete_response: list  # the complete response text as list

    # function to update the prompt in case language or system prompt have been changed by user
    def update_prompt(self, prompt=False):
        if prompt:
            self.user_prompt = prompt
        extra_prompt = self.base_prompt
        if self.user_prompt:
            extra_prompt = f"{extra_prompt}\n{self.user_prompt}"
        if self.session.language != "multilingual":
            self.dialogue = [
                {
                    "role": "system",
                    "content": f"Your name is {self.name} and you are a personal assistant. Give short answers (maximum 2 sentences).\nPlease always answer in {language_names[self.session.language]}.\n"
                    + extra_prompt,
                }
            ]
        else:
            self.dialogue = [
                {
                    "role": "system",
                    "content": f"Your name is {self.name} and you are a personal assistant. Give short answers (maximum 2 sentences).\n" + extra_prompt,
                }
            ]

    # the search performed on all text snippets by the biencoder to return an inacurrate list of candidates
    def get_candidates(self, df, question):
        t0 = time.time()
        if df.shape[0] > settings.num_candidates:
            question_embedding = self.embeddings_model.encode(question)
            df["similiarities"] = df.embedding.apply(lambda x: np.dot([float(s) for s in x.split(" ")], question_embedding))
            df = df.sort_values("similiarities", ascending=False).head(settings.num_candidates)
        t1 = time.time()
        return df.text.to_frame(), round(t1 - t0, 2)

    async def question(self, question, request, play_locally=False):
        try:
            # Init variables
            self.new_sentence = []
            self.ready_sentence = []
            self.complete_response = []

            await self.session.send_json(
                json={
                    "question": question,
                    "request_id": request.id,
                }
            )
            logging.info(f"session {self.session.session_id}, request {request.id}: Question: {question}")

            if self.session.client is None:
                logging.info(
                    f"session {self.session.session_id}, request {request.id}: "
                    "OpenAI unavailable -- answering locally."
                )
                await self._serve_local(question, request, play_locally)
                return

            while self.num_tokens_from_messages() > self.maxtoken:
                del self.dialogue[1:3]

            # the embeddings search
            if self.content != "none" and self.embeddings_model is not None:
                # get the paragraphs of the source
                df = pd.read_csv(f"sources/{self.content}.csv")
                # narrow the paragraphs down to num_candidates amount of candidates
                (candidates, time_taken) = self.get_candidates(df, question)
                logging.info(f"session {self.session.session_id}, request {request.id}: Bi-encoder results: {candidates.index.values}\nTime: {time_taken}")
                # sort the paragraphs by similarity
                t0 = time.time()
                candidates["similarities"] = candidates.text.apply(lambda x: self.crossencoder.predict([question, x]))
                candidates = candidates.sort_values("similarities", ascending=False)
                t1 = time.time()
                logging.info(f"session {self.session.session_id}, request {request.id}: Cross-encoder results: {candidates.index.values}\nTime: {round(t1 - t0, 2)}")
                # add the information to the question
                question += (
                    "\n\n Here is some information about the topic of the question, that you can use to answer the question, if it is useful. You may assume that the question is about this topic. Treat the information like knowledge you already have. Do not mention that you received information and do not directly refer to it or lack thereof. Do not include Number examples and example calculations for provided data if not specifically asked about it. \n"
                    + "\n".join(candidates.head(settings.paragraphs_per_answer)["text"])
                )
            logging.info(f"session {self.session.session_id}, request {request.id}: New Input token count: {len(self.token_encoding.encode(question))}")
            # add question to dialogue
            self.dialogue.append({"role": "user", "content": question})
            logging.info(f"session {self.session.session_id}, request {request.id}: Dialogue token count: {self.num_tokens_from_messages()}")
            # Call the GPT-API Stream
            time_buffer = 1  # Experiment depending mostly on tts api speed
            start_time = 0
            audio_duration = 0
            next_token = ""

            stream = self.answer_with_retry(request)
            for response in stream:
                if request.cancel:
                    # delete the question from the dialogue
                    del self.dialogue[-1]
                    # send finish and exit program
                    await self.session.send_json(
                        {
                            "finish": "cancel",
                            "request_id": request.id,
                        }
                    )
                    logging.info(f"session {self.session.session_id}, request {request.id}: ChatGPT finished due to user cancel.")
                    return
                response_token = next_token
                next_token = response.choices[0].delta.content
                # skip first two iterations
                if response_token == "":
                    continue

                # get the Finish reason
                finish = response.choices[0].finish_reason

                # escape necessary characters for HTML
                escaped_response_token = response_token.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&apos;")
                # add escaped text
                self.new_sentence.append(escaped_response_token)
                self.complete_response.append(response_token)

                # check for punctuation in numbers, then don't check for end of sentence (elif) but still check creating audio
                if escaped_response_token in (".", ",", "٫") and next_token is not None and next_token.isdigit():
                    pass
                # New sentence - send to frontend to display text
                elif escaped_response_token.strip() in (".", "!", "?", ":", ";", "،", "؟", "؛", "？", "！", "；", "。", "，", "、") or ("\n") in escaped_response_token or finish:
                    if not request.cancel:
                        await self.session.send_json(
                            {
                                "sentence": "".join(self.new_sentence),
                                "request_id": request.id,
                            }
                        )
                    self.ready_sentence.extend(self.new_sentence)
                    self.new_sentence = []

                # Ready sentence - create audio shortly before former audio expires or at linebreaks to avoid unnatural breaks
                time_up = (time.time() - start_time) > (audio_duration - time_buffer - len(self.ready_sentence) / 25)
                # If multilingual, do not create audio for sentences too short to avoid wrong choice of pronunciation
                multilingual_min_chars = 20
                if self.ready_sentence and (finish or ((self.session.language != "multilingual" or (len("".join(self.ready_sentence)) > multilingual_min_chars)) and (time_up or ("\n") in response_token))):
                    (start_time, audio_duration) = await self.session.tts_module.speak("".join(self.ready_sentence), request, play_locally)
                    self.ready_sentence = []

                if finish:
                    # Play a ping sound after your message as a signal for the wake-word-detection (only locally)
                    if play_locally:
                        await self.session.tts_module.play_ping()
                    # Send finish command to frontend
                    await self.session.send_json(
                        {
                            "finish": "success",
                            "request_id": request.id,
                        }
                    )
                    logging.info(f"session {self.session.session_id}, request {request.id}: ChatGPT finished due to {finish}.")

                    # Save text
                    complete_response_text = "".join(self.complete_response)
                    logging.info(f"session {self.session.session_id}, request {request.id}: complete response text: {complete_response_text}")
                    logging.info(f"session {self.session.session_id}, request {request.id}: Response token count: {len(self.token_encoding.encode(complete_response_text))}")
                    self.dialogue.append({"role": "assistant", "content": complete_response_text})
                    return
        except Exception as exc:
            logging.exception(f"session {self.session.session_id}, request {request.id}: error in GPT: {exc}")
            # Anything OpenAI threw at us (401, timeout, quota, network) --
            # instead of surfacing "There has been an error", answer from the
            # local Q&A. The frontend can't tell the difference.
            try:
                await self._serve_local(question, request, play_locally)
                self.session.finish = False
            except Exception as wsexc:
                logging.exception(f"session {self.session.session_id}, request {request.id}: error in GPT ws: {wsexc}")

    async def _serve_local(self, question, request, play_locally):
        """Send a local answer through the same websocket protocol the
        GPT streaming path uses: `question`, one `sentence`, then
        `finish: success`. Nothing downstream distinguishes it from an
        online reply, so the frontend renders the answer normally instead
        of showing an error banner."""
        # Prior turns only: the failed online attempt may already have pushed
        # this question onto the dialogue, and local_ai appends it itself.
        history = [turn for turn in self.dialogue if turn.get("content") != question]
        answer = local_ai.answer(question, history)
        # Roll the answer into the dialogue history so multi-turn context
        # stays coherent if the online path later recovers.
        if not self.dialogue or self.dialogue[-1].get("role") != "user":
            self.dialogue.append({"role": "user", "content": question})
        self.dialogue.append({"role": "assistant", "content": answer})

        await self.session.send_json({"sentence": answer, "request_id": request.id})

        # Speak it too: TTS falls back to the offline Windows voice, so the
        # answer is still heard with no OpenAI key at all.
        try:
            await self.session.tts_module.speak(answer, request, play_locally)
        except Exception as ttsexc:
            logging.info(
                f"session {self.session.session_id}, request {request.id}: "
                f"local answer TTS skipped ({ttsexc})."
            )

        await self.session.send_json({"finish": "success", "request_id": request.id})

    # the requests are timed out after 5 seconds and retried with exponential backoff
    def answer_with_retry(self, request):
        delay = 0.5
        base = 2
        max_retries = 2
        for retries in range(1, max_retries + 1):
            client = self.session.client
            if client is None:
                raise RuntimeError("OpenAI client not configured")
            try:
                return client.chat.completions.create(
                    model=self.model,
                    messages=self.dialogue,
                    temperature=self.temperature,
                    stream=True,
                    timeout=5,
                    max_tokens=self.max_response_tokens,
                )
            except openai.AuthenticationError as exc:
                # A rejected key will be rejected again. Give up on OpenAI for
                # this session so the next question goes straight to the local
                # engine instead of burning two more round trips and 1.5s of
                # backoff on every single answer.
                logging.error("OpenAI rejected the API key; this session is now fully local.")
                self.session.disable_openai()
                raise exc
            except (openai.RateLimitError, openai.APIError, openai.APITimeoutError) as exc:
                logging.exception(exc)
                time.sleep(delay)
                delay *= base
                if retries == max_retries:
                    raise exc
            logging.error(f"session {self.session.session_id}, request {request.id}: Retrying GPT")

    def num_tokens_from_messages(self):
        num_tokens = 0
        for message in self.dialogue:
            num_tokens += 4  # every message follows <im_start>{role/name}\n{content}<im_end>\n
            for key, value in message.items():
                num_tokens += len(self.token_encoding.encode(value))
                if key == "name":  # if there's a name, the role is omitted
                    num_tokens += -1  # role is always required and always 1 response_token
        num_tokens += 2  # every reply is primed with <im_start>assistant
        return num_tokens
