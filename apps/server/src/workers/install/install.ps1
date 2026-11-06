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
Running this script again is a repair, never an upgrade. It never changes the images an approved
worker runs, never writes inside the block of .env the updater manages, and never touches a volume
(except -Uninstall -Purge, which removes them). A worker that is not set up yet (its page waits for
a platform, its Claude sign-in or its approval) runs nothing worth keeping, so a re-run installs the
core's build over it.

A setting the bundle declares with a default (APP_WORKER_UI_PORT, LOG_LEVEL, ...) that is set in
this session ($env:NAME) is saved into the folder's .env, outside the updater's block, before the
first 'docker compose up': the updater carries into a new build only values with no default, so one
given in the session alone would go back to its default at the next update. Secret-looking names,
the image and trust variables, and anything the bundle does not declare are never written.

Options: -Dir DIR, -Core URL, -NoOpen, -Uninstall, -Purge (with -Uninstall). With irm | iex, pass
them as: & ([scriptblock]::Create((irm '<core>/api/worker/v1/install.ps1'))) -Uninstall
#>
# Everything runs inside one script block, its options included, so `irm | iex` leaves no function,
# variable or preference behind in the caller's session: the script has no parameters of its own and
# hands what it was given (`@args`) to the block, and the block's exit status goes straight to `exit`
# when this is a file run, and nowhere when it is not.
& {
  param(
    [string]$Dir = '',
    [string]$Core = '',
    [switch]$NoOpen,
    [switch]$Uninstall,
    [switch]$Purge
  )
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
  # Where the updater mounts this folder; after its first update Compose's working_dir label names it.
  $UpdaterFolder = '/var/lib/platform/host-bundle'
  # Removed from Compose's environment: they would change which images run, where the bundle comes
  # from or what the updater trusts. They are the updater's to set, or the bundle's defaults.
  # Declared with a default in the bundle but never saved into .env: the four images and the git
  # image (the bundle's pins, which a saved line would hold past every update), what the updater
  # trusts, the core's address, and the folder the updater mounts (the updater answers it itself).
  # Held to the template by install-script.test.ts.
  $NotSaved = @('PLATFORM_IMAGE', 'PLATFORM_LAUNCHER_IMAGE', 'PLATFORM_RUNTIME_IMAGE', 'PLATFORM_EGRESS_IMAGE', 'APP_WORKSPACE_GIT_IMAGE', 'APP_TRUSTED_IMAGE_REPOSITORY', 'APP_TRUSTED_BUILDER', 'APP_CORE_URL', 'APP_WORKER_BUNDLE_DIR')
  # The label the launcher puts on the volumes it creates: the control volume of the launcher that
  # made it (packages/application/src/ports/workspace.ts, WORKSPACE_LABELS.instance).
  $InstanceLabel = 'com.agentic.instance'
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
    # The host directly, not the pipeline: the block's only pipeline output is its exit status.
    $Host.UI.WriteLine($Text)
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
    # Removed with Remove-Item Env:, not through SetEnvironmentVariable: on the Windows runner that
    # left each one defined and empty (measured, S-22.20), and an APP_TRUSTED_BUILDER that is set but
    # empty would reach Compose and switch the updater's verification off.
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

  # This installer's install is the folder with its mark (TD-032's 2026-11-05 decision-4
  # amendment), never what a label says: a folder without the mark is a new install, so any project of
  # the name on this machine is someone else's; a marked folder's project is ours, unless the label
  # names another host folder outright. After the updater's first update the label names its own
  # mount path, which is ours.
  function Assert-NothingForeignOrBusy {
    $here = $WorkerDir.TrimEnd('\')
    $containers = @(Get-ProjectContainer)
    $foreign = @($containers | ForEach-Object { Get-Label $_ 'com.docker.compose.project.working_dir' } |
        Where-Object { $_ -ne '' -and $_.TrimEnd('\') -ne $here -and $_ -ne $UpdaterFolder } | Sort-Object -Unique)
    if ($foreign.Count -gt 0) {
      Exit-Installer 3 "a worker bundle named $Project already runs from $($foreign -join ', '). This installer will not take it over: stop it there first (docker compose down, in that folder), or keep using it."
    }
    if ($containers.Count -gt 0 -and -not (Test-Path -LiteralPath (Join-Path $WorkerDir $Mark))) {
      Exit-Installer 3 "a worker bundle named $Project already exists on this machine, and $WorkerDir is not this installer's (it has no $Mark). This installer will not take it over: run it with -Dir pointing at that bundle's folder, or remove that bundle first."
    }
    Assert-NotApplying
  }

  # The updater's one-shot apply container is running: it rewrites this folder's files.
  function Assert-NotApplying {
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

  # --- Settings given in this session (BACKLOG 1055) ---

  # Every variable a bundle text declares with a non-empty default (`${VAR:-x}`), comments aside.
  function Get-DefaultedVariable {
    param([string]$Text)
    $names = @()
    foreach ($line in ($Text -split "`r?`n")) {
      if ($line -match '^\s*#') { continue }
      foreach ($found in [regex]::Matches($line, '\$\{([A-Z][A-Z0-9_]*):-[^}]')) { $names += $found.Groups[1].Value }
    }
    return @($names | Sort-Object -Unique)
  }

  # The value .env sets for a variable outside the updater's block (the last line wins), or '':
  # `NAME=value`, `export NAME=value`, with the value bare, 'single' or "double" quoted.
  function Get-EnvFileValue {
    param([string]$Name)
    $text = Read-Text (Join-Path $WorkerDir '.env')
    if ($null -eq $text) { return '' }
    $inside = $false
    $value = ''
    foreach ($line in ($text -split "`r?`n")) {
      if ($inside) {
        if ($line.StartsWith($BlockEnd)) { $inside = $false }
        continue
      }
      if ($line.StartsWith($BlockBegin)) { $inside = $true; continue }
      $found = [regex]::Match($line, '^\s*(?:export\s+)?' + [regex]::Escape($Name) + '\s*=\s*(.*?)\s*\z')
      if ($found.Success) { $value = $found.Groups[1].Value }
    }
    if ($value -match '^''(.*)''\z' -or $value -match '^"(.*)"\z') { $value = $Matches[1] }
    return $value
  }

  # The name a variable resolves to for Compose: this session, else .env, else the bundle's default.
  function Get-ResolvedValue {
    param([string]$Name, [string]$BundleText)
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrEmpty($value)) { $value = Get-EnvFileValue $Name }
    if ([string]::IsNullOrEmpty($value)) { $value = Get-DefaultPin $BundleText $Name }
    return $value
  }

  # Writes the settings of this session into .env (BACKLOG 1055), before the first
  # `docker compose up`: an earlier line of the same name outside the updater's block is replaced
  # where it stands (a later duplicate dropped), a new one appended; the updater's block is copied as
  # it is. Says in one line what it saved.
  function Save-ShellSetting {
    $names = @()
    foreach ($variable in (Get-DefaultedVariable (Read-Text (Join-Path $WorkerDir $Download)))) {
      if ($NotSaved -ccontains $variable) { continue }
      if ($variable -cmatch 'TOKEN|SECRET|PASSWORD|PASSWD|KEY|DSN|CREDENTIAL|PRIVATE') { continue }
      $value = [Environment]::GetEnvironmentVariable($variable, 'Process')
      if ([string]::IsNullOrEmpty($value)) { continue }
      if ($value -cnotmatch '^[A-Za-z0-9_.:/@%+,=-]+\z') {
        $Host.UI.WriteErrorLine("agentic-worker: did not save ${variable}: its value has a character this installer does not write into .env; add it to $WorkerDir\.env yourself, or it goes back to its default at the next update.")
        continue
      }
      $names += $variable
    }
    if ($names.Count -eq 0) { return }
    # The updater rewrites .env when it applies an update, so the file is read only now, with no
    # apply running, and the write is refused when it changed (or an apply started) meanwhile: moving
    # a stale copy into place would put back the managed block it had just replaced.
    Assert-NotApplying
    $path = Join-Path $WorkerDir '.env'
    $text = Read-Text $path
    $lines = New-Object System.Collections.Generic.List[string]
    $written = @{}
    if (-not [string]::IsNullOrEmpty($text)) {
      $inside = $false
      foreach ($line in (($text -replace '\r?\n$', '') -split '\r?\n')) {
        if ($inside) {
          $lines.Add($line)
          if ($line.StartsWith($BlockEnd)) { $inside = $false }
          continue
        }
        if ($line.StartsWith($BlockBegin)) { $inside = $true; $lines.Add($line); continue }
        if ($line -cmatch '^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=' -and $names -ccontains $Matches[2]) {
          $name = $Matches[2]
          if (-not $written.ContainsKey($name)) {
            $lines.Add("$name=$([Environment]::GetEnvironmentVariable($name, 'Process'))")
            $written[$name] = $true
          }
          continue
        }
        $lines.Add($line)
      }
    }
    foreach ($name in $names) {
      if (-not $written.ContainsKey($name)) { $lines.Add("$name=$([Environment]::GetEnvironmentVariable($name, 'Process'))") }
    }
    $next = Join-Path $WorkerDir '.env.installer'
    [IO.File]::WriteAllText($next, (($lines -join "`n") + "`n"))
    if ((Read-Text $path) -cne $text) {
      Remove-Item -LiteralPath $next -Force
      Exit-Installer 3 "$path changed while this installer was saving settings into it (the updater applying an update?). Run this again."
    }
    try { Assert-NotApplying } catch { Remove-Item -LiteralPath $next -Force; throw }
    Move-Item -LiteralPath $next -Destination $path -Force
    $note = ''
    if (@(Get-ProjectContainer).Count -gt 0) { $note = ' (a worker already running takes a changed one at its next update)' }
    Write-Line "Saved in $path, so its updates keep them: $($names -join ' ')$note"
  }

  # --- Another worker's names (BACKLOG 1056) ---

  # One label of a Docker volume or network, read off `{{json .Labels}}`; '' when the object does not
  # exist (or Docker does not answer) or has no such label.
  function Get-ObjectLabel {
    param([string]$Kind, [string]$Name, [string]$Label)
    if ($Name -eq '') { return '' }
    $inspected = Invoke-Native -File 'docker' -Arguments @($Kind, 'inspect', '--format', '{{json .Labels}}', $Name) -Capture
    if ($inspected.Code -ne 0 -or $inspected.Output.Trim() -eq '') { return '' }
    try { $labels = $inspected.Output | ConvertFrom-Json } catch { return '' }
    if ($null -eq $labels) { return '' }
    $property = $labels.PSObject.Properties[$Label]
    if ($null -eq $property) { return '' }
    return [string]$property.Value
  }

  # Refuses, before anything is created, a worker whose control volume, run network or repository
  # cache resolves to a name another worker on this machine already holds: Compose labels the volume
  # and the network with the project that created them, and the launcher labels the cache with its own
  # control volume. What it cannot see: an object of that name nobody labelled, and a cache another
  # worker is configured with but has not created yet (no run yet).
  function Assert-NoSharedName {
    param([bool]$MadeDir)
    $bundleText = Read-Text (Join-Path $WorkerDir $Download)
    $control = Get-ResolvedValue 'APP_WORKER_CONTROL_VOLUME' $bundleText
    $network = Get-ResolvedValue 'APP_WORKER_RUN_NETWORK' $bundleText
    $cache = Get-ResolvedValue 'APP_WORKER_CACHE_VOLUME' $bundleText
    $shared = ''
    $owner = Get-ObjectLabel 'volume' $control 'com.docker.compose.project'
    if ($owner -ne '' -and $owner -ne $Project) {
      $shared = "the compose project $owner already uses the volume $control, so set APP_WORKER_CONTROL_VOLUME"
    }
    $owner = Get-ObjectLabel 'network' $network 'com.docker.compose.project'
    if ($shared -eq '' -and $owner -ne '' -and $owner -ne $Project) {
      $shared = "the compose project $owner already uses the network $network, so set APP_WORKER_RUN_NETWORK"
    }
    $maker = Get-ObjectLabel 'volume' $cache $InstanceLabel
    if ($shared -eq '' -and $maker -ne '' -and $maker -ne $control) {
      $shared = "the worker whose control volume is $maker already uses the repository cache $cache, so set APP_WORKER_CACHE_VOLUME"
    }
    if ($shared -eq '') { return }
    Remove-Item -LiteralPath (Join-Path $WorkerDir $Download) -Force -ErrorAction SilentlyContinue
    if ($MadeDir -and @(Get-ChildItem -LiteralPath $WorkerDir -Force).Count -eq 0) { Remove-Item -LiteralPath $WorkerDir -Force }
    Exit-Installer 3 "another worker runs on this machine: $shared to a name of its own in this session (the installer saves it in .env) and run this again."
  }

  # The host port the running remote-worker publishes its page on, or '' (not running yet). A
  # setting saved into .env by a re-run reaches the container only at its next update, so this, not
  # the setting, is where the page is.
  function Get-PublishedPort {
    $container = @(Get-ProjectContainer | Where-Object { (Get-Label $_ 'com.docker.compose.service') -eq 'remote-worker' -and [string]$_.State.Status -eq 'running' }) | Select-Object -First 1
    if ($null -eq $container -or $null -eq $container.NetworkSettings -or $null -eq $container.NetworkSettings.Ports) { return '' }
    $binding = $container.NetworkSettings.Ports.PSObject.Properties['7357/tcp']
    if ($null -eq $binding -or $null -eq $binding.Value) { return '' }
    $port = [string](@($binding.Value)[0].HostPort)
    if ($port -match '^\d+\z') { return $port }
    return ''
  }

  # The page's port: what the running worker publishes, else this session, else .env, else the default.
  function Get-PagePort {
    $port = Get-PublishedPort
    if ([string]::IsNullOrEmpty($port)) { $port = [Environment]::GetEnvironmentVariable('APP_WORKER_UI_PORT', 'Process') }
    if ([string]::IsNullOrEmpty($port)) { $port = Get-EnvFileValue 'APP_WORKER_UI_PORT' }
    if ($port -notmatch '^\d+\z') { $port = '7357' }
    return $port
  }

  # The launcher's repository cache volume: APP_WORKER_CACHE_VOLUME (this session, else .env), or
  # the bundle's default.
  function Get-CacheVolume {
    $volume = [Environment]::GetEnvironmentVariable('APP_WORKER_CACHE_VOLUME', 'Process')
    if ([string]::IsNullOrEmpty($volume)) { $volume = Get-EnvFileValue 'APP_WORKER_CACHE_VOLUME' }
    if ($volume -notmatch '^[A-Za-z0-9_.-]+\z') { $volume = 'agentic-worker-repo-cache' }
    return $volume
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

  # Whether the worker holds a credential yet, read off its page's state. 'not_set_up': its
  # `connection` waits for a platform, its Claude sign-in or its device approval. 'unknown': the page
  # does not answer at all (a stopped worker). 'set_up': anything else, an HTTP refusal included (a
  # token, APP_WORKER_UI_AUTH=token), so the caller keeps the cautious path. Only that one field is
  # read, and nothing of the answer is printed.
  function Get-SetUpState {
    try {
      $answer = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$(Get-PagePort)/api/local/state" -TimeoutSec 3
      # PowerShell 7 answers a body it does not take for text as bytes.
      $content = $answer.Content
      if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
      $connection = [string]($content | ConvertFrom-Json).connection
    } catch {
      # An HTTP answer (a refusal) carries a response; a page that does not answer carries none.
      $response = $_.Exception.PSObject.Properties['Response']
      if ($null -ne $response -and $null -ne $response.Value) { return 'set_up' }
      return 'unknown'
    }
    if (@('needs_platform', 'needs_claude', 'logging_in') -contains $connection) { return 'not_set_up' }
    return 'set_up'
  }

  # The served bundle over a worker that is not set up yet: it runs nothing worth keeping.
  function Install-Served {
    param([string]$Downloaded, [string]$BundlePath)
    Move-Item -LiteralPath $Downloaded -Destination $BundlePath -Force
    Write-Line "This worker runs another build than the core serves now and is not set up yet, so updating it loses nothing: installing the core's build in $WorkerDir ..."
    if ((Invoke-Compose @('up', '-d')).Code -ne 0) { Exit-Installer 1 'docker compose up failed (see above). Fix what it names and run this again.' }
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

    $madeDir = -not (Test-Path -LiteralPath $WorkerDir -PathType Container)
    $null = New-Item -ItemType Directory -Force -Path $WorkerDir
    Get-Bundle
    Assert-NoSharedName $madeDir
    [IO.File]::WriteAllText($markPath, "# Written by the Agentic platform worker installer (install.ps1, S-22.20). Do not edit.`ncore=$CoreAddress`n")
    Save-ShellSetting
    $downloaded = Join-Path $WorkerDir $Download
    $bundlePath = Join-Path $WorkerDir $Bundle
    $served = Get-BundlePin $downloaded
    $current = Get-BlockPin (Join-Path $WorkerDir '.env')
    if ($current -eq '') { $current = Get-BundlePin $bundlePath }
    $existing = @(Get-ProjectContainer).Count -gt 0
    # Asked only of a worker on another build that the updater never moved (no managed block).
    $setup = 'set_up'
    if ($existing -and $current -ne $served -and (Get-BlockPin (Join-Path $WorkerDir '.env')) -eq '') { $setup = Get-SetUpState }

    if (-not $existing -and ($current -eq '' -or $current -eq $served)) {
      Move-Item -LiteralPath $downloaded -Destination $bundlePath -Force
      Write-Line "Starting the worker in $WorkerDir ..."
      if ((Invoke-Compose @('up', '-d')).Code -ne 0) { Exit-Installer 1 'docker compose up failed (see above). Fix what it names and run this again.' }
    } elseif ($existing -and $current -eq $served) {
      # The same build: create what is missing (a removed updater too), start what is stopped, and
      # recreate nothing.
      Move-Item -LiteralPath $downloaded -Destination $bundlePath -Force
      Write-Line "The worker is already installed in $WorkerDir; starting what is stopped and adding what is missing (nothing is recreated) ..."
      if ((Invoke-Compose @('up', '-d', '--no-recreate')).Code -ne 0) { Exit-Installer 1 'docker compose up failed (see above).' }
    } elseif ($setup -eq 'not_set_up') {
      Install-Served $downloaded $bundlePath
    } elseif ($existing) {
      $started = $false
      if ($setup -eq 'unknown' -and (Test-Path -LiteralPath $bundlePath)) {
        # A stopped worker's page answers nothing: start it, and ask again once the page answers.
        Write-Line 'Starting whatever of it is stopped (nothing is recreated) ...'
        if ((Invoke-Compose @('start')).Code -ne 0) {
          Remove-Item -LiteralPath $downloaded -Force
          Exit-Installer 1 'docker compose start failed (see above).'
        }
        $started = $true
        $waited = 0
        while ($true) {
          $setup = Get-SetUpState
          if ($setup -ne 'unknown' -or $waited -ge $WaitLimit) { break }
          Start-Sleep -Seconds 2
          $waited += 2
        }
      }
      if ($setup -eq 'not_set_up') {
        Install-Served $downloaded $bundlePath
      } else {
        Remove-Item -LiteralPath $downloaded -Force
        Write-Line 'This worker runs another build than the core serves now. Its updater moves it there after verifying the build;'
        Write-Line 'this installer never changes the images a worker runs.'
        if (-not $started) {
          if (-not (Test-Path -LiteralPath $bundlePath)) { Exit-Installer 3 "$bundlePath is missing, so this installer cannot restart the worker." }
          Write-Line 'Starting whatever of it is stopped (nothing is recreated) ...'
          if ((Invoke-Compose @('start')).Code -ne 0) { Exit-Installer 1 'docker compose start failed (see above).' }
        }
      }
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
    Write-Line "  Updates:    automatic. Its updater follows $CoreAddress; you never run this again to update."

    Write-Line '  Remove it:  run this script again with -Uninstall (add -Purge to remove its data too)'
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
      $cache = Get-CacheVolume
      if ((Invoke-Compose @('down', '--volumes', '--remove-orphans')).Code -ne 0) { Exit-Installer 1 'docker compose down failed (see above).' }
      # The launcher's repository cache (cloned source) is the launcher's volume, not Compose's.
      if ((Invoke-Native -File 'docker' -Arguments @('volume', 'inspect', $cache) -Capture).Code -eq 0) {
        if ((Invoke-Native -File 'docker' -Arguments @('volume', 'rm', $cache) -Capture).Code -ne 0) {
          Write-Line "Kept the volume $cache (still in use?); remove it with: docker volume rm $cache"
        }
      }
      foreach ($name in @($Bundle, $Download, '.env', '.env.previous', $Mark)) {
        $path = Join-Path $WorkerDir $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
      }
      if (@(Get-ChildItem -LiteralPath $WorkerDir -Force).Count -eq 0) {
        Remove-Item -LiteralPath $WorkerDir -Force
        Write-Line "Removed the worker, its volumes, its repository cache and $WorkerDir."
      } else {
        Write-Line "Removed the worker, its volumes and its repository cache. Kept ${WorkerDir}: it holds files this installer did not write."
      }
    } else {
      if ((Invoke-Compose @('down', '--remove-orphans')).Code -ne 0) { Exit-Installer 1 'docker compose down failed (see above).' }
      Write-Line "Removed the worker's containers. Kept its volumes (its approval, its Claude sign-in) and $WorkerDir."
      Write-Line "To start it again as it was: cd '$WorkerDir'; docker compose up -d (its updater then follows the core)."
      Write-Line 'To remove the rest: run this script again with -Uninstall -Purge.'
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
    $Host.UI.WriteErrorLine("agentic-worker: $($_.Exception.Message)")
    $code
  }
} @args | Select-Object -Last 1 | ForEach-Object { if ($PSCommandPath) { exit $_ } }
