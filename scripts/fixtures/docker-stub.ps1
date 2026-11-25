<#
A stub `docker` for scripts/worker-install-ps1-check.ps1 (S-22.20), reached through `docker.cmd`
beside it on PATH. It records each call in $env:STUB_LOG and answers from $env:STUB_STATE: the
project agentic-worker's state in $env:STUB_STATE itself, any other project's (S-29.2: several
workers on one machine) in $env:STUB_STATE\projects\<name>.

  docker info --format {{.OSType}}       linux
  docker compose version                 a version line
  docker ps ... --quiet ...              per project, its name as the container id while it is up;
                                         nothing for the apply label. With no project filter: every
                                         up project (with a service filter: its container of that
                                         service), and `stopped` when $env:STUB_BOUND_PORTS is set
  docker inspect --format {{json .}} ... for a project id: its remote-worker and updater, running,
                                         labelled with the folder; remote-worker publishes 7357/tcp
                                         on the port its up took, and the updater mounts the folder
                                         its up ran in; for `stopped`: an exited container binding
                                         $env:STUB_BOUND_PORTS
  docker compose ... up -d               the project is up; the folder, Compose's environment and .env
                                         kept; with $env:STUB_UP_PAGE_SITE a page served on the port
                                         it publishes (its pid in up-page-<port>.pid)
  docker compose ... start / down        up / not up; a start also serves $env:STUB_START_PAGE_SITE
                                         on $env:STUB_START_PAGE_PORT when set (the worker's page,
                                         answering only once the worker started; its pid in page.pid)
  docker volume|network inspect --format {{json .Labels}} NAME
                                         $env:STUB_STATE\labels-<volume|network>-NAME, else exit 1
  docker volume inspect / rm ...         recorded, answered 0
#>
$ErrorActionPreference = 'Stop'
$line = $args -join ' '
Add-Content -LiteralPath $env:STUB_LOG -Value "docker $line"

# A project's state folder (made when missing).
function Get-StateFolder {
  param([string]$Project)
  if ($Project -eq 'agentic-worker') { return $env:STUB_STATE }
  $folder = Join-Path (Join-Path $env:STUB_STATE 'projects') $Project
  $null = New-Item -ItemType Directory -Force -Path $folder
  return $folder
}

# Every project the stub knows, agentic-worker first.
function Get-KnownProject {
  $names = @('agentic-worker')
  $projects = Join-Path $env:STUB_STATE 'projects'
  if (Test-Path -LiteralPath $projects) { $names += @(Get-ChildItem -LiteralPath $projects -Directory | ForEach-Object { $_.Name }) }
  return $names
}

function Test-Up {
  param([string]$Project)
  return (Test-Path -LiteralPath (Join-Path (Get-StateFolder $Project) 'up'))
}

$project = ''
$named = [regex]::Match($line, '--project-name ([a-z0-9_-]+)')
if ($named.Success) { $project = $named.Groups[1].Value } else {
  $labelled = [regex]::Match($line, 'com\.docker\.compose\.project=([a-z0-9_-]+)')
  if ($labelled.Success) { $project = $labelled.Groups[1].Value }
}
$state = $env:STUB_STATE
if ($project -ne '') { $state = Get-StateFolder $project }
$upFile = Join-Path $state 'up'
$publishedFile = Join-Path $state 'published-port'

# The page's host port a container created now publishes: this env, else .env, else the default.
function Write-PublishedPort {
  $published = $env:APP_WORKER_UI_PORT
  $dotenvText = Join-Path (Get-Location).ProviderPath '.env'
  if ([string]::IsNullOrEmpty($published) -and (Test-Path -LiteralPath $dotenvText)) {
    $found = [regex]::Matches([IO.File]::ReadAllText($dotenvText), '(?m)^APP_WORKER_UI_PORT=(\d+)')
    if ($found.Count -gt 0) { $published = $found[$found.Count - 1].Groups[1].Value }
  }
  if ([string]::IsNullOrEmpty($published)) { $published = '7357' }
  Set-Content -LiteralPath $publishedFile -Value $published
}

