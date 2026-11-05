<#
A stub `docker` for scripts/worker-install-ps1-check.ps1 (S-22.20), reached through `docker.cmd`
beside it on PATH. It records each call in $env:STUB_LOG and answers from $env:STUB_STATE:

  docker info --format {{.OSType}}       linux
  docker compose version                 a version line
  docker ps ... --quiet ...              one id while the project is up; nothing for the apply label
  docker inspect --format {{json .}} ... remote-worker and updater, running, labelled with the folder
  docker compose ... up -d               the project is up; the folder and Compose's environment kept
  docker compose ... start / down        up / not up
  docker volume inspect / rm ...         recorded, answered 0
#>
$ErrorActionPreference = 'Stop'
$line = $args -join ' '
Add-Content -LiteralPath $env:STUB_LOG -Value "docker $line"
$upFile = Join-Path $env:STUB_STATE 'up'

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
    Write-Output (ConvertTo-Json $container -Depth 5 -Compress)
  }
  exit 0
}
if ($args[0] -eq 'volume') { exit 0 }
if ($args[0] -eq 'compose') {
  if ($args -contains 'up') {
    Set-Content -LiteralPath (Join-Path $env:STUB_STATE 'wd') -Value (Get-Location).ProviderPath
    Set-Content -LiteralPath $upFile -Value ''
    $names = Get-ChildItem env: | Where-Object { $_.Name -match '^(PLATFORM_|APP_TRUSTED_|APP_CORE_URL|COMPOSE_)' } | ForEach-Object { $_.Name }
    Set-Content -LiteralPath (Join-Path $env:STUB_STATE 'up-env') -Value ($names -join ',')
    exit 0
  }
  if ($args -contains 'start') { Set-Content -LiteralPath $upFile -Value ''; exit 0 }
  if ($args -contains 'down') { Remove-Item -LiteralPath $upFile -Force -ErrorAction SilentlyContinue; exit 0 }
}
[Console]::Error.WriteLine("stub docker: unexpected: $line")
exit 64
