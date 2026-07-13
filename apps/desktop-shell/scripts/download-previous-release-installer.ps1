[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Repository,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$ExcludeTag = "",

  [string]$GitHubToken = $env:GITHUB_TOKEN
)

$ErrorActionPreference = "Stop"

if ($Repository -notmatch "^[^/\s]+/[^/\s]+$") {
  throw "Repository must be in owner/repo form"
}
if (-not $GitHubToken) {
  throw "GITHUB_TOKEN is required to download a previous release installer"
}

$headers = @{
  Authorization = "Bearer $GitHubToken"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "ArcWriter-RC-Smoke"
}
$releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases?per_page=100" -Headers $headers
$release = $releases | Where-Object {
  -not $_.draft -and -not $_.prerelease -and $_.tag_name -ne $ExcludeTag
} | Select-Object -First 1
if (-not $release) {
  throw "No previous stable release is available for $Repository"
}
$asset = $release.assets | Where-Object { $_.name -match "^ArcWriter-Setup-.+\.exe$" } | Select-Object -First 1
if (-not $asset) {
  throw "Release $($release.tag_name) has no ArcWriter NSIS installer"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $OutputPath
if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf) -or (Get-Item -LiteralPath $OutputPath).Length -eq 0) {
  throw "Downloaded previous installer is missing or empty: $OutputPath"
}

Write-Host "Downloaded baseline installer from $($release.tag_name): $($asset.name)"
