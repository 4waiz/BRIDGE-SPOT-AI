$folder = "downloaded_requirements"
Remove-Item -Path $folder -Recurse -Force
pip download -r requirements.txt -d $folder