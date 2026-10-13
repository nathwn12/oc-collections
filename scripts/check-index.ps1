# check-index.ps1 - verify every link in the README index table resolves.
#
# For each table row ("| <repo> | ... | `<pkg>@<ver>` | [repo](url) · [npm](url) |"):
#   * the repo link must return HTTP 200,
#   * the npm link's package must resolve on the npm registry (HTTP 200),
#   * the version pinned in the table must be a published version of that package.
# npmjs.com serves HTTP 403 to non-browser clients from this network, so npm
# resolution is taken from the registry API, which is the canonical source.
# Exit 0 only when every link resolves and every pinned version is published.
$ErrorActionPreference = 'Stop'
$readme = Join-Path $PSScriptRoot '..' 'README.md'
$ua = @{ 'User-Agent' = 'oc-collections-index-check/1.0' }
$fail = 0
$checked = 0

function Get-HttpStatus([string]$url) {
    try {
        $r = Invoke-WebRequest -Uri $url -Method Get -MaximumRedirection 5 -TimeoutSec 30 -UseBasicParsing -Headers $ua
        return [int]$r.StatusCode
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

foreach ($line in Get-Content -LiteralPath $readme) {
    if ($line -notmatch '^\| .*\[repo\]\(http') { continue }
    $cells = $line.Trim('|').Split('|')
    $repoName = $cells[0].Trim()
    if ($repoName -eq 'Repo') { continue }
    $versionPin = if ($cells[2] -match '`([^`]+)`') { $Matches[1] } else { $null }

    foreach ($m in [regex]::Matches($line, '\[(repo|npm)\]\((https?://[^)]+)\)')) {
        $kind = $m.Groups[1].Value
        $url  = $m.Groups[2].Value
        $checked++

        if ($kind -eq 'npm') {
            $pkg = [uri]::UnescapeDataString(($url -replace '^.*/package/', ''))
            $code = Get-HttpStatus "https://registry.npmjs.org/$pkg"
            if ($code -ne 200) {
                Write-Output ("FAIL {0,-16} npm  HTTP {1}  {2}" -f $repoName, $code, $url)
                $fail++
                continue
            }
            $meta = (Invoke-WebRequest -Uri "https://registry.npmjs.org/$pkg" -UseBasicParsing -Headers $ua).Content | ConvertFrom-Json
            $pin = if ($versionPin) { $versionPin.Split('@')[-1] } else { $null }
            if ($pin -and $meta.versions.PSObject.Properties.Name -notcontains $pin) {
                Write-Output ("FAIL {0,-16} npm  version {1} not published  {2}" -f $repoName, $pin, $pkg)
                $fail++
            } else {
                Write-Output ("PASS {0,-16} npm  registry OK{1}  {2}" -f $repoName, $(if ($pin) { " - $pin published" } else { '' }), $pkg)
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

Write-Output ("checked={0} failed={1}" -f $checked, $fail)
exit $(if ($fail -eq 0) { 0 } else { 1 })
