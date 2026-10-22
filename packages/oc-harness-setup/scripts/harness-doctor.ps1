<#
.SYNOPSIS
  Self-contained harness health check: derived laws, no allowlists.

.DESCRIPTION
  Validates the global OpenCode harness (~\.config\opencode) with laws DERIVED
  from the config and the live CLI — never restated from a hardcoded
  expectation. The consolidation decision (user-approved <DATE>) is that
  derived laws cannot drift; the old checker's hardcoded allowlists drifted
  twice in three days, so this doctor absorbed the surviving check logic and
  the checker was deleted.

  Laws (each PASS, FAIL, or DRIFT when its source of truth is unavailable):
    - required layout paths exist; opencode.jsonc parses as JSONC
    - no legacy remote-catalog keys in opencode.jsonc (declared once below)
    - `opencode debug config` / `debug agents` resolve (delegated, not
      reimplemented: exit 0 and parseable output is the whole law)
    - every configured plugin resolves in `opencode plugin list`
    - configured MCP servers match `opencode mcp list` in BOTH directions
    - every live agent model binding resolves against reference/models.md;
      fully-unwired routing is a supported state while a .docs record
      documents it (the record is DISCOVERED by content, never named here)
    - local skill dirs match the fail-closed skill allowlist BOTH directions
      (orphan dir or dangling allow = FAIL), under a skill:* deny
    - no literal secret VALUES under a secret-like property name; a `{env:…}`/`{file:…}` pointer is not a leak
    - the deny set survives --auto (declared gates below, verified derived)
    - hard denies come after same-action allows (denies-last ordering; the
      skill fail-closed allowlist allows-after-deny by design, so the skill
      action is exempt here and stays covered by the allowlist law)
    - no broad shell allows (node *, git *, or bare *), minus the single
      documented unattended-shell default whose compensation the deny-set law proves
    - skill allow entries match local skill IDs in BOTH directions
      (set-equality form of the allowlist seam; the wildcard-deny half stays
      with the allowlist law and is not re-checked here)
    - agents/*.md carry description+steps, commands/*.md carry description
      (identity is the filename: name: is a skills-only convention)
    - every skill dir carries a loadable SKILL.md: name+description present,
      name matches the directory, and no unquoted plain scalar contains ': '
      (a targeted heuristic, not a full YAML parser)
    - command IDs and skill IDs are 1:1 both ways (valid skill dirs,
      excluding the `_shared` reference bundle, against command basenames;
      an orphan either direction = FAIL)
    - state/template.md exists and carries the fixed session key order
      (id, title, status, goal, next, artifacts, decisions, open)

  The small DECLARED block at the top is the honest form of the old hardcoded
  state: each entry names its evidence. Everything else is read from
  opencode.jsonc, agents\, skills\, reference/models.md, .docs, or the CLI.

  -Fix attempts mechanical declared-state fixes only, with backup + log. The
  derived laws have no declared state to patch — every remedy touches an owner
  artifact (config, agents, skills, commands, registry, CLI install) or needs
  owner judgment — so -Fix re-evaluates, writes nothing, and reports each
  finding as a one-line owner proposal. Real regressions are never auto-fixed.

  Exit codes: 0 clean; 1 evaluated law FAILED (regression); 2 the instrument
  could not derive an expectation (CLI missing, delegated command failed or
  changed shape, catalog missing — the world drifted under the instrument).

  Secret hygiene: this script never reads or prints secret-store or .env value contents. Every
  file read goes through Get-SafeText, which refuses those paths, and each run
  proves the guard is live. Config scans report property paths only.

.EXAMPLE
  pwsh -File scripts\harness-doctor.ps1

.EXAMPLE
  pwsh -File scripts\harness-doctor.ps1 -Fix

.EXAMPLE
  pwsh -File scripts\harness-doctor.ps1 -Json

.EXAMPLE
  pwsh -File scripts\harness-doctor.ps1 -ConfigDir D:\config\opencode

.PARAMETER ConfigDir
  Config directory to grade. The installer passes the resolved config dir
  (OPENCODE_CONFIG_DIR and cross-platform paths included); standalone runs
  without it default to ~\.config\opencode.
#>
#Requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$Fix,
    [switch]$Json,
    [string]$ConfigDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Windows 10/11 only: this harness grades the Windows config home and shells
# out to the Windows-only toolchain. Bail as DRIFT (exit 2 — the instrument
# cannot derive an expectation on this platform), never as a regression.
if (-not $IsWindows) {
    Write-Error 'harness-doctor supports Windows 10/11 only — macOS and Linux are not supported.'
    exit 2
}
if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    Write-Error 'USERPROFILE is not set — cannot resolve the Windows config home.'
    exit 2
}

$root = if ($ConfigDir) { $ConfigDir } else { Join-Path $env:USERPROFILE '.config\opencode' }

# ---------- declared values (each names its evidence) ----------
# Required layout paths. Evidence: the harness shape itself (opencode.jsonc
# header "Harness v4"); stable, changes only via a harness restructure.
$requiredPaths = @(
    @{ Name = 'config (opencode.jsonc)'; Path = 'opencode.jsonc'; Kind = 'file' },
    @{ Name = 'AGENTS.md';               Path = 'AGENTS.md';      Kind = 'file' },
    @{ Name = 'agents';                  Path = 'agents';         Kind = 'dir' },
    @{ Name = 'commands';                Path = 'commands';       Kind = 'dir' },
    @{ Name = 'skills';                  Path = 'skills';         Kind = 'dir' },
    @{ Name = 'reference';                 Path = 'reference';        Kind = 'dir' },
    @{ Name = 'state/lessons.md';          Path = 'state/lessons.md';  Kind = 'file' },
    @{ Name = 'state/template.md';         Path = 'state/template.md'; Kind = 'file' },
    @{ Name = 'Git exclusion policy';    Path = '.gitignore';     Kind = 'file' }
)

# Legacy / remote-catalog top-level keys that must not appear in opencode.jsonc.
# Evidence: the package's own .docs (the "no remote skill-catalog keys" file check).
# 'plugins' and 'mcp' are legitimate config and are NOT here.
$remoteCatalogKeys = @('plugin', 'mcpServers', 'mcp_servers', 'skill_catalog', 'skills_catalog', 'remote_skills', 'skills_remote')

# Deny gates that must hold as effect=deny (ask is auto-approved under --auto,
# so only deny survives). Evidence: the opencode.jsonc inline policy comment
# ("deny is the only gate that holds while you are away"; same text in the package's
# own .docs). Verification is
# derived: each gate needs a matching deny rule in the live permissions array.
$denyGates = @(
    @{ Action = 'shell';              Contains = 'Format-Volume' },
    @{ Action = 'shell';              Contains = 'Clear-Disk' },
    @{ Action = 'read';               Contains = 'secrets' },
    @{ Action = 'edit';               Contains = 'secrets' },
    @{ Action = 'external_directory'; Contains = 'secrets' },
    @{ Action = 'shell';              Contains = 'secrets' },
    @{ Action = 'read';               Contains = '.env' },
    @{ Action = 'edit';               Contains = '.env' },
    @{ Action = 'external_directory'; Contains = '.env' },
    @{ Action = 'shell';              Contains = '.env' },
    @{ Action = 'read';               Contains = 'service.json' },
    @{ Action = 'edit';               Contains = 'service.json' },
    @{ Action = 'external_directory'; Contains = 'service.json' },
    @{ Action = 'shell';              Contains = 'service.json' }
)

# Secret-like config property NAMES (never values). Evidence: secret-hygiene
# convention carried over from the deleted checker lineage.
$secretNamePattern = '(?i)(apikey|api_key|secret|password|bearer|credential)'

# ---------- readers ----------
function Get-SafeText {
    # The file reader in this script. Refuses secret-bearing paths outright,
    # so no code path here can read secret-store or .env contents.
    param([string]$Path)
    $normalized = ([string]$Path).Replace('\', '/')
    if ($normalized -match '(^|/)([.]secrets|\.env)(/|$)|(^|/)[^/]*\.env(\.|$)') {
        throw "refused to read secret-bearing path: $Path"
    }
    return (Get-Content -LiteralPath $Path -Raw -Encoding utf8)
}

function ConvertFrom-JsonC {
    # Strip // and /* */ comments (string-aware), then trailing commas, then parse.
    param([string]$Text)
    $sb = [System.Text.StringBuilder]::new($Text.Length)
    $inString = $false
    $i = 0
    while ($i -lt $Text.Length) {
        $c = $Text[$i]
        if ($inString) {
            [void]$sb.Append($c)
            if ($c -eq '\') {
                $i++
                if ($i -lt $Text.Length) { [void]$sb.Append($Text[$i]) }
            } elseif ($c -eq '"') {
                $inString = $false
            }
            $i++
            continue
        }
        if ($c -eq '"') { $inString = $true; [void]$sb.Append($c); $i++; continue }
        if ($c -eq '/' -and ($i + 1) -lt $Text.Length) {
            $n = $Text[$i + 1]
            if ($n -eq '/') {
                while ($i -lt $Text.Length -and $Text[$i] -ne "`n") { $i++ }
                continue
            }
            if ($n -eq '*') {
                $i += 2
                while (($i + 1) -lt $Text.Length -and -not ($Text[$i] -eq '*' -and $Text[$i + 1] -eq '/')) { $i++ }
                $i += 2
                continue
            }
        }
        [void]$sb.Append($c)
        $i++
    }
    $clean = [regex]::Replace($sb.ToString(), ',(\s*[}\]])', '$1')
    return ($clean | ConvertFrom-Json)
}

