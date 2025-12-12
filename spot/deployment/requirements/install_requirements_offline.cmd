:: Uninstall all currently installed packages
for /F "delims=" %%p in ('pip freeze') do pip uninstall -y %%p

:: Install requirements from the local source
pip install --upgrade -r requirements.txt --no-index --find-links downloaded_requirements