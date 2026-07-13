[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Repository,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$MetadataOutputPath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateVersion,

  [string]$ExcludeTag = "",

  [string]$GitHubToken = $env:GITHUB_TOKEN
)

$ErrorActionPreference = "Stop"

if ($Repository -notmatch "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") {
  throw "Repository must be in owner/repo form"
}
$normalizedCandidateVersion = $CandidateVersion.Trim()
if ($normalizedCandidateVersion -notmatch '^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
  throw "CandidateVersion must be a valid semantic version: $CandidateVersion"
}
try {
  $candidateSemVer = [System.Management.Automation.SemanticVersion]::new($normalizedCandidateVersion)
} catch {
  throw "CandidateVersion must be a valid semantic version: $CandidateVersion"
}
$outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
$metadataFullPath = [System.IO.Path]::GetFullPath($MetadataOutputPath)
if ([string]::Equals($outputFullPath, $metadataFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputPath and MetadataOutputPath must be different files"
}

$headers = @{
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "ArcWriter-RC-Smoke"
}
if ($GitHubToken) {
  $headers.Authorization = "Bearer $GitHubToken"
}
$releases = @()
for ($page = 1; $page -le 20; $page++) {
  $pageResponse = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases?per_page=100&page=$page" -Headers $headers
  $pageReleases = @($pageResponse)
  $releases += $pageReleases
  if ($pageReleases.Count -lt 100) {
    break
  }
  if ($page -eq 20) {
    throw "Release history exceeds the bounded 2000-release scan for $Repository"
  }
}

$selected = $null
foreach ($candidateRelease in $releases) {
  $tag = [string]$candidateRelease.tag_name
  if ($candidateRelease.draft -or $candidateRelease.prerelease -or ($ExcludeTag -and $tag -eq $ExcludeTag)) {
    continue
  }
  $tagMatch = [regex]::Match($tag, '^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$')
  if (-not $tagMatch.Success) {
    continue
  }
  $versionText = $tagMatch.Groups[1].Value
  $version = [System.Management.Automation.SemanticVersion]::new($versionText)
  $versionComparison = $version.CompareTo($candidateSemVer)
  if ($versionComparison -ge 0) {
    continue
  }
  if (-not $selected -or $version.CompareTo($selected.Version) -gt 0) {
    $selected = [pscustomobject]@{
      Release = $candidateRelease
      Tag = $tag
      Version = $version
      VersionText = $versionText
      VersionRelation = "previous"
    }
  }
}
if (-not $selected) {
  throw "No stable release below candidate version $CandidateVersion is available for $Repository"
}

$release = $selected.Release
$expectedAssetName = "ArcWriter-Setup-$($selected.VersionText).exe"
$matchingAssets = @($release.assets | Where-Object { [string]$_.name -eq $expectedAssetName })
if ($matchingAssets.Count -ne 1) {
  throw "Release $($selected.Tag) must contain exactly one asset named $expectedAssetName"
}
$asset = $matchingAssets[0]
try {
  $releaseId = [System.Convert]::ToInt64($release.id)
  $assetId = [System.Convert]::ToInt64($asset.id)
  $assetSize = [System.Convert]::ToInt64($asset.size)
} catch {
  throw "Release $($selected.Tag) contains invalid numeric identity metadata"
}
if ($releaseId -le 0 -or $assetId -le 0 -or $assetSize -le 0) {
  throw "Release $($selected.Tag) contains non-positive identity or asset size metadata"
}
try {
  $publishedTimestamp = [System.DateTimeOffset]$release.published_at
  $publishedAt = $publishedTimestamp.UtcDateTime.ToString(
    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
    [System.Globalization.CultureInfo]::InvariantCulture
  )
} catch {
  throw "Release $($selected.Tag) has an invalid published_at timestamp"
}
try {
  $assetUri = [System.Uri]::new([string]$asset.browser_download_url, [System.UriKind]::Absolute)
} catch {
  throw "Release $($selected.Tag) has an invalid asset download URL"
}
if ($assetUri.Scheme -ne 'https') {
  throw "Release asset download URL must use HTTPS"
}
if ($assetUri.Host -ne 'github.com') {
  throw "Release asset download URL must use github.com"
}
$expectedAssetUrl = "https://github.com/$Repository/releases/download/$($selected.Tag)/$expectedAssetName"
if ($assetUri.AbsoluteUri -ne $expectedAssetUrl -or $assetUri.UserInfo -or $assetUri.Query -or $assetUri.Fragment -or -not $assetUri.IsDefaultPort) {
  throw "Release asset download URL does not match the selected repository, tag, and asset"
}

New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($outputFullPath)) | Out-Null
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($metadataFullPath)) | Out-Null
$downloadTempPath = "$outputFullPath.partial-$([Guid]::NewGuid().ToString('N'))"
$metadataTempPath = "$metadataFullPath.partial-$([Guid]::NewGuid().ToString('N'))"
try {
  Invoke-WebRequest -Uri $assetUri.AbsoluteUri -Headers $headers -OutFile $downloadTempPath
  if (-not (Test-Path -LiteralPath $downloadTempPath -PathType Leaf)) {
    throw "Downloaded previous installer is missing: $expectedAssetName"
  }
  $downloadedSize = (Get-Item -LiteralPath $downloadTempPath).Length
  if ($downloadedSize -ne $assetSize) {
    throw "Downloaded installer size $downloadedSize does not match GitHub asset size $assetSize"
  }
  $installerHash = (Get-FileHash -LiteralPath $downloadTempPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installerHash -notmatch '^[0-9a-f]{64}$') {
    throw "Downloaded installer did not produce a valid SHA-256"
  }
  $declaredDigest = [string]$asset.digest
  if ($declaredDigest) {
    $digestMatch = [regex]::Match($declaredDigest, '^sha256:([0-9a-f]{64})$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $digestMatch.Success) {
      throw "GitHub asset declares an unsupported digest: $declaredDigest"
    }
    if ($installerHash -ne $digestMatch.Groups[1].Value.ToLowerInvariant()) {
      throw "Downloaded installer SHA-256 does not match the GitHub asset digest"
    }
  }

  Move-Item -LiteralPath $downloadTempPath -Destination $outputFullPath -Force
  $metadata = [ordered]@{
    schema_version = 1
    repository = $Repository
    candidate_version = $candidateSemVer.ToString()
    baseline_version = $selected.VersionText
    version_relation = $selected.VersionRelation
    tag = $selected.Tag
    release_id = $releaseId
    asset_id = $assetId
    asset_name = $expectedAssetName
    asset_url = $assetUri.AbsoluteUri
    sha256 = $installerHash
    published_at = $publishedAt
  }
  $metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metadataTempPath -Encoding utf8
  Move-Item -LiteralPath $metadataTempPath -Destination $metadataFullPath -Force
} finally {
  Remove-Item -LiteralPath $downloadTempPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $metadataTempPath -Force -ErrorAction SilentlyContinue
}

Write-Host "Downloaded baseline installer from $($selected.Tag): $expectedAssetName"
Write-Host "Baseline metadata written to $metadataFullPath"