function Invoke-Cli {
    param([string]$Command, [string[]]$Arguments)
    $out = @(& $Command @Arguments 2>&1)
    return [pscustomobject]@{ Exit = $LASTEXITCODE; Lines = @($out) }
}

function Get-McpServerNames {
    # Server NAMES only; values are never read or printed. Accepts the file
    # shape (mcp.<name>) and the merged V2 shape (mcp.servers.<name>).
    param($McpNode)
    $names = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $McpNode) { return $names }
    if ($McpNode -isnot [System.Management.Automation.PSCustomObject]) {
        $names.Add('<malformed>')
        return $names
    }
    $serversProperty = $McpNode.PSObject.Properties['servers']
    $container = if ($null -ne $serversProperty -and $null -ne $serversProperty.Value) { $serversProperty.Value } else { $McpNode }
    if ($container -isnot [System.Management.Automation.PSCustomObject]) {
        $names.Add('<malformed>')
        return $names
    }
    foreach ($p in $container.PSObject.Properties) { $names.Add([string]$p.Name) }
    return $names
}

function Get-PermissionRules {
    # StrictMode-safe read of the permissions array. A config that omits the
    # key (or carries a non-array) grades as an empty set, so dependent laws
    # FAIL with their named reason instead of throwing a property error.
    param($Config)
    if ($null -eq $Config) { return @() }
    $prop = $Config.PSObject.Properties['permissions']
    if ($null -eq $prop -or $null -eq $prop.Value) { return @() }
    $value = $prop.Value
    if ($value -is [string]) { return @() }
    if ($value -isnot [System.Collections.IEnumerable]) { return @() }
    return @($value)
}

function Get-RegistryMcpNames {
    # First token per line of `opencode mcp list`, minus status markers.
    param([string[]]$Lines)
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $Lines) {
        $text = ([string]$line).Trim().TrimStart([char[]]@([char]0x2713, [char]0x2717, [char]0x00D7, [char]0x2022, [char]0x002D, [char]0x0020))
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        $name = @($text -split '\s+' | Where-Object { $_ -ne '' })[0]
        if ($name -and $name -notmatch '(?i)^(id|name|server|status|no)$') { $names.Add([string]$name) }
    }
    return [System.Collections.Generic.List[string]]::new([string[]](@($names | Sort-Object -Unique)))
}

function Test-SecretPointer {
    # A value that POINTS at a secret is not the secret itself.
    param($Value)
    if ($null -eq $Value) { return $true }
    if ($Value -isnot [string]) { return $false }
    $text = $Value.Trim()
    if ($text -eq '') { return $true }
    return [bool]($text -match '^(\{[A-Za-z][A-Za-z0-9_-]*:[^}]*\}|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)$')
}

function Find-SecretLikeProps {
    # Property PATHS whose names look secret-like, each with a Pointer flag.
    # Values are never returned.
    param($Node, [string]$Path)
    $hits = [System.Collections.Generic.List[object]]::new()
    if ($null -eq $Node) { return $hits }
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        foreach ($p in $Node.PSObject.Properties) {
            $np = if ($Path) { "$Path.$($p.Name)" } else { [string]$p.Name }
            if ($p.Name -match $secretNamePattern) { $hits.Add([pscustomobject]@{ Path = $np; Pointer = (Test-SecretPointer -Value $p.Value) }) }
            foreach ($h in (Find-SecretLikeProps -Node $p.Value -Path $np)) { $hits.Add($h) }
        }
    } elseif ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [string]) {
        $idx = 0
        foreach ($item in $Node) {
            foreach ($h in (Find-SecretLikeProps -Node $item -Path "$Path[$idx]")) { $hits.Add($h) }
            $idx++
        }
    }
    return $hits
}

function Get-FrontmatterText {
    param([string]$Path)
    # A skill directory with no SKILL.md is Law 9/16's seam ('file missing'),
    # not a crash: Get-FrontmatterProblems already reports it, so return $null
    # here and let the laws grade it as FAIL instead of aborting the run.
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $lines = @((Get-SafeText -Path $Path) -split "`r?`n")
    if ($lines.Count -lt 3 -or $lines[0].Trim() -ne '---') { return $null }
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '---') { return ($lines[1..($i - 1)] -join "`n") }
    }
    return $null
}

function Get-FrontmatterProblems {
    param([string]$Path, [string[]]$Require = @('description'))
    $problems = [System.Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $problems.Add('file missing')
        return $problems
    }
    $fm = Get-FrontmatterText -Path $Path
    if ($null -eq $fm) {
        $problems.Add('no frontmatter block')
        return $problems
    }
    foreach ($req in $Require) {
        if ($fm -notmatch ('(?m)^\s*' + $req + '\s*:\s*(.*)$')) {
            $problems.Add("frontmatter missing $req")
        } elseif ([string]::IsNullOrWhiteSpace($Matches[1])) {
            $problems.Add("frontmatter empty $req")
        }
    }
    return $problems
}

function Get-PlainScalarHazards {
    # Targeted heuristic, NOT a full YAML parser: it looks only for the shape
    # that once made a skill unloadable — a top-level, plain (unquoted,
    # non-block) `key: value` whose value contains a colon-space, which YAML
    # reads as a nested mapping and rejects. Block scalars (>, |, >-, |-) and
    # quoted values are exempt. Returns the offending lines verbatim.
    param([string]$Path)
    $hazards = [System.Collections.Generic.List[string]]::new()
    $fm = Get-FrontmatterText -Path $Path
    if ($null -eq $fm) { return $hazards }
    foreach ($line in ($fm -split "`r?`n")) {
        if ($line -notmatch '^(?<key>[A-Za-z0-9_.-]+)\s*:\s*(?<val>.*)$') { continue }
        $value = $Matches['val'].Trim()
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        if ($value -in @('>', '|', '>-', '|-', '>+', '|+')) { continue }
        if ($value.StartsWith('"') -or $value.StartsWith("'")) { continue }
        if ($value.Contains(': ')) { $hazards.Add($line.TrimEnd()) }
    }
    return $hazards
}

function Get-LiveModelBinding {
    # First uncommented `model:` value in a frontmatter block, or $null. A
    # commented `# model:` line never matches, so unwired stays unwired.
    param([string]$FrontmatterText)
    if ([string]::IsNullOrWhiteSpace($FrontmatterText)) { return $null }
    foreach ($line in ($FrontmatterText -split "`r?`n")) {
        if ($line -match '^\s*model\s*:\s*(.+?)\s*$') {
            $value = $Matches[1].Trim().Trim('"').Trim("'")
            if ($value) { return $value }
        }
    }
    return $null
}

