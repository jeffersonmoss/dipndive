param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][ValidateSet('thing-1', 'thing-2', 'imac', 'win')][string]$Machine,
    [string]$TokenFile
)

$ErrorActionPreference = 'Stop'
$ConfigDirectory = Join-Path $env:APPDATA 'DipDive'
$ConfigPath = Join-Path $ConfigDirectory 'clipboard-helper.json'
$HelperPath = Join-Path $PSScriptRoot 'windows_clipboard_helper.ps1'
$TaskName = 'DipDive Clipboard Helper'

if ($BaseUrl -notmatch '^https?://[^\s]+$' -or $BaseUrl -match '[\p{Cc}\p{Cf}]|\\') { throw 'BaseUrl must be a valid secure URL.' }
$BaseUri = [Uri]$BaseUrl
if (($BaseUri.Scheme -ne 'https' -and -not ($BaseUri.IsLoopback -or $BaseUri.Host.EndsWith('.ts.net', [StringComparison]::OrdinalIgnoreCase))) -or
    $BaseUri.Query -or $BaseUri.Fragment) { throw 'BaseUrl must use https, except loopback or *.ts.net.' }
if ($TokenFile) {
    $Token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
} else {
    $SecureToken = Read-Host 'Companion bearer token' -AsSecureString
    $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureToken)
    try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }
}
if ([string]::IsNullOrWhiteSpace($Token)) { throw 'The token is empty.' }

New-Item -ItemType Directory -Path $ConfigDirectory -Force | Out-Null
$Config = [ordered]@{ base_url = $BaseUrl.TrimEnd('/'); token = $Token; machine = $Machine }
$Json = $Config | ConvertTo-Json -Compress
[IO.File]::WriteAllText($ConfigPath, $Json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$Acl = New-Object Security.AccessControl.FileSecurity
$Acl.SetAccessRuleProtection($true, $false)
$Rule = New-Object Security.AccessControl.FileSystemAccessRule($Identity, 'FullControl', 'Allow')
$Acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
$Acl.AddAccessRule($Rule)
Set-Acl -LiteralPath $ConfigPath -AclObject $Acl
$Token = $null
$Json = $null

$PowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $HelperPath + '" -ConfigPath "' + $ConfigPath + '"'
$Action = New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $Identity
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$Principal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output ('Installed Dip''n''Dive clipboard helper for ' + $Machine + '.')
