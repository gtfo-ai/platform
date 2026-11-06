<#
Runs the worker's install.ps1 (S-22.20) against a stub docker and a local HTTP server, in the
PowerShell that runs this file: `.github/workflows/worker-install.yml` runs it under PowerShell 7 and
Windows PowerShell 5.1 on a Windows runner. No tier of the repository has PowerShell, so this is
where install.ps1 is executed; install-script.test.ts holds its text.

Asserted: a first install downloads the core's bundle verbatim, marks the folder, runs
`docker compose up -d` there with none of the variables that would re-pin the images or change what
the updater trusts; a re-run starts what exists and recreates nothing; a re-run against another
served build only starts an approved worker (or one whose page cannot be read) and installs the
served build over one that is not set up yet (its page reads needs_claude) - a stopped one too,
whose page answers only once it was started; an `irm | iex`-style run
leaves the caller's session alive with no installer function behind; `-Uninstall -Purge` removes
the volumes and the folder. Prints PASS or FAIL and exits 0 or 1.
#>
$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]
function Test-That {
  param([bool]$Condition, [string]$What)
  if ($Condition) { Write-Host "ok   $What" } else { Write-Host "FAIL $What"; $failures.Add($What) }
}

$repository = Split-Path -Parent $PSScriptRoot
$shell = (Get-Process -Id $PID).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ("worker-install-" + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $root 'bin'
$state = Join-Path $root 'state'
$site = Join-Path $root 'site'
$workerDir = Join-Path $root 'agentic-worker'
foreach ($folder in @($bin, $state, (Join-Path $site 'api\worker\v1'), (Join-Path $site 'api\local'))) { $null = New-Item -ItemType Directory -Force -Path $folder }
$log = Join-Path $root 'calls.log'
Set-Content -LiteralPath $log -Value ''

# The stub, as a .cmd so `Get-Command -CommandType Application` and `& docker` both find it.
Copy-Item -LiteralPath (Join-Path $repository 'scripts\fixtures\docker-stub.ps1') -Destination $bin
Set-Content -LiteralPath (Join-Path $bin 'docker.cmd') -Encoding Ascii -Value "@`"$shell`" -NoProfile -ExecutionPolicy Bypass -File `"%~dp0docker-stub.ps1`" %*`r`n@exit /b %ERRORLEVEL%"

# The core: compose.yml and the page, from one local server.
$port = 7357
$core = "http://127.0.0.1:$port"
$sha = 'sha256:' + ('a' * 64)
$bundle = @(
  'name: agentic-worker',
  'services:',
  '  remote-worker:',
  "    image: `${PLATFORM_IMAGE:-ghcr.io/acme/platform@$sha}",
  '  launcher:',
  "    image: `${PLATFORM_LAUNCHER_IMAGE:-ghcr.io/acme/platform-launcher@$sha}",
  '  pull-runtime-image:',
  "    image: `${PLATFORM_RUNTIME_IMAGE:-ghcr.io/acme/platform-runtime@$sha}",
  '  pull-egress-image:',
  "    image: `${PLATFORM_EGRESS_IMAGE:-ghcr.io/acme/platform-egress@$sha}",
  '  updater:',
  "    image: `${PLATFORM_IMAGE:-ghcr.io/acme/platform@$sha}",
  ''
) -join "`n"
[IO.File]::WriteAllText((Join-Path $site 'api\worker\v1\compose.yml'), $bundle)
[IO.File]::WriteAllText((Join-Path $site 'index.html'), '<!doctype html><title>worker</title>')
$server = Start-Process -FilePath 'python' -ArgumentList @('-m', 'http.server', "$port", '--bind', '127.0.0.1', '--directory', $site) -PassThru -WindowStyle Hidden
try {
  $up = $false
  for ($i = 0; $i -lt 50 -and -not $up; $i++) {
    try { $null = Invoke-WebRequest -UseBasicParsing -Uri "$core/" -TimeoutSec 2; $up = $true } catch { Start-Sleep -Milliseconds 200 }
  }
  Test-That $up 'the stand-in core answers'

  $template = [IO.File]::ReadAllText((Join-Path $repository 'apps\server\src\workers\install\install.ps1'))
  $script = Join-Path $root 'install.ps1'
  [IO.File]::WriteAllText($script, $template.Replace('@@AGENTIC_CORE_URL@@', $core))

  $env:PATH = "$bin;$env:PATH"
  $env:STUB_LOG = $log
  $env:STUB_STATE = $state
  $env:AGENTIC_INSTALL_WAIT_SECONDS = '10'
  # Hostile values in the caller's environment: none may reach Compose.
  $env:PLATFORM_IMAGE = 'ghcr.io/evil/platform:latest'
  $env:APP_TRUSTED_BUILDER = ''
  $env:APP_TRUSTED_IMAGE_REPOSITORY = 'ghcr.io/evil/platform'
  $env:COMPOSE_PROFILES = 'none'

  & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Dir $workerDir -NoOpen
  Test-That ($LASTEXITCODE -eq 0) "a first install exits 0 (it exited $LASTEXITCODE)"
  Test-That ([IO.File]::ReadAllText((Join-Path $workerDir 'compose.yaml')) -eq $bundle) 'compose.yaml is the core''s bundle, byte for byte'
  Test-That ([IO.File]::ReadAllText((Join-Path $workerDir '.agentic-worker-install')) -match "(?m)^core=$([regex]::Escape($core))$") 'the folder is marked with its core'
  Test-That (-not (Test-Path -LiteralPath (Join-Path $workerDir '.env'))) 'the installer writes no .env'
  $calls = @(Get-Content -LiteralPath $log | Where-Object { $_ -like 'docker compose --project-name*' })
  Test-That (($calls -join '|') -eq 'docker compose --project-name agentic-worker up -d') "Compose was asked to up -d once (asked: $($calls -join ' | '))"
  Test-That ((Get-Content -LiteralPath (Join-Path $state 'wd') -Raw).Trim() -eq $workerDir) 'Compose ran in the worker''s folder'
  $leaked = (Get-Content -LiteralPath (Join-Path $state 'up-env') -Raw).Trim()
  Test-That ($leaked -eq '') "no re-pinning or trust variable reached Compose (reached: $leaked)"
  Test-That ($env:PLATFORM_IMAGE -eq 'ghcr.io/evil/platform:latest') 'the caller''s environment is put back'

  & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Dir $workerDir -NoOpen
  Test-That ($LASTEXITCODE -eq 0) "a re-run exits 0 (it exited $LASTEXITCODE)"
  $calls = @(Get-Content -LiteralPath $log | Where-Object { $_ -like 'docker compose --project-name*' })
  Test-That ($calls[-1] -eq 'docker compose --project-name agentic-worker up -d --no-recreate') "a re-run adds what is missing and recreates nothing (last: $($calls[-1]))"

  # The core serves another build now. The worker's page (the same stand-in server) answers its state
  # at /api/local/state: absent (it cannot be read), approved, then not set up yet.
  $bundleB = $bundle.Replace(('a' * 64), ('b' * 64))
  [IO.File]::WriteAllText((Join-Path $site 'api\worker\v1\compose.yml'), $bundleB)
  $pageState = Join-Path $site 'api\local\state'
  foreach ($case in @(@{ What = 'a page that cannot be read'; State = $null }, @{ What = 'an approved worker'; State = 'connected' })) {
    if ($null -eq $case.State) { Remove-Item -LiteralPath $pageState -Force -ErrorAction SilentlyContinue } else {
      [IO.File]::WriteAllText($pageState, "{`"worker_id`":`"w1`",`"worker_name`":`"dev`",`"connection`":`"$($case.State)`",`"protocol`":3}")
    }
    & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Dir $workerDir -NoOpen
    Test-That ($LASTEXITCODE -eq 0) "another served build, $($case.What): exits 0 (it exited $LASTEXITCODE)"
    $calls = @(Get-Content -LiteralPath $log | Where-Object { $_ -like 'docker compose --project-name*' })
    Test-That ($calls[-1] -eq 'docker compose --project-name agentic-worker start') "another served build, $($case.What): only starts what is stopped (last: $($calls[-1]))"
    Test-That ([IO.File]::ReadAllText((Join-Path $workerDir 'compose.yaml')) -eq $bundle) "another served build, $($case.What): compose.yaml is unchanged"
  }
  [IO.File]::WriteAllText($pageState, '{"worker_id":null,"worker_name":null,"connection":"needs_claude","protocol":3}')
  & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Dir $workerDir -NoOpen
  Test-That ($LASTEXITCODE -eq 0) "another served build, a worker not set up yet: exits 0 (it exited $LASTEXITCODE)"
  $calls = @(Get-Content -LiteralPath $log | Where-Object { $_ -like 'docker compose --project-name*' })
  Test-That ($calls[-1] -eq 'docker compose --project-name agentic-worker up -d') "another served build, a worker not set up yet: installs it with up -d (last: $($calls[-1]))"
  Test-That ([IO.File]::ReadAllText((Join-Path $workerDir 'compose.yaml')) -eq $bundleB) 'another served build, a worker not set up yet: compose.yaml is the served bundle'
  Test-That (-not (Test-Path -LiteralPath (Join-Path $workerDir '.env'))) 'another served build, a worker not set up yet: still no .env'
  Remove-Item -LiteralPath $pageState -Force

  # A stopped worker: its page (another port here) answers nothing until `docker compose start`
  # serves it, and then reads needs_claude, so the same run installs the served build.
  $bundleC = $bundle.Replace(('a' * 64), ('c' * 64))
  [IO.File]::WriteAllText((Join-Path $site 'api\worker\v1\compose.yml'), $bundleC)
  $stoppedSite = Join-Path $root 'stopped-page'
  $null = New-Item -ItemType Directory -Force -Path (Join-Path $stoppedSite 'api\local')
  [IO.File]::WriteAllText((Join-Path $stoppedSite 'index.html'), '<!doctype html><title>worker</title>')
  [IO.File]::WriteAllText((Join-Path $stoppedSite 'api\local\state'), '{"worker_id":null,"worker_name":null,"connection":"needs_claude","protocol":3}')
  $env:APP_WORKER_UI_PORT = '7358'
  $env:STUB_START_PAGE_PORT = '7358'
  $env:STUB_START_PAGE_SITE = $stoppedSite
  & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Dir $workerDir -NoOpen
  Test-That ($LASTEXITCODE -eq 0) "a stopped worker not set up yet: exits 0 (it exited $LASTEXITCODE)"
  $calls = @(Get-Content -LiteralPath $log | Where-Object { $_ -like 'docker compose --project-name*' })
  Test-That (($calls[-2..-1] -join '|') -eq 'docker compose --project-name agentic-worker start|docker compose --project-name agentic-worker up -d') "a stopped worker not set up yet: started, then installed in the same run (last two: $($calls[-2..-1] -join ' | '))"
  Test-That ([IO.File]::ReadAllText((Join-Path $workerDir 'compose.yaml')) -eq $bundleC) 'a stopped worker not set up yet: compose.yaml is the served bundle'
  Remove-Item -LiteralPath Env:APP_WORKER_UI_PORT, Env:STUB_START_PAGE_PORT, Env:STUB_START_PAGE_SITE
  $pagePid = Join-Path $state 'page.pid'
  if (Test-Path -LiteralPath $pagePid) { Stop-Process -Id ([int](Get-Content -LiteralPath $pagePid -Raw).Trim()) -Force -ErrorAction SilentlyContinue }

  # After the updater's first update Compose's label names its mount path (S-22.21): the installer
  # still knows its own install, by its mark.
  Set-Content -LiteralPath (Join-Path $state 'wd') -Value '/var/lib/platform/host-bundle'
  & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Dir $workerDir -NoOpen
  Test-That ($LASTEXITCODE -eq 0) "a re-run after an update accepts its own install (it exited $LASTEXITCODE)"
  # And a folder without the mark, meeting that same project, refuses: it is someone else's.
  $unmarked = Join-Path $root 'unmarked'
  & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Dir $unmarked -NoOpen
  Test-That ($LASTEXITCODE -eq 3) "an unmarked folder meeting an existing project is refused (it exited $LASTEXITCODE)"
  Test-That (-not (Test-Path -LiteralPath (Join-Path $unmarked 'compose.yaml'))) 'the refused folder gets no compose file'

  # As `irm | iex` runs it: in the caller's own scope, which must survive with nothing of the
  # installer left. With no options it targets $HOME\agentic-worker, which has no mark, so the stub's
  # running project makes it refuse (exit 3) before it writes anything.
  $probe = "Invoke-Expression ([IO.File]::ReadAllText('$script')); " +
    "`$left = @(Get-Variable -Name Dir, Core, NoOpen, Uninstall, Purge, installerExitCode, CoreAddress, WorkerDir -Scope Global -ErrorAction SilentlyContinue).Count + " +
    "@(Get-Command -Name Install-Worker, Exit-Installer -ErrorAction SilentlyContinue).Count; " +
    "if (`$left -eq 0 -and `$ErrorActionPreference -eq 'Continue') { 'session-clean' } else { `"leaked `$left`" }"
  $alive = & $shell -NoProfile -ExecutionPolicy Bypass -Command $probe
  Test-That ((@($alive) -join ' ') -match 'session-clean') "an irm | iex run leaves the caller's session alive and clean (said: $(@($alive) -join ' '))"
  # And with options, as the script's header says to pass them.
  $alive = & $shell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('$script'))) -Dir '$workerDir' -NoOpen | Out-Null; 'session-alive'"
  Test-That ((@($alive) -join ' ') -match 'session-alive') "a script block run with options leaves the session alive (said: $(@($alive) -join ' '))"
  $calls = @(Get-Content -LiteralPath $log | Where-Object { $_ -like 'docker compose --project-name*' })
  Test-That ($calls[-1] -eq 'docker compose --project-name agentic-worker up -d --no-recreate') "it took its options (last: $($calls[-1]))"

  & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Dir $workerDir -Uninstall -Purge
  Test-That ($LASTEXITCODE -eq 0) "-Uninstall -Purge exits 0 (it exited $LASTEXITCODE)"
  $calls = @(Get-Content -LiteralPath $log | Where-Object { $_ -like 'docker compose --project-name*' })
  Test-That ($calls[-1] -eq 'docker compose --project-name agentic-worker down --volumes --remove-orphans') "-Purge removes the volumes (last: $($calls[-1]))"
  $volumeCalls = @(Get-Content -LiteralPath $log | Where-Object { $_ -like 'docker volume *' })
  Test-That (($volumeCalls -join '|') -eq 'docker volume inspect agentic-worker-repo-cache|docker volume rm agentic-worker-repo-cache') "-Purge removes the launcher's repository cache (asked: $($volumeCalls -join ' | '))"
  Test-That (-not (Test-Path -LiteralPath $workerDir)) '-Purge removes the folder it made'

  & $shell -NoProfile -ExecutionPolicy Bypass -File $script -Dir $workerDir -Purge
  Test-That ($LASTEXITCODE -eq 2) "-Purge without -Uninstall is a usage error (it exited $LASTEXITCODE)"
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  $pagePid = Join-Path $state 'page.pid'
  if (Test-Path -LiteralPath $pagePid) { Stop-Process -Id ([int](Get-Content -LiteralPath $pagePid -Raw).Trim()) -Force -ErrorAction SilentlyContinue }
}

if ($failures.Count -gt 0) { Write-Host "FAIL: worker-install-ps1 ($($failures.Count))"; exit 1 }
Write-Host 'PASS: worker-install-ps1'
exit 0
