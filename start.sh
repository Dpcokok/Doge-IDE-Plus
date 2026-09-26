#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "Starting Doge IDE local server..."
echo "Your browser will open automatically at: http://localhost:8787"

# Open the browser once the server starts listening on port 8787
( for i in $(seq 1 120); do
    if (exec 3<>/dev/tcp/127.0.0.1/8787) 2>/dev/null; then
        exec 3>&- 3<&-
        if command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:8787
        elif command -v open >/dev/null 2>&1; then open http://localhost:8787
        elif command -v python3 >/dev/null 2>&1; then python3 -m webbrowser http://localhost:8787
        fi
        break
    fi
    sleep 0.25
done ) &

if command -v node >/dev/null 2>&1; then
    node proxy.mjs
else
    python3 proxy.py
fi