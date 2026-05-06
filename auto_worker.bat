@echo off
cd /d "C:\Users\PC\Desktop\클코\인스타 채널 정리"
if not exist logs mkdir logs
python auto_worker.py >> logs\auto_worker.log 2>&1
