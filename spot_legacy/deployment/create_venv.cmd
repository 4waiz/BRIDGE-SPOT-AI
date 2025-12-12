python -m venv ../venv
cd ../venv/Scripts
call activate
cd ../../deployment
python -m pip install --upgrade pip
pip install -r requirements.txt