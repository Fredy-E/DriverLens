param([string]$FixtureDirectory = (Join-Path $PSScriptRoot 'test-fixtures'))
. (Join-Path $PSScriptRoot 'Collect-DriverLens.ps1') -FunctionsOnly
[void][IO.Directory]::CreateDirectory($FixtureDirectory)
foreach ($case in @(@('arm64',0xAA64,'ARM64'),@('x64',0x8664,'x64'),@('x86',0x014C,'x86'),@('arm64ec',0xA641,'ARM64EC'),@('arm64x',0xA64E,'ARM64X'))) {
    $bytes = New-Object byte[] 128
    $bytes[0]=77; $bytes[1]=90
    [Array]::Copy([BitConverter]::GetBytes([uint32]64),0,$bytes,60,4)
    $bytes[64]=80; $bytes[65]=69
    [Array]::Copy([BitConverter]::GetBytes([uint16]$case[1]),0,$bytes,68,2)
    $file = Join-Path $FixtureDirectory ($case[0]+'.sys')
    [IO.File]::WriteAllBytes($file,$bytes)
    if ((Get-PeArchitecture $file) -ne $case[2]) { throw ('Architecture failed: '+$case[0]) }
}
$invalid=New-Object byte[] 128; $invalid[0]=77; $invalid[1]=90
[Array]::Copy([BitConverter]::GetBytes([uint32]4294967295),0,$invalid,60,4)
$file=Join-Path $FixtureDirectory 'bad-offset.sys'; [IO.File]::WriteAllBytes($file,$invalid)
if ((Get-PeArchitecture $file) -ne 'Invalid PE') { throw 'Bounds validation failed' }
$inf=Join-Path $FixtureDirectory 'example.inf'; [IO.File]::WriteAllText($inf,"[Manufacturer]`nExample=Models,NTarm64,NTamd64.10.0`n")
$targets=@(Get-InfArchitectures $inf)
if ($targets.Count -ne 2 -or 'ARM64' -notin $targets -or 'x64' -notin $targets) { throw 'INF parsing failed' }
Write-Output 'Passed: five PE machine types, invalid offset rejection, and INF architecture parsing.'
