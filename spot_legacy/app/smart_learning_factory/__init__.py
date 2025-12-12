from flask import Flask
from flask_cors import CORS

import bridge

from smart_learning_factory import config, routes

# instantiate flask and register routes Blueprint
app = Flask(__name__)
CORS(app)
app.register_blueprint(routes.routes)

bridge.start_logging(config.LOG_FILES)
# Changes made by Awaiz Ahmed