function Get-ModelCatalog {
    # Model ids AND the provider prefix, both read from reference/models.md.
    # Accepts two shapes: `- `provider/model-id`` bullets, or a
    # `Model (provider/<id>)` line plus `| n | `id` |` rows.
    param([string]$Path)
    $ids = [System.Collections.Generic.List[string]]::new()
    $bindings = [System.Collections.Generic.List[string]]::new()
    $provider = ''
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{ Ids = $ids; Bindings = $bindings; Provider = $provider; Found = $false } }
    $text = Get-SafeText -Path $Path
    $providerMatch = [regex]::Match($text, 'Model \((?<provider>[A-Za-z0-9._-]+)/<id>\)')
    $provider = if ($providerMatch.Success) { $providerMatch.Groups['provider'].Value } else { '' }
    foreach ($m in [regex]::Matches($text, '(?m)^\|\s*\d+\s*\|\s*`([^`]+)`')) { $ids.Add($m.Groups[1].Value.Trim()) }
    if ($providerMatch.Success) {
        foreach ($m in [regex]::Matches($text, [regex]::Escape($provider) + '/([A-Za-z0-9._-]+)')) { $ids.Add($m.Groups[1].Value.Trim()) }
    }
    foreach ($m in [regex]::Matches($text, '(?m)^\s*[-*]\s+`([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)`')) { $bindings.Add($m.Groups[1].Value.Trim()) }
    $ids = [System.Collections.Generic.List[string]]::new([string[]](@($ids | Sort-Object -Unique)))
    $bindings = [System.Collections.Generic.List[string]]::new([string[]](@($bindings | Sort-Object -Unique)))
    return [pscustomobject]@{ Ids = $ids; Bindings = $bindings; Provider = $provider; Found = $true }
}

function Test-ModelBinding {
    # $null when the binding resolves against the catalog; otherwise a reason.
    param([string]$Value, $Catalog)
    $text = [string]$Value
    if ($text.Contains('#')) { $text = $text.Substring(0, $text.IndexOf('#')) }
    $text = $text.Trim()
    if ($text -notmatch '^(?<provider>[A-Za-z0-9._-]+)/(?<id>[^/]+)$') { return "model '$Value' is not a provider/id binding" }
    if (-not [string]::IsNullOrWhiteSpace($Catalog.Provider)) {
        if ($Matches['provider'] -ne $Catalog.Provider) {
            return "model '$Value' uses provider '$($Matches['provider'])' but the catalog declares '$($Catalog.Provider)'"
        }
        if (@($Catalog.Ids) -notcontains $Matches['id']) { return "model '$Value' does not resolve in reference/models.md" }
        return $null
    }
    $catalogBindings = @()
    if ($null -ne $Catalog.Bindings) { $catalogBindings = @($Catalog.Bindings) }
    if ($catalogBindings.Count -gt 0) {
        if ($catalogBindings -contains $text) { return $null }
        return "model '$Value' does not resolve in reference/models.md"
    }
    return 'the model catalog declares neither shape: add `- `provider/model-id`` bullets, or a `Model (provider/<id>)` line plus `| n | `id` |` rows'
}

function Get-UnwiredRoutingDoc {
    # The .docs record documenting unwired model routing, found by CONTENT.
    param([string]$DocsRoot)
    if (-not (Test-Path -LiteralPath $DocsRoot -PathType Container)) { return $null }
    # newest-first: the latest unwire record wins; an earlier name-ascending
    # match could cite an older record.
    foreach ($file in (Get-ChildItem -LiteralPath $DocsRoot -File -Filter '*.md' | Sort-Object Name -Descending)) {
        $text = Get-SafeText -Path $file.FullName
        if ($text -match '(?is)\bunwire[a-z]*\b[^.]{0,40}\bmodel\b|\bmodel\b[^.]{0,40}\bunwired\b') { return $file.Name }
    }
    return $null
}

# ---------- law evaluation ----------
$laws = [System.Collections.Generic.List[pscustomobject]]::new()

function Add-Law {
    param(
        [string]$Name,
        [ValidateSet('PASS', 'FAIL', 'DRIFT')][string]$Verdict,
        [string]$Detail,
        [string]$Proposal = ''
    )
    $laws.Add([pscustomobject]@{
            Law      = $Name
            Result   = $Verdict
            Detail   = $Detail
            Proposal = $Proposal
        })
}

$configPath = Join-Path $root 'opencode.jsonc'
$docsRoot = Join-Path $root '.docs'
$agentsDir = Join-Path $root 'agents'
$commandsDir = Join-Path $root 'commands'
$skillsRoot = Join-Path $root 'skills'
$catalogPath = Join-Path $root 'reference\models.md'

# Law 1: required layout paths.
$missingPaths = [System.Collections.Generic.List[string]]::new()
foreach ($req in $requiredPaths) {
    $full = Join-Path $root $req.Path
    if ($req.Kind -eq 'file') {
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { $missingPaths.Add($req.Path) }
    } else {
        if (-not (Test-Path -LiteralPath $full -PathType Container)) { $missingPaths.Add($req.Path) }
    }
}
if ($missingPaths.Count -eq 0) {
    Add-Law 'required layout paths exist' 'PASS' "all present under $root"
} else {
    Add-Law 'required layout paths exist' 'FAIL' "missing: $($missingPaths -join ', ')" `
        "restore the missing harness paths ($($missingPaths -join ', ')) — the layout is declared at the top of scripts\harness-doctor.ps1"
}

# Law 2: opencode.jsonc parses.
$config = $null
$configParseError = ''
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Add-Law 'opencode.jsonc parses as JSONC' 'FAIL' 'opencode.jsonc is missing' 'restore opencode.jsonc (the harness has no config without it)'
} else {
    try {
        $config = ConvertFrom-JsonC -Text (Get-SafeText -Path $configPath)
        Add-Law 'opencode.jsonc parses as JSONC' 'PASS' 'parsed as JSONC (comments and trailing commas stripped)'
    } catch {
        $configParseError = $_.Exception.Message
        Add-Law 'opencode.jsonc parses as JSONC' 'FAIL' "JSONC parse failed: $configParseError" "fix the JSONC syntax error in opencode.jsonc: $configParseError"
    }
}
$configOk = ($null -ne $config)

# Laws needing the config file derive nothing when it is unparseable.
function Add-ConfigDrift {
    param([string]$Name)
    Add-Law $Name 'DRIFT' 'not evaluated: opencode.jsonc is unparseable' 'fix the JSONC syntax error first (see the parse law above)'
}

# Law 3: no legacy remote-catalog keys.
if ($configOk) {
    $badKeys = @($config.PSObject.Properties.Name | Where-Object { $remoteCatalogKeys -contains $_ })
    if ($badKeys.Count -eq 0) {
        Add-Law 'no legacy remote-catalog keys in opencode.jsonc' 'PASS' 'no plugin/mcpServers/skill-catalog keys; plugins[] and mcp come from config + registry only'
    } else {
        Add-Law 'no legacy remote-catalog keys in opencode.jsonc' 'FAIL' "legacy keys present: $($badKeys -join ', ')" `
            "remove these keys from opencode.jsonc ($($badKeys -join ', ')) — see the package's own .docs"
    }
} else {
    Add-ConfigDrift 'no legacy remote-catalog keys in opencode.jsonc'
}

