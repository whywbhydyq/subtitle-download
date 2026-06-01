# Run this from the subtitle-download project root if you copied this package over the old M3U8 project.
$paths = @(
  "m3u8_to_mp4",
  "post",
  "assets\m3u8-mp4-converter.js"
)
foreach ($path in $paths) {
  if (Test-Path $path) {
    Remove-Item $path -Recurse -Force
    Write-Host "Removed $path"
  }
}
Write-Host "Old M3U8-only files removed."
