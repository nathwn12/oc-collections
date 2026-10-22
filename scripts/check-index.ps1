# check-index.ps1 - the README index, checked in two honest halves.
#
#   --structural (default, offline)
#     Every table name is well-formed, and the set of names matches the repo's
#     package inventory exactly: workspace packages, archived packages, and the
#     root manifest. A package added, renamed, or removed without the table
#     fails here. No network, so it runs on every pull request.
#
#   --registry (network, post-publish)
#     Every listed package resolves on the npm registry and every claimed
#     version is published. Packages released from this monorepo (the table in
#     scripts/index-registry.ps1) must also name `nathwn12/oc-collections` in
#     their registry `repository` metadata; packages on other release lanes
#     (oc-todo, gladius-mcp, puppet-mcp) are existence/version-only, because
#     their published metadata names their original repos by design.
#     This is the post-publish check: it cannot pass in the
#     window between a version bump and its publish, so it must not gate a PR.
#     --package <name> narrows it to one table row (used by the release
#     workflow right after it publishes that package).
#
# A run that recognises no rows exits 1 in both modes: a check that cannot go
# red proves nothing. scripts/check-index.selftest.ps1 proves the structural
# half can go red, offline.
#
# Usage: check-index.ps1 [--structural | --registry [--package <name>]] [-Path <readme>]
param(
    # Defaults to the repo README; -Path lets a fixture stand in.
    [string]$Path
)
$ErrorActionPreference = 'Stop'

$argv = @($args)
$structuralFlag = $argv -contains '--structural'
$registryFlag = $argv -contains '--registry'
if ($structuralFlag -and $registryFlag) {
    Write-Output 'FAILED: choose --structural or --registry, not both'
    exit 2
}
$mode = if ($registryFlag) { 'registry' } else { 'structural' }

$packageFilter = $null
for ($i = 0; $i -lt $argv.Count; $i++) {
    $arg = $argv[$i]
    if ($arg -in @('--structural', '--registry')) { continue }
    if ($arg -eq '--package') {
        if ($i + 1 -ge $argv.Count) {
            Write-Output 'FAILED: --package needs a package name'
            exit 2
        }
        $packageFilter = $argv[$i + 1]
        $i++
        continue
    }
    Write-Output ("FAILED: unknown argument '{0}'" -f $arg)
    exit 2
}
if ($packageFilter -and $mode -ne 'registry') {
    Write-Output 'FAILED: --package is only meaningful with --registry'
    exit 2
}

$readme = if ($Path) { $Path } else { Join-Path $PSScriptRoot '..' 'README.md' }
$ua = @{ 'User-Agent' = 'oc-collections-index-check/1.0' }

# The released/external scope table and the repository-metadata assertion.
. (Join-Path $PSScriptRoot 'index-registry.ps1')

# A scoped package's table label is its unscoped half (@scope/name -> name).
function Get-PackageLabel([string]$name) {
    if ($name -match '^@[^/]+/(.+)$') { return $Matches[1] }
    return $name
}

# Every table row in the file. Header and separator rows are skipped; other
# tables are not expected in this README.
$rows = @()
foreach ($line in Get-Content -LiteralPath $readme) {
    if ($line -notmatch '^\|') { continue }
    $cells = $line.Trim().Trim('|').Split('|')
    if ($cells.Count -lt 2) { continue }
    $name = $cells[0].Trim()
    if ($name -eq 'Repo' -or $name -match '^[-: ]+$') { continue }
    $rows += [pscustomobject]@{ Name = $name; Line = $line; Cells = $cells }
}

if ($rows.Count -eq 0) {
    Write-Output ("FAILED: no index rows recognised in {0}" -f $readme)
    exit 1
}

if ($mode -eq 'structural') {
    $fail = 0
    $checked = 0
    $names = @()

    foreach ($row in $rows) {
        $name = $row.Name
        $checked++
        if ($name -notmatch '^[a-z0-9][a-z0-9._-]*$') {
            Write-Output ("FAIL {0,-20} name is not well-formed" -f $name)
            $fail++
            continue
        }
        $names += $name
        Write-Output ("PASS {0,-20} name well-formed" -f $name)
    }

    $rootDir = Join-Path $PSScriptRoot '..'
    $expected = New-Object System.Collections.Generic.List[string]
    $rootPkg = Get-Content (Join-Path $rootDir 'package.json') -Raw | ConvertFrom-Json
    $expected.Add((Get-PackageLabel $rootPkg.name))
    foreach ($base in @('packages', 'archive')) {
        $dir = Join-Path $rootDir $base
        if (-not (Test-Path $dir)) { continue }
        foreach ($child in @(Get-ChildItem $dir -Directory)) {
            $manifest = Join-Path $child.FullName 'package.json'
            if (-not (Test-Path $manifest)) { continue }
            $pkg = Get-Content $manifest -Raw | ConvertFrom-Json
            $expected.Add((Get-PackageLabel $pkg.name))
        }
    }
    $expected = @($expected | Sort-Object -Unique)

    $actual = @($names | Sort-Object -Unique)
    $missing = @($expected | Where-Object { $_ -notin $actual })
    $extra = @($actual | Where-Object { $_ -notin $expected })
    $duplicates = @($names | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })

    foreach ($name in $missing) {
        Write-Output ("FAIL {0,-20} missing from the table" -f $name)
        $fail++
    }
    foreach ($name in $extra) {
        Write-Output ("FAIL {0,-20} table names no such package" -f $name)
        $fail++
    }
    foreach ($name in $duplicates) {
        Write-Output ("FAIL {0,-20} duplicate table row" -f $name)
        $fail++
    }

    Write-Output ("structural: rows={0} packages={1} missing={2} extra={3} failed={4}" -f $rows.Count, $expected.Count, $missing.Count, $extra.Count, $fail)
    exit $(if ($fail -eq 0) { 0 } else { 1 })
}

