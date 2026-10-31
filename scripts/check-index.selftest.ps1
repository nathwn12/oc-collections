# check-index.selftest.ps1 - prove both index checks can go red, offline.
#
# The structural unit is scripts/check-index.ps1 --structural; the registry
# unit is the scope table and repository assertion in scripts/index-registry.ps1.
# A check that always exits 0 proves nothing, so this self-test asserts, all
# without network:
#   * a fixture with no index rows exits 1 and says why,
#   * a fixture table naming a package that is not in the repo exits 1 and
#     names the phantom,
#   * a fixture with header `Package` passes like one with header `Repo`, and a
#     fixture with any other header label still fails as a phantom package,
#   * a fixture whose released package shows a stale version exits 1 and names
#     the mismatch,
#   * a fixture whose package released elsewhere shows a version literal exits 1
#     and names the row,
#   * the real README exits 0 with a non-empty structural summary,
#   * a released-from-here package with stale repository metadata fails,
#   * the same package with monorepo metadata passes,
#   * an externally released package (fixture classification) with its original
#     metadata passes,
#   * an unclassified package fails instead of being guessed,
#   * registry mode reads a shelf-shaped table (Package | Kind | Version | What it
#     does | Install, no [repo]/[npm] link anywhere) and finds every installation
#     target from the cells, resolving a scoped published name from its manifest,
#   * a shelf row whose pinned version is not published fails,
#   * a shelf row with no version pin and no artifact kind is skipped, not failed,
#   * --package for an absent package exits 1, and for a row that is not an
#     installation target exits 1 with that reason.
# The registry cases run the real script bytes against registry documents in
# CHECK_INDEX_REGISTRY_FIXTURES instead of the network, so they hold offline; the
# live registry itself is exercised by the post-publish --registry run, not here.
# Exit 0 only when every direction holds.
$ErrorActionPreference = 'Stop'
$check = Join-Path $PSScriptRoot 'check-index.ps1'
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('oc-collections-check-index-selftest-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$fail = 0
try {
    # 1. No rows at all.
    $emptyFixture = Join-Path $temp 'no-index-rows.md'
    Set-Content -LiteralPath $emptyFixture -Encoding utf8 -Value @(
        '# Not an index',
        '',
        'This file has a heading and prose, but no index table rows.',
        ''
    )
    $emptyOut = @(& pwsh -NoProfile -File $check --structural -Path $emptyFixture 2>&1)
    $emptyExit = $LASTEXITCODE
    Write-Output ('negative control (zero rows): exit={0}' -f $emptyExit)
    $emptyOut | ForEach-Object { Write-Output ('  ' + $_) }
    if ($emptyExit -eq 0) {
        Write-Output 'FAIL: a zero-row input exited 0'
        $fail++
    }
    if (-not ($emptyOut -match 'no index rows recognised')) {
        Write-Output 'FAIL: a zero-row input did not name the failure'
        $fail++
    }

    # 2. A real table plus a phantom package row.
    $phantomFixture = Join-Path $temp 'phantom-package.md'
    $realReadme = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..' 'README.md') -Raw
    $phantomRow = '| phantom-pkg | Phantom package. | not on npm | [repo](https://example.com) |'
    Set-Content -LiteralPath $phantomFixture -Encoding utf8 -Value ($realReadme.TrimEnd() + "`n`n" + $phantomRow + "`n")
    $phantomOut = @(& pwsh -NoProfile -File $check --structural -Path $phantomFixture 2>&1)
    $phantomExit = $LASTEXITCODE
    Write-Output ('negative control (phantom package): exit={0}' -f $phantomExit)
    $phantomOut | Where-Object { $_ -match 'phantom-pkg|no such package' } | ForEach-Object { Write-Output ('  ' + $_) }
    if ($phantomExit -eq 0) {
        Write-Output 'FAIL: a table naming a non-existent package exited 0'
        $fail++
    }
    if (-not ($phantomOut -match 'phantom-pkg' -and $phantomOut -match 'no such package')) {
        Write-Output 'FAIL: the phantom-package failure was not named'
        $fail++
    }

    # 3. The real README passes, offline.
    $posOut = @(& pwsh -NoProfile -File $check --structural 2>&1)
    $posExit = $LASTEXITCODE
    $summary = ($posOut | Where-Object { $_ -match '^structural:' } | Select-Object -Last 1)
    Write-Output ('positive control (README): exit={0}; {1}' -f $posExit, $summary)
    if ($posExit -ne 0) {
        Write-Output 'FAIL: the real README did not pass the structural check'
        $fail++
    }
    if ($summary -notmatch '^structural: rows=(\d+) .* failed=0$' -or [int]$Matches[1] -lt 1) {
        Write-Output 'FAIL: the structural run recognised no rows'
        $fail++
    }

    # 3b. The header row is skipped by label, in either spelling this index has
    # used; any other label still becomes a phantom package, so the same table
    # gains exactly one row, one phantom, one failure. Counts are read back from
    # the positive control just run rather than frozen here, so this stays a
    # test of header handling and not of how many packages happen to exist.
    $tableLines = @($realReadme -split "`r?`n" | Where-Object { $_ -match '^\|' })
    $readmeRows = 0
    $readmePackages = 0
    if ($summary -match '^structural: rows=(\d+) packages=(\d+) ') {
        $readmeRows = [int]$Matches[1]
        $readmePackages = [int]$Matches[2]
    }
    $headerCases = @(
        [pscustomobject]@{ Label = 'Package'; Exit = 0; Rows = $readmeRows; Packages = $readmePackages; Extra = 0; Failed = 0 }
        [pscustomobject]@{ Label = 'Bogus'; Exit = 1; Rows = $readmeRows + 1; Packages = $readmePackages; Extra = 1; Failed = 1 }
    )
    foreach ($case in $headerCases) {
        $fixture = Join-Path $temp ('header-' + $case.Label + '.md')
        $table = @(($tableLines[0] -replace '^\|[^|]*\|', ('| ' + $case.Label + ' |'))) + @($tableLines | Select-Object -Skip 1)
        Set-Content -LiteralPath $fixture -Encoding utf8 -Value $table
        $headerOut = @(& pwsh -NoProfile -File $check --structural -Path $fixture 2>&1)
        $headerExit = $LASTEXITCODE
        $headerSummary = ($headerOut | Where-Object { $_ -match '^structural:' } | Select-Object -Last 1)
        Write-Output ('header token ({0}): exit={1}; {2}' -f $case.Label, $headerExit, $headerSummary)
        $headerOut | Where-Object { $_ -match 'no such package' } | ForEach-Object { Write-Output ('  ' + $_) }
        if ($headerExit -ne $case.Exit) {
            Write-Output ('FAIL: header {0} exited {1}, expected {2}' -f $case.Label, $headerExit, $case.Exit)
            $fail++
        }
        if ($headerSummary -notmatch ('^structural: rows={0} packages={1} omitted=0 missing=0 extra={2} failed={3}$' -f $case.Rows, $case.Packages, $case.Extra, $case.Failed)) {
            Write-Output ('FAIL: header {0} did not produce the expected summary' -f $case.Label)
            $fail++
        }
        if ($case.Exit -ne 0 -and -not ($headerOut -match ('FAIL ' + $case.Label) -and $headerOut -match 'no such package')) {
            Write-Output ('FAIL: header {0} did not fail as a phantom package' -f $case.Label)
            $fail++
        }
    }

    # 3c. A synthetic tree. The real script bytes run against a copy that
    # resolves its root from its own $PSScriptRoot, so version fixtures exercise
    # the real inventory rules without mutating this checkout.
    $fakeRoot = Join-Path $temp 'synthetic-root'
    $fakeScripts = Join-Path $fakeRoot 'scripts'
    New-Item -ItemType Directory -Force -Path $fakeScripts | Out-Null
    Copy-Item -LiteralPath $check -Destination $fakeScripts
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'index-registry.ps1') -Destination $fakeScripts
    $fakeCheck = Join-Path $fakeScripts 'check-index.ps1'
    # The fixture tree mirrors the real inventory by the same rule the checker
    # uses -- the root manifest plus every packages/*/package.json -- so a
    # package added to the repo needs no edit here and the version fixtures
    # below, built from the real README, always line up with it.
    $realRootManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..' 'package.json') -Raw | ConvertFrom-Json
    Set-Content -LiteralPath (Join-Path $fakeRoot 'package.json') -Encoding utf8 -Value ('{ "name": "' + $realRootManifest.name + '", "version": "' + $realRootManifest.version + '" }')
    $fakePackages = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '..' 'packages') -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
        Sort-Object Name |
        ForEach-Object { $_.Name })
    function Set-FakePackage([string]$name) {
        $dir = Join-Path $fakeRoot ('packages/' + $name)
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        # The structural check compares a released package's version cell with
        # its manifest, and resolves scope by the published name, so the fake
        # tree carries both from the real manifest: a scoped package must keep
        # its scope or its lane becomes unclassifiable.
        $realManifest = Join-Path $PSScriptRoot '..' 'packages' $name 'package.json'
        $real = Get-Content -LiteralPath $realManifest -Raw | ConvertFrom-Json
        Set-Content -LiteralPath (Join-Path $dir 'package.json') -Encoding utf8 -Value ('{ "name": "' + $real.name + '", "version": "' + $real.version + '" }')
    }
    foreach ($name in $fakePackages) { Set-FakePackage $name }

    # 3d. Version cells are claims. A released package must show its manifest
    # version; a package released elsewhere must show no version literal at all.
    function Set-VersionCell([string]$text, [string]$name, [string]$cell) {
        $out = foreach ($line in ($text -split "`r?`n")) {
            if ($line -match ('^\| ' + [regex]::Escape($name) + ' \|')) {
                $cells = $line.Trim().Trim('|').Split('|')
                $cells[2] = ' ' + $cell + ' '
                '|' + ($cells -join '|') + '|'
            } else { $line }
        }
        return ($out -join "`n")
    }
    $versionCases = @(
        [pscustomobject]@{
            What   = 'released package, stale version cell'
            Name   = 'oc-harness-setup'
            Cell   = '`0.0.1`'
            Needle = 'does not match manifest'
        }
    )
    foreach ($case in $versionCases) {
        $versionFixture = Join-Path $temp ('version-' + $case.Name + '.md')
        Set-Content -LiteralPath $versionFixture -Encoding utf8 -Value (Set-VersionCell $realReadme $case.Name $case.Cell)
        $versionOut = @(& pwsh -NoProfile -File $fakeCheck --structural -Path $versionFixture 2>&1)
        $versionExit = $LASTEXITCODE
        $versionSummary = ($versionOut | Where-Object { $_ -match '^structural:' } | Select-Object -Last 1)
        Write-Output ('version guard ({0}): exit={1}; {2}' -f $case.What, $versionExit, $versionSummary)
        $versionOut | Where-Object { $_ -match ('FAIL ' + $case.Name) } | ForEach-Object { Write-Output ('  ' + $_) }
        if ($versionExit -eq 0) {
            Write-Output ('FAIL: {0} exited 0' -f $case.What)
            $fail++
        }
        if (-not ($versionOut -match [regex]::Escape($case.Name) -and $versionOut -match $case.Needle)) {
            Write-Output ('FAIL: {0} was not named as {1}' -f $case.What, $case.Needle)
            $fail++
        }
        if ($versionSummary -notmatch 'failed=1$') {
            Write-Output ('FAIL: {0} did not report one failure' -f $case.What)
            $fail++
        }
    }

    # 4. Registry scope: the repository assertion in both directions, offline.
    . (Join-Path $PSScriptRoot 'index-registry.ps1')
    # No live index package is released from another repository today, so the
    # 'external' lane is exercised with a fixture classification instead of a
    # name this index no longer carries.
    $script:RegistryScope['external-fixture'] = [pscustomobject]@{
        Scope  = 'external'
        Reason = 'selftest fixture: released from its own repository'
    }
    $scopeCases = @(
        [pscustomobject]@{ Name = 'released package, stale repository metadata'; Expected = $false; Actual = (Test-RepositoryMetadata '@nathwn12/oc-bifrost' 'git+https://github.com/nathwn12/oc-bifrost.git') }
        [pscustomobject]@{ Name = 'released package, monorepo metadata'; Expected = $true; Actual = (Test-RepositoryMetadata '@nathwn12/oc-bifrost' 'git+https://github.com/nathwn12/oc-collections.git') }
        [pscustomobject]@{ Name = 'externally released package, original metadata'; Expected = $true; Actual = (Test-RepositoryMetadata 'external-fixture' 'git+https://github.com/nathwn12/external-fixture.git') }
        [pscustomobject]@{ Name = 'unclassified package'; Expected = $false; Actual = (Test-RepositoryMetadata 'mystery-pkg' 'git+https://github.com/nathwn12/oc-collections.git') }
    )
    foreach ($case in $scopeCases) {
        Write-Output ('scope control ({0}): expected={1} actual={2}' -f $case.Name, $case.Expected, $case.Actual)
        if ($case.Actual -ne $case.Expected) {
            Write-Output ('FAIL: ' + $case.Name)
            $fail++
        }
    }

    # 5. Registry mode reads the shelf table, not link syntax. The fixture README
    # is the README's shape -- Package | Kind | Version | What it does | Install
    # -- and carries no [repo]/[npm] link at all, which is precisely what made
    # the old link filter match zero rows. Registry documents served from
    # CHECK_INDEX_REGISTRY_FIXTURES stand in for npm, so row discovery, target
    # classification and the version/metadata assertions are all proven here
    # offline. The scoped package's document is keyed by its published name, so a
    # row resolved to the bare label 404s instead of quietly passing.
    $shelfFixture = Join-Path $temp 'shelf.md'
    $shelfLines = @(
        '# Shelf index',
        '',
        '| Package | Kind | Version | What it does | Install |',
        '| --- | --- | --- | --- | --- |',
        '| oc-bifrost | plugin | `1.6.13` | Scoped fixture row. | Add `@nathwn12/oc-bifrost` to your `plugins`. |',
        '| oc-flight-deck | plugin | `0.21.0` | Fixture row with a published pin. | Add `oc-flight-deck` to your `plugins`. |',
        '| oc-harness-setup | CLI | `1.0.0` | Fixture row. | `npx -y oc-harness-setup setup` |',
        '| oc-talk | plugin | not published | Private fixture row. | Nothing installs it. |',
        '| oc-collections | repo | — | The index itself. | — |',
        ''
    )
    Set-Content -LiteralPath $shelfFixture -Encoding utf8 -Value $shelfLines
    $shelfText = Get-Content -LiteralPath $shelfFixture -Raw
    $shelfRepoLinks = [regex]::Matches($shelfText, '\[repo\]\(http').Count
    $shelfNpmLinks = [regex]::Matches($shelfText, '\[npm\]\(http').Count
    Write-Output ('shelf fixture: repo-links={0} npm-links={1}' -f $shelfRepoLinks, $shelfNpmLinks)
    if ($shelfRepoLinks -ne 0 -or $shelfNpmLinks -ne 0) {
        Write-Output 'FAIL: the shelf fixture carries a link, so it cannot prove the old filter saw no rows'
        $fail++
    }

    $registryDir = Join-Path $temp 'registry'
    New-Item -ItemType Directory -Force -Path $registryDir | Out-Null
    function Set-RegistryDoc([string]$file, [string]$name, [string]$version) {
        $doc = '{ "name": "' + $name + '", "versions": { "' + $version + '": {} }, "repository": { "type": "git", "url": "git+https://github.com/nathwn12/oc-collections.git" } }'
        Set-Content -LiteralPath (Join-Path $registryDir $file) -Encoding utf8 -Value $doc
    }
    Set-RegistryDoc 'nathwn12__oc-bifrost.json' '@nathwn12/oc-bifrost' '1.6.13'
    Set-RegistryDoc 'oc-flight-deck.json' 'oc-flight-deck' '0.21.0'
    Set-RegistryDoc 'oc-harness-setup.json' 'oc-harness-setup' '1.0.0'

    $staleFixture = Join-Path $temp 'shelf-stale.md'
    Set-Content -LiteralPath $staleFixture -Encoding utf8 -Value (Set-VersionCell $shelfText 'oc-flight-deck' '`9.9.9`')

    $previousFixtures = $env:CHECK_INDEX_REGISTRY_FIXTURES
    $env:CHECK_INDEX_REGISTRY_FIXTURES = $registryDir
    try {
        $registryCases = @(
            [pscustomobject]@{
                What    = 'shelf table, every pin published'
                Path    = $shelfFixture
                Args    = @()
                Exit    = 0
                Summary = '^registry: checked=3 failed=0$'
                Needles = @('PASS oc-bifrost.*@nathwn12/oc-bifrost', 'PASS oc-flight-deck', 'PASS oc-harness-setup', 'SKIP oc-talk', 'SKIP oc-collections')
            }
            [pscustomobject]@{
                What    = 'shelf table, not-yet-released pin'
                Path    = $staleFixture
                Args    = @()
                Exit    = 1
                Summary = '^registry: checked=3 failed=1$'
                Needles = @('FAIL oc-flight-deck.*version 9\.9\.9 not published')
            }
            [pscustomobject]@{
                What    = '--package names a target row'
                Path    = $shelfFixture
                Args    = @('--package', 'oc-flight-deck')
                Exit    = 0
                Summary = '^registry: checked=1 failed=0$'
                Needles = @('PASS oc-flight-deck')
            }
            [pscustomobject]@{
                What    = '--package names an absent row'
                Path    = $shelfFixture
                Args    = @('--package', 'oc-not-in-the-table')
                Exit    = 1
                Summary = $null
                Needles = @("FAILED: no index row for package 'oc-not-in-the-table'")
            }
            [pscustomobject]@{
                What    = '--package names a non-target row'
                Path    = $shelfFixture
                Args    = @('--package', 'oc-talk')
                Exit    = 1
                Summary = $null
                Needles = @('not an installation target')
            }
        )
        foreach ($case in $registryCases) {
            $caseArgv = @('--registry') + @($case.Args) + @('-Path', $case.Path)
            $caseOut = @(& pwsh -NoProfile -File $fakeCheck @caseArgv 2>&1)
            $caseExit = $LASTEXITCODE
            Write-Output ('shelf registry ({0}): exit={1}' -f $case.What, $caseExit)
            $caseOut | Where-Object { $_ -match '^(PASS|FAIL|SKIP|FAILED|INFO|registry:)' } | ForEach-Object { Write-Output ('  ' + $_) }
            if ($caseExit -ne $case.Exit) {
                Write-Output ('FAIL: shelf registry {0} exited {1}, expected {2}' -f $case.What, $caseExit, $case.Exit)
                $fail++
            }
            foreach ($needle in $case.Needles) {
                if (@($caseOut | Where-Object { $_ -match $needle }).Count -eq 0) {
                    Write-Output ('FAIL: shelf registry {0} never showed {1}' -f $case.What, $needle)
                    $fail++
                }
            }
            if ($case.Summary -and @($caseOut | Where-Object { $_ -match $case.Summary }).Count -eq 0) {
                Write-Output ('FAIL: shelf registry {0} did not produce the expected summary' -f $case.What)
                $fail++
            }
        }
    } finally {
        if ($null -eq $previousFixtures) {
            Remove-Item Env:\CHECK_INDEX_REGISTRY_FIXTURES -ErrorAction SilentlyContinue
        } else {
            $env:CHECK_INDEX_REGISTRY_FIXTURES = $previousFixtures
        }
    }
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output ('selftest failed={0}' -f $fail)
exit $(if ($fail -eq 0) { 0 } else { 1 })