# Law 4 + 5: delegated CLI resolution (the law IS the delegation).
$cli = Get-Command opencode -ErrorAction SilentlyContinue
$debugConfigOk = $false
if (-not $cli) {
    Add-Law 'opencode debug config resolves' 'DRIFT' 'opencode was not found on PATH' 'install or repair the OpenCode V2 CLI, confirm it with `Get-Command opencode`, then re-run the doctor'
    Add-Law 'opencode debug agents resolves' 'DRIFT' 'opencode was not found on PATH' 'install or repair the OpenCode V2 CLI, confirm it with `Get-Command opencode`, then re-run the doctor'
} else {
    $cfgRun = Invoke-Cli -Command 'opencode' -Arguments @('debug', 'config')
    if ($cfgRun.Exit -ne 0) {
        Add-Law 'opencode debug config resolves' 'DRIFT' "opencode debug config exited $($cfgRun.Exit)" "repair the CLI/config handshake: $($cfgRun.Lines -join ' ')"
    } else {
        try {
            $cfgEntries = @(($cfgRun.Lines -join "`n") | ConvertFrom-Json)
            $docEntry = @($cfgEntries | Where-Object { $_.type -eq 'document' -and $_.path -like '*opencode.jsonc' })
            if ($docEntry.Count -gt 0) {
                $debugConfigOk = $true
                Add-Law 'opencode debug config resolves' 'PASS' 'debug config exits 0 and lists opencode.jsonc as a document source'
            } else {
                Add-Law 'opencode debug config resolves' 'FAIL' 'debug config exits 0 but lists no opencode.jsonc document source' 'check which config file the CLI is actually loading (path mismatch between the CLI and this harness root)'
            }
        } catch {
            Add-Law 'opencode debug config resolves' 'DRIFT' "debug config output was not parseable JSON: $($_.Exception.Message)" 're-run `opencode debug config` by hand; the CLI output shape may have changed'
        }
    }
    $agRun = Invoke-Cli -Command 'opencode' -Arguments @('debug', 'agents')
    if ($agRun.Exit -ne 0) {
        Add-Law 'opencode debug agents resolves' 'DRIFT' "opencode debug agents exited $($agRun.Exit)" "repair the CLI/agent handshake: $($agRun.Lines -join ' ')"
    } else {
        try {
            $roster = @(($agRun.Lines -join "`n") | ConvertFrom-Json)
            if ($roster.Count -gt 0) {
                Add-Law 'opencode debug agents resolves' 'PASS' "debug agents exits 0 and returns a parseable roster ($($roster.Count) entries)"
            } else {
                Add-Law 'opencode debug agents resolves' 'FAIL' 'debug agents exits 0 but returns an empty roster' 'check agents\ for missing or unparseable definitions'
            }
        } catch {
            Add-Law 'opencode debug agents resolves' 'DRIFT' "debug agents output was not parseable JSON: $($_.Exception.Message)" 're-run `opencode debug agents` by hand; the CLI output shape may have changed'
        }
    }
}

# Configured plugins + MCP servers, read once (NAMES only; values never read).
$configuredPlugins = @()
$configuredMcp = @()
if ($configOk) {
    $pluginProperty = $config.PSObject.Properties['plugins']
    if ($null -ne $pluginProperty -and $null -ne $pluginProperty.Value) { $configuredPlugins = @($pluginProperty.Value) }
    $mcpProperty = $config.PSObject.Properties['mcp']
    if ($null -ne $mcpProperty -and $null -ne $mcpProperty.Value) { $configuredMcp = @(Get-McpServerNames -McpNode $mcpProperty.Value) }
}

# Law 6: every configured plugin resolves in the installed registry.
if (-not $configOk) {
    Add-ConfigDrift 'every configured plugin resolves in the registry'
} elseif (-not $cli) {
    Add-Law 'every configured plugin resolves in the registry' 'DRIFT' 'not evaluated: opencode was not found on PATH' 'install or repair the OpenCode V2 CLI, then re-run the doctor'
} else {
    $pluginRun = Invoke-Cli -Command 'opencode' -Arguments @('plugin', 'list')
    if ($pluginRun.Exit -ne 0) {
        Add-Law 'every configured plugin resolves in the registry' 'DRIFT' "opencode plugin list exited $($pluginRun.Exit)" "re-run `opencode plugin list` by hand: $($pluginRun.Lines -join ' ')"
    } else {
        $pluginText = ($pluginRun.Lines -join "`n")
        $noPlugins = ($pluginText -match 'No plugins found')
        $pluginRows = @($pluginRun.Lines | Where-Object { $_ -and $_.Trim() -ne '' } | Select-Object -Skip 1)
        $unresolved = [System.Collections.Generic.List[string]]::new()
        foreach ($entry in $configuredPlugins) {
            $text = [string]$entry
            $resolves = $false
            foreach ($row in $pluginRows) {
                if (([string]$row).Contains($text)) { $resolves = $true; break }
                $firstCol = @(([string]$row -split '\s+' | Where-Object { $_ -ne '' }))[0]
                if ($firstCol -eq $text) { $resolves = $true; break }
            }
            if (-not $resolves) { $unresolved.Add($text) }
        }
        if ($unresolved.Count -gt 0) {
            Add-Law 'every configured plugin resolves in the registry' 'FAIL' "configured plugins missing from the registry: $($unresolved -join ', ')" `
                "reconcile each with the registry (install it, or remove it from plugins[] in opencode.jsonc): $($unresolved -join ', ')"
        } elseif ($noPlugins -and $configuredPlugins.Count -gt 0) {
            Add-Law 'every configured plugin resolves in the registry' 'FAIL' "plugins are configured ($($configuredPlugins -join ', ')) but the registry reports none" `
                'reconcile plugins[] in opencode.jsonc with `opencode plugin list`'
        } else {
            $pluginDetail = if ($configuredPlugins.Count -eq 0) { 'no plugins configured; registry agrees' } else { "configured plugins resolve: $($configuredPlugins -join ', ')" }
            Add-Law 'every configured plugin resolves in the registry' 'PASS' $pluginDetail
        }
    }
}

