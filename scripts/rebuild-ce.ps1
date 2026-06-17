# Rebuild app5-nextaura-fit on IBM Code Engine from local source.
param(
    [string]$CeProject = "nextaura-workflows",
    [string]$CeRegion = "us-south",
    [string]$AppName = "app5-nextaura-fit",
    [string]$SourceRoot = "E:\NextAuraMonth3(corefocuses)\V2opensources2d"
)

$ErrorActionPreference = "Stop"

function Test-AppExists {
    param([string]$Name)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $null = ibmcloud ce app get -n $Name 2>$null
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prev
    return $ok
}

Write-Host "=== Rebuild $AppName from $SourceRoot ===" -ForegroundColor Cyan

ibmcloud target -g Default | Out-Null
ibmcloud target -r $CeRegion | Out-Null
ibmcloud ce project select -n $CeProject | Out-Null

if (-not (Test-AppExists -Name $AppName)) {
    Write-Host "Creating $AppName..." -ForegroundColor Yellow
    ibmcloud ce app create -n $AppName `
        --build-source $SourceRoot `
        --build-dockerfile Dockerfile `
        --build-strategy dockerfile `
        --cpu 1 --memory 2G `
        --min-scale 1 --max-scale 3 `
        --port 8080
} else {
    ibmcloud ce app update -n $AppName `
        --build-source $SourceRoot `
        --build-dockerfile Dockerfile `
        --build-strategy dockerfile `
        --rebuild
}

$url = (ibmcloud ce app get -n $AppName --output json | ConvertFrom-Json).status.url
Write-Host "`nCE:     $url" -ForegroundColor Green
Write-Host "Public: https://app5.nextaura.fit" -ForegroundColor Green
