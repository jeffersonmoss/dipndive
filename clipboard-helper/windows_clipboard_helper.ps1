param([string]$ConfigPath = (Join-Path $env:APPDATA 'DipDive\clipboard-helper.json'))

$ErrorActionPreference = 'Stop'
$AllowedMachines = @('thing-1', 'thing-2', 'imac', 'win')
$LogDirectory = Join-Path $env:LOCALAPPDATA 'DipDive\Logs'
$LogPath = Join-Path $LogDirectory 'clipboard-helper.log'
$PollSeconds = 2
$MaximumBackoff = 30

function Test-ClipboardUrl([object]$Value) {
    if ($Value -isnot [string] -or $Value.Length -lt 1 -or $Value.Length -gt 2048) { return $false }
    if ($Value -match '[\p{Cc}\s]') { return $false }
    $Parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$Parsed)) { return $false }
    return (($Parsed.Scheme -eq 'http' -or $Parsed.Scheme -eq 'https') -and -not [string]::IsNullOrEmpty($Parsed.Host))
}

function Write-HelperError([string]$Kind) {
    try {
        New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
        if (Test-Path $LogPath -PathType Leaf) {
            if ((Get-Item $LogPath).Length -ge 65536) {
                if (Test-Path ($LogPath + '.2')) { Remove-Item ($LogPath + '.2') -Force }
                if (Test-Path ($LogPath + '.1')) { Move-Item ($LogPath + '.1') ($LogPath + '.2') -Force }
                Move-Item $LogPath ($LogPath + '.1') -Force
            }
        }
        Add-Content -Path $LogPath -Encoding UTF8 -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' WARNING ' + $Kind)
    } catch { }
}

function Get-NextUrl($Client, $Config) {
    $Machine = [Uri]::EscapeDataString($Config.machine)
    $Endpoint = $Config.base_url.TrimEnd('/') + '/clipboard/next?machine=' + $Machine
    $Response = $Client.GetAsync($Endpoint).GetAwaiter().GetResult()
    try {
        if ([int]$Response.StatusCode -eq 204) { return $null }
        $Response.EnsureSuccessStatusCode() | Out-Null
        $Body = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $Body) { return $null }
        $Item = $Body | ConvertFrom-Json
        if ($Item -is [string]) { $Url = $Item } else { $Url = $Item.url }
        if (Test-ClipboardUrl $Url) { return $Url }
        return $null
    } finally { $Response.Dispose() }
}

try {
    Add-Type -AssemblyName System.Net.Http
    $Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($Config.machine -notin $AllowedMachines -or [string]::IsNullOrWhiteSpace($Config.token) -or
        -not (Test-ClipboardUrl $Config.base_url)) { throw 'InvalidConfig' }
    $BaseUri = [Uri]$Config.base_url
    if ($BaseUri.Query -or $BaseUri.Fragment) { throw 'InvalidConfig' }
    $Client = [System.Net.Http.HttpClient]::new()
    $Client.Timeout = [TimeSpan]::FromSeconds(10)
    $Client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', [string]$Config.token)
} catch {
    Write-HelperError 'config error'
    exit 1
}

$Backoff = $PollSeconds
while ($true) {
    try {
        $Url = Get-NextUrl $Client $Config
        if ($Url) { Set-Clipboard -Value $Url }
        $Backoff = $PollSeconds
        Start-Sleep -Seconds $PollSeconds
    } catch {
        Write-HelperError 'poll error'
        Start-Sleep -Seconds $Backoff
        $Backoff = [Math]::Min($MaximumBackoff, [Math]::Max($PollSeconds, $Backoff * 2))
    }
}