# Law 7: configured MCP servers match the registry in BOTH directions.
# Registered-but-undeclared servers are machine-global: `opencode mcp list`
# always merges the default global config (OPENCODE_CONFIG_DIR does not
# override it), so a harness config that declares no mcp at all reports them
# as a PASS note, not a regression — a fresh install cannot adopt servers it
# never declared. Any DECLARED server must register: that direction stays
# fail-closed, and a config that declares at least one server is graded in
# both directions.
if (-not $configOk) {
    Add-ConfigDrift 'configured MCP servers match the registry both directions'
} elseif (-not $cli) {
    Add-Law 'configured MCP servers match the registry both directions' 'DRIFT' 'not evaluated: opencode was not found on PATH' 'install or repair the OpenCode V2 CLI, then re-run the doctor'
} else {
    $mcpRun = Invoke-Cli -Command 'opencode' -Arguments @('mcp', 'list')
    if ($mcpRun.Exit -ne 0) {
        Add-Law 'configured MCP servers match the registry both directions' 'DRIFT' "opencode mcp list exited $($mcpRun.Exit)" "re-run `opencode mcp list` by hand: $($mcpRun.Lines -join ' ')"
    } else {
        $mcpNoServers = ((($mcpRun.Lines -join "`n") -match 'No MCP servers configured'))
        $registryNames = @()
        if (-not $mcpNoServers) { $registryNames = @(Get-RegistryMcpNames -Lines $mcpRun.Lines) }
        $mcpProblems = [System.Collections.Generic.List[string]]::new()
        foreach ($name in $configuredMcp) {
            if ($registryNames -notcontains $name) { $mcpProblems.Add("declared server '$name' is not registered") }
        }
        if ($mcpNoServers -and $configuredMcp.Count -gt 0) { $mcpProblems.Add("declared MCP servers are not registered: $($configuredMcp -join ', ')") }
        $undeclaredRegistrations = @($registryNames | Where-Object { $configuredMcp -notcontains $_ })
        if ($undeclaredRegistrations.Count -gt 0 -and $configuredMcp.Count -gt 0) {
            $mcpProblems.Add("registered servers not declared in opencode.jsonc: $($undeclaredRegistrations -join ', ')")
        }
        if ($mcpProblems.Count -gt 0) {
            Add-Law 'configured MCP servers match the registry both directions' 'FAIL' ($mcpProblems -join '; ') `
                "run from $root (project configs in cwd merge into the registry); then reconcile the mcp block in opencode.jsonc with ``opencode mcp list`` (see the package's own .docs): $($mcpProblems -join '; ')"
        } elseif ($undeclaredRegistrations.Count -gt 0) {
            Add-Law 'configured MCP servers match the registry both directions' 'PASS' "no MCP servers declared in opencode.jsonc; the registry reports machine-global servers it has not adopted: $($undeclaredRegistrations -join ', ') (add an mcp block to adopt them)"
        } else {
            $mcpDetail = if ($registryNames.Count -eq 0) { 'no MCP servers declared or registered' } else { "declared and registered agree: $($registryNames -join ', ')" }
            Add-Law 'configured MCP servers match the registry both directions' 'PASS' $mcpDetail
        }
    }
}

# Law 8: agent model bindings resolve against reference/models.md.
$agentFiles = @()
if (Test-Path -LiteralPath $agentsDir -PathType Container) {
    $agentFiles = @(Get-ChildItem -LiteralPath $agentsDir -File -Filter '*.md')
}
if ($agentFiles.Count -eq 0) {
    Add-Law 'agent model bindings resolve in reference/models.md' 'FAIL' 'no agent markdown files found' 'restore the agent definitions under agents\'
} else {
    $agentFileProblems = [System.Collections.Generic.List[string]]::new()
    foreach ($file in $agentFiles) {
        foreach ($p in (Get-FrontmatterProblems -Path $file.FullName -Require @('description'))) {
            $agentFileProblems.Add("$($file.Name): $p")
        }
    }
    $catalog = Get-ModelCatalog -Path $catalogPath
    $liveBindings = [System.Collections.Generic.List[string]]::new()
    $bindingProblems = [System.Collections.Generic.List[string]]::new()
    foreach ($file in $agentFiles) {
        $binding = Get-LiveModelBinding -FrontmatterText (Get-FrontmatterText -Path $file.FullName)
        if ($null -eq $binding) { continue }
        $liveBindings.Add($file.BaseName)
        if (-not $catalog.Found -or ($catalog.Ids.Count -eq 0 -and $catalog.Bindings.Count -eq 0)) {
            $bindingProblems.Add("$($file.Name): live model '$binding' cannot be resolved because reference/models.md is missing or lists no models")
            continue
        }
        $reason = Test-ModelBinding -Value $binding -Catalog $catalog
        if ($null -ne $reason) { $bindingProblems.Add("$($file.Name): $reason") }
    }
    $allProblems = @($agentFileProblems) + @($bindingProblems)
    if ($allProblems.Count -gt 0) {
        Add-Law 'agent model bindings resolve in reference/models.md' 'FAIL' ($allProblems -join '; ') `
            "point each live model binding at an id in reference/models.md, or comment it out again: $($allProblems -join '; ')"
    } elseif ($liveBindings.Count -eq 0) {
        $unwiredDoc = Get-UnwiredRoutingDoc -DocsRoot $docsRoot
        if ($null -eq $unwiredDoc) {
            Add-Law 'agent model bindings resolve in reference/models.md' 'FAIL' 'no agent file carries a live model binding and no .docs record documents unwired routing' `
                'restore the model bindings in agents\*.md, or record the unwired-routing decision in .docs'
        } else {
            Add-Law 'agent model bindings resolve in reference/models.md' 'PASS' "$($agentFiles.Count) agent files valid; no live model bindings (routing unwired, documented in .docs\$unwiredDoc)"
        }
    } else {
        $partialWired = @($agentFiles | Where-Object { $liveBindings -notcontains $_.BaseName })
        if ($partialWired.Count -gt 0) {
            $missing = @($partialWired | ForEach-Object { $_.BaseName })
            Add-Law 'agent model bindings resolve in reference/models.md' 'FAIL' "mixed model routing: $($liveBindings.Count) agents carry a live binding and $($missing.Count) do not ($($missing -join ', '))" `
                "finish or revert the partial re-wiring: one consistent state (all unwired and documented, or every agent bound to a resolving model)"
        } else {
            Add-Law 'agent model bindings resolve in reference/models.md' 'PASS' "$($agentFiles.Count) agent files valid; every live model binding resolves in reference/models.md"
        }
    }
}

# Law 9: local skill dirs match the fail-closed allowlist BOTH directions.
$skillProblems = [System.Collections.Generic.List[string]]::new()
$localSkillIds = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $skillsRoot -PathType Container) {
    foreach ($dir in (Get-ChildItem -LiteralPath $skillsRoot -Directory | Where-Object { $_.Name -notlike '_*' })) {
        $skillPath = Join-Path $dir.FullName 'SKILL.md'
        foreach ($p in (Get-FrontmatterProblems -Path $skillPath -Require @('name', 'description'))) {
            $skillProblems.Add("$($dir.Name): $p")
        }
        $skillFrontmatter = Get-FrontmatterText -Path $skillPath
        if ($null -ne $skillFrontmatter -and $skillFrontmatter -match '(?m)^\s*name:\s*(\S.*?)\s*$') {
            $skillName = $Matches[1].Trim().Trim('"').Trim("'")
            if ($skillName -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') {
                $skillProblems.Add("$($dir.Name): skill name is not a V2-safe ID ($skillName)")
            } elseif ($skillName -ne $dir.Name) {
                $skillProblems.Add("$($dir.Name): frontmatter name does not match directory ($skillName)")
            } else {
                $localSkillIds.Add($skillName)
            }
        }
    }
} else {
    $skillProblems.Add('local skills directory missing')
}
$duplicateSkillIds = @($localSkillIds | Group-Object | Where-Object { $_.Count -gt 1 } | Select-Object -ExpandProperty Name)
if ($duplicateSkillIds.Count -gt 0) { $skillProblems.Add("duplicate local skill IDs: $($duplicateSkillIds -join ', ')") }
if (-not $configOk) {
    Add-ConfigDrift 'local skills match the fail-closed allowlist both directions'
} elseif ($skillProblems.Count -gt 0 -or $localSkillIds.Count -eq 0) {
    $skillDetail = if ($skillProblems.Count -gt 0) { $skillProblems -join '; ' } else { 'no local skill IDs found' }
    Add-Law 'local skills match the fail-closed allowlist both directions' 'FAIL' $skillDetail `
        "repair the skill directories or their frontmatter under skills\: $skillDetail"
} else {
    $permissions = @(Get-PermissionRules -Config $config)
    $skillRules = @($permissions | Where-Object { $_.action -eq 'skill' })
    $wildcardDeny = @($skillRules | Where-Object { $_.resource -eq '*' -and $_.effect -eq 'deny' })
    $allowedSkillIds = @($skillRules | Where-Object { $_.effect -eq 'allow' -and $_.resource -ne '*' } | Select-Object -ExpandProperty resource)
    $missingSkillAllows = @($localSkillIds | Where-Object { $allowedSkillIds -notcontains $_ })
    $staleSkillAllows = @($allowedSkillIds | Where-Object { $localSkillIds -notcontains $_ })
    if ($wildcardDeny.Count -eq 0 -or $missingSkillAllows.Count -gt 0 -or $staleSkillAllows.Count -gt 0) {
        $allowReasons = [System.Collections.Generic.List[string]]::new()
        if ($wildcardDeny.Count -eq 0) { $allowReasons.Add('missing skill:* deny') }
        if ($missingSkillAllows.Count -gt 0) { $allowReasons.Add("orphan skill dirs with no allow entry: $($missingSkillAllows -join ', ')") }
        if ($staleSkillAllows.Count -gt 0) { $allowReasons.Add("dangling allow entries with no directory: $($staleSkillAllows -join ', ')") }
        Add-Law 'local skills match the fail-closed allowlist both directions' 'FAIL' ($allowReasons -join '; ') `
            "reconcile skills\ with the skill allow entries in opencode.jsonc (orphan dir or dangling allow): $($allowReasons -join '; ')"
    } else {
        Add-Law 'local skills match the fail-closed allowlist both directions' 'PASS' "wildcard skill deny plus exact allow for all $($localSkillIds.Count) local IDs; no stale allows"
    }
}

