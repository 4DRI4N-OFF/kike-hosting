$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
function Refresh-Path { $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User') }
function Need-Tool($command,$package,$url) {
  if(Get-Command $command -ErrorAction SilentlyContinue){return}
  Write-Host "Falta $command. Descarga oficial: $url"
  if((Get-Command winget -ErrorAction SilentlyContinue) -and ((Read-Host "Instalar $package con winget? [s/N]") -eq 's')) {
    & winget install --id $package --exact --source winget
    Refresh-Path
  }
  if(!(Get-Command $command -ErrorAction SilentlyContinue)){throw "Instala $command desde $url y vuelve a ejecutar Iniciar.cmd."}
}
Need-Tool 'node' 'OpenJS.NodeJS.LTS' 'https://nodejs.org/'
$nodeText=(& node --version | Out-String).Trim()
if($nodeText -notmatch '^v(\d+)'){throw 'No pude comprobar Node.js.'}
if([int]$Matches[1] -lt 20){throw 'Necesitas Node.js 20 o superior: https://nodejs.org/'}
Need-Tool 'java' 'EclipseAdoptium.Temurin.25.JDK' 'https://adoptium.net/temurin/releases/'
$javaOut=[IO.Path]::GetTempFileName()
$javaErr=[IO.Path]::GetTempFileName()
try {
  $check=Start-Process -FilePath (Get-Command java).Source -ArgumentList '-version' -NoNewWindow -Wait -PassThru -RedirectStandardOutput $javaOut -RedirectStandardError $javaErr
  $j=(Get-Content $javaOut,$javaErr -Raw | Out-String)
  if($check.ExitCode -ne 0){throw 'Java no responde correctamente.'}
} finally { Remove-Item $javaOut,$javaErr -Force -ErrorAction SilentlyContinue }
if($j -notmatch 'version "(\d+)'){throw 'No pude comprobar la version de Java.'}
if([int]$Matches[1] -lt 21){throw 'Necesitas Java 21 o superior. Para las versiones nuevas usa Java 25: https://adoptium.net/temurin/releases/'}
if([int]$Matches[1] -lt 25){Write-Warning 'Tienes Java 21-24. Algunas versiones recientes de Minecraft necesitan Java 25. Elige una version compatible o actualiza Java.'}
if(!(Test-Path 'mc-host.config.json')){Copy-Item 'mc-host.config.example.json' 'mc-host.config.json'}
$port=8788
if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw "El puerto $port esta ocupado. Cierra el otro panel o programa que lo usa y vuelve a intentarlo."}
$env:JAVA_BIN=(Get-Command java).Source
Write-Host "Panel: http://127.0.0.1:$port/"
Write-Host 'Abre esa direccion en el navegador. La primera vez creas tu propio PIN. No compartas el panel en Internet.'
Write-Host 'Manten esta ventana abierta. Para salir usa Apagar el panel con el servidor detenido.'
Start-Process "http://127.0.0.1:$port/"
& node "$PSScriptRoot\panel\server.js"
exit $LASTEXITCODE
