# script_gen v4 — Gemini 3.1 Pro baseline (2026-05-07)

## 상태
- **모델**: gemini-3.1-pro-preview (Pre/Section Planner / Writer / Refine 모두 Pro)
- **파이프라인**: multi-step B = Pre-Planner → Section Planners (4 parallel Pro) → Section Writers (chunk 10, max_workers 8 parallel Pro, count+mirroring 재시도 ×2) → Refine (Pro, max_tokens=32768)
- **검증**: 어절 수 + 어절별 음절 ±2 (mirroring 위반 재시도 자동)
- **어투 감지**: ref 전체 텍스트로 dominant 반말/존댓말 결정 (Writer 강제)
- **USP override**: usp_mapping_override + chunk_usp_override + chunk_meta_override (위저드 수동 조정)

## 비용 (실측 기준 추정 1대본)
- meter 기록: $0.45
- 실비 (thoughts 포함): $0.7~1.0

## 알려진 이슈
- pre-planner 2회 호출 (preview + generate) — 중복
- writer 재시도 30%대 발생 — Pro 어절 수 종종 어김
- refine pass 단독 30-60s — max_tokens=32768 thoughts 폭주

## 다음 단계 (실험 후보)
1. Sonnet 4.6 으로 Writer 분기 — 미러링 안정화 + thoughts 없음 → 비용 절반 가능
2. Pre-planner / Section planner Flash 강등
3. Refine max_tokens 8192로 ↓
4. cost_meter에 thoughtsTokenCount 합산

## 파일
- `script_gen.py` — 핵심 로직
- `server.py` — API endpoints (preview-mapping, generate, refine 등)
