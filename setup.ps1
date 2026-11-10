$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Se creó .env. Completá la URL de PostgreSQL, el usuario admin y la contraseña."
}

$envLines = Get-Content ".env"
foreach ($line in $envLines) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
    $name = $Matches[1]
    $value = $Matches[2].Trim("'`"")
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

$required = @("DATABASE_URL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "SESSION_SECRET")
$missing = @($required | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, "Process")) })
if ($missing.Count -gt 0) {
  Write-Host "Faltan datos en .env: $($missing -join ', ')" -ForegroundColor Yellow
  Write-Host "Copiá la URL desde Supabase > Connect > Session pooler y completá también las credenciales privadas del administrador."
  Start-Process notepad.exe -ArgumentList (Join-Path $PSScriptRoot ".env")
  exit 1
}

try {
  $databaseUri = [Uri]$env:DATABASE_URL
} catch {
  throw "DATABASE_URL no es una URL válida. Copiá la cadena completa desde Supabase > Connect > Session pooler."
}
if ($databaseUri.Scheme -notin @("postgres", "postgresql") -or
    $databaseUri.Host -match '^(HOST|USER|PASSWORD|DATABASE|PROJECT-REF|\[.+\])$' -or
    $env:DATABASE_URL -match '\[(YOUR-PASSWORD|PROJECT-REF)\]') {
  throw "DATABASE_URL todavía contiene valores de ejemplo. Copiá la cadena real desde Supabase > Connect > Session pooler."
}

if ($env:ADMIN_PASSWORD.Length -lt 12) {
  throw "ADMIN_PASSWORD debe tener al menos 12 caracteres."
}
if ($env:SESSION_SECRET.Length -lt 32) {
  throw "SESSION_SECRET debe tener al menos 32 caracteres aleatorios."
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand -and (Test-Path "C:\Program Files\nodejs\node.exe")) {
  $env:PATH = "C:\Program Files\nodejs;" + $env:PATH
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  $npmPath = "C:\Program Files\nodejs\npm.cmd"
  if (-not (Test-Path $npmPath)) {
    throw "No se encontró npm. Instalá Node.js LTS y reiniciá VS Code."
  }
  & $npmPath install
  if ($LASTEXITCODE -ne 0) { throw "Falló npm install." }
  & $npmPath start
  exit $LASTEXITCODE
}

npm install
if ($LASTEXITCODE -ne 0) { throw "Falló npm install." }
npm start
exit $LASTEXITCODE