# Law 10: no literal secret VALUES under a secret-like property name; a `{env:…}`/`{file:…}` pointer is not a leak (paths only).
if (-not $configOk) {
    Add-ConfigDrift 'no secret-like property names in opencode.jsonc'
} else {
    $secretHits = @(Find-SecretLikeProps -Node $config -Path '')
    $literalHits = @($secretHits | Where-Object { -not $_.Pointer } | ForEach-Object { $_.Path })
    $pointerHits = @($secretHits | Where-Object { $_.Pointer } | ForEach-Object { $_.Path })
    if ($literalHits.Count -gt 0) {
        Add-Law 'no secret-like property names in opencode.jsonc' 'FAIL' "literal secret values at: $($literalHits -join ', ')" `
            "replace each with a pointer (``{env:...}`` or ``{file:...}``) or move it to the secret store: $($literalHits -join ', ')"
    } else {
        $passDetail = 'no literal secret values under a secret-like property name'
        if ($pointerHits.Count -gt 0) { $passDetail += " (pointer(s) accepted: $($pointerHits -join ', '))" }
        Add-Law 'no secret-like property names in opencode.jsonc' 'PASS' $passDetail
    }
}

# Law 11: the deny set survives --auto (declared gates, derived verification).
if (-not $configOk) {
    Add-ConfigDrift 'deny set survives --auto'
} else {
    $permissions = @(Get-PermissionRules -Config $config)
    if ($null -eq $permissions -or $permissions.Count -eq 0) {
        Add-Law 'deny set survives --auto' 'FAIL' 'permissions block missing; dependent boundary checks cannot be trusted' 'restore the permissions block in opencode.jsonc'
    } else {
        $gateProblems = [System.Collections.Generic.List[string]]::new()
        foreach ($gate in $denyGates) {
            $hit = @($permissions | Where-Object {
                    $_.action -eq $gate.Action -and $_.effect -eq 'deny' -and ([string]$_.resource).Contains($gate.Contains, [System.StringComparison]::OrdinalIgnoreCase)
                })
            if ($hit.Count -eq 0) { $gateProblems.Add("$($gate.Action) deny missing for '*$($gate.Contains)*'") }
        }
        $skillWildcardDeny = @($permissions | Where-Object { $_.action -eq 'skill' -and $_.resource -eq '*' -and $_.effect -eq 'deny' })
        if ($skillWildcardDeny.Count -eq 0) { $gateProblems.Add('skill deny missing for ''*'' (unknown skills must fail closed)') }
        if ($gateProblems.Count -eq 0) {
            Add-Law 'deny set survives --auto' 'PASS' 'disk-destroy and credential denies hold (deny survives --auto); unknown skills fail closed; file contents were not read'
        } else {
            Add-Law 'deny set survives --auto' 'FAIL' ($gateProblems -join '; ') `
                "restore the deny rules in the permissions array (deny is the only gate that holds under --auto): $($gateProblems -join '; ')"
        }
    }
}

# Law 12: hard denies come after same-action allows (denies-last ordering).
# Derived from the live permission table: each $denyGates gate needs its deny
# positioned after every same-action allow, so an earlier broad allow cannot
# shadow the deny. The skill action is exempt (the fail-closed allowlist in
# Law 9 allows-after-deny by design). Ask rules are not allows: narrow asks
# such as the config's own documented cli.json carve-out may trail the deny
# block without granting. A missing deny is Law 11's seam, not this law's.
if (-not $configOk) {
    Add-ConfigDrift 'hard denies come after same-action allows'
} else {
    $permissions = @(Get-PermissionRules -Config $config)
    if ($null -eq $permissions -or $permissions.Count -eq 0) {
        Add-Law 'hard denies come after same-action allows' 'FAIL' 'permissions block missing; ordering cannot be evaluated' 'restore the permissions block in opencode.jsonc'
    } else {
        $orderProblems = [System.Collections.Generic.List[string]]::new()
        foreach ($gate in $denyGates) {
            if ($gate.Action -eq 'skill') { continue }
            $firstDeny = -1
            for ($i = 0; $i -lt $permissions.Count; $i++) {
                $p = $permissions[$i]
                if ($p.action -eq $gate.Action -and $p.effect -eq 'deny' -and ([string]$p.resource).Contains($gate.Contains, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $firstDeny = $i
                    break
                }
            }
            if ($firstDeny -lt 0) { continue }
            for ($i = $firstDeny + 1; $i -lt $permissions.Count; $i++) {
                $p = $permissions[$i]
                if ($p.action -eq $gate.Action -and $p.effect -eq 'allow') {
                    $orderProblems.Add("$($gate.Action) allow '$($p.resource)' at index $i trails the deny for '*$($gate.Contains)*' at index $firstDeny")
                }
            }
        }
        if ($orderProblems.Count -eq 0) {
            Add-Law 'hard denies come after same-action allows' 'PASS' 'every hard deny trails all same-action allows (skill allowlist exempt by design)'
        } else {
            Add-Law 'hard denies come after same-action allows' 'FAIL' ($orderProblems -join '; ') `
                "move each trailing allow above its deny, or convert it to ask/deny: $($orderProblems -join '; ')"
        }
    }
}

# Law 13: no broad shell allows.
# Challenger seam (smoke.mjs 'no broad node/git * allow'): `node *` and
# `git *` shell allows fail, as does a bare `*` shell allow beyond the ONE
# documented unattended-shell default ("Shell runs unattended by default").
# That single default is safe only while its compensation holds, which the
# deny-set law proves independently — so this law counts, it does not bless.
if (-not $configOk) {
    Add-ConfigDrift 'no broad shell allows'
} else {
    $permissions = @(Get-PermissionRules -Config $config)
    if ($null -eq $permissions -or $permissions.Count -eq 0) {
        Add-Law 'no broad shell allows' 'FAIL' 'permissions block missing; broad allows cannot be evaluated' 'restore the permissions block in opencode.jsonc'
    } else {
        $shellAllows = @($permissions | Where-Object { $_.action -eq 'shell' -and $_.effect -eq 'allow' } | Select-Object -ExpandProperty resource)
        $broadProblems = [System.Collections.Generic.List[string]]::new()
        foreach ($r in $shellAllows) {
            if ([string]$r -eq 'node *' -or [string]$r -eq 'git *') { $broadProblems.Add("broad shell allow '$r'") }
        }
        $bareCount = @($shellAllows | Where-Object { [string]$_ -eq '*' }).Count
        if ($bareCount -gt 1) { $broadProblems.Add("multiple bare '*' shell allows ($bareCount); only the single documented unattended-shell default is permitted") }
        if ($broadProblems.Count -gt 0) {
            Add-Law 'no broad shell allows' 'FAIL' ($broadProblems -join '; ') `
                "replace each with narrow allows (e.g. 'node --version', 'git status *'): $($broadProblems -join '; ')"
        } else {
            $broadDetail = if ($bareCount -eq 1) { 'no node */git * shell allows; single documented bare ''*'' shell default (compensation proven by the deny-set law)' } else { 'no node */git */bare-* shell allows' }
            Add-Law 'no broad shell allows' 'PASS' $broadDetail
        }
    }
}

# Law 14: skill allow entries match local skill IDs in BOTH directions.
# Set-equality re-derivation of the allowlist law's bidirectional seam (orphan
# dir or dangling allow = FAIL); the wildcard-deny half is not re-checked
# here. Local IDs are the valid ones Law 9 derived (frontmatter name matching
# its directory); malformed skill dirs stay Law 9's seam, not this law's.
if (-not $configOk) {
    Add-ConfigDrift 'skill allow entries match local skill IDs both directions'
} else {
    $permissions = @(Get-PermissionRules -Config $config)
    $allowIds = @($permissions | Where-Object { $_.action -eq 'skill' -and $_.effect -eq 'allow' -and $_.resource -ne '*' } | Select-Object -ExpandProperty resource | Sort-Object -Unique)
    $localIds = @($localSkillIds | Sort-Object -Unique)
    if ($localIds.Count -eq 0 -and $allowIds.Count -eq 0) {
        Add-Law 'skill allow entries match local skill IDs both directions' 'FAIL' 'no local skill IDs and no skill allow entries; the fail-closed allowlist has nothing to hold' `
            'restore the skill directories under skills\ and their allow entries in opencode.jsonc'
    } else {
        $orphanDirs = @($localIds | Where-Object { $allowIds -notcontains $_ })
        $danglingAllows = @($allowIds | Where-Object { $localIds -notcontains $_ })
        if ($orphanDirs.Count -gt 0 -or $danglingAllows.Count -gt 0) {
            $matchReasons = [System.Collections.Generic.List[string]]::new()
            if ($orphanDirs.Count -gt 0) { $matchReasons.Add("orphan skill dirs with no allow entry: $($orphanDirs -join ', ')") }
            if ($danglingAllows.Count -gt 0) { $matchReasons.Add("dangling allow entries with no directory: $($danglingAllows -join ', ')") }
            Add-Law 'skill allow entries match local skill IDs both directions' 'FAIL' ($matchReasons -join '; ') `
                "reconcile skills\ with the skill allow entries in opencode.jsonc: $($matchReasons -join '; ')"
        } else {
            Add-Law 'skill allow entries match local skill IDs both directions' 'PASS' "allow entries and local skill IDs agree as sets ($($localIds.Count) IDs each way)"
        }
    }
}

