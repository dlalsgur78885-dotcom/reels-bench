# Transcriber Agent

## 역할
수집된 릴스 영상에서 대본을 추출하는 에이전트. 비디오 URL → ffmpeg 오디오 추출 → Whisper STT로 음성을 텍스트로 변환

## 상태
- active: true
- version: 1.2.0
- updated: 2026-04-04

## 입력
- collector 에이전트로부터 데이터 수신

## 출력
- analyzer 에이전트로 데이터 전달
