param(
    [string]$OutputPath = (Join-Path $PSScriptRoot 'driver-report.json'),
    [switch]$FunctionsOnly
)

# Inventory only: this script does not install, disable, modify, or remove drivers.
function Get-PeArchitecture {
    param([string]$LiteralPath)
    $stream = $null
    try {
        $stream = [IO.File]::Open($LiteralPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        if ($stream.Length -lt 64) { return 'Not PE' }
        $header = New-Object byte[] 64
        if ($stream.Read($header, 0, 64) -ne 64) { return 'Unreadable' }
        if ($header[0] -ne 77 -or $header[1] -ne 90) { return 'Not PE' }
        $offset = [BitConverter]::ToUInt32($header, 60)
        if ($offset -lt 64 -or [long]$offset + 24 -gt $stream.Length) { return 'Invalid PE' }
        [void]$stream.Seek($offset, [IO.SeekOrigin]::Begin)
        $coff = New-Object byte[] 24
        if ($stream.Read($coff, 0, 24) -ne 24) { return 'Unreadable' }
        if ($coff[0] -ne 80 -or $coff[1] -ne 69 -or $coff[2] -ne 0 -or $coff[3] -ne 0) { return 'Invalid PE' }
        switch ([BitConverter]::ToUInt16($coff, 4)) {
            0xAA64 { return 'ARM64' }
            0x8664 { return 'x64' }
            0x014C { return 'x86' }
            0xA641 { return 'ARM64EC' }
            0xA64E { return 'ARM64X' }
            0x01C4 { return 'ARM32' }
            default { return ('Unknown (0x{0:X4})' -f [BitConverter]::ToUInt16($coff, 4)) }
        }
    } catch { return 'Unreadable' }
    finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Get-InfArchitectures {
    param([string]$LiteralPath)
    try {
        $text = [IO.File]::ReadAllText($LiteralPath)
        $found = @()
        foreach ($pair in @(@('NTarm64','ARM64'), @('NTamd64','x64'), @('NTx86','x86'), @('NTarm','ARM32'))) {
            if ($text -match ('(?i)\b' + $pair[0] + '(?:\.|\b)')) { $found += $pair[1] }
        }
        return $found
    } catch { return @() }
}

function Get-DeviceDigest {
    param([string]$Instance)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Instance.ToUpperInvariant()))).Replace('-', '').Substring(0, 16)) }
    finally { $sha.Dispose() }
}