if ($args[0] -eq 'info') { Write-Output 'linux'; exit 0 }
if ($args[0] -eq 'compose' -and $args[1] -eq 'version') { Write-Output 'Docker Compose version v5.7.0'; exit 0 }
if ($args[0] -eq 'ps') {
  if ($line -match 'org\.platform\.update-apply') { exit 0 }
  if ($project -ne '') {
    if (Test-Path -LiteralPath $upFile) { Write-Output $project }
    exit 0
  }
  foreach ($known in @(Get-KnownProject)) { if (Test-Up $known) { Write-Output $known } }
  if ($line -notmatch 'com\.docker\.compose\.service=' -and $env:STUB_BOUND_PORTS) { Write-Output 'stopped' }
  exit 0
}
if ($args[0] -eq 'inspect' -and $args[2] -eq '{{json .HostConfig.PortBindings}}') {
  # One line per container: its port bindings (remote-worker's published page port), else null.
  foreach ($id in @($args | Select-Object -Skip 3)) {
    if ($id -eq 'stopped') {
      $ports = @($env:STUB_BOUND_PORTS -split ' ' | Where-Object { $_ -ne '' } | ForEach-Object { "{`"HostIp`":`"127.0.0.1`",`"HostPort`":`"$_`"}" })
      Write-Output "{`"7000/tcp`":[$($ports -join ',')]}"
      continue
    }
    $portFile = Join-Path (Get-StateFolder $id) 'published-port'
    if (Test-Path -LiteralPath $portFile) {
      Write-Output "{`"7357/tcp`":[{`"HostIp`":`"127.0.0.1`",`"HostPort`":`"$((Get-Content -LiteralPath $portFile -Raw).Trim())`"}]}"
    } else {
      Write-Output 'null'
    }
  }
  exit 0
}
if ($args[0] -eq 'inspect') {
  foreach ($id in @($args | Select-Object -Skip 3)) {
    if ($id -eq 'stopped') {
      $bindings = @{}
      $index = 0
      foreach ($port in ($env:STUB_BOUND_PORTS -split ' ' | Where-Object { $_ -ne '' })) {
        $bindings["$(7000 + $index)/tcp"] = @(@{ HostIp = '127.0.0.1'; HostPort = $port })
        $index++
      }
      Write-Output (ConvertTo-Json @{ Config = @{ Labels = @{} }; State = @{ Status = 'exited' }; HostConfig = @{ PortBindings = $bindings } } -Depth 6 -Compress)
      continue
    }
    $folderState = Get-StateFolder $id
    $folder = (Get-Content -LiteralPath (Join-Path $folderState 'wd') -Raw).Trim()
    $mountFile = Join-Path $folderState 'mount'
    $portFile = Join-Path $folderState 'published-port'
    foreach ($service in @('remote-worker', 'updater')) {
      $container = @{
        Config = @{ Labels = @{
            'com.docker.compose.project' = $id
            'com.docker.compose.service' = $service
            'com.docker.compose.project.working_dir' = $folder
          }
        }
        State = @{ Status = 'running' }
      }
      if ($service -eq 'remote-worker' -and (Test-Path -LiteralPath $portFile)) {
        $published = (Get-Content -LiteralPath $portFile -Raw).Trim()
        $container['NetworkSettings'] = @{ Ports = @{ '7357/tcp' = @(@{ HostIp = '127.0.0.1'; HostPort = $published }) } }
        $container['HostConfig'] = @{ PortBindings = @{ '7357/tcp' = @(@{ HostIp = '127.0.0.1'; HostPort = $published }) } }
      }
      if ($service -eq 'updater' -and (Test-Path -LiteralPath $mountFile)) {
        $container['Mounts'] = @(@{ Type = 'bind'; Source = (Get-Content -LiteralPath $mountFile -Raw).Trim(); Destination = '/var/lib/platform/host-bundle' })
      }
      Write-Output (ConvertTo-Json $container -Depth 6 -Compress)
    }
  }
  exit 0
}
if (($args[0] -eq 'volume' -or $args[0] -eq 'network') -and $args[1] -eq 'inspect' -and $args[2] -eq '--format') {
  $labels = Join-Path $env:STUB_STATE "labels-$($args[0])-$($args[4])"
  if (-not (Test-Path -LiteralPath $labels)) { exit 1 }
  Write-Output (Get-Content -LiteralPath $labels -Raw).Trim()
  exit 0
}
if ($args[0] -eq 'volume') { exit 0 }
if ($args[0] -eq 'compose') {
  if ($args -contains 'up') {
    Set-Content -LiteralPath (Join-Path $state 'wd') -Value (Get-Location).ProviderPath
    Set-Content -LiteralPath (Join-Path $state 'mount') -Value (Get-Location).ProviderPath
    Set-Content -LiteralPath $upFile -Value ''
    # --no-recreate leaves a container that exists (and the port it publishes) as it is.
    if (-not ($args -contains '--no-recreate') -or -not (Test-Path -LiteralPath $publishedFile)) { Write-PublishedPort }
    # The folder's .env as Compose read it at this up (nothing: no file).
    $dotenv = Join-Path (Get-Location).ProviderPath '.env'
    $atUp = Join-Path $state 'env-at-up'
    if (Test-Path -LiteralPath $dotenv) { Copy-Item -LiteralPath $dotenv -Destination $atUp -Force } else { Remove-Item -LiteralPath $atUp -Force -ErrorAction SilentlyContinue }
    $names = Get-ChildItem env: | Where-Object { $_.Name -match '^(PLATFORM_|APP_TRUSTED_|APP_CORE_URL|COMPOSE_)' } | ForEach-Object { $_.Name }
    Set-Content -LiteralPath (Join-Path $state 'up-env') -Value ($names -join ',')
    if ($env:STUB_UP_PAGE_SITE) {
      $pagePort = (Get-Content -LiteralPath $publishedFile -Raw).Trim()
      $page = Start-Process -FilePath 'python' -ArgumentList @('-m', 'http.server', $pagePort, '--bind', '127.0.0.1', '--directory', $env:STUB_UP_PAGE_SITE) -PassThru -WindowStyle Hidden
      Set-Content -LiteralPath (Join-Path $env:STUB_STATE "up-page-$pagePort.pid") -Value $page.Id
    }
    exit 0
  }
  if ($args -contains 'start') {
    Set-Content -LiteralPath $upFile -Value ''
    # A stopped container (no published-port: it publishes nothing) publishes its port again.
    if (-not (Test-Path -LiteralPath $publishedFile)) { Write-PublishedPort }
    if ($env:STUB_START_PAGE_SITE) {
      $page = Start-Process -FilePath 'python' -ArgumentList @('-m', 'http.server', $env:STUB_START_PAGE_PORT, '--bind', '127.0.0.1', '--directory', $env:STUB_START_PAGE_SITE) -PassThru -WindowStyle Hidden
      Set-Content -LiteralPath (Join-Path $env:STUB_STATE 'page.pid') -Value $page.Id
    }
    exit 0
  }
  if ($args -contains 'down') {
    Remove-Item -LiteralPath $upFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $state 'mount') -Force -ErrorAction SilentlyContinue
    exit 0
  }
}
[Console]::Error.WriteLine("stub docker: unexpected: $line")
exit 64
