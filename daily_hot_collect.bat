@echo off
cd /d "C:\Users\PC\Desktop\클코\인스타 채널 정리"
python collect_channels.py --hot >> logs\daily_hot.log 2>&1
python backfill_recent_thumbs.py --limit 100 --workers 4 >> logs\daily_hot.log 2>&1
