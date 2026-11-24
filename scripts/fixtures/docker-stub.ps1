<#
A stub `docker` for scripts/worker-install-ps1-check.ps1 (S-22.20), reached through `docker.cmd`
beside it on PATH. It records each call in $env:STUB_LOG and answers from $env:STUB_STATE, one folder
per compose project (S-29.2): agentic-worker's is $env:STUB_STATE itself, another project P's
$env:STUB_STATE\projects\P.

  docker info --format {{.OSType}}       linux
  docker compose version                 a version line
  docker ps ... --quiet ...              per project: one id (c0ffee-<project>) while it is up;
                                         no project filter: every up project's id; nothing for the
                                         apply label or the updater service
  docker inspect --format {{json .}} ... remote-worker and updater of each id's project, running,
                                         labelled with its folder; remote-worker publishes 7357/tcp
                                         on the port its up took
  docker inspect --format {{json .HostConfig.PortBindings}} ...
                                         each up project's published page port
  docker compose -p P ... up -d          P is up; the folder, Compose's environment and .env kept; a
                                         P other than agentic-worker also serves
                                         $env:STUB_UP_PAGE_SITE on its published port when set
  docker compose -p P ... start / down   up / not up; a start also serves $env:STUB_START_PAGE_SITE
                                         on $env:STUB_START_PAGE_PORT when set (the worker's page,
                                         answering only once the worker started; its pid in page.pid)
  docker volume|network inspect --format {{json .Labels}} NAME
                                         $env:STUB_STATE\labels-<volume|network>-NAME, else exit 1
  docker volume inspect / rm ...         recorded, answered 0
#>
$ErrorActionPreference = 'Stop'
$line = $args -join ' '
Add-Content -LiteralPath $env:STUB_LOG -Value "docker $line"

function Get-ProjectState {
  param([string]$Project)
  if ($Project -eq 'agentic-worker') { return $env:STUB_STATE }
  $folder = Join-Path (Join-Path $env:STUB_STATE 'projects') $Project
  $null = New-Item -ItemType Directory -Force -Path $folder
  return $folder
}

function Get-UpProject {
  $up = @()
  if (Test-Path -LiteralPath (Join-Path $env:STUB_STATE 'up')) { $up += 'agentic-worker' }
  $projects = Join-Path $env:STUB_STATE 'projects'
  if (Test-Path -LiteralPath $projects) {
    foreach ($folder in @(Get-ChildItem -LiteralPath $projects -Directory)) {
      if (Test-Path -LiteralPath (Join-Path $folder.FullName 'up')) { $up += $folder.Name }
    }
  }
  return $up
}

# The page's host port a container created now publishes: this env, else .env, else the default.
function Write-PublishedPort {
  param([string]$State)
  $published = $env:APP_WORKER_UI_PORT
  $dotenvText = Join-Path (Get-Location).ProviderPath '.env'
  if ([string]::IsNullOrEmpty($published) -and (Test-Path -LiteralPath $dotenvText)) {
    $found = [regex]::Matches([IO.File]::ReadAllText($dotenvText), '(?m)^APP_WORKER_UI_PORT=(\d+)')
    if ($found.Count -gt 0) { $published = $found[$found.Count - 1].Groups[1].Value }
  }
  if ([string]::IsNullOrEmpty($published)) { $published = '7357' }
  Set-Content -LiteralPath (Join-Path $State 'published-port') -Value $published
}

$filtered = [regex]::Match($line, 'label=com\.docker\.compose\.project=([a-z0-9_-]+)')

