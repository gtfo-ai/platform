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

One worker per core on one machine (S-29.2, TD-031's 2026-11-24 amendment, decision 9). Every run
first looks for this core's install - a folder whose mark names this core - in -Dir, then in
the home folder's agentic-worker, then $HOME\agentic-worker-<-Name>, then every $HOME\agentic-worker-* and every
folder an 'updater' container mounts, and repairs the first it finds. With none, a new install goes
to $HOME\agentic-worker as project 'agentic-worker' (today's install) unless another worker already
has that folder or project; then, or with -Name <n>, it goes to $HOME\agentic-worker-<n> as project
'agentic-worker-<n>', <n> being -Name or this platform's name as the core that served this copy
renders it ($PlatformSlug below). Such a named install writes into its .env, outside the updater's
block: COMPOSE_PROJECT_NAME (so a 'docker compose up' in the folder is the same project), its own
control volume, repository cache volume and run network, the first page port from 7357 up that
nothing listens on and no container (stopped ones too) has bound, and, from -Name, APP_WORKER_LABEL.
No install is ever renamed: -Name on an existing install sets its label only. $HOME here is
%USERPROFILE%.

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

Options: -Name NAME (1 to 24 of a-z, 0-9 and -, starting with a letter or digit; not dev), -Dir DIR,
-Core URL, -NoOpen, -Uninstall, -Purge (with -Uninstall). APP_WORKER_LABEL (any text but ' and \ and
control characters) is saved as the page's label. With irm | iex, pass them as:
& ([scriptblock]::Create((irm '<core>/api/worker/v1/install.ps1'))) -Uninstall
#>
# Everything runs inside one script block, its options included, so `irm | iex` leaves no function,
# variable or preference behind in the caller's session: the script has no parameters of its own and
# hands what it was given (`@args`) to the block, and the block's exit status goes straight to `exit`
# when this is a file run, and nowhere when it is not.
& {
  param(
    [string]$Name = '',
    [string]$Dir = '',
    [string]$Core = '',
    [switch]$NoOpen,
    [switch]$Uninstall,
    [switch]$Purge
  )
  $ErrorActionPreference = 'Stop'

  $CoreUrl = '@@AGENTIC_CORE_URL@@'
  # This platform's name as an install name (S-29.2): the core renders it, '' when it has none.
  $PlatformSlug = '@@AGENTIC_PLATFORM_SLUG@@'
  # The project of today's single install; a named one is agentic-worker-<name>.
  $DefaultProject = 'agentic-worker'
  # The install's project, set once the run has resolved which install it is.
  $Project = $DefaultProject
  # What an install name is, and the ones no install takes: pnpm worker:dev owns agentic-worker-dev.
  $NamePattern = '^[a-z0-9][a-z0-9-]{0,23}\z'
  $ReservedNames = @('dev')
  # The page's label: free text the bundle declares with an empty default, saved single-quoted.
  $LabelVariable = 'APP_WORKER_LABEL'
  # The page's default port, and how far up a named install looks for a free one.
  $FirstPagePort = 7357
  $PagePortSearch = 100
  # What a new named install writes into its .env (S-29.2), filled in by Resolve-Install.
  $Planned = @{}
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

  # One warning line, on the error stream as install.sh's.
  function Write-Problem {
    param([string]$Text)
    $Host.UI.WriteErrorLine("agentic-worker: $Text")
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

  # The ids of the containers, any state, that carry every label filter given (none: all of them).
  function Get-ContainerId {
    param([string[]]$Filter = @())
    $arguments = @('ps', '--all', '--quiet')
    foreach ($label in $Filter) { $arguments += @('--filter', $label) }
    $ids = Invoke-Native -File 'docker' -Arguments $arguments -Capture
    if ($ids.Code -ne 0) { Exit-Installer 1 'docker ps failed' }
    return @($ids.Output -split "`n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_.Trim() })
  }

  # The project's containers, any state, as `docker inspect` describes them (JSON: no argument
  # carries a double quote, which Windows PowerShell 5.1 does not pass to a native command intact).
  function Get-ProjectContainer {
    $list = @(Get-ContainerId @("label=com.docker.compose.project=$Project"))
    if ($list.Count -eq 0) { return @() }
    $inspected = Invoke-Native -File 'docker' -Arguments (@('inspect', '--format', '{{json .}}') + $list) -Capture
    if ($inspected.Code -ne 0) { Exit-Installer 1 'docker inspect failed' }
    return @($inspected.Output -split "`n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_ | ConvertFrom-Json })
  }

  function Get-Label {
    param($Container, [string]$LabelName)
    if ($null -eq $Container.Config -or $null -eq $Container.Config.Labels) { return '' }
    $property = $Container.Config.Labels.PSObject.Properties[$LabelName]
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
      Exit-Installer 3 "a worker bundle named $Project already runs from $($foreign -join ', '). This installer will not take it over: stop it there first (docker compose down, in that folder), keep using it, or install this core's worker beside it with -Name <name>."
    }
    if ($containers.Count -gt 0 -and -not (Test-Path -LiteralPath (Join-Path $WorkerDir $Mark))) {
      Exit-Installer 3 "a worker bundle named $Project already exists on this machine, and $WorkerDir is not this installer's (it has no $Mark). This installer will not take it over: run it with -Dir pointing at that bundle's folder, remove that bundle first, or install this core's worker beside it with -Name <name>."
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
    return (Get-MarkedCoreIn $WorkerDir)
  }

  # The core a folder's mark names, or ''.
  function Get-MarkedCoreIn {
    param([string]$Folder)
    $text = Read-Text (Join-Path $Folder $Mark)
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
    param([string]$Variable)
    return (Get-EnvFileValueIn $WorkerDir $Variable)
  }

  # The same, of another folder's .env.
  function Get-EnvFileValueIn {
    param([string]$Folder, [string]$Variable)
    $text = Read-Text (Join-Path $Folder '.env')
    if ($null -eq $text) { return '' }
    $inside = $false
    $value = ''
    foreach ($line in ($text -split "`r?`n")) {
      if ($inside) {
        if ($line.StartsWith($BlockEnd)) { $inside = $false }
        continue
      }
      if ($line.StartsWith($BlockBegin)) { $inside = $true; continue }
      $found = [regex]::Match($line, '^\s*(?:export\s+)?' + [regex]::Escape($Variable) + '\s*=\s*(.*?)\s*\z')
      if ($found.Success) { $value = $found.Groups[1].Value }
    }
    if ($value -match '^''(.*)''\z' -or $value -match '^"(.*)"\z') { $value = $Matches[1] }
    return $value
  }

  # The name a variable resolves to for Compose: this session, else what a new named install plans
  # for it, else .env, else the bundle's default.
  function Get-ResolvedValue {
    param([string]$Variable, [string]$BundleText)
    $value = [Environment]::GetEnvironmentVariable($Variable, 'Process')
    if ([string]::IsNullOrEmpty($value) -and $Planned.ContainsKey($Variable)) { $value = $Planned[$Variable] }
    if ([string]::IsNullOrEmpty($value)) { $value = Get-EnvFileValue $Variable }
    if ([string]::IsNullOrEmpty($value)) { $value = Get-DefaultPin $BundleText $Variable }
    return $value
  }

  # `NAME=value`; the label single-quoted (BACKLOG 1643: its value was checked at the start to hold no
  # single quote, backslash or control character).
  function Format-SettingLine {
    param([string]$Variable, [string]$Value)
    if ($Variable -ceq $LabelVariable) { return "$Variable='$Value'" }
    return "$Variable=$Value"
  }

  # Writes the settings of this session into .env (BACKLOG 1055), before the first
  # `docker compose up`: an earlier line of the same name outside the updater's block is replaced
  # where it stands (a later duplicate dropped), a new one appended; the updater's block is copied as
  # it is. Says in one line what it saved.
  function Save-ShellSetting {
    $bundleText = Read-Text (Join-Path $WorkerDir $Download)
    $values = @{}
    $names = @()
    foreach ($variable in (Get-DefaultedVariable $bundleText)) {
      if ($NotSaved -ccontains $variable) { continue }
      if ($variable -cmatch 'TOKEN|SECRET|PASSWORD|PASSWD|KEY|DSN|CREDENTIAL|PRIVATE') { continue }
      $value = [Environment]::GetEnvironmentVariable($variable, 'Process')
      if ([string]::IsNullOrEmpty($value) -and $Planned.ContainsKey($variable)) { $value = $Planned[$variable] }
      if ([string]::IsNullOrEmpty($value)) { continue }
      if ($value -cnotmatch '^[A-Za-z0-9_.:/@%+,=-]+\z') {
        $Host.UI.WriteErrorLine("agentic-worker: did not save ${variable}: its value has a character this installer does not write into .env; add it to $WorkerDir\.env yourself, or it goes back to its default at the next update.")
        continue
      }
      $names += $variable
      $values[$variable] = $value
    }
    # The compose project of a named install: the installer's own, never this session's.
    if ($Planned.ContainsKey('COMPOSE_PROJECT_NAME')) {
      $names += 'COMPOSE_PROJECT_NAME'
      $values['COMPOSE_PROJECT_NAME'] = $Planned['COMPOSE_PROJECT_NAME']
    }
    # The page's label (S-29.1, BACKLOG 1643): this session's, else -Name's on a new or existing install.
    $label = [Environment]::GetEnvironmentVariable($LabelVariable, 'Process')
    if ([string]::IsNullOrEmpty($label) -and $Planned.ContainsKey($LabelVariable)) { $label = $Planned[$LabelVariable] }
    if (-not [string]::IsNullOrEmpty($label) -and $bundleText.Contains('${' + $LabelVariable + ':-}')) {
      $names += $LabelVariable
      $values[$LabelVariable] = $label
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
            $lines.Add((Format-SettingLine $name $values[$name]))
            $written[$name] = $true
          }
          continue
        }
        $lines.Add($line)
      }
    }
    foreach ($name in $names) {
      if (-not $written.ContainsKey($name)) { $lines.Add((Format-SettingLine $name $values[$name])) }
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
    param([string]$Kind, [string]$ObjectName, [string]$Label)
    if ($ObjectName -eq '') { return '' }
    $inspected = Invoke-Native -File 'docker' -Arguments @($Kind, 'inspect', '--format', '{{json .Labels}}', $ObjectName) -Capture
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

  # --- Which install (S-29.2, TD-031's 2026-11-24 amendment, decision 9 item 2) ---

  # Whether a name may be an install's: the pattern, and not a reserved one.
  function Test-InstallName {
    param([string]$Candidate)
    return (($Candidate -cmatch $NamePattern) -and ($ReservedNames -cnotcontains $Candidate))
  }

  # The compose project a folder's install runs as: its .env's COMPOSE_PROJECT_NAME (a named
  # install's, written by this installer), else agentic-worker.
  function Get-ProjectOf {
    param([string]$Folder)
    $value = Get-EnvFileValueIn $Folder 'COMPOSE_PROJECT_NAME'
    if ($value -eq '') { return $DefaultProject }
    if ($value -cnotmatch '^[a-z0-9][a-z0-9_-]*\z') {
      Exit-Installer 3 "$Folder\.env names the compose project '$value', which is not a name Compose and the updater accept; correct COMPOSE_PROJECT_NAME there and run this again."
    }
    return $value
  }

  # The folders an updater container of any state mounts as its host bundle (Docker reports the bind
  # mount's source; a label does not, TD-032 decision 4).
  function Get-UpdaterFolder {
    $ids = @(Get-ContainerId @('label=com.docker.compose.service=updater'))
    if ($ids.Count -eq 0) { return @() }
    $inspected = Invoke-Native -File 'docker' -Arguments (@('inspect', '--format', '{{json .Mounts}}') + $ids) -Capture
    $folders = @()
    foreach ($line in ($inspected.Output -split "`n")) {
      if ($line.Trim() -eq '') { continue }
      try { $mounts = $line | ConvertFrom-Json } catch { continue }
      foreach ($mount in @($mounts)) {
        if ($null -ne $mount -and [string]$mount.Destination -eq $UpdaterFolder -and [string]$mount.Source -ne '') { $folders += [string]$mount.Source }
      }
    }
    return $folders
  }

  # Where an install may be, in the decision's order: -Dir, agentic-worker, agentic-worker-<-Name>,
  # every agentic-worker-* in the home folder, every folder an updater mounts.
  function Get-CandidateFolder {
    $folders = @()
    if ($DirGiven -ne '') { $folders += $DirGiven }
    $folders += (Join-Path $HomeFolder 'agentic-worker')
    if ($Name -ne '') { $folders += (Join-Path $HomeFolder "agentic-worker-$Name") }
    $folders += @(Get-ChildItem -LiteralPath $HomeFolder -Directory -Filter 'agentic-worker-*' -ErrorAction SilentlyContinue |
        Sort-Object -Property Name | ForEach-Object { $_.FullName })
    $folders += @(Get-UpdaterFolder)
    return $folders
  }

  # The installed folders (each with this installer's mark) among the candidates, once each, in order.
  function Get-MarkedFolder {
    $seen = @{}
    $marked = @()
    foreach ($folder in @(Get-CandidateFolder)) {
      if (-not (Test-Path -LiteralPath (Join-Path $folder $Mark) -PathType Leaf)) { continue }
      $key = [IO.Path]::GetFullPath($folder).TrimEnd('\', '/').ToLowerInvariant()
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      $marked += $folder
    }
    return $marked
  }

  # This core's install, or $null: the first marked folder that names this core; the rest are named
  # in one warning.
  function Find-ThisCoreInstall {
    $mine = @(Get-MarkedFolder | Where-Object { (Get-MarkedCoreIn $_) -eq $CoreAddress })
    if ($mine.Count -eq 0) { return $null }
    $first = $mine[0]
    if ($DirGiven -ne '' -and $first -ne $DirGiven) {
      Write-Problem "$DirGiven is not this core's install; this core's worker is installed in $first, so this run works on that one."
    }
    if ($mine.Count -gt 1) {
      Write-Problem "this core has another install too: $(@($mine | Select-Object -Skip 1) -join ', '). This run works on $first only; remove the other with -Uninstall -Dir <its folder>."
    }
    return $first
  }

  # Whether today's single install may be made: its folder is absent or empty and no container of the
  # project agentic-worker exists.
  function Test-DefaultInstallFree {
    $folder = Join-Path $HomeFolder 'agentic-worker'
    if (Test-Path -LiteralPath $folder) {
      if (-not (Test-Path -LiteralPath $folder -PathType Container)) { return $false }
      if (@(Get-ChildItem -LiteralPath $folder -Force).Count -gt 0) { return $false }
    }
    return (@(Get-ContainerId @("label=com.docker.compose.project=$DefaultProject")).Count -eq 0)
  }

  # The host ports any container of any state has bound (a stopped worker keeps its port).
  function Get-BoundPort {
    $ids = @(Get-ContainerId)
    if ($ids.Count -eq 0) { return @() }
    $inspected = Invoke-Native -File 'docker' -Arguments (@('inspect', '--format', '{{json .HostConfig.PortBindings}}') + $ids) -Capture
    $ports = @()
    foreach ($line in ($inspected.Output -split "`n")) {
      if ($line.Trim() -eq '') { continue }
      try { $bindings = $line | ConvertFrom-Json } catch { continue }
      if ($null -eq $bindings) { continue }
      foreach ($property in $bindings.PSObject.Properties) {
        foreach ($binding in @($property.Value)) {
          if ($null -ne $binding -and [string]$binding.HostPort -match '^\d+\z') { $ports += [string]$binding.HostPort }
        }
      }
    }
    return $ports
  }

  # The TCP ports something on this machine listens on, read off the system's own table rather than
  # by connecting: Windows refuses a connection to a closed loopback port only after retrying it, so
  # a one-second probe called every port of 7357-7456 taken (measured on the Windows runner, S-29.2).
  function Get-ListeningPort {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return @($listeners | ForEach-Object { [string]$_.Port } | Sort-Object -Unique)
  }

  # The first port from 7357 up that nothing listens on and no container has bound.
  function Get-FirstFreePort {
    $taken = @(Get-BoundPort) + @(Get-ListeningPort)
    for ($port = $FirstPagePort; $port -lt $FirstPagePort + $PagePortSearch; $port++) {
      if ($taken -notcontains [string]$port) { return $port }
    }
    Exit-Installer 1 "no port from $FirstPagePort to $($FirstPagePort + $PagePortSearch - 1) is free for the worker's page; set APP_WORKER_UI_PORT to one that is and run this again."
  }

  # Whether this session gives a variable a value.
  function Test-SessionValue {
    param([string]$Variable)
    return (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($Variable, 'Process')))
  }

  # Which install this run makes or repairs: @{ Dir; Project; Existing }, and for a new named one the
  # settings its .env gets (in $Planned).
  function Resolve-Install {
    $found = Find-ThisCoreInstall
    if ($null -ne $found) {
      $foundProject = Get-ProjectOf $found
      if ($Name -ne '') {
        if (-not (Test-SessionValue $LabelVariable)) { $Planned[$LabelVariable] = $Name }
        Write-Line "This core's worker is already installed in $found (compose project $foundProject). No install is renamed, so -Name only sets its page's label."
      }
      return @{ Dir = $found; Project = $foundProject; Existing = $true }
    }
    $installName = $Name
    if ($installName -eq '' -and $DirGiven -eq '' -and -not (Test-DefaultInstallFree)) {
      if ($PlatformSlug -eq '') {
        Exit-Installer 3 "another worker already has $(Join-Path $HomeFolder 'agentic-worker') or the compose project $DefaultProject, and this core names no platform to call a second worker after. Run this again with -Name <name> to install this core's worker beside it."
      }
      $installName = $PlatformSlug
      Write-Line "Another worker already has $(Join-Path $HomeFolder 'agentic-worker') or the compose project $DefaultProject, so this core's worker is installed beside it as $installName (pass -Name to choose another name)."
    }
    if ($installName -eq '') {
      $folder = $DirGiven
      if ($folder -eq '') { $folder = Join-Path $HomeFolder 'agentic-worker' }
      return @{ Dir = $folder; Project = $DefaultProject; Existing = $false }
    }
    $named = "$DefaultProject-$installName"
    $folder = $DirGiven
    if ($folder -eq '') { $folder = Join-Path $HomeFolder $named }
    # Its .env lines (TD-031 2026-11-24 item 1); a value given in this session is the person's and wins.
    $Planned['COMPOSE_PROJECT_NAME'] = $named
    foreach ($pair in @(@('APP_WORKER_CONTROL_VOLUME', "$named-ctl"), @('APP_WORKER_CACHE_VOLUME', "$named-repo-cache"), @('APP_WORKER_RUN_NETWORK', "$named-run-egress"))) {
      if (-not (Test-SessionValue $pair[0])) { $Planned[$pair[0]] = $pair[1] }
    }
    if (-not (Test-SessionValue 'APP_WORKER_UI_PORT')) { $Planned['APP_WORKER_UI_PORT'] = [string](Get-FirstFreePort) }
    # A person's -Name is the page's label too; the platform's name never is (a rename still shows).
    if ($Name -ne '' -and -not (Test-SessionValue $LabelVariable)) { $Planned[$LabelVariable] = $Name }
    return @{ Dir = $folder; Project = $named; Existing = $false }
  }

  # Which install -Uninstall removes: -Dir; else -Name's (its folder, or the installed folder whose
  # project is agentic-worker-<name>); else this core's. Never another one in its place.
  function Resolve-Uninstall {
    $folder = $DirGiven
    if ($folder -eq '' -and $Name -ne '') {
      $folder = Join-Path $HomeFolder "agentic-worker-$Name"
      if (-not (Test-Path -LiteralPath (Join-Path $folder $Mark) -PathType Leaf)) {
        $byProject = @(Get-MarkedFolder | Where-Object { (Get-ProjectOf $_) -eq "$DefaultProject-$Name" }) | Select-Object -First 1
        if ($null -eq $byProject) {
          Exit-Installer 3 "nothing to remove: no install is named $Name ($folder has no worker this installer made, and no installed folder runs the compose project $DefaultProject-$Name)."
        }
        $folder = $byProject
      }
    } elseif ($folder -eq '') {
      $folder = Find-ThisCoreInstall
      if ($null -eq $folder) {
        Exit-Installer 3 "nothing to remove: no worker of $CoreAddress is installed on this machine (none of the home folder's agentic-worker, agentic-worker-* or an updater's folder is marked with it). For another core's worker pass -Name <name> or -Dir <folder>."
      }
    }
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) { Exit-Installer 3 "nothing to remove: $folder does not exist" }
    if (-not (Test-Path -LiteralPath (Join-Path $folder $Mark))) {
      Exit-Installer 3 "$folder was not made by this installer (it has no $Mark); remove that worker yourself (docker compose down, in that folder)."
    }
    return @{ Dir = $folder; Project = (Get-ProjectOf $folder); Existing = $true }
  }

  # The options that name this install again: nothing for today's, -Name for a named one.
  function Get-AgainOption {
    if ($Project -ceq $DefaultProject) { return '' }
    if ($Project.StartsWith("$DefaultProject-")) { return " -Name $($Project.Substring($DefaultProject.Length + 1))" }
    return ''
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

  # The page's port: what the running worker publishes, else this session, else what a new named
  # install planned, else .env, else the default.
  function Get-PagePort {
    $port = Get-PublishedPort
    if ([string]::IsNullOrEmpty($port)) { $port = [Environment]::GetEnvironmentVariable('APP_WORKER_UI_PORT', 'Process') }
    if ([string]::IsNullOrEmpty($port) -and $Planned.ContainsKey('APP_WORKER_UI_PORT')) { $port = $Planned['APP_WORKER_UI_PORT'] }
    if ([string]::IsNullOrEmpty($port)) { $port = Get-EnvFileValue 'APP_WORKER_UI_PORT' }
    if ($port -notmatch '^\d+\z') { $port = '7357' }
    return $port
  }

  # The launcher's repository cache volume: APP_WORKER_CACHE_VOLUME (this session, else .env), or
  # the bundle's default - for today's install only. A named install's is in its .env; without that
  # line it answers '' rather than the default install's name, so a purge never reaches another
  # worker's cache.
  function Get-CacheVolume {
    $volume = [Environment]::GetEnvironmentVariable('APP_WORKER_CACHE_VOLUME', 'Process')
    if ([string]::IsNullOrEmpty($volume)) { $volume = Get-EnvFileValue 'APP_WORKER_CACHE_VOLUME' }
    if ($volume -notmatch '^[A-Za-z0-9_.-]+\z') {
      $volume = ''
      if ($Project -ceq $DefaultProject) { $volume = 'agentic-worker-repo-cache' }
    }
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
        Exit-Installer 3 "the worker in $WorkerDir was installed from $previous, not $CoreAddress. To move it, remove it first (-Uninstall -Purge) and install again; to install this core's worker beside it, pass another -Name."
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
    Write-Line "  Its folder: $WorkerDir (compose project $Project)"
    Write-Line "  Updates:    automatic. Its updater follows $CoreAddress; you never run this again to update."

    Write-Line "  Remove it:  run this script again with -Uninstall$(Get-AgainOption) (add -Purge to remove its data too)"
  }

  function Uninstall-Worker {
    Assert-NothingForeignOrBusy
    if (-not (Test-Path -LiteralPath (Join-Path $WorkerDir $Bundle))) { Exit-Installer 3 "$WorkerDir\$Bundle is missing, so this installer cannot tell Compose what to remove." }
    if ($Purge) {
      $cache = Get-CacheVolume
      if ((Invoke-Compose @('down', '--volumes', '--remove-orphans')).Code -ne 0) { Exit-Installer 1 'docker compose down failed (see above).' }
      # The launcher's repository cache (cloned source) is the launcher's volume, not Compose's.
      if ($cache -eq '') {
        Write-Problem "kept the launcher's repository cache: $WorkerDir\.env does not name it (APP_WORKER_CACHE_VOLUME), and this installer removes no volume by guess."
      } elseif ((Invoke-Native -File 'docker' -Arguments @('volume', 'inspect', $cache) -Capture).Code -eq 0) {
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
      Write-Line "To remove the rest: run this script again with -Uninstall -Purge$(Get-AgainOption)."
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

    if ($Name -ne '' -and -not (Test-InstallName $Name)) {
      Exit-Installer 2 "-Name takes 1 to 24 of a-z, 0-9 and -, starting with a letter or digit, and not dev (pnpm worker:dev uses agentic-worker-dev); it was given: $Name"
    }
    # A copy not served by a core, or a slug that is not an install name, names no platform.
    if (-not (Test-InstallName $PlatformSlug)) { $PlatformSlug = '' }
    # The page's label from this session (BACKLOG 1643): saved into .env single-quoted, so Compose
    # reads spaces, #, double quotes and $ as they are; a single quote, a backslash or a control
    # character cannot be written that way, so such a label is refused before anything is done.
    $sessionLabel = [Environment]::GetEnvironmentVariable($LabelVariable, 'Process')
    if (-not $Uninstall -and -not [string]::IsNullOrEmpty($sessionLabel)) {
      if ($sessionLabel.Contains("'") -or $sessionLabel.Contains('\')) {
        Exit-Installer 2 'APP_WORKER_LABEL cannot hold a single quote or a backslash (it is saved in .env inside single quotes); choose a label without them.'
      }
      if ($sessionLabel -match '[\x00-\x1f\x7f]') {
        Exit-Installer 2 'APP_WORKER_LABEL cannot hold a control character or a line break; choose a label on one line.'
      }
    }

    # The home folder: %USERPROFILE% (where Windows keeps it), else PowerShell's $HOME.
    $HomeFolder = [Environment]::GetEnvironmentVariable('USERPROFILE', 'Process')
    if ([string]::IsNullOrEmpty($HomeFolder)) { $HomeFolder = $HOME }
    # -Dir as given (absolute, no trailing separator); the install's folder is resolved below.
    $DirGiven = ''
    if ($Dir -ne '') {
      $DirGiven = $Dir
      if (-not [IO.Path]::IsPathRooted($DirGiven)) { $DirGiven = Join-Path (Get-Location).ProviderPath $DirGiven }
      $DirGiven = [IO.Path]::GetFullPath($DirGiven).TrimEnd('\', '/')
    }

    $WaitLimit = 300
    $waitSetting = [Environment]::GetEnvironmentVariable('AGENTIC_INSTALL_WAIT_SECONDS', 'Process')
    if (-not [string]::IsNullOrEmpty($waitSetting)) {
      if ($waitSetting -notmatch '^\d+$') { Exit-Installer 2 'AGENTIC_INSTALL_WAIT_SECONDS must be a whole number of seconds' }
      $WaitLimit = [int]$waitSetting
    }

    # Windows PowerShell 5.1 may not offer TLS 1.2 by default.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    Assert-Docker
    if ($Uninstall) { $target = Resolve-Uninstall } else { $target = Resolve-Install }
    $WorkerDir = $target.Dir
    $Project = $target.Project
    if ($Uninstall) { Uninstall-Worker } else { Install-Worker }
    0
  } catch {
    $code = $_.Exception.Data['code']
    if ($null -eq $code) { $code = 1 }
    $Host.UI.WriteErrorLine("agentic-worker: $($_.Exception.Message)")
    $code
  }
} @args | Select-Object -Last 1 | ForEach-Object { if ($PSCommandPath) { exit $_ } }
