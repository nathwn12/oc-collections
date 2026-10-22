# check-index.selftest.ps1 - prove both index checks can go red, offline.
#
# The structural unit is scripts/check-index.ps1 --structural; the registry
# unit is the scope table and repository assertion in scripts/index-registry.ps1.
# A check that always exits 0 proves nothing, so this self-test asserts, all
# without network:
#   * a fixture with no index rows exits 1 and says why,
#   * a fixture table naming a package that is not in the repo exits 1 and
#     names the phantom,
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
