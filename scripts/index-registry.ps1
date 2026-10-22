# index-registry.ps1 - which packages this monorepo releases, and the
# repository-metadata assertion that follows from it.
#
# The index table includes packages this repository does not publish:
#   * gladius-mcp and puppet-mcp stay on their original release lanes, where
#     their engine provisioning lives.
# Their published metadata names those original repositories by design, so a
# repository assertion on them can never pass. They are checked for existence
# and claimed version only. Every package must be classified here; an unknown
# package fails the registry check instead of being guessed.
#
# oc-todo is the third such package but is omitted from the table altogether
# (EOL/deprecated; never republished from this monorepo), so the registry loop
# never reaches its entry below. It stays classified so the entry is already
# right if the table ever shows it again.
$script:RegistryScope = [ordered]@{
    '@nathwn12/oc-bifrost' = [pscustomobject]@{
        Scope  = 'released'
        Reason = 'packages/oc-bifrost; published by this repo''s release workflow.'
    }
    'oc-flight-deck' = [pscustomobject]@{
        Scope  = 'released'
        Reason = 'packages/oc-flight-deck; published by this repo''s release workflow.'
    }
    'oc-harness-setup' = [pscustomobject]@{
        Scope  = 'released'
        Reason = 'packages/oc-harness-setup; published by this repo''s release workflow.'
    }
    'rea-shim' = [pscustomobject]@{
        Scope  = 'released'
        Reason = 'packages/rea-shim; published by this repo''s release workflow.'
    }
    # Not in the table, so never queried today; retained rather than deleted so
    # the external-package classification holds the moment it is shown again.
    'oc-todo' = [pscustomobject]@{
        Scope  = 'external'
        Reason = 'EOL/deprecated; never republished from this monorepo.'
    }
    'gladius-mcp' = [pscustomobject]@{
        Scope  = 'external'
        Reason = 'original release lane; engine provisioning stays in its own repo.'
    }
    'puppet-mcp' = [pscustomobject]@{
        Scope  = 'external'
        Reason = 'original release lane; engine provisioning stays in its own repo.'
    }
}

function Get-RegistryScope([string]$PackageName) {
    if ($script:RegistryScope.Contains($PackageName)) { return $script:RegistryScope[$PackageName] }
    return [pscustomobject]@{
        Scope  = 'unknown'
        Reason = 'not classified in scripts/index-registry.ps1; classify it before checking it.'
    }
}

function Test-RepositoryMetadata([string]$PackageName, [string]$Repository) {
    $entry = Get-RegistryScope $PackageName
    if ($entry.Scope -eq 'external') { return $true }   # deliberately not asserted
    if ($entry.Scope -ne 'released') { return $false }  # unknown scope is a failure
    return [bool]($Repository -match 'github\.com[/:]nathwn12/oc-collections')
}
