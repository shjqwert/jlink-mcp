[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,

  [string]$FixtureRoot = "D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config",

  [switch]$Force
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$KitRoot = Split-Path -Parent $ScriptDir

$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$GitTop = (& git -C $RepoRoot rev-parse --show-toplevel 2>$null)
if (-not $GitTop) {
  throw "RepoRoot is not a Git repository: $RepoRoot"
}
$GitTop = (Resolve-Path -LiteralPath $GitTop.Trim()).Path
if ($GitTop -ne $RepoRoot) {
  throw "RepoRoot must be the Jlink_MCP Git top-level directory. Expected: $GitTop"
}

if (-not (Test-Path -LiteralPath $FixtureRoot)) {
  Write-Warning "FixtureRoot does not currently exist: $FixtureRoot. It will still be recorded for later P00 verification."
}

$Mappings = @(
  @{ Source = "spec\Jlink_MCP_v0.2.1_Functional_Spec_Rev1_Frozen.md"; Destination = "docs\spec\v0.2.1\Jlink_MCP_v0.2.1_Functional_Spec_Rev1_Frozen.md" },
  @{ Source = "spec\SPEC_REV1_CHANGELOG.md"; Destination = "docs\spec\v0.2.1\SPEC_REV1_CHANGELOG.md" },
  @{ Source = "spec\source\Jlink_MCP_v0.2.1_Function_List_Updated.md"; Destination = "docs\spec\v0.2.1\source\Jlink_MCP_v0.2.1_Function_List_Updated.md" },
  @{ Source = "DEVELOPMENT_PLAN.md"; Destination = "docs\project\v0.2.1\DEVELOPMENT_PLAN.md" },
  @{ Source = "OPERATIONS_GUIDE.md"; Destination = "docs\project\v0.2.1\OPERATIONS_GUIDE.md" },
  @{ Source = "spec\requirement-traceability.json"; Destination = "reports\governance\requirement-traceability.json" },
  @{ Source = "environment\hardware-environment.json"; Destination = "reports\environment\hardware-environment.json" },
  @{ Source = "schemas\phase-result.schema.json"; Destination = "reports\schemas\phase-result.schema.json" },
  @{ Source = "schemas\pro-review-result.schema.json"; Destination = "reports\schemas\pro-review-result.schema.json" },
  @{ Source = "schemas\requirement-traceability.schema.json"; Destination = "reports\schemas\requirement-traceability.schema.json" },
  @{ Source = "schemas\hardware-environment.schema.json"; Destination = "reports\schemas\hardware-environment.schema.json" },
  @{ Source = "schemas\test-catalog.schema.json"; Destination = "reports\schemas\test-catalog.schema.json" },
  @{ Source = "templates\phase-result.template.json"; Destination = "reports\templates\phase-result.template.json" },
  @{ Source = "templates\pro-review-result.template.json"; Destination = "reports\templates\pro-review-result.template.json" },
  @{ Source = "templates\task-handoff.template.md"; Destination = "reports\templates\task-handoff.template.md" },
  @{ Source = "templates\P00-phase-summary.template.md"; Destination = "reports\templates\P00-phase-summary.template.md" },
  @{ Source = "templates\requirement-status.template.json"; Destination = "reports\templates\requirement-status.template.json" },
  @{ Source = "templates\catalog-snapshot.template.json"; Destination = "reports\templates\catalog-snapshot.template.json" },
  @{ Source = "orchestrator\P00-goal-contract.json"; Destination = ".agent\orchestrator\P00-goal-contract.json" },
  @{ Source = "orchestrator\P00-task-wave.json"; Destination = ".agent\orchestrator\P00-task-wave.json" },
  @{ Source = "tests\test-catalog.json"; Destination = "tests\planning\v0.2.1\test-catalog.json" },
  @{ Source = "tests\TEST_CATALOG.md"; Destination = "tests\planning\v0.2.1\TEST_CATALOG.md" }
)

foreach ($Mapping in $Mappings) {
  $Source = Join-Path $KitRoot $Mapping.Source
  $Destination = Join-Path $RepoRoot $Mapping.Destination
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Missing kit file: $Source"
  }
  $Parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $Parent -Force | Out-Null
  if ((Test-Path -LiteralPath $Destination) -and -not $Force) {
    throw "Destination already exists. Review it or rerun with -Force: $Destination"
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

$PromptDest = Join-Path $RepoRoot "docs\project-prompts\v0.2.1"
New-Item -ItemType Directory -Path $PromptDest -Force | Out-Null
Copy-Item -Path (Join-Path $KitRoot "prompts\*.md") -Destination $PromptDest -Force

# Materialize actual repo/fixture paths in copied governance JSON.
$HardwarePath = Join-Path $RepoRoot "reports\environment\hardware-environment.json"
$Hardware = Get-Content -LiteralPath $HardwarePath -Raw -Encoding UTF8 | ConvertFrom-Json
$Hardware.project.root = $FixtureRoot
Write-Utf8NoBom $HardwarePath (($Hardware | ConvertTo-Json -Depth 100) + "`n")

$TaskWavePath = Join-Path $RepoRoot ".agent\orchestrator\P00-task-wave.json"
$TaskWave = Get-Content -LiteralPath $TaskWavePath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($Task in $TaskWave) {
  $Task.cwd = $RepoRoot
  $Task.worktree = $RepoRoot
}
Write-Utf8NoBom $TaskWavePath (($TaskWave | ConvertTo-Json -Depth 100) + "`n")

$PromptPath = Join-Path $PromptDest "00_START_P00_ORCHESTRATOR.md"
$PromptText = Get-Content -LiteralPath $PromptPath -Raw -Encoding UTF8
$PromptText = $PromptText.Replace("<JLINK_MCP_REPO>", $RepoRoot)
Write-Utf8NoBom $PromptPath $PromptText

$PhaseRoot = Join-Path $RepoRoot "reports\phases\P00"
New-Item -ItemType Directory -Path (Join-Path $PhaseRoot "evidence") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PhaseRoot "review") -Force | Out-Null

Write-Host "P00 kit installed into: $RepoRoot"
Write-Host "Fixture recorded as: $FixtureRoot"
Write-Host "No file was written to the fixture."
Write-Host ""
Write-Host "Next:"
Write-Host "1. Review: git -C `"$RepoRoot`" status --short"
Write-Host "2. Commit the governance baseline."
Write-Host "3. Open Codex at RepoRoot and paste docs/project-prompts/v0.2.1/00_START_P00_ORCHESTRATOR.md"
