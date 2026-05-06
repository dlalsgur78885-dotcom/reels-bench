# Analyzer Agent

## 역할
릴스탭에 반복적으로 뜨는 패턴을 분석하는 에이전트. 메타데이터 + 대본을 기반으로 알고리즘 추천 패턴(오디오/포맷/주제/화법) 트렌드를 도출

## 상태
- active: true
- version: 1.2.0
- updated: 2026-04-04

## 입력
- transcriber 에이전트로부터 데이터 수신

## 출력
- reporter 에이전트로 데이터 전달
