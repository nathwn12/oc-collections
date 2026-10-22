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
#   * a fixture whose table matches the inventory less the reasoned omissions
#     passes and reports the omission count,
#   * a fixture whose omitted package has vanished from the tree exits 1 and
#     names it,
#   * a fixture whose table carries a row for an omitted package exits 1 and
#     names the double claim,
#   * the real README exits 0 with a non-empty structural summary,
#   * a released-from-here package with stale repository metadata fails,
#   * the same package with monorepo metadata passes,
#   * a not-released-from-here package with its original metadata passes,
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
    # used; any other label still becomes a phantom package. Same nine rows.
    $tableLines = @($realReadme -split "`r?`n" | Where-Object { $_ -match '^\|' })
    $headerCases = @(
        [pscustomobject]@{ Label = 'Package'; Exit = 0; Summary = '^structural: rows=7 packages=7 omitted=2 missing=0 extra=0 failed=0$' }
        [pscustomobject]@{ Label = 'Bogus'; Exit = 1; Summary = '^structural: rows=8 packages=7 omitted=2 missing=0 extra=1 failed=1$' }
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

    # 3c. Reasoned omissions. The real script bytes run against a synthetic tree:
    # a copy of the script resolves its root from its own $PSScriptRoot, so a
    # fake root exercises the vanish and double-claim guards without mutating
    # this checkout.
    $fakeRoot = Join-Path $temp 'omitted-root'
    $fakeScripts = Join-Path $fakeRoot 'scripts'
    New-Item -ItemType Directory -Force -Path $fakeScripts | Out-Null
    Copy-Item -LiteralPath $check -Destination $fakeScripts
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'index-registry.ps1') -Destination $fakeScripts
    $fakeCheck = Join-Path $fakeScripts 'check-index.ps1'
    Set-Content -LiteralPath (Join-Path $fakeRoot 'package.json') -Encoding utf8 -Value '{ "name": "oc-collections" }'
    $fakePackages = New-Object System.Collections.Generic.List[string]
    $fakePackages.AddRange([string[]]@('oc-bifrost', 'oc-flight-deck', 'oc-harness-setup', 'rea-shim', 'gladius-mcp', 'puppet-mcp', 'oc-unified'))
    function Set-FakePackage([string]$name) {
        $dir = Join-Path $fakeRoot ('packages/' + $name)
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir 'package.json') -Encoding utf8 -Value ('{ "name": "' + $name + '" }')
    }
    foreach ($name in $fakePackages) { Set-FakePackage $name }
    $fakeArchived = Join-Path $fakeRoot 'archive/oc-todo'
    New-Item -ItemType Directory -Force -Path $fakeArchived | Out-Null
    Set-Content -LiteralPath (Join-Path $fakeArchived 'package.json') -Encoding utf8 -Value '{ "name": "oc-todo" }'
    $shownFixture = Join-Path $temp 'omitted-shown.md'
    Set-Content -LiteralPath $shownFixture -Encoding utf8 -Value $realReadme

    # 3c-i. Both omitted, both still in the tree: green, and the count is reported.
    $omittedOut = @(& pwsh -NoProfile -File $fakeCheck --structural -Path $shownFixture 2>&1)
    $omittedExit = $LASTEXITCODE
    $omittedSummary = ($omittedOut | Where-Object { $_ -match '^structural:' } | Select-Object -Last 1)
    Write-Output ('omission control (both omitted, both present): exit={0}; {1}' -f $omittedExit, $omittedSummary)
    if ($omittedExit -ne 0) {
        Write-Output 'FAIL: a table matching the inventory less its omissions exited non-zero'
        $fail++
    }
    if ($omittedSummary -notmatch '^structural: rows=7 packages=7 omitted=2 missing=0 extra=0 failed=0$') {
        Write-Output 'FAIL: the omission pass did not report omitted=2 with no failures'
        $fail++
    }

    # 3c-ii. An omitted package vanishes from the tree: red, and named.
    Remove-Item -LiteralPath (Join-Path $fakeRoot 'packages/oc-unified') -Recurse -Force
    $vanishOut = @(& pwsh -NoProfile -File $fakeCheck --structural -Path $shownFixture 2>&1)
    $vanishExit = $LASTEXITCODE
    $vanishSummary = ($vanishOut | Where-Object { $_ -match '^structural:' } | Select-Object -Last 1)
    Write-Output ('vanish guard (oc-unified deleted from tree): exit={0}; {1}' -f $vanishExit, $vanishSummary)
    $vanishOut | Where-Object { $_ -match 'declared omitted but missing' } | ForEach-Object { Write-Output ('  ' + $_) }
    if ($vanishExit -eq 0) {
        Write-Output 'FAIL: an omitted package missing from the tree exited 0'
        $fail++
    }
    if (-not ($vanishOut -match 'oc-unified' -and $vanishOut -match 'declared omitted but missing from the tree')) {
        Write-Output 'FAIL: the vanish failure was not named'
        $fail++
    }
    if ($vanishSummary -notmatch 'failed=1$') {
        Write-Output 'FAIL: the vanish run did not report one failure'
        $fail++
    }
    Set-FakePackage 'oc-unified'

    # 3c-iii. An omitted package also has a table row: red, and named as a double claim.
    $doubleFixture = Join-Path $temp 'omitted-row.md'
    $doubleRow = '| oc-unified | Session watching, tool liveness, and title renaming in one plugin. | `private` | [repo](https://github.com/nathwn12/oc-collections) |'
    Set-Content -LiteralPath $doubleFixture -Encoding utf8 -Value ($realReadme.TrimEnd() + "`n`n" + $doubleRow + "`n")
    $doubleOut = @(& pwsh -NoProfile -File $fakeCheck --structural -Path $doubleFixture 2>&1)
    $doubleExit = $LASTEXITCODE
    $doubleSummary = ($doubleOut | Where-Object { $_ -match '^structural:' } | Select-Object -Last 1)
    Write-Output ('double-claim guard (oc-unified rowed while omitted): exit={0}; {1}' -f $doubleExit, $doubleSummary)
    $doubleOut | Where-Object { $_ -match 'omitted package' } | ForEach-Object { Write-Output ('  ' + $_) }
    if ($doubleExit -eq 0) {
        Write-Output 'FAIL: a table row for an omitted package exited 0'
        $fail++
    }
    if (-not ($doubleOut -match 'table row for an omitted package' -and $doubleOut -match 'private; never published')) {
        Write-Output 'FAIL: the double-claim failure was not named'
        $fail++
    }
    if ($doubleSummary -notmatch '^structural: rows=8 packages=7 omitted=2 missing=0 extra=0 failed=1$') {
        Write-Output 'FAIL: the double-claim run did not isolate its own failure'
        $fail++
    }

    # 4. Registry scope: the repository assertion in both directions, offline.
    . (Join-Path $PSScriptRoot 'index-registry.ps1')
    $scopeCases = @(
        [pscustomobject]@{ Name = 'released package, stale repository metadata'; Expected = $false; Actual = (Test-RepositoryMetadata '@nathwn12/oc-bifrost' 'git+https://github.com/nathwn12/oc-bifrost.git') }
        [pscustomobject]@{ Name = 'released package, monorepo metadata'; Expected = $true; Actual = (Test-RepositoryMetadata '@nathwn12/oc-bifrost' 'git+https://github.com/nathwn12/oc-collections.git') }
        [pscustomobject]@{ Name = 'non-released package, original metadata'; Expected = $true; Actual = (Test-RepositoryMetadata 'oc-todo' 'git+https://github.com/nathwn12/oc-todo.git') }
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
