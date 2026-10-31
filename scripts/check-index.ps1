# check-index.ps1 - the README index, checked in two honest halves.
#
#   --structural (default, offline)
#     Every table name is well-formed; a version cell is a claim (a package this
#     monorepo releases must show its workspace manifest version, and a package
#     released elsewhere must show no version literal at all); and the set of
#     names matches the repo's package inventory exactly, less the reasoned
#     omissions declared in $Omitted below: a workspace package and the root
#     manifest. A package added, renamed, or removed without the table fails here, as does an omitted package that disappears
#     from the tree or appears in the table anyway. No network, so it runs on
#     every pull request.
#
#   --registry (network, post-publish)
#     Package identity is read from the table's own cells -- the Package cell for
#     the label, the Kind cell for whether it is an install target, the Version
#     cell for the claimed pin -- and the published name is resolved from the
#     workspace manifest where one exists. Link syntax is never consulted: the
#     README is a shelf page, so a row's links cannot decide whether it counts.
#     Every installation target resolves on the npm registry and every claimed
#     version is published; a row the table declares non-installable (a kind that
#     ships no artifact, or a Version cell with no pin) is skipped with its
#     reason, never counted as a publish failure. A package declared omitted is
#     never queried.
#     Packages released from this monorepo (the table in
#     scripts/index-registry.ps1) must also name `nathwn12/oc-collections` in
#     their registry `repository` metadata; a package classified `external`
#     (released from another repository) is existence/version-only, because
#     its published metadata names that original repo by design. No package
#     is external today; the scope stays for one released elsewhere later.
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

# Deliberately not shown in the public table: a stranger cannot install it.
# This is a reasoned omission, not an allowlist of names to skip: each one must
# still exist in the tree (a vanish is a failure), and a table row for one is a
# failure too, so the table and this list can never both claim the same package.
# Empty since 2026-10-29: nothing in the tree is withheld from the table. The
# guard stays for a future private package.
$Omitted = @{}

# Kinds whose row ships an npm artifact, so a row of that kind with a version
# pin is an installation target. `repo` is deliberately absent: the index's own
# row names this monorepo's private root manifest, which is never published.
$ArtifactKinds = @('plugin', 'cli', 'mcp', 'mcp-server', 'server', 'library', 'tool')

# The released/external scope table and the repository-metadata assertion.
. (Join-Path $PSScriptRoot 'index-registry.ps1')

# A scoped package's table label is its unscoped half (@scope/name -> name).
function Get-PackageLabel([string]$name) {
    if ($name -match '^@[^/]+/(.+)$') { return $Matches[1] }
    return $name
}

# The workspace inventory, by the rule both halves need: the root manifest plus
# every packages/* (and archive/*) manifest that has one. Structural mode
# compares version cells against it; registry mode resolves a row's published
# name from it, because a table label is only the unscoped half of it.
function Get-WorkspaceInventory {
    $rootDir = Join-Path $PSScriptRoot '..'
    $names = New-Object System.Collections.Generic.List[string]
    $versions = @{}
    $manifests = @{}
    $rootPkg = Get-Content (Join-Path $rootDir 'package.json') -Raw | ConvertFrom-Json
    $rootLabel = Get-PackageLabel $rootPkg.name
    $names.Add($rootLabel)
    $versions[$rootLabel] = $rootPkg.version
    $manifests[$rootLabel] = $rootPkg.name
    foreach ($base in @('packages', 'archive')) {
        $dir = Join-Path $rootDir $base
        if (-not (Test-Path $dir)) { continue }
        foreach ($child in @(Get-ChildItem $dir -Directory)) {
            $manifest = Join-Path $child.FullName 'package.json'
            if (-not (Test-Path $manifest)) { continue }
            $pkg = Get-Content $manifest -Raw | ConvertFrom-Json
            $label = Get-PackageLabel $pkg.name
            $names.Add($label)
            $versions[$label] = $pkg.version
            $manifests[$label] = $pkg.name
        }
    }
    return [pscustomobject]@{
        Inventory = @($names | Sort-Object -Unique)
        Versions  = $versions
        Manifests = $manifests
    }
}

