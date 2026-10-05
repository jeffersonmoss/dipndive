$ErrorActionPreference = 'Stop'
$TaskName = 'DipDive Clipboard Helper'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$ConfigPath = Join-Path $env:APPDATA 'DipDive\clipboard-helper.json'
if (Test-Path -LiteralPath $ConfigPath) { Remove-Item -LiteralPath $ConfigPath -Force }
Write-Output 'Removed Dip''n''Dive clipboard helper.'