if ($args[0] -eq 'info') { Write-Output 'linux'; exit 0 }
if ($args[0] -eq 'compose' -and $args[1] -eq 'version') { Write-Output 'Docker Compose version v5.7.0'; exit 0 }
if ($args[0] -eq 'ps') {
  if ($line -match 'org\.platform\.update-apply') { exit 0 }
  if ($line -match 'com\.docker\.compose\.service=updater') { exit 0 }
  if ($filtered.Success) {
    $project = $filtered.Groups[1].Value
    if (Test-Path -LiteralPath (Join-Path (Get-ProjectState $project) 'up')) { Write-Output "c0ffee-$project" }
    exit 0
  }
  foreach ($project in @(Get-UpProject)) { Write-Output "c0ffee-$project" }
  exit 0
}
if ($args[0] -eq 'inspect') {
  $ids = @($args | Where-Object { $_ -like 'c0ffee-*' })
  if ($line -match 'PortBindings') {
    foreach ($id in $ids) {
      $published = Join-Path (Get-ProjectState $id.Substring(7)) 'published-port'
      if (Test-Path -LiteralPath $published) {
        Write-Output (ConvertTo-Json @{ '7357/tcp' = @(@{ HostIp = '127.0.0.1'; HostPort = (Get-Content -LiteralPath $published -Raw).Trim() }) } -Depth 5 -Compress)
      } else { Write-Output 'null' }
    }
    exit 0
  }
  foreach ($id in $ids) {
    $project = $id.Substring(7)
    $state = Get-ProjectState $project
    $folder = (Get-Content -LiteralPath (Join-Path $state 'wd') -Raw).Trim()
    $publishedFile = Join-Path $state 'published-port'
    foreach ($service in @('remote-worker', 'updater')) {
      $container = @{
        Config = @{ Labels = @{
            'com.docker.compose.project' = $project
            'com.docker.compose.service' = $service
            'com.docker.compose.project.working_dir' = $folder
          }
        }
        State = @{ Status = 'running' }
      }
      if ($service -eq 'remote-worker' -and (Test-Path -LiteralPath $publishedFile)) {
        $published = (Get-Content -LiteralPath $publishedFile -Raw).Trim()
        $container['NetworkSettings'] = @{ Ports = @{ '7357/tcp' = @(@{ HostIp = '127.0.0.1'; HostPort = $published }) } }
      }
      Write-Output (ConvertTo-Json $container -Depth 5 -Compress)
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
  # docker compose --project-name <project> ...
  $state = Get-ProjectState $args[2]
  $upFile = Join-Path $state 'up'
  $publishedFile = Join-Path $state 'published-port'
  if ($args -contains 'up') {
    Set-Content -LiteralPath (Join-Path $state 'wd') -Value (Get-Location).ProviderPath
    Set-Content -LiteralPath $upFile -Value ''
    # --no-recreate leaves a container that exists (and the port it publishes) as it is.
    $created = -not ($args -contains '--no-recreate') -or -not (Test-Path -LiteralPath $publishedFile)
    if ($created) { Write-PublishedPort $state }
    # A project other than agentic-worker gets its own page on its own port when the check asks for
    # one (S-29.2): $env:STUB_UP_PAGE_SITE served there, its pid in page-<project>.pid.
    if ($created -and $args[2] -ne 'agentic-worker' -and $env:STUB_UP_PAGE_SITE) {
      $port = (Get-Content -LiteralPath $publishedFile -Raw).Trim()
      $page = Start-Process -FilePath 'python' -ArgumentList @('-m', 'http.server', $port, '--bind', '127.0.0.1', '--directory', $env:STUB_UP_PAGE_SITE) -PassThru -WindowStyle Hidden
      Set-Content -LiteralPath (Join-Path $env:STUB_STATE "page-$($args[2]).pid") -Value $page.Id
    }
    # The folder's .env as Compose read it at this up (nothing: no file).
    $dotenv = Join-Path (Get-Location).ProviderPath '.env'
    $atUp = Join-Path $state 'env-at-up'
    if (Test-Path -LiteralPath $dotenv) { Copy-Item -LiteralPath $dotenv -Destination $atUp -Force } else { Remove-Item -LiteralPath $atUp -Force -ErrorAction SilentlyContinue }
    $names = Get-ChildItem env: | Where-Object { $_.Name -match '^(PLATFORM_|APP_TRUSTED_|APP_CORE_URL|COMPOSE_)' } | ForEach-Object { $_.Name }
    Set-Content -LiteralPath (Join-Path $state 'up-env') -Value ($names -join ',')
    exit 0
  }
  if ($args -contains 'start') {
    Set-Content -LiteralPath $upFile -Value ''
    # A stopped container (no published-port: it publishes nothing) publishes its port again.
    if (-not (Test-Path -LiteralPath $publishedFile)) { Write-PublishedPort $state }
    if ($env:STUB_START_PAGE_SITE) {
      $page = Start-Process -FilePath 'python' -ArgumentList @('-m', 'http.server', $env:STUB_START_PAGE_PORT, '--bind', '127.0.0.1', '--directory', $env:STUB_START_PAGE_SITE) -PassThru -WindowStyle Hidden
      Set-Content -LiteralPath (Join-Path $env:STUB_STATE 'page.pid') -Value $page.Id
    }
    exit 0
  }
  if ($args -contains 'down') { Remove-Item -LiteralPath $upFile -Force -ErrorAction SilentlyContinue; exit 0 }
}
[Console]::Error.WriteLine("stub docker: unexpected: $line")
exit 64
