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
echo Feche esta janela ou pressione Ctrl+C para parar o servidor.
call npm run dev -- --host 127.0.0.1 --port 5173 --strictPort --open
if errorlevel 1 (
  echo Falha ao iniciar. Verifique se a porta 5173 ja esta em uso.
  pause
  exit /b 1
)

endlocal
