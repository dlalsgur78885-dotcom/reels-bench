@echo off
cd /d "C:\Users\PC\Desktop\클코\인스타 채널 정리"
if not exist logs mkdir logs
python auto_analyze.py --limit 5 >> logs\auto_analyze.log 2>&1