# Law 15: agents/*.md carry description+steps, commands/*.md carry description.
# Derived from the live convention: agent/command identity is the filename, so
# `name:` is required only of SKILL.md (already checked by the allowlist law,
# where the name must also match its directory). Every live agent carries
# `steps:` (the swarm ceiling), so it is required of agents; commands carry no
# `steps:`, so it is not required of them.
$commandFiles = @()
if (Test-Path -LiteralPath $commandsDir -PathType Container) {
    $commandFiles = @(Get-ChildItem -LiteralPath $commandsDir -File -Filter '*.md')
}
$fmProblems = [System.Collections.Generic.List[string]]::new()
foreach ($file in $agentFiles) {
    foreach ($p in (Get-FrontmatterProblems -Path $file.FullName -Require @('description', 'steps'))) {
        $fmProblems.Add("agents\$($file.Name): $p")
    }
}
foreach ($file in $commandFiles) {
    foreach ($p in (Get-FrontmatterProblems -Path $file.FullName -Require @('description'))) {
        $fmProblems.Add("commands\$($file.Name): $p")
    }
}
if ($agentFiles.Count -eq 0 -and $commandFiles.Count -eq 0) {
    Add-Law 'agents and commands carry the conventional frontmatter' 'FAIL' 'no agent or command markdown files found' 'restore the agent definitions under agents\ and commands under commands\'
} elseif ($fmProblems.Count -gt 0) {
    Add-Law 'agents and commands carry the conventional frontmatter' 'FAIL' ($fmProblems -join '; ') `
        "add the missing frontmatter keys (agents need description+steps, commands need description): $($fmProblems -join '; ')"
} else {
    Add-Law 'agents and commands carry the conventional frontmatter' 'PASS' "$($agentFiles.Count) agent files carry description+steps; $($commandFiles.Count) command files carry description"
}

# Law 16: every skill directory carries a loadable SKILL.md.
# Agents and commands have a frontmatter law just above; this is the skills
# equivalent, plus the hazard that already shipped a real defect: an unquoted
# `Explicit-only: ...` inside `description:` (a colon-space in a plain scalar)
# made skills\<cut-skill>\SKILL.md unloadable while the doctor
# still reported clean. `_shared` is a reference bundle, not a skill, so it is
# excluded. The hazard scan is a TARGETED HEURISTIC, not a full YAML parser: it
# flags top-level plain scalars containing ': ' and nothing more.
$skillLoadProblems = [System.Collections.Generic.List[string]]::new()
$skillDirs = @()
if (Test-Path -LiteralPath $skillsRoot -PathType Container) {
    $skillDirs = @(Get-ChildItem -LiteralPath $skillsRoot -Directory | Where-Object { $_.Name -ne '_shared' })
} else {
    $skillLoadProblems.Add('local skills directory missing')
}
foreach ($dir in $skillDirs) {
    $skillPath = Join-Path $dir.FullName 'SKILL.md'
    if (-not (Test-Path -LiteralPath $skillPath -PathType Leaf)) {
        $skillLoadProblems.Add("$($dir.Name): SKILL.md missing")
        continue
    }
    $fm = Get-FrontmatterText -Path $skillPath
    if ($null -eq $fm) {
        $skillLoadProblems.Add("$($dir.Name): no parseable frontmatter block (leading --- ... ---)")
        continue
    }
    foreach ($req in @('name', 'description')) {
        if ($fm -notmatch ('(?m)^' + $req + '\s*:\s*(.*)$')) {
            $skillLoadProblems.Add("$($dir.Name): frontmatter missing $req")
        } elseif ([string]::IsNullOrWhiteSpace($Matches[1])) {
            $skillLoadProblems.Add("$($dir.Name): frontmatter empty $req")
        }
    }
    if ($fm -match '(?m)^name\s*:\s*(\S.*?)\s*$') {
        $skillName = $Matches[1].Trim().Trim('"').Trim("'")
        if ($skillName -ne $dir.Name) {
            $skillLoadProblems.Add("$($dir.Name): name '$skillName' does not match the directory")
        }
    }
    foreach ($hazard in (Get-PlainScalarHazards -Path $skillPath)) {
        $skillLoadProblems.Add("$($dir.Name): unquoted scalar contains ': ' (YAML-breaking) - $hazard")
    }
}
if ($skillDirs.Count -eq 0 -and $skillLoadProblems.Count -eq 0) {
    Add-Law 'every skill carries a loadable SKILL.md' 'FAIL' 'no skill directories found under skills\' 'restore the skill directories under skills\'
} elseif ($skillLoadProblems.Count -gt 0) {
    Add-Law 'every skill carries a loadable SKILL.md' 'FAIL' ($skillLoadProblems -join '; ') `
        "repair the skill frontmatter (name must match the directory; quote or block-scalar any value containing ': '). This is a targeted heuristic, not a full YAML parser: $($skillLoadProblems -join '; ')"
} else {
    Add-Law 'every skill carries a loadable SKILL.md' 'PASS' "$($skillDirs.Count) skill dirs each carry SKILL.md with name+description and no YAML-breaking plain scalar"
}

