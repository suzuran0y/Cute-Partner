param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$release = $env:CUTE_PARTNER_INSTALL_RELEASE | ConvertFrom-Json
$target = $env:CUTE_PARTNER_INSTALL_TARGET
if (Test-Path -LiteralPath $target) { throw 'Installation target already exists.' }
$parent = Split-Path -Parent $target
New-Item -ItemType Directory -Path $parent -Force | Out-Null
if ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation parent is a reparse point.' }
$work = Join-Path $parent ('install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$zip = Join-Path $work 'download.zip'
Invoke-WebRequest -UseBasicParsing -Uri $release.url -OutFile $zip -TimeoutSec 600
if ((Get-Item -LiteralPath $zip).Length -ne $release.bytes) { throw 'Download size mismatch.' }
$hashStream = [IO.File]::OpenRead($zip)
$hasher = [Security.Cryptography.SHA256]::Create()
try { $digest = [BitConverter]::ToString($hasher.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant() }
finally { $hashStream.Dispose(); $hasher.Dispose() }
if ($digest -ne $release.sha256) { throw 'Download hash mismatch.' }
$stage = Join-Path $work 'app'
New-Item -ItemType Directory -Path $stage | Out-Null
$prefix = [IO.Path]::GetFullPath($stage) + [IO.Path]::DirectorySeparatorChar
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  [long]$expanded = 0
  if ($archive.Entries.Count -gt 3000) { throw 'Too many archive entries.' }
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if ($name.StartsWith('/') -or $name.Contains(':') -or ($name.Split('/') -contains '..') -or ($name.Split('/') -contains '.')) { throw 'Unsafe archive entry.' }
    $out = [IO.Path]::GetFullPath((Join-Path $stage $name))
    if (-not $out.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not $seen.Add($out)) { throw 'Unsafe or duplicate archive path.' }
    if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Archive links are not supported.' }
    $expanded += $entry.Length
    if ($expanded -gt 2147483648) { throw 'Expanded archive is too large.' }
  }
  foreach ($entry in $archive.Entries) {
    $out = [IO.Path]::GetFullPath((Join-Path $stage $entry.FullName.Replace('\', '/')))
    if ($entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Path $out -Force | Out-Null }
    else {
      New-Item -ItemType Directory -Path (Split-Path -Parent $out) -Force | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $out, $false)
    }
  }
} finally { $archive.Dispose() }
$product = Get-Content -LiteralPath (Join-Path $stage 'product.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($product.name -ne 'Cute-Partner' -or $product.version -ne $release.version) { throw 'Unexpected product metadata.' }
foreach ($required in @('apps\desktop\launch.ps1', 'apps\desktop\tools\start.cjs', 'apps\desktop\node_modules\electron\dist\electron.exe', 'characters\default\model\character.model3.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) { throw 'Incomplete desktop package.' }
}
Move-Item -LiteralPath $stage -Destination $target
Write-Output 'Cute-Partner base application installed. Voice components remain optional.'
