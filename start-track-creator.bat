@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js nao foi encontrado no PATH.
  echo Instale Node.js e tente novamente.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm nao foi encontrado no PATH.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Instalando dependencias...
  call npm install
  if errorlevel 1 (
    echo Falha ao instalar as dependencias.
    pause
    exit /b 1
  )
)

echo Iniciando o servidor do Track Creator...
start "Track Creator Dev Server" cmd /k "cd /d ""%~dp0"" && npm run dev -- --host 127.0.0.1 --port 5173"

echo Aguardando o servidor ficar pronto...
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5173/"

echo Track Creator aberto em http://127.0.0.1:5173/

endlocal
