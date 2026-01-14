import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect
import user_session
import bridge_logger

# logging config
LOG_FILES = [
    {"filename": "data/smartassistant/log/server_error", "level": logging.ERROR, "backup_count": 90},
    {"filename": "data/smartassistant/log/server_debug", "level": logging.DEBUG, "backup_count": 90},
]

# initalize file and console logging
bridge_logger.start_logging(LOG_FILES)


# Set up Server
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_STATIC_FOLDER = "../../frontend/static"


# legacy url
@app.get("/static/lif.html")
async def redirect_legacy_url():
    return RedirectResponse("/?branding=lif")


# serve static file
app.mount("/static", StaticFiles(directory=FRONTEND_STATIC_FOLDER), name="static")
# allow direct asset paths for the frontend dev server
app.mount("/css", StaticFiles(directory=FRONTEND_STATIC_FOLDER + "/css"), name="static-css")
app.mount("/js", StaticFiles(directory=FRONTEND_STATIC_FOLDER + "/js"), name="static-js")
app.mount("/avatar", StaticFiles(directory=FRONTEND_STATIC_FOLDER + "/avatar"), name="static-avatar")
app.mount("/icon", StaticFiles(directory=FRONTEND_STATIC_FOLDER + "/icon"), name="static-icon")
app.mount("/sounds", StaticFiles(directory=FRONTEND_STATIC_FOLDER + "/sounds"), name="static-sounds")


# redirect to static website
@app.get("/")
async def serve_root_file():
    url = FRONTEND_STATIC_FOLDER + "/index.html"
    return FileResponse(url)


# Websocket endpoint
@app.websocket("/ws/")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            await handle_message(websocket, data)
    except (WebSocketDisconnect, ConnectionResetError):
        # session id is created at client. If connection is lost before client sent id, then session id is unknown
        session = user_session.search_user_session_by_ws(websocket)
        if session:
            logging.error(f"session {session.session_id}: Lost websocket connection")
        else:
            logging.error("Unknown session: Lost websocket connection")


async def handle_message(websocket, data):
    session = user_session.get_user_session(data["session_id"], websocket)
    # different settings, cancel and most importantly the recorded audio might be received
    if "cancel" in data:
        request = user_session.get_request(data["request_id"])
        if request:
            request.cancel = True
    elif "greeting" in data:
        request = user_session.Request(data["request_id"], session)
        await request.handle_request(data, greeting=True)
    elif "avatar" in data:
        # set the name in the system prompt and also the gender in TTS
        session.gpt_connector.name = data["avatar"].capitalize()
        session.gpt_connector.update_prompt()
        if data["avatar"] in ["aki", "anna", "maya", "rose", "zara", "zola"]:
            session.tts_module.gender = "female"
        else:
            session.tts_module.gender = "male"
    elif "language" in data:
        session.language = data["language"]
        session.gpt_connector.update_prompt()
    elif "playback-speed" in data:
        session.tts_module.playback_speed = data["playback-speed"]
    elif "creativity" in data:
        session.gpt_connector.temperature = float(data["creativity"])
    elif "gpt-model" in data:
        session.gpt_connector.model = "gpt-4.1-nano"
    elif "prompt" in data:
        session.gpt_connector.update_prompt(data["prompt"])
    elif "content" in data:
        session.gpt_connector.content = data["content"]
        session.gpt_connector.update_prompt()
    elif "stt" in data:
        session.stt_module.load_model(None if data["stt"] == "api" else data["stt"])
    elif "question" in data:
        request = user_session.Request(data["request_id"], session)
        await request.handle_request(data, question=data["question"])
    elif "client_audio" in data:
        request = user_session.Request(data["request_id"], session)
        await request.handle_request(data, client_audio=True)
    elif "server_audio" in data:
        request = user_session.Request(data["request_id"], session)
        await request.handle_request(data, server_audio=True)
    elif "server_wwd" in data:
        request = user_session.Request(data["request_id"], session)
        await request.handle_wwd_request(data)

# Changes made by Awaiz Ahmed
