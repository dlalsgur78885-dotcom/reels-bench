# script_gen v4-sonnet — Sonnet writer + Flash pre-planner (2026-05-07)

## 변경점 (v4 baseline 대비)
- **Pre-planner**: gemini-3.1-pro-preview → **gemini-3-flash-preview**
  - preview-mapping (`/api/script/preview-mapping`)
  - generate 내부 ([_generate_multistep](script_gen.py))
- **Section writer**: gemini-3.1-pro-preview → **anthropic/claude-sonnet-4-6** (env `WRITER_MODEL`)
- **call_openrouter** 추가, **call_llm** 라우터 (model prefix로 자동 분기)
- **Section planner / Refine**: gemini-3.1-pro-preview 유지 (아직 안 바꿈)
- **사회적 증명** (social proof) 분석 추가:
  - `script_structure.overall.social_proof` 필드
  - `my_products.social_proof` 컬럼 + UI 입력
  - 위저드 매핑 화면에 ref SP × user SP 매핑 panel
  - writer prompt에 `sp_block` 통합 (user_social_proof 인자)

## 비용 (실측 02:35 / 03:26 배치)
- 대본 1개당 ≈ **$0.7~0.9** (writer Sonnet $0.5 + Gemini Pro $0.2-0.4)
- 이전 v4 (전부 Pro) 대비 ~30% 절감

## 알려진 이슈
- Writer input 평균 16k 토큰 — 모든 호출에 11k 동일 prefix 중복 (룰·예시·페르소나)
- → v5에서 Anthropic Prompt Cache로 70% 절감 예정

## 복구
- `git checkout script-gen-v4-sonnet`
- 또는 `backup/v4-sonnet/script_gen.py` + `server.py` 복사
- env `WRITER_MODEL=anthropic/claude-sonnet-4-6` 필요 (Vercel 환경변수)

## 다음
- v5: Anthropic Prompt Cache 적용 → writer cost 70% 추가 절감 예상