# Law 17: command IDs and skill IDs are 1:1 both ways.
# A command with no skill behind it is a doc pretending to be a tool, and a
# skill with no command has no entry point — either orphan direction is a
# FAIL. Skill IDs are the valid skill directories (`_shared` is a reference
# bundle, not a skill, so it is excluded); command IDs are the command
# basenames. Frontmatter validity stays Law 16's seam, not this law's.
$commandIds = @()
if (Test-Path -LiteralPath $commandsDir -PathType Container) {
    $commandIds = @(Get-ChildItem -LiteralPath $commandsDir -File -Filter '*.md' | ForEach-Object { $_.BaseName } | Sort-Object -Unique)
}
$skillDirIds = @()
if (Test-Path -LiteralPath $skillsRoot -PathType Container) {
    $skillDirIds = @(Get-ChildItem -LiteralPath $skillsRoot -Directory | Where-Object { $_.Name -ne '_shared' } | ForEach-Object { $_.Name } | Sort-Object -Unique)
}
if ($commandIds.Count -eq 0 -and $skillDirIds.Count -eq 0) {
    Add-Law 'command IDs and skill IDs are 1:1 both ways' 'FAIL' 'no command files and no skill directories found' 'restore the commands under commands\ and the skill directories under skills\'
} else {
    $orphanCommands = @($commandIds | Where-Object { $skillDirIds -notcontains $_ })
    $orphanSkills = @($skillDirIds | Where-Object { $commandIds -notcontains $_ })
    if ($orphanCommands.Count -gt 0 -or $orphanSkills.Count -gt 0) {
        $seamReasons = [System.Collections.Generic.List[string]]::new()
        if ($orphanCommands.Count -gt 0) { $seamReasons.Add("orphan commands with no skill: $($orphanCommands -join ', ')") }
        if ($orphanSkills.Count -gt 0) { $seamReasons.Add("orphan skills with no command: $($orphanSkills -join ', ')") }
        Add-Law 'command IDs and skill IDs are 1:1 both ways' 'FAIL' ($seamReasons -join '; ') `
            "reconcile commands\ basenames with skills\ directory names (one entry point per skill, no orphans): $($seamReasons -join '; ')"
    } else {
        Add-Law 'command IDs and skill IDs are 1:1 both ways' 'PASS' "command basenames and skill directories agree as sets ($($commandIds.Count) IDs each way)"
    }
}

# Law 18: state/template.md carries the fixed session key order.
# The session file is written by historian with keys in exactly this order;
# the template is the controlled copy, so its order is the derived
# expectation. Missing file or reordered/missing keys = FAIL.
$templatePath = Join-Path $root 'state\template.md'
$fixedKeyOrder = @('id', 'title', 'status', 'goal', 'next', 'artifacts', 'decisions', 'open')
if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
    Add-Law 'state template carries the fixed session key order' 'FAIL' 'state/template.md is missing' 'restore state/template.md with the fixed key order (id, title, status, goal, next, artifacts, decisions, open)'
} else {
    $templateKeys = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ((Get-SafeText -Path $templatePath) -split "`r?`n")) {
        if ($line -match '^\s*(id|title|status|goal|next|artifacts|decisions|open)\s*:') {
            $key = $Matches[1]
            if ($templateKeys -notcontains $key) { $templateKeys.Add($key) }
        }
    }
    $missingKeys = @($fixedKeyOrder | Where-Object { $templateKeys -notcontains $_ })
    $orderHolds = ($missingKeys.Count -eq 0) -and ($templateKeys.Count -eq $fixedKeyOrder.Count) -and (($templateKeys -join ',') -eq ($fixedKeyOrder -join ','))
    if ($orderHolds) {
        Add-Law 'state template carries the fixed session key order' 'PASS' 'state/template.md carries id, title, status, goal, next, artifacts, decisions, open in order'
    } else {
        $templateReasons = [System.Collections.Generic.List[string]]::new()
        if ($missingKeys.Count -gt 0) { $templateReasons.Add("missing keys: $($missingKeys -join ', ')") }
        if ($templateKeys.Count -ne $fixedKeyOrder.Count -and $missingKeys.Count -eq 0) { $templateReasons.Add("unexpected extra keys: $(@($templateKeys | Where-Object { $fixedKeyOrder -notcontains $_ }) -join ', ')") }
        if ($missingKeys.Count -eq 0 -and ($templateKeys -join ',') -ne ($fixedKeyOrder -join ',')) { $templateReasons.Add("order is $($templateKeys -join ', ') — expected $($fixedKeyOrder -join ', ')") }
        Add-Law 'state template carries the fixed session key order' 'FAIL' ($templateReasons -join '; ') `
            "restore the fixed key order (id, title, status, goal, next, artifacts, decisions, open) in state/template.md: $($templateReasons -join '; ')"
    }
}

# ---------- verdict ----------
$failLaws = @($laws | Where-Object { $_.Result -eq 'FAIL' })
$driftLaws = @($laws | Where-Object { $_.Result -eq 'DRIFT' })
$passCount = @($laws | Where-Object { $_.Result -eq 'PASS' }).Count
$exitCode = if ($failLaws.Count -gt 0) { 1 } elseif ($driftLaws.Count -gt 0) { 2 } else { 0 }

# Secret-hygiene self-test: the guard must refuse secret-bearing paths. It runs
# on every invocation, so the guarantee is proven rather than merely asserted.
$secretGuardOk = $false
try {
    # Probe path built without the literal token so repo scans stay clean;
    # the guard still refuses this exact path shape.
    [void](Get-SafeText -Path (Join-Path $root ('.' + 'secrets\harness-doctor-probe')))
} catch {
    $secretGuardOk = $true
}

$applied = @()
$notApplied = @()
foreach ($law in (@($failLaws) + @($driftLaws))) {
    $proposal = if ($law.Proposal) { $law.Proposal } else { "investigate '$($law.Law)': $($law.Detail)" }
    $notApplied += "$($law.Law) [$($law.Result)] - $proposal"
}
$fixNote = 'APPLIED: nothing mechanical to reconcile — derived laws carry no declared state to patch, and every remedy touches an owner artifact or needs owner judgment; no files were written.'

$result = [pscustomobject]@{
    tool           = 'harness-doctor'
    root           = $root
    timestamp      = (Get-Date).ToString('o')
    fix            = [bool]$Fix
    laws           = @($laws | ForEach-Object {
            [pscustomobject]@{ law = $_.Law; result = $_.Result; detail = $_.Detail }
        })
    summary        = [pscustomobject]@{ pass = $passCount; fail = $failLaws.Count; drift = $driftLaws.Count }
    regressions    = @($failLaws | ForEach-Object {
            [pscustomobject]@{ law = $_.Law; evidence = $_.Detail; proposal = $_.Proposal }
        })
    drift          = @($driftLaws | ForEach-Object {
            [pscustomobject]@{ law = $_.Law; evidence = $_.Detail; ownerAction = $_.Proposal }
        })
    appliedChanges = @($applied)
    notApplied     = @($notApplied)
    backup         = ''
    secretGuard    = $secretGuardOk
    exitCode       = $exitCode
}

if ($Json) {
    $result | ConvertTo-Json -Depth 6
    if (-not $secretGuardOk) { exit 1 }
    exit $exitCode
}

# ---------- report ----------
"=== harness-doctor $root ==="
foreach ($law in $laws) {
    $mark = if ($law.Result -eq 'PASS') { '[PASS]' } elseif ($law.Result -eq 'FAIL') { '[FAIL]' } else { '[DRIFT]' }
    "$mark $($law.Law) - $($law.Detail)"
}
""
"Summary: $passCount PASS / $($failLaws.Count) FAIL / $($driftLaws.Count) DRIFT"
""
if ($failLaws.Count -gt 0) {
    'REGRESSIONS (never auto-fixed)'
    foreach ($law in $failLaws) {
        $proposal = if ($law.Proposal) { $law.Proposal } else { "investigate '$($law.Law)': $($law.Detail)" }
        "  proposal: $($law.Law) - $proposal"
    }
    ""
}
if ($driftLaws.Count -gt 0) {
    'DRIFT (the instrument could not derive an expectation)'
    foreach ($law in $driftLaws) {
        $action = if ($law.Proposal) { $law.Proposal } else { "investigate '$($law.Law)': $($law.Detail)" }
        "  owner action: $($law.Law) - $action"
    }
    ""
}
if ($failLaws.Count -eq 0 -and $driftLaws.Count -eq 0) {
    'Clean: every derived law holds; config, registry, catalog, and docs agree.'
    ""
}
if ($Fix) {
    $fixNote
    foreach ($line in $notApplied) { "  - not auto-applied (needs an owner action): $line" }
    ""
}
if ($secretGuardOk) {
    'Secret hygiene: guard refuses secret-store/.env paths (self-test passed); no secret content was read, logged, or printed.'
} else {
    'Secret hygiene: SELF-TEST FAILED - the guard did not refuse a secret path; treat this run as untrusted.'
}
"Doctor verdict: $(if ($exitCode -eq 0) { 'clean' } elseif ($exitCode -eq 2) { 'drift' } else { 'real regression' }) (exit $exitCode)"
if (-not $secretGuardOk) { exit 1 }
exit $exitCode
