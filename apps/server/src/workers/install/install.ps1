<#
Install, repair or remove an Agentic platform worker on this machine (Windows, Docker Desktop).

The core serves this file at /api/worker/v1/install.ps1 with its own address filled in below
(S-22.20). Run it in PowerShell (Windows PowerShell 5.1 or PowerShell 7) with:

  powershell -ExecutionPolicy ByPass -c "irm '@@AGENTIC_CORE_URL@@/api/worker/v1/install.ps1' | iex"

Or read it before running it:

  irm '@@AGENTIC_CORE_URL@@/api/worker/v1/install.ps1' -OutFile install.ps1; notepad install.ps1
  powershell -ExecutionPolicy ByPass -File install.ps1

What it changes on this machine, and nothing else:
  - a folder, $HOME\agentic-worker by default (-Dir). It holds compose.yaml, the core's worker
    bundle, and .agentic-worker-install, this installer's mark (which core it came from);
  - the Docker containers, volumes and networks of the compose project 'agentic-worker', created by
    'docker compose up -d' in that folder. Docker Desktop keeps them running while it runs.
It needs no administrator rights, installs no service and edits no PATH or profile.

The worker's 'updater' service follows the core and verifies each build before it applies it.
Running this script again is a repair, never an upgrade. It never changes the images a worker runs,
never writes the .env file the updater manages, and never touches a volume (except
-Uninstall -Purge, which removes them).

Options: -Dir DIR, -Core URL, -NoOpen, -Uninstall, -Purge (with -Uninstall). With irm | iex, pass
them as: & ([scriptblock]::Create((irm '<core>/api/worker/v1/install.ps1'))) -Uninstall
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'An interactive installer talks to the person running it.')]
param(
  [string]$Dir = '',
  [string]$Core = '',
  [switch]$NoOpen,
  [switch]$Uninstall,
  [switch]$Purge
)

