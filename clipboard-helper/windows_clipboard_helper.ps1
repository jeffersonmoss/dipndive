param([string]$ConfigPath = (Join-Path $env:APPDATA 'DipDive\clipboard-helper.json'))

$ErrorActionPreference = 'Stop'
$AllowedMachines = @('thing-1', 'thing-2', 'imac', 'win')
$LogDirectory = Join-Path $env:LOCALAPPDATA 'DipDive\Logs'
$LogPath = Join-Path $LogDirectory 'clipboard-helper.log'
$PollSeconds = 2
$MaximumBackoff = 30
$MaximumResponseBytes = 65536
$WriteAttempts = 4
$LastUnauthorizedLog = [DateTime]::MinValue

function Test-ClipboardUrl([object]$Value) {
    if ($Value -isnot [string] -or $Value.Length -lt 1 -or $Value.Length -gt 2048) { return $false }
    if ($Value -match '[\p{Cc}\p{Cf}\s]' -or $Value.Contains('\') -or $Value -notmatch '^https?://') { return $false }
    $Parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$Parsed)) { return $false }
    return (($Parsed.Scheme -eq 'http' -or $Parsed.Scheme -eq 'https') -and -not [string]::IsNullOrEmpty($Parsed.Host))
}

function Test-SecureBase([string]$Value) {
    $Parsed = $null
    if ($Value -notmatch '^https?://' -or -not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$Parsed)) { return $false }
    if ($Parsed.Query -or $Parsed.Fragment) { return $false }
    return ($Parsed.Scheme -eq 'https' -or $Parsed.IsLoopback -or $Parsed.Host.EndsWith('.ts.net', [StringComparison]::OrdinalIgnoreCase))
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
    $Response = $Client.GetAsync($Endpoint, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    try {
        if ([int]$Response.StatusCode -eq 204) { return $null }
        if ([int]$Response.StatusCode -eq 401) { throw [System.UnauthorizedAccessException]::new('Unauthorized') }
        $Response.EnsureSuccessStatusCode() | Out-Null
        $Stream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $Buffer = New-Object byte[] 8192
        $Memory = [IO.MemoryStream]::new()
        try {
            while (($Read = $Stream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
                if ($Memory.Length + $Read -gt $MaximumResponseBytes) { throw 'ResponseTooLarge' }
                $Memory.Write($Buffer, 0, $Read)
            }
            $Body = [Text.Encoding]::UTF8.GetString($Memory.ToArray())
        } finally { $Memory.Dispose(); $Stream.Dispose() }
        if (-not $Body) { return $null }
        $Item = $Body | ConvertFrom-Json
        if ($Item -is [string]) { $Url = $Item } else { $Url = $Item.url }
        if (Test-ClipboardUrl $Url) { return $Url }
        return $null
    } finally { $Response.Dispose() }
}

function Read-HelperConfig {
    $Loaded = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($Loaded.machine -notin $AllowedMachines -or [string]::IsNullOrWhiteSpace($Loaded.token) -or
        -not (Test-ClipboardUrl $Loaded.base_url) -or -not (Test-SecureBase $Loaded.base_url)) { throw 'InvalidConfig' }
    $Uri = [Uri]$Loaded.base_url
    if ($Uri.Query -or $Uri.Fragment) { throw 'InvalidConfig' }
    return $Loaded
}

try {
    Add-Type -AssemblyName System.Net.Http
    $Config = $null
    $Handler = [System.Net.Http.HttpClientHandler]::new()
    $Handler.AllowAutoRedirect = $false
    $Client = [System.Net.Http.HttpClient]::new($Handler)
    $Client.Timeout = [TimeSpan]::FromSeconds(10)
} catch {
    Write-HelperError 'client error'
    exit 1
}

$Backoff = $PollSeconds
while ($true) {
    try {
        if ($null -eq $Config) { $Config = Read-HelperConfig }
        if ($null -eq $Client.DefaultRequestHeaders.Authorization) {
            $Client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', [string]$Config.token)
        }
        $Url = Get-NextUrl $Client $Config
        if ($Url) {
            $Copied = $false
            for ($Attempt = 1; $Attempt -le $WriteAttempts; $Attempt++) {
                try { Set-Clipboard -Value $Url; $Copied = $true; break }
                catch { if ($Attempt -lt $WriteAttempts) { Start-Sleep -Milliseconds 250 } }
            }
            if (-not $Copied) { throw 'ClipboardWriteFailed' }
        }
        $Backoff = $PollSeconds
        Start-Sleep -Seconds $PollSeconds
    } catch [System.UnauthorizedAccessException] {
        $Now = Get-Date
        if (($Now - $LastUnauthorizedLog).TotalHours -ge 1) { Write-HelperError 'unauthorized'; $LastUnauthorizedLog = $Now }
        $Config = $null
        $Client.DefaultRequestHeaders.Authorization = $null
        Start-Sleep -Seconds $Backoff
        $Backoff = [Math]::Min($MaximumBackoff, [Math]::Max($PollSeconds, $Backoff * 2))
    } catch {
        Write-HelperError 'poll or config error'
        Start-Sleep -Seconds $Backoff
        $Backoff = [Math]::Min($MaximumBackoff, [Math]::Max($PollSeconds, $Backoff * 2))
    }
}