function Get-HttpStatus([string]$url) {
    try {
        $r = Invoke-WebRequest -Uri $url -Method Get -MaximumRedirection 5 -TimeoutSec 30 -UseBasicParsing -Headers $ua
        return [int]$r.StatusCode
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

$fail = 0
$checked = 0
$matched = 0
$npmChecked = 0
$filterLabel = if ($packageFilter) { Get-PackageLabel $packageFilter } else { $null }

foreach ($row in $rows) {
    if ($row.Line -notmatch '\[repo\]\(http') { continue }
    $repoName = $row.Name
    $label = Get-PackageLabel $repoName
    if ($filterLabel -and $label -ne $filterLabel) { continue }
    $matched++

    $versionPin = if ($row.Cells.Count -ge 3 -and $row.Cells[2] -match '`([^`]+)`') { $Matches[1] } else { $null }

    foreach ($m in [regex]::Matches($row.Line, '\[(repo|npm)\]\((https?://[^)]+)\)')) {
        $kind = $m.Groups[1].Value
        $url  = $m.Groups[2].Value
        $checked++

        if ($kind -eq 'npm') {
            $npmChecked++
            $pkg = [uri]::UnescapeDataString(($url -replace '^.*/package/', ''))
            $code = Get-HttpStatus "https://registry.npmjs.org/$pkg"
            if ($code -ne 200) {
                Write-Output ("FAIL {0,-16} npm  HTTP {1}  {2}" -f $repoName, $code, $url)
                $fail++
                continue
            }
            $meta = (Invoke-WebRequest -Uri "https://registry.npmjs.org/$pkg" -UseBasicParsing -Headers $ua).Content | ConvertFrom-Json
            $pin = if ($versionPin) { $versionPin.Split('@')[-1] } else { $null }
            $pinPublished = (-not $pin) -or ($meta.versions.PSObject.Properties.Name -contains $pin)
            if ($pin -and -not $pinPublished) {
                Write-Output ("FAIL {0,-16} npm  version {1} not published  {2}" -f $repoName, $pin, $pkg)
                $fail++
            } else {
                Write-Output ("PASS {0,-16} npm  registry OK{1}  {2}" -f $repoName, $(if ($pin) { " - $pin published" } else { '' }), $pkg)
            }
            $scope = Get-RegistryScope $pkg
            if ($scope.Scope -eq 'unknown') {
                Write-Output ("FAIL {0,-16} npm  not classified in the registry scope table ({1})" -f $repoName, $scope.Reason)
                $fail++
            } elseif ($scope.Scope -eq 'external') {
                if ($pin -and -not $pinPublished) {
                    Write-Output ("INFO {0,-16} npm  claimed version missing; repository metadata not asserted ({1})" -f $repoName, $scope.Reason)
                } else {
                    Write-Output ("PASS {0,-16} npm  existence and claimed version OK; repository metadata not asserted ({1})" -f $repoName, $scope.Reason)
                }
            } elseif ($pin -and -not $pinPublished) {
                # The claimed version is not on the registry yet, so the only
                # metadata visible belongs to an older version. Asserting it
                # would test the wrong bytes; the version failure above already
                # makes this run red.
                Write-Output ("INFO {0,-16} npm  repository metadata not asserted until {1} is published" -f $repoName, $pin)
            } else {
                $repoUrl = if ($meta.repository -is [string]) { $meta.repository } else { $meta.repository.url }
                if (-not (Test-RepositoryMetadata $pkg $repoUrl)) {
                    Write-Output ("FAIL {0,-16} npm  repository does not name oc-collections: {1} ({2})" -f $repoName, $repoUrl, $scope.Reason)
                    $fail++
                }
            }
        } else {
            $code = Get-HttpStatus $url
            if ($code -eq 200) {
                Write-Output ("PASS {0,-16} repo HTTP 200  {1}" -f $repoName, $url)
            } else {
                Write-Output ("FAIL {0,-16} repo HTTP {1}  {2}" -f $repoName, $code, $url)
                $fail++
            }
        }
    }
}

if ($packageFilter) {
    if ($matched -eq 0) {
        Write-Output ("FAILED: no index row for package '{0}'" -f $packageFilter)
        exit 1
    }
    if ($npmChecked -eq 0) {
        Write-Output ("FAILED: '{0}' has no npm link in the table" -f $packageFilter)
        exit 1
    }
}

Write-Output ("registry: checked={0} failed={1}" -f $checked, $fail)
exit $(if ($fail -eq 0) { 0 } else { 1 })
