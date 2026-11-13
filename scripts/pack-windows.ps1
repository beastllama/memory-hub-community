# Build the source tree first. This script does not install dependencies.
[CmdletBinding()]
param([switch]$Candidate)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = '22.23.5'
$runtimeDirName = "node-v$version-win-x64"
$runtimeUrl = "https://nodejs.org/dist/v$version/$runtimeDirName.zip"
$releaseNotes = "https://nodejs.org/en/blog/release/v$version/"
# Pinned from SHASUMS in the vendor release notes above. Check Authenticode too.
$runtimeZipHash = '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3'
$runtimeExeHash = '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Run this pack script on Windows.' }
if (-not $Candidate -and -not (Test-Path -LiteralPath (Join-Path $root 'LICENSE') -PathType Leaf)) {
  throw 'The app LICENSE is required for a distributable ZIP. Use -Candidate for local testing only.'
}

function Copy-ReleaseFile([string]$Source, [string]$Destination) {
  $item = Get-Item -LiteralPath $Source -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'A release input is not a regular file.'
  }
  [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Destination))
  Copy-Item -LiteralPath $item.FullName -Destination $Destination
}

$releaseRoot = Join-Path $root 'release'
[void][IO.Directory]::CreateDirectory($releaseRoot)
if ((Get-Item -LiteralPath $releaseRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'The release folder must not be a link.'
}

$id = [guid]::NewGuid().ToString('N')
$work = Join-Path $releaseRoot $id
$stage = Join-Path $work 'Memory Hub'
[void][IO.Directory]::CreateDirectory($stage)

# Exact runtime allowlist. No workspace symlinks, dev dependencies, or user state.
$inputs = @(
  'Start Memory Hub.cmd', 'README.md',
  'apps/local/dist/server.js', 'apps/local/dist/hub.js', 'apps/local/dist/scan.js',
  'apps/local/dist/types.js', 'apps/local/dist/public/index.html',
  'apps/local/dist/public/style.css', 'apps/local/dist/public/app.js',
  'docs/VISUAL-QUICK-START.md', 'docs/images/01-choose.png', 'docs/images/02-review.png',
  'docs/images/03-save.png', 'docs/images/04-ai-preview.png',
  'examples/Trail Notes/README.md', 'examples/Trail Notes/package.json'
)
if (Test-Path -LiteralPath (Join-Path $root 'LICENSE') -PathType Leaf) { $inputs += 'LICENSE' }
foreach ($file in $inputs) {
  Copy-ReleaseFile (Join-Path $root $file) (Join-Path $stage $file)
}

$appManifest = Join-Path $stage 'apps/local/package.json'
[IO.File]::WriteAllText($appManifest, '{"type":"module"}')
foreach ($name in @('scanner', 'runners')) {
  $package = Join-Path $stage "node_modules/@memory-hub/$name"
  Copy-ReleaseFile (Join-Path $root "packages/$name/dist/index.js") (Join-Path $package 'index.js')
  [IO.File]::WriteAllText((Join-Path $package 'package.json'), '{"type":"module","exports":"./index.js"}')
}

$cache = Join-Path $releaseRoot "$runtimeDirName.zip"
if (-not (Test-Path -LiteralPath $cache -PathType Leaf)) {
  Write-Host "Downloading the official Node.js $version Windows x64 runtime."
  $download = Join-Path $work "$runtimeDirName.zip"
  Invoke-WebRequest -UseBasicParsing -Uri $runtimeUrl -OutFile $download -MaximumRedirection 0 -TimeoutSec 120
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash -ne $runtimeZipHash) {
    throw 'The downloaded Node.js archive did not match the pinned vendor checksum.'
  }
  Move-Item -LiteralPath $download -Destination $cache
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $cache).Hash -ne $runtimeZipHash) {
  throw 'The cached Node.js archive did not match the pinned vendor checksum.'
}

# Read only two verified archive entries. Do not unpack npm or any other bundled tools.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$runtime = Join-Path $stage 'runtime'
[void][IO.Directory]::CreateDirectory($runtime)
$vendor = [IO.Compression.ZipFile]::OpenRead($cache)
try {
  foreach ($name in @('node.exe', 'LICENSE')) {
    $entry = $vendor.GetEntry("$runtimeDirName/$name")
    if ($null -eq $entry) { throw 'The vendor archive is missing a required entry.' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtime $name))
  }
} finally {
  $vendor.Dispose()
}

$exe = Join-Path $runtime 'node.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $exe
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash -ne $runtimeExeHash -or
    $signature.Status -ne 'Valid' -or
    $signature.SignerCertificate.Subject -notmatch '(^|, )CN=OpenJS Foundation(,|$)') {
  throw 'The Node.js executable did not match the pinned checksum and valid OpenJS Foundation signature.'
}

$notice = @"
The runtime includes the unmodified Windows x64 Node.js v$version executable.
The Node.js license and its dependency notices are in runtime/LICENSE.
Vendor distribution: $runtimeUrl
Vendor checksums and release information: $releaseNotes
Node.js source: https://nodejs.org/dist/v$version/node-v$version.tar.gz
"@
[IO.File]::WriteAllText((Join-Path $stage 'THIRD-PARTY-NOTICES.txt'), $notice)
if ($Candidate) {
  [IO.File]::WriteAllText((Join-Path $stage 'CANDIDATE.txt'), 'Internal test build. Do not redistribute.')
}

$zipName = if ($Candidate) { 'Memory-Hub-windows-x64-CANDIDATE.zip' } else { 'Memory-Hub-windows-x64.zip' }
$zipPath = Join-Path $work $zipName
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $true)
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$zipPath.sha256", "$sha  $zipName`n")
Write-Output $zipPath
