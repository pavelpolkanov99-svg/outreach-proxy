#!/bin/bash
# Запускаем прокси в фоне — это главный процесс
node index.js &
PROXY_PID=$!

# Запускаем бота отдельно с автоперезапуском
while true; do
  node bot.js
  echo "[start.sh] bot.js exited, restarting in 5s..."
  sleep 5
done &

# Ждём прокси (главный процесс)
wait $PROXY_PID
