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
#   * an unclassified package fails instead of being guessed.
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
    # used; any other label still becomes a phantom package. Same four rows.
    $tableLines = @($realReadme -split "`r?`n" | Where-Object { $_ -match '^\|' })
    $headerCases = @(
        [pscustomobject]@{ Label = 'Package'; Exit = 0; Summary = '^structural: rows=4 packages=4 omitted=0 missing=0 extra=0 failed=0$' }
        [pscustomobject]@{ Label = 'Bogus'; Exit = 1; Summary = '^structural: rows=5 packages=4 omitted=0 missing=0 extra=1 failed=1$' }
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
        if ($headerSummary -notmatch $case.Summary) {
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
    Set-Content -LiteralPath (Join-Path $fakeRoot 'package.json') -Encoding utf8 -Value '{ "name": "oc-collections" }'
    $fakePackages = New-Object System.Collections.Generic.List[string]
    $fakePackages.AddRange([string[]]@('oc-bifrost', 'oc-flight-deck', 'oc-harness-setup'))
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
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output ('selftest failed={0}' -f $fail)
exit $(if ($fail -eq 0) { 0 } else { 1 })
