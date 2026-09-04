# Offline text-to-speech using the SAPI voices built into Windows.
# Called by connectors/local_tts.py as:
#   powershell -File sapi_tts.ps1 <text-file> <out-wav> <Male|Female>
# The text arrives in a file rather than on the command line so quotes,
# apostrophes and non-ASCII in an answer cannot break the invocation.
param(
    [Parameter(Mandatory = $true)][string]$TextFile,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$Gender = "Male"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { exit 2 }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    try {
        $hint = [System.Speech.Synthesis.VoiceGender]::$Gender
        $synth.SelectVoiceByHints($hint)
    } catch {
        # No voice installed for that gender -- the default voice is fine.
    }

    # 16 kHz mono 16-bit matches SAMPLE_RATE in text_to_speech.py, so the
    # server-side playback path needs no resampling.
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        16000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono)

    $synth.SetOutputToWaveFile($OutFile, $format)
    $synth.Speak($text)
    $synth.SetOutputToNull()
} finally {
    $synth.Dispose()
}
