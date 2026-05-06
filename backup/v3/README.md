# V3 백업 (2026-05-03)

## 라이브 접속
- **고정 URL**: https://v3-reels-bench.vercel.app
- **deployment ID**: `reels-bench-eo5q2bbec-dlalsgur78885-3009s-projects`
- **alias 만든 시점**: 2026-05-03

## 파이프라인 스펙
1. **Planner (Pro 3.1)** — single 호출
   - Step 0: Ref-USP 정렬
   - Step 1: Skeleton 추출 (no slot_fills)
   - Step 2: Signature 추출
2. **Section Writers (Pro × 4 parallel)**
   - skeleton + signature + usp_id 받아 USP 리뷰에서 단어 추출 + 조립
   - 리뷰 셔플 (variance)
3. **Critic + Refiner 1차에서 제거**
4. **2차 Refine** (`/api/script/refine`)
   - Flash awkward detector (`detect_awkward_sentences`)
   - awkward_block + length match + awkward patterns 가이드
   - per-sentence 음절 검증 + retry merge

## v3에 없는 기능 (v4에서 추가됨)
- ❌ Pre-Planner Flash + Section Planners 4 parallel (B-version 분할)
- ❌ Body chunked Writers (large section 분할)
- ❌ Writer min_sentences 강제
- ❌ Pro awkward detector (v3는 Flash)
- ❌ 도메인 정합 검증
- ❌ main USP keyword check (hook-first/cta-last)
- ❌ Writer main_kw_block (usp_id=1 강제 키워드 포함)
- ❌ CTA fallback (자동 감지 실패 시 마지막 N문장 CTA로)

## 비용·시간 (실측)
- 1차: ~110-150s, ~$0.08-0.12
- 2차: ~50-90s, ~$0.03-0.04
- 합계: ~$0.11-0.16 / 원고

## 검증된 결과 예 (DSHPniIkuMx 잠옷, 2026-05-03 18시 시점)
- 1차 28/28 자연 미러링
- 2차: "갑자기 땀 차는 일 생기면 / 잠에 드는 것부터 / 너무 찝찝할 때 있지?" — 자연
- CTA: "꿀잠 gogo / 꿀잠잘 때도 / 모두 이 잠옷 하나로 해결"

## 파일
- `script_gen_v3.py` ✅ — v3 spec 그대로 코드 복원
- `server_v3.py` ✅ — v3 spec 그대로 코드 복원
- `script_gen_v4_broken.py` — v4 시점 (Pre-Planner Pro / 도메인 정합 / main USP 강제 등 추가)
- `server_v4_broken.py` — v4 시점 (main USP keyword check 추가)

## v3 reconstruction 변경 내역 (v4 → v3)
1. `_extract_main_usp_keywords` 제거
2. `_build_pre_planner_prompt` 제거
3. `_build_section_planner_prompt` 제거
4. `_classify_ref_sections` 제거
5. `detect_awkward_sentences` Flash로 변경 (Pro 3.1 → Flash, simple prompt)
6. `build_refine_prompt` awkward_block 단순 format 사용 (idx + text + reason만, awkward_part/suggestion 제거)
7. `_generate_multistep` Section Planners 분할 → single Planner Pro로 단일 호출
8. Writer chunked 분할 제거 (CHUNK_SIZE 로직 삭제)
9. server.py refine_script 에서 main USP keyword 누락 체크 제거

## 복구 방법
1. **빠른 방법**: `https://v3-reels-bench.vercel.app` 사용 (별도 deployment alias)
2. **로컬 코드 복구**:
   ```bash
   cp backup/v3/script_gen_v3.py api/services/script_gen.py
   cp backup/v3/server_v3.py api/server.py
   vercel --prod
   ```