# Everything runs inside one script block, so `irm | iex` leaves no function, variable or
# preference behind in the caller's session; the options are handed to it as its own parameters,
# and the exit status is its last output.
$installerExitCode = & {
  param([string]$Dir, [string]$Core, [bool]$NoOpen, [bool]$Uninstall, [bool]$Purge)
  $ErrorActionPreference = 'Stop'

  $CoreUrl = '@@AGENTIC_CORE_URL@@'
  $Project = 'agentic-worker'
  $Mark = '.agentic-worker-install'
  $Bundle = 'compose.yaml'
  $Download = '.compose.yaml.download'
  # The updater's managed block in the project's .env (apps/server/src/updater/env-file.ts).
  $BlockBegin = '# >>> agentic-platform updater'
  $BlockEnd = '# <<< agentic-platform updater'
  $ImageVariables = @('PLATFORM_IMAGE', 'PLATFORM_LAUNCHER_IMAGE', 'PLATFORM_RUNTIME_IMAGE', 'PLATFORM_EGRESS_IMAGE')
  # The label the updater puts on its one-shot apply container (apps/server/src/updater/updater.ts).
  $ApplyLabel = 'org.platform.update-apply'
  # Removed from Compose's environment: they would change which images run, where the bundle comes
  # from or what the updater trusts. They are the updater's to set, or the bundle's defaults.
  $Scrubbed = @('COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES', 'APP_CORE_URL') + $ImageVariables + @('APP_TRUSTED_IMAGE_REPOSITORY', 'APP_TRUSTED_BUILDER')

  # Exit status: 0 done, 1 a prerequisite or a step failed, 2 a usage error, 3 refused (to protect
  # something that already exists).
  function Exit-Installer {
    param([int]$Code, [string]$Message)
    $failure = New-Object System.Exception $Message
    $failure.Data['code'] = $Code
    throw $failure
  }

  function Write-Line {
    param([string]$Text = '')
    Write-Host $Text
  }

  # One native call with the preference relaxed: Windows PowerShell 5.1 turns a native command's
  # stderr into a terminating error under 'Stop'. `-Capture` answers its stdout as one string.
  function Invoke-Native {
    param([string]$File, [string[]]$Arguments, [switch]$Capture)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      if ($Capture) {
        $output = & $File @Arguments 2>$null
        return @{ Code = $LASTEXITCODE; Output = ((@($output) | ForEach-Object { "$_" }) -join "`n") }
      }
      & $File @Arguments | Out-Host
      return @{ Code = $LASTEXITCODE; Output = '' }
    } finally {
      $ErrorActionPreference = $previous
    }
  }

  function Invoke-Compose {
    param([string[]]$Arguments)
    # Removed, not emptied: PowerShell hands a .NET string parameter '' for $null, and an empty
    # APP_TRUSTED_BUILDER would still reach Compose and switch the updater's verification off.
    $saved = @{}
    foreach ($name in $Scrubbed) {
      $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
      Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
    Push-Location -LiteralPath $WorkerDir
    try {
      return (Invoke-Native -File 'docker' -Arguments (@('compose', '--project-name', $Project) + $Arguments))
    } finally {
      Pop-Location
      foreach ($name in $Scrubbed) {
        if ($null -ne $saved[$name]) { Set-Item -LiteralPath "Env:$name" -Value $saved[$name] }
      }
    }
  }

  # The project's containers, any state, as `docker inspect` describes them (JSON: no argument
  # carries a double quote, which Windows PowerShell 5.1 does not pass to a native command intact).
  function Get-ProjectContainer {
    $ids = Invoke-Native -File 'docker' -Arguments @('ps', '--all', '--quiet', '--filter', "label=com.docker.compose.project=$Project") -Capture
    if ($ids.Code -ne 0) { Exit-Installer 1 'docker ps failed' }
    $list = @($ids.Output -split "`n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_.Trim() })
    if ($list.Count -eq 0) { return @() }
    $inspected = Invoke-Native -File 'docker' -Arguments (@('inspect', '--format', '{{json .}}') + $list) -Capture
    if ($inspected.Code -ne 0) { Exit-Installer 1 'docker inspect failed' }
    return @($inspected.Output -split "`n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_ | ConvertFrom-Json })
  }

  function Get-Label {
    param($Container, [string]$Name)
    if ($null -eq $Container.Config -or $null -eq $Container.Config.Labels) { return '' }
    $property = $Container.Config.Labels.PSObject.Properties[$Name]
    if ($null -eq $property) { return '' }
    return [string]$property.Value
  }

  # One service's state: ready, starting, unhealthy, missing, or Docker's own word (exited, ...).
  function Get-ServiceState {
    param([string]$Service)
    $container = @(Get-ProjectContainer | Where-Object { (Get-Label $_ 'com.docker.compose.service') -eq $Service }) | Select-Object -First 1
    if ($null -eq $container) { return 'missing' }
    $status = [string]$container.State.Status
    if ($status -ne 'running') { return $status }
    $health = $container.State.PSObject.Properties['Health']
    if ($null -eq $health -or $null -eq $health.Value) { return 'ready' }
    switch ([string]$health.Value.Status) {
      'healthy' { return 'ready' }
      'unhealthy' { return 'unhealthy' }
      default { return 'starting' }
    }
  }

  function Assert-NothingForeignOrBusy {
    $here = $WorkerDir.TrimEnd('\')
    $foreign = @(Get-ProjectContainer | ForEach-Object { Get-Label $_ 'com.docker.compose.project.working_dir' } |
        Where-Object { $_ -ne '' -and $_.TrimEnd('\') -ne $here } | Sort-Object -Unique)
    if ($foreign.Count -gt 0) {
      Exit-Installer 3 "a worker bundle named $Project already runs from $($foreign -join ', '). This installer will not take it over: stop it there first (docker compose down, in that folder), or keep using it."
    }
    $applying = Invoke-Native -File 'docker' -Arguments @('ps', '--quiet', '--filter', "label=$ApplyLabel=$Project") -Capture
    if ($applying.Code -ne 0) { Exit-Installer 1 'docker ps failed' }
    if ($applying.Output.Trim() -ne '') {
      Exit-Installer 3 "this worker is applying an update right now. Run this again when it has finished (cd '$WorkerDir'; docker compose logs updater)."
    }
  }

  function Assert-Docker {
    if ($null -eq (Get-Command 'docker' -CommandType Application -ErrorAction SilentlyContinue)) {
      Exit-Installer 1 'Docker is not installed. To run a worker, install Docker Desktop for Windows (https://docs.docker.com/desktop/setup/install/windows-install/), start it, and run this again.'
    }
    $info = Invoke-Native -File 'docker' -Arguments @('info', '--format', '{{.OSType}}') -Capture
    if ($info.Code -ne 0) {
      Exit-Installer 1 'Docker Desktop is installed but not running. Start it, wait until it is running, and run this again.'
    }
    if ($info.Output.Trim() -ne 'linux') {
      Exit-Installer 1 "Docker Desktop runs $($info.Output.Trim()) containers; the worker needs Linux containers. Switch Docker Desktop to Linux containers and run this again."
    }
    $version = Invoke-Native -File 'docker' -Arguments @('compose', 'version') -Capture
    if ($version.Code -ne 0) {
      Exit-Installer 1 'Docker Compose v2 is missing (docker compose version failed). Update Docker Desktop and run this again.'
    }
  }

  function Read-Text {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return [IO.File]::ReadAllText($Path)
  }

  # The image a bundle file pins for one variable: the default of its `${VAR:-<image>}`.
  function Get-DefaultPin {
    param([string]$Text, [string]$Variable)
    $found = [regex]::Match($Text, '\$\{' + $Variable + ':-([^}]*)\}')
    if ($found.Success) { return $found.Groups[1].Value }
    return ''
  }

  # The four images a bundle file pins, as one line; empty when it is not there.
  function Get-BundlePin {
    param([string]$Path)
    $text = Read-Text $Path
    if ($null -eq $text) { return '' }
    return (($ImageVariables | ForEach-Object { "$_=$(Get-DefaultPin $text $_)" }) -join ' ')
  }

  # The four images the updater's managed block pins, as one line; empty without a complete block.
  function Get-BlockPin {
    param([string]$Path)
    $text = Read-Text $Path
    if ($null -eq $text) { return '' }
    $inside = $false
    $values = @{}
    foreach ($line in ($text -split "`r?`n")) {
      if ($line.StartsWith($BlockBegin)) { $inside = $true; continue }
      if ($inside -and $line.StartsWith($BlockEnd)) { $inside = $false; continue }
      if ($inside -and $line -match '^([A-Z_]+)=(.*)$' -and -not $values.ContainsKey($Matches[1])) { $values[$Matches[1]] = $Matches[2] }
    }
    $pins = @()
    foreach ($variable in $ImageVariables) {
      if (-not $values.ContainsKey($variable) -or $values[$variable] -eq '') { return '' }
      $pins += "$variable=$($values[$variable])"
    }
    return ($pins -join ' ')
  }

  function Get-Bundle {
    $url = "$CoreAddress/api/worker/v1/compose.yml"
    $target = Join-Path $WorkerDir $Download
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $target -TimeoutSec 120
    } catch {
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
      Exit-Installer 1 "could not download the worker bundle from $url ($($_.Exception.Message)). Is the core reachable from this machine? A 503 means the core cannot name its images yet, so try again in a minute."
    }
    $text = Read-Text $target
    $problem = ''
    if ($text -notmatch '(?m)^  updater:\r?$') { $problem = 'it has no updater service, and this installer installs only workers that keep themselves up to date' }
    if ($text -match '(?m)^ *profiles:') { $problem = 'it declares compose profiles, which could leave the updater switched off' }
    foreach ($variable in $ImageVariables) {
      if ((Get-DefaultPin $text $variable) -notmatch '@sha256:') { $problem = "it does not pin $variable by digest" }
    }
    if ($problem -ne '') {
      Remove-Item -LiteralPath $target -Force
      Exit-Installer 1 "the bundle $url cannot be installed: $problem."
    }
  }

  function Get-MarkedCore {
    $text = Read-Text (Join-Path $WorkerDir $Mark)
    if ($null -eq $text) { return '' }
    $found = [regex]::Match($text, '(?m)^core=(.*?)\r?$')
    if ($found.Success) { return $found.Groups[1].Value }
    return ''
  }

  function Get-PagePort {
    $port = [Environment]::GetEnvironmentVariable('APP_WORKER_UI_PORT', 'Process')
    if ([string]::IsNullOrEmpty($port)) {
      $envText = Read-Text (Join-Path $WorkerDir '.env')
      if ($null -ne $envText) {
        $found = [regex]::Matches($envText, '(?m)^APP_WORKER_UI_PORT=(\d+)\r?$')
        if ($found.Count -gt 0) { $port = $found[$found.Count - 1].Groups[1].Value }
      }
    }
    if ($port -notmatch '^\d+$') { $port = '7357' }
    return $port
  }

  function Test-Page {
    param([string]$Page)
    try {
      $null = Invoke-WebRequest -UseBasicParsing -Uri $Page -TimeoutSec 3
      return $true
    } catch {
      return $false
    }
  }

  function Wait-Worker {
    param([string]$Page)
    Write-Line "Waiting for the worker, its updater and its page (up to $WaitLimit s) ..."
    $waited = 0
    while ($true) {
      $worker = Get-ServiceState 'remote-worker'
      $updater = Get-ServiceState 'updater'
      $pageState = 'waiting'
      if (Test-Page $Page) { $pageState = 'ready' }
      if ($worker -eq 'ready' -and $updater -eq 'ready' -and $pageState -eq 'ready') { return }
      if ($waited -ge $WaitLimit) {
        Exit-Installer 1 "the worker did not come up within $WaitLimit s (worker: $worker, updater: $updater, page ${Page}: $pageState). See what it says: cd '$WorkerDir'; docker compose logs --tail 50"
      }
      Start-Sleep -Seconds 2
      $waited += 2
    }
  }

  function Install-Worker {
    Assert-Docker
    if ((Test-Path -LiteralPath $WorkerDir) -and -not (Test-Path -LiteralPath $WorkerDir -PathType Container)) {
      Exit-Installer 3 "$WorkerDir exists and is not a folder; pass another with -Dir"
    }
    $markPath = Join-Path $WorkerDir $Mark
    if ((Test-Path -LiteralPath $WorkerDir -PathType Container) -and -not (Test-Path -LiteralPath $markPath) -and
      @(Get-ChildItem -LiteralPath $WorkerDir -Force).Count -gt 0) {
      Exit-Installer 3 "$WorkerDir exists and was not made by this installer (it has no $Mark). Pass another folder with -Dir. A worker you set up there by hand keeps itself up to date; keep running it with docker compose in that folder."
    }
    if (Test-Path -LiteralPath $markPath) {
      $previous = Get-MarkedCore
      if ($previous -ne '' -and $previous -ne $CoreAddress) {
        Exit-Installer 3 "this worker was installed from $previous, not $CoreAddress. To move it, remove it first (-Uninstall -Purge) and install again."
      }
    }
    Assert-NothingForeignOrBusy

    $null = New-Item -ItemType Directory -Force -Path $WorkerDir
    Get-Bundle
    [IO.File]::WriteAllText($markPath, "# Written by the Agentic platform worker installer (install.ps1, S-22.20). Do not edit.`ncore=$CoreAddress`n")
    $downloaded = Join-Path $WorkerDir $Download
    $bundlePath = Join-Path $WorkerDir $Bundle
    $served = Get-BundlePin $downloaded
    $current = Get-BlockPin (Join-Path $WorkerDir '.env')
    if ($current -eq '') { $current = Get-BundlePin $bundlePath }
    $existing = @(Get-ProjectContainer).Count -gt 0

    if (-not $existing -and ($current -eq '' -or $current -eq $served)) {
      Move-Item -LiteralPath $downloaded -Destination $bundlePath -Force
      Write-Line "Starting the worker in $WorkerDir ..."
      if ((Invoke-Compose @('up', '-d')).Code -ne 0) { Exit-Installer 1 'docker compose up failed (see above). Fix what it names and run this again.' }
    } elseif ($existing) {
      if ($current -eq $served) {
        Move-Item -LiteralPath $downloaded -Destination $bundlePath -Force
      } else {
        Remove-Item -LiteralPath $downloaded -Force
        Write-Line 'This worker runs another build than the core serves now. Its updater moves it there after verifying the build;'
        Write-Line 'this installer never changes the images a worker runs.'
        if (-not (Test-Path -LiteralPath $bundlePath)) { Exit-Installer 3 "$bundlePath is missing, so this installer cannot restart the worker." }
      }
      Write-Line "The worker is already installed in $WorkerDir; starting whatever of it is stopped (nothing is recreated) ..."
      if ((Invoke-Compose @('start')).Code -ne 0) { Exit-Installer 1 'docker compose start failed (see above).' }
    } else {
      Remove-Item -LiteralPath $downloaded -Force
      Exit-Installer 3 "nothing of this worker is in Docker, and its folder pins another build than the core serves now. Installing the core's would bypass the updater's checks. Start it as it was (cd '$WorkerDir'; docker compose up -d) and its updater moves it forward, or remove it (-Uninstall -Purge) and install again."
    }

    $page = "http://127.0.0.1:$(Get-PagePort)"
    Wait-Worker $page
    Write-Line ''
    Write-Line 'The worker is running.'
    $opened = $false
    if ($OpenPage) {
      try { Start-Process $page; $opened = $true } catch { $opened = $false }
    }
    if ($opened) { Write-Line "  Its page:   $page (opened in your browser)" } else { Write-Line "  Its page:   $page (open it in a browser)" }
    Write-Line '              Sign in to Claude and approve this machine there. If the page asks for a token:'
    Write-Line "              cd '$WorkerDir'; docker compose logs remote-worker | Select-String token="
    Write-Line "  Its folder: $WorkerDir"
    Write-Line "  Updates:    its updater follows $CoreAddress; you never run this again to update."
    Write-Line '  Remove it:  run this script again with -Uninstall (add -Purge to remove its data too)'
    Write-Line ''
    Write-Line 'On Windows, the updater cannot apply an update from a Windows folder yet (backlog 990): it'
    Write-Line 'reports each one it cannot apply to the core, and keeps the worker running as it is.'
  }

  function Uninstall-Worker {
    Assert-Docker
    if (-not (Test-Path -LiteralPath $WorkerDir -PathType Container)) { Exit-Installer 3 "nothing to remove: $WorkerDir does not exist" }
    if (-not (Test-Path -LiteralPath (Join-Path $WorkerDir $Mark))) {
      Exit-Installer 3 "$WorkerDir was not made by this installer (it has no $Mark); remove that worker yourself (docker compose down, in that folder)."
    }
    Assert-NothingForeignOrBusy
    if (-not (Test-Path -LiteralPath (Join-Path $WorkerDir $Bundle))) { Exit-Installer 3 "$WorkerDir\$Bundle is missing, so this installer cannot tell Compose what to remove." }
    if ($Purge) {
      if ((Invoke-Compose @('down', '--volumes')).Code -ne 0) { Exit-Installer 1 'docker compose down failed (see above).' }
      foreach ($name in @($Bundle, $Download, '.env', '.env.previous', $Mark)) {
        $path = Join-Path $WorkerDir $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
      }
      if (@(Get-ChildItem -LiteralPath $WorkerDir -Force).Count -eq 0) {
        Remove-Item -LiteralPath $WorkerDir -Force
        Write-Line "Removed the worker, its volumes and $WorkerDir."
      } else {
        Write-Line "Removed the worker and its volumes. Kept ${WorkerDir}: it holds files this installer did not write."
      }
    } else {
      if ((Invoke-Compose @('down')).Code -ne 0) { Exit-Installer 1 'docker compose down failed (see above).' }
      Write-Line "Removed the worker's containers. Kept its volumes (its approval, its Claude sign-in) and ${WorkerDir}:"
      Write-Line 'run this script again to start it as it was, or with -Uninstall -Purge to remove them.'
    }
    Write-Line 'Its images stay in Docker; docker image prune -a removes the ones nothing uses.'
  }

  try {
    if ($Purge -and -not $Uninstall) { Exit-Installer 2 '-Purge goes with -Uninstall' }
    $OpenPage = -not $NoOpen
    $CoreAddress = $CoreUrl
    if ($Core -ne '') { $CoreAddress = $Core }
    if ($CoreAddress.StartsWith('@@')) { Exit-Installer 2 'this copy of the script was not served by a core; pass -Core https://<your core>' }
    $CoreAddress = $CoreAddress.TrimEnd('/')
    if ($CoreAddress -notmatch '^https?://.') { Exit-Installer 2 "the core's address must start with https:// (or http://): $CoreAddress" }
    if ($CoreAddress -notmatch '^[-A-Za-z0-9.:/_~%]+$') { Exit-Installer 2 "the core's address has a character this installer does not accept: $CoreAddress" }

    $WorkerDir = $Dir
    if ($WorkerDir -eq '') { $WorkerDir = Join-Path $HOME 'agentic-worker' }
    if (-not [IO.Path]::IsPathRooted($WorkerDir)) { $WorkerDir = Join-Path (Get-Location).ProviderPath $WorkerDir }
    $WorkerDir = [IO.Path]::GetFullPath($WorkerDir).TrimEnd('\', '/')

    $WaitLimit = 300
    $waitSetting = [Environment]::GetEnvironmentVariable('AGENTIC_INSTALL_WAIT_SECONDS', 'Process')
    if (-not [string]::IsNullOrEmpty($waitSetting)) {
      if ($waitSetting -notmatch '^\d+$') { Exit-Installer 2 'AGENTIC_INSTALL_WAIT_SECONDS must be a whole number of seconds' }
      $WaitLimit = [int]$waitSetting
    }

    # Windows PowerShell 5.1 may not offer TLS 1.2 by default.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if ($Uninstall) { Uninstall-Worker } else { Install-Worker }
    0
  } catch {
    $code = $_.Exception.Data['code']
    if ($null -eq $code) { $code = 1 }
    Write-Host "agentic-worker: $($_.Exception.Message)" -ForegroundColor Red
    $code
  }
} -Dir $Dir -Core $Core -NoOpen ([bool]$NoOpen) -Uninstall ([bool]$Uninstall) -Purge ([bool]$Purge) | Select-Object -Last 1

if ($PSCommandPath) { exit $installerExitCode }
