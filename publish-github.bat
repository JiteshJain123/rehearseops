@echo off
setlocal
cd /d "%~dp0"
echo.
echo === Publishing RehearseOps to https://github.com/JiteshJain123/rehearseops ===
echo.
where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed.
  echo Download it from https://git-scm.com/download/win , install with the default options,
  echo then double-click this file again.
  pause
  exit /b 1
)

if not exist .git (
  git init
)

rem Safety 1: .env must be ignored and never tracked.
git check-ignore -q .env
if errorlevel 1 (
  echo STOP: .env is not ignored by .gitignore. Nothing was pushed.
  pause
  exit /b 1
)
git ls-files --error-unmatch .env >nul 2>nul
if not errorlevel 1 (
  echo STOP: .env is tracked by git. Run: git rm --cached .env  then try again. Nothing was pushed.
  pause
  exit /b 1
)

git config user.name >nul 2>nul || git config user.name "JiteshJain123"
git config user.email >nul 2>nul || git config user.email "JiteshJain123@users.noreply.github.com"

git add -A

rem Safety 2: refuse to commit anything that looks like a Nebius or Tavily key.
git grep --cached -n -I -E "tvly-[A-Za-z0-9_-]{12,}|v1\.Cm[A-Za-z0-9+/=_-]{20,}" >nul 2>nul
if not errorlevel 1 (
  echo STOP: a staged file contains something that looks like an API key:
  git grep --cached -n -I -l -E "tvly-[A-Za-z0-9_-]{12,}|v1\.Cm[A-Za-z0-9+/=_-]{20,}"
  echo Remove it and try again. Nothing was pushed.
  git reset -q
  pause
  exit /b 1
)

git commit -q -m "RehearseOps: Nemotron incident-recovery agent with deterministic safety gate" || echo Nothing new to commit.
git branch -M main

git remote get-url origin >nul 2>nul
if errorlevel 1 git remote add origin https://github.com/JiteshJain123/rehearseops.git

echo.
echo Pushing... If a GitHub sign-in window opens, approve it in your browser.
git push -u origin main
if errorlevel 1 (
  echo.
  echo Push failed. Make sure the empty repo JiteshJain123/rehearseops exists on GitHub and you approved the sign-in.
  pause
  exit /b 1
)
echo.
echo Done: https://github.com/JiteshJain123/rehearseops
pause
endlocal
