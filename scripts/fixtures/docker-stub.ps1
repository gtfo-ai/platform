<#
A stub `docker` for scripts/worker-install-ps1-check.ps1 (S-22.20), reached through `docker.cmd`
beside it on PATH. It records each call in $env:STUB_LOG and answers from $env:STUB_STATE:

  docker info --format {{.OSType}}       linux
  docker compose version                 a version line
  docker ps ... --quiet ...              one id while the project is up; nothing for the apply label
  docker inspect --format {{json .}} ... remote-worker and updater, running, labelled with the folder;
                                         remote-worker publishes 7357/tcp on the port its up took
  docker compose ... up -d               the project is up; the folder, Compose's environment and .env kept
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
$upFile = Join-Path $env:STUB_STATE 'up'
$publishedFile = Join-Path $env:STUB_STATE 'published-port'

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
  if (Test-Path -LiteralPath $upFile) { Write-Output 'c0ffee' }
  exit 0
}
if ($args[0] -eq 'inspect') {
  $folder = (Get-Content -LiteralPath (Join-Path $env:STUB_STATE 'wd') -Raw).Trim()
  foreach ($service in @('remote-worker', 'updater')) {
    $container = @{
      Config = @{ Labels = @{
          'com.docker.compose.project' = 'agentic-worker'
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
    Set-Content -LiteralPath (Join-Path $env:STUB_STATE 'wd') -Value (Get-Location).ProviderPath
    Set-Content -LiteralPath $upFile -Value ''
    # --no-recreate leaves a container that exists (and the port it publishes) as it is.
    if (-not ($args -contains '--no-recreate') -or -not (Test-Path -LiteralPath $publishedFile)) { Write-PublishedPort }
    # The folder's .env as Compose read it at this up (nothing: no file).
    $dotenv = Join-Path (Get-Location).ProviderPath '.env'
    $atUp = Join-Path $env:STUB_STATE 'env-at-up'
    if (Test-Path -LiteralPath $dotenv) { Copy-Item -LiteralPath $dotenv -Destination $atUp -Force } else { Remove-Item -LiteralPath $atUp -Force -ErrorAction SilentlyContinue }
    $names = Get-ChildItem env: | Where-Object { $_.Name -match '^(PLATFORM_|APP_TRUSTED_|APP_CORE_URL|COMPOSE_)' } | ForEach-Object { $_.Name }
    Set-Content -LiteralPath (Join-Path $env:STUB_STATE 'up-env') -Value ($names -join ',')
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
  if ($args -contains 'down') { Remove-Item -LiteralPath $upFile -Force -ErrorAction SilentlyContinue; exit 0 }
}
[Console]::Error.WriteLine("stub docker: unexpected: $line")
exit 64
