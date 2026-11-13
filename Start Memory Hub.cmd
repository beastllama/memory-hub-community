@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0" || exit /b 1

if not exist "apps\local\dist\server.js" (
  echo Memory Hub files are missing. Extract the whole ZIP or follow the source build steps in README.md.
  pause
  exit /b 1
)

set "NODE_OPTIONS="
set "NODE_PATH="
set "MEMORY_HUB_LAUNCH=--open"
if "%~1"=="--print-url" set "MEMORY_HUB_LAUNCH=--print-url"
if exist "runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0apps\local\dist\server.js" %MEMORY_HUB_LAUNCH%
) else if exist "runtime\LICENSE" (
  echo The bundled runtime is missing. Extract the whole ZIP again.
  pause
  exit /b 1
) else (
  "%SystemRoot%\System32\where.exe" node.exe >nul 2>&1
  if errorlevel 1 (
    echo Node.js is not available. Use the Windows ZIP or see README.md for the source build.
    pause
    exit /b 1
  )
  node.exe "%~dp0apps\local\dist\server.js" %MEMORY_HUB_LAUNCH%
)

set "MEMORY_HUB_EXIT=%ERRORLEVEL%"
if not "%MEMORY_HUB_EXIT%"=="0" pause
popd
exit /b %MEMORY_HUB_EXIT%