# Every table row in the file. Header and separator rows are skipped; other
# tables are not expected in this README.
$rows = @()
foreach ($line in Get-Content -LiteralPath $readme) {
    if ($line -notmatch '^\|') { continue }
    $cells = $line.Trim().Trim('|').Split('|')
    if ($cells.Count -lt 2) { continue }
    $name = $cells[0].Trim()
    if ($name -in @('Repo', 'Package') -or $name -match '^[-: ]+$') { continue }
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

    $tree = Get-WorkspaceInventory
    $inventory = $tree.Inventory
    $versions = $tree.Versions
    $manifests = $tree.Manifests

    # A version cell is a claim about published bytes. Only this monorepo's own
    # releases have a manifest here to compare against, so their cell must name
    # that exact version, and a package on another release lane must carry no
    # version literal at all: a literal prints this repo's belief about another
    # repo's release, which is how a stale 0.4.2 outlived its 0.4.4. Scope is
    # keyed by the published name, which is not always the table label.
    foreach ($row in $rows) {
        $name = $row.Name
        # A malformed name already failed above; one row earns one failure.
        if ($name -notmatch '^[a-z0-9][a-z0-9._-]*$') { continue }
        $cell = if ($row.Cells.Count -ge 3) { $row.Cells[2].Trim() } else { '' }
        $pin = if ($cell -match '`([^`]+)`') { $Matches[1] } else { $null }
        $published = if ($manifests.ContainsKey($name)) { $manifests[$name] } else { $name }
        $scope = (Get-RegistryScope $published).Scope
        if ($scope -eq 'released') {
            if (-not $versions.ContainsKey($name)) {
                Write-Output ("FAIL {0,-20} versions itself here but has no workspace manifest" -f $name)
                $fail++
            } elseif (-not $pin) {
                Write-Output ("FAIL {0,-20} version cell names no version (manifest {1})" -f $name, $versions[$name])
                $fail++
            } elseif ($pin -ne $versions[$name]) {
                Write-Output ("FAIL {0,-20} version {1} does not match manifest {2}" -f $name, $pin, $versions[$name])
                $fail++
            } else {
                Write-Output ("PASS {0,-20} version {1} matches its manifest" -f $name, $pin)
            }
        } elseif ($cell -match '\d+\.\d+\.\d+') {
            Write-Output ("FAIL {0,-20} shows version {1} but this monorepo does not release it" -f $name, $cell)
            $fail++
        }
    }

    # An omission list that outlives its package would hide a deletion instead of
    # recording one, so every omitted name must still be in the tree.
    foreach ($name in @($Omitted.Keys | Sort-Object)) {
        if ($name -notin $inventory) {
            Write-Output ("FAIL {0,-20} declared omitted but missing from the tree" -f $name)
            $fail++
        }
    }

    $expected = @($inventory | Where-Object { -not $Omitted.ContainsKey($_) })
    $actual = @($names | Sort-Object -Unique)

    # A row for an omitted package claims two contradictory things at once. It is
    # reported as its own failure, never silently tolerated and never miscounted
    # as a phantom package.
    $doubleClaim = @($actual | Where-Object { $Omitted.ContainsKey($_) })
    foreach ($name in $doubleClaim) {
        Write-Output ("FAIL {0,-20} table row for an omitted package ({1})" -f $name, $Omitted[$name])
        $fail++
    }

    $shown = @($actual | Where-Object { -not $Omitted.ContainsKey($_) })
    $missing = @($expected | Where-Object { $_ -notin $shown })
    $extra = @($shown | Where-Object { $_ -notin $expected })
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

    Write-Output ("structural: rows={0} packages={1} omitted={2} missing={3} extra={4} failed={5}" -f $rows.Count, $expected.Count, $Omitted.Count, $missing.Count, $extra.Count, $fail)
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

# One npm registry document, or the status that stood in for it. The fixture
# seam exists so scripts/check-index.selftest.ps1 can prove the version and
# metadata assertions go red without network: CHECK_INDEX_REGISTRY_FIXTURES
# naming a directory of `<published-name>.json` documents stands in for the
# registry, a scoped name losing its @ and keeping `__` for the slash. Unset in
# every real run, where registry.npmjs.org answers.
function Get-NpmMetadata([string]$Name) {
    $dir = $env:CHECK_INDEX_REGISTRY_FIXTURES
    if ($dir) {
        $file = Join-Path $dir ((($Name -replace '^@', '').Replace('/', '__')) + '.json')
        if (-not (Test-Path -LiteralPath $file)) { return [pscustomobject]@{ Code = 404; Meta = $null } }
        return [pscustomobject]@{ Code = 200; Meta = (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json) }
    }
    $url = "https://registry.npmjs.org/$Name"
    $code = Get-HttpStatus $url
    if ($code -ne 200) { return [pscustomobject]@{ Code = $code; Meta = $null } }
    $meta = (Invoke-WebRequest -Uri $url -UseBasicParsing -Headers $ua -TimeoutSec 30).Content | ConvertFrom-Json
    return [pscustomobject]@{ Code = 200; Meta = $meta }
}

$fail = 0
$checked = 0
$matched = 0
$filterLabel = if ($packageFilter) { Get-PackageLabel $packageFilter } else { $null }
# A table label is the unscoped half of the published name; the full name comes
# from the workspace manifest where this monorepo releases the package.
$manifests = (Get-WorkspaceInventory).Manifests

foreach ($row in $rows) {
    $label = Get-PackageLabel $row.Name
    if ($filterLabel -and $label -ne $filterLabel) { continue }

    $kindCell    = if ($row.Cells.Count -ge 2) { $row.Cells[1].Trim() } else { '' }
    $versionCell = if ($row.Cells.Count -ge 3) { $row.Cells[2].Trim() } else { '' }
    # The Version cell is the table's own claim about published bytes, so its
    # backticked pin is what gets asserted -- never a link. A row carrying no pin
    # is not an installation target: `oc-collections` (kind `repo`, this
    # monorepo's private root manifest) and `oc-talk` (private, owner
    # ruling) both say so in their own cells, so no name list is needed. A
    # released package that drops its pin is still caught, by structural mode's
    # "version cell names no version".
    $pin = if ($versionCell -match '`([^`]+)`') { $Matches[1].Split('@')[-1] } else { $null }
    if (-not $pin -or ($ArtifactKinds -notcontains $kindCell)) {
        Write-Output ("SKIP {0,-16} kind={1} version-cell='{2}'  not an installation target" -f $label, $kindCell, $versionCell)
        continue
    }
    $matched++
    $checked++
    $published = if ($manifests.ContainsKey($label)) { $manifests[$label] } else { $label }

    $result = Get-NpmMetadata $published
    if ($result.Code -ne 200) {
        Write-Output ("FAIL {0,-16} npm  HTTP {1}  {2}" -f $label, $result.Code, $published)
        $fail++
        continue
    }
    $meta = $result.Meta
    $pinPublished = $meta.versions.PSObject.Properties.Name -contains $pin
    if ($pinPublished) {
        Write-Output ("PASS {0,-16} npm  registry OK - {1} published  {2}" -f $label, $pin, $published)
    } else {
        Write-Output ("FAIL {0,-16} npm  version {1} not published  {2}" -f $label, $pin, $published)
        $fail++
    }
    $scope = Get-RegistryScope $published
    if ($scope.Scope -eq 'unknown') {
        Write-Output ("FAIL {0,-16} npm  not classified in the registry scope table ({1})" -f $label, $scope.Reason)
        $fail++
    } elseif ($scope.Scope -eq 'external') {
        if (-not $pinPublished) {
            Write-Output ("INFO {0,-16} npm  claimed version missing; repository metadata not asserted ({1})" -f $label, $scope.Reason)
        } else {
            Write-Output ("PASS {0,-16} npm  existence and claimed version OK; repository metadata not asserted ({1})" -f $label, $scope.Reason)
        }
    } elseif (-not $pinPublished) {
        # The claimed version is not on the registry yet, so the only metadata
        # visible belongs to an older version. Asserting it would test the wrong
        # bytes; the version failure above already makes this run red.
        Write-Output ("INFO {0,-16} npm  repository metadata not asserted until {1} is published" -f $label, $pin)
    } else {
        $repoUrl = if ($meta.repository -is [string]) { $meta.repository } else { $meta.repository.url }
        if (-not (Test-RepositoryMetadata $published $repoUrl)) {
            Write-Output ("FAIL {0,-16} npm  repository does not name oc-collections: {1} ({2})" -f $label, $repoUrl, $scope.Reason)
            $fail++
        }
    }
}

if ($packageFilter -and $matched -eq 0) {
    # A row can exist and still name no installation target; that is a different
    # failure from a missing row. Both exit 1.
    $known = @($rows | Where-Object { (Get-PackageLabel $_.Name) -eq $filterLabel }).Count
    if ($known -gt 0) {
        Write-Output ("FAILED: row for package '{0}' is not an installation target (no version pin)" -f $packageFilter)
    } else {
        Write-Output ("FAILED: no index row for package '{0}'" -f $packageFilter)
    }
    exit 1
}

Write-Output ("registry: checked={0} failed={1}" -f $checked, $fail)
exit $(if ($fail -eq 0) { 0 } else { 1 })
