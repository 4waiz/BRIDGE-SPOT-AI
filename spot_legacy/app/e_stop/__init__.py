from flask import Flask
from flask_cors import CORS

from e_stop import config, routes
import bridge

app = Flask(__name__)
app.register_blueprint(routes.routes)
CORS(app)

bridge.start_logging(config.LOG_FILES)
# Changes made by Awaiz Ahmed
