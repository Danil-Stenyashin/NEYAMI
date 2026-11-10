@echo off
rem NEYAMI для Windows: двойной щелчок запускает сервер и открывает приложение.
chcp 65001 >nul
title NEYAMI
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node scripts\check-node.js
if errorlevel 1 goto fail

if not exist "data\neyami.db" (
  echo Первый запуск: создаю демо-каталог, это займёт несколько секунд...
  node --disable-warning=ExperimentalWarning scripts\seed.js
  if errorlevel 1 goto fail
)

node --disable-warning=ExperimentalWarning src\main.js --open
goto end

:nonode
echo Не найден Node.js. Сейчас откроется сайт nodejs.org - установите версию LTS и запустите NEYAMI снова.
start "" https://nodejs.org/
goto end

:fail
echo Что-то пошло не так - текст ошибки выше.

:end
pause
