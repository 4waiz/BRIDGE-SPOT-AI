# Generate requirements.txt
pipenv requirements > requirements.txt
pipenv requirements --dev > requirements_dev.txt

# Delete existing downloads
$folder = "downloaded_requirements"
$exception = "wfastcgi-3.0.0-py2.py3-none-any.whl"
$items = Get-ChildItem -Path $folder | Where-Object { $_.Name -ne $exception }
# Remove the filtered items
foreach ($item in $items) {
    Remove-Item -Path $item.FullName -Recurse -Force
}

# Download packages
pip download -r requirements.txt -d $folder

# Output
Write-Host "Requirements downloaded for:"
python --version
Write-Host "If other python version is used, downloaded requirements might not work."
