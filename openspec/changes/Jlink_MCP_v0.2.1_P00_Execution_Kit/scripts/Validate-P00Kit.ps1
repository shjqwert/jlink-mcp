[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$Files = @(
  "docs\spec\v0.2.1\Jlink_MCP_v0.2.1_Functional_Spec_Rev1_Frozen.md",
  "reports\governance\requirement-traceability.json",
  "reports\environment\hardware-environment.json",
  "reports\schemas\phase-result.schema.json",
  "reports\schemas\pro-review-result.schema.json",
  ".agent\orchestrator\P00-goal-contract.json",
  ".agent\orchestrator\P00-task-wave.json"
)

foreach ($Relative in $Files) {
  $Path = Join-Path $RepoRoot $Relative
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing required file: $Path"
  }
}

$Trace = Get-Content -LiteralPath (Join-Path $RepoRoot "reports\governance\requirement-traceability.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Trace.requirements.Count -ne 144) {
  throw "Expected 144 requirements, found $($Trace.requirements.Count)"
}
$Ids = @($Trace.requirements | ForEach-Object { $_.id })
if (($Ids | Sort-Object -Unique).Count -ne 144) {
  throw "Requirement IDs are not unique"
}

$Hardware = Get-Content -LiteralPath (Join-Path $RepoRoot "reports\environment\hardware-environment.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Hardware.project.gitRequired -ne $false) {
  throw "Target fixture must not require Git"
}
if ($Hardware.p00Authorization.r4ApprovalGranted -ne $false) {
  throw "P00 must not grant R4 approval"
}

Write-Host "P00 kit structural validation passed."
Write-Host "Requirements: 144 unique IDs"
Write-Host "R4 approval: false"
