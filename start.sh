#!/bin/sh
# 측위 서버(백그라운드) → Node 웹서버(포그라운드, $PORT 는 Render 가 준다)
/venv/bin/python -m uvicorn vps.server.main:app --host 127.0.0.1 --port 8000 &
exec node server.js