function Resolve-KernelPath {
    param([string]$DriverPath)
    if (-not $DriverPath) { return $null }
    $candidate = [Environment]::ExpandEnvironmentVariables($DriverPath.Trim().Trim('"'))
    if ($candidate.StartsWith('\SystemRoot\', [StringComparison]::OrdinalIgnoreCase)) { $candidate = Join-Path $env:SystemRoot $candidate.Substring(12) }
    elseif ($candidate.StartsWith('System32\', [StringComparison]::OrdinalIgnoreCase)) { $candidate = Join-Path $env:SystemRoot $candidate }
    if ($candidate.StartsWith('\??\')) { $candidate = $candidate.Substring(4) }
    if ($candidate -notmatch '(?i)\.sys$') { return $null }
    try {
        $resolved = [IO.Path]::GetFullPath($candidate)
        $allowed = [IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        return $resolved
    } catch { return $null }
}

if ($FunctionsOnly) { return }
if ($env:OS -ne 'Windows_NT') { throw 'DriverLens inventory requires Windows.' }
$issues = New-Object 'System.Collections.Generic.List[string]'
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
try { $osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
catch { $osArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
$osArchitecture = switch -Regex ($osArchitecture) { '^Arm64$|^ARM64$' { 'ARM64'; break } '^X64$|^AMD64$' { 'x64'; break } '^X86$' { 'x86'; break } default { $osArchitecture } }
$signed = @{}
try { Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop | ForEach-Object { if ($_.DeviceID) { $signed[$_.DeviceID] = $_ } } }
catch { $issues.Add('Signed-driver metadata could not be read; some fields are unknown.') }
$services = @{}
try { Get-CimInstance Win32_SystemDriver -ErrorAction Stop | ForEach-Object { $services[$_.Name] = $_ } }
catch { $issues.Add('Kernel service inventory could not be read; binary architecture may be unknown.') }
$infCache = @{}
$binaryCache = @{}
$devices = @(Get-CimInstance Win32_PnPEntity -ErrorAction Stop | ForEach-Object {
    $device = $_
    $driver = if ($device.DeviceID) { $signed[$device.DeviceID] } else { $null }
    $service = if ($device.Service) { $services[$device.Service] } else { $null }
    $binary = if ($service) { Resolve-KernelPath $service.PathName } else { $null }
    $architecture = 'Unknown'
    if ($binary) {
        if (-not $binaryCache.ContainsKey($binary)) { $binaryCache[$binary] = Get-PeArchitecture $binary }
        $architecture = $binaryCache[$binary]
    }
    $inf = if ($driver) { [string]$driver.InfName } else { '' }
    $targets = @()
    if ($inf -match '^[A-Za-z0-9_.-]+\.inf$') {
        if (-not $infCache.ContainsKey($inf)) { $infCache[$inf] = @(Get-InfArchitectures (Join-Path (Join-Path $env:SystemRoot 'INF') $inf)) }
        $targets = $infCache[$inf]
    }
    $review = New-Object 'System.Collections.Generic.List[string]'
    if ($null -ne $device.ConfigManagerErrorCode -and $device.ConfigManagerErrorCode -ne 0) { $review.Add('Windows device error ' + $device.ConfigManagerErrorCode) }
    if ($driver -and $driver.IsSigned -eq $false) { $review.Add('Driver metadata reports unsigned') }
    if ($architecture -in @('x86','x64','ARM64') -and $osArchitecture -in @('x86','x64','ARM64') -and $architecture -ne $osArchitecture) { $review.Add('Kernel binary architecture differs from OS') }
    $vendorId = $null; $productId = $null
    if ($device.DeviceID -match 'VID_([0-9A-Fa-f]{4})') { $vendorId = $matches[1].ToUpperInvariant() }
    if ($device.DeviceID -match 'PID_([0-9A-Fa-f]{4})') { $productId = $matches[1].ToUpperInvariant() }
    [pscustomobject][ordered]@{
        id = Get-DeviceDigest ([string]$device.DeviceID)
        name = [string]$device.Name
        deviceClass = [string]$device.PNPClass
        manufacturer = [string]$device.Manufacturer
        bus = ([string]$device.DeviceID -split '\\')[0]
        vid = $vendorId; pid = $productId
        status = if ($review.Count) { 'review' } else { 'observed' }
        windowsStatus = [string]$device.Status
        errorCode = $device.ConfigManagerErrorCode
        provider = if ($driver) { [string]$driver.DriverProviderName } else { '' }
        version = if ($driver) { [string]$driver.DriverVersion } else { '' }
        signed = if ($driver) { $driver.IsSigned } else { $null }
        inf = $inf
        packageTargets = @($targets)
        service = [string]$device.Service
        kernelBinary = if ($binary) { [IO.Path]::GetFileName($binary) } else { '' }
        architecture = $architecture
        notes = @($review)
    }
} | Sort-Object name)
$report = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString('o')
    sample = $false
    system = @{ os = [string]$os.Caption; build = [string]$os.BuildNumber; architecture = $osArchitecture }
    privacy = 'Raw device instance IDs are replaced by a digest. Hostnames, usernames, serial fields, and full driver paths are omitted.'
    warnings = @($issues)
    devices = @($devices)
}
$destination = [IO.Path]::GetFullPath($OutputPath)
$json = $report | ConvertTo-Json -Depth 9
[IO.File]::WriteAllText($destination, $json, (New-Object Text.UTF8Encoding($false)))
Write-Output ('Saved local inventory: ' + $devices.Count + ' devices -> ' + $destination)
