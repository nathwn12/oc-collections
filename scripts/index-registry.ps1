# index-registry.ps1 - which packages this monorepo releases, and the
# repository-metadata assertion that follows from it.
#
# Every package in the index must be classified here; an unknown package fails
# the registry check instead of being guessed. A package released from another
# repository is classified 'external': its published metadata names that
# repository by design, so the repository assertion is skipped and only its
# existence and claimed version are checked. No package is external today.
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
    '@nathwn12/janua' = [pscustomobject]@{
        Scope  = 'released'
        Reason = 'packages/janua; published by this repo''s release workflow.'
    }
    'oc-talk' = [pscustomobject]@{
        Scope  = 'released'
        Reason = 'packages/oc-talk; published by this repo''s release workflow.'
    }
    'rea-shim' = [pscustomobject]@{
        Scope  = 'released'
        Reason = 'packages/rea-shim; published by this repo''s release workflow.'
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
