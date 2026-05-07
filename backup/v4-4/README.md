# script-gen v4-4 (2026-05-07)

**SP(사회적 증명) 부활 + 문장별 정밀 컨트롤**

## v4-3 → v4-4 변경

v5의 옛 SP 시스템(섹션 단위 매핑)이 4가지 결함으로 깨져서 SP 분석 통째로 빠졌었음 (commit 9b7d428). v4-4에서 결함 다 고치고 부활.

### 옛 v5 결함 4종 → v4-4 해결
1. ❌ SP 매핑이 섹션 단위 (어느 문장인지 불명) → ✅ **sentence_idx 단위**
2. ❌ spec에 "SP다" 라벨 없음 (Writer 자유 배치) → ✅ **🚨 SP[type] = action 마커**
3. ❌ "SP→SP 1:1" 룰 없음 (SP가 일반 카피로 변질) → ✅ **4종 action 명시 룰**
4. ❌ "keep_as_is" 명령 없음 (미매핑 SP가 변형됨) → ✅ **default action = keep**

### 변경 (3 phase)

**Phase A — analyzer (script_gen.py)**
- `analyze_sp_per_sentence(sentences)` 추가 — Gemini 3.1 Pro로 sentence_idx별 SP 마킹
- 결과: `[{sentence_idx, sp_type, sp_strength, evidence, label}]`
- 7가지 sp_type: sales_volume / review_volume / rating / authority / scarcity / award / personal
- DB 저장 위치: `reels_script_structure.overall.sp_sentences`

**Phase B — script_gen 배선**
- `generate()` + `_generate_multistep()`에 `sp_decisions` param 추가
- multistep flow에서 idx별 dict 변환
- ref_subset / spec에 `sp_decision` 박음
- Writer spec_block에 `🚨 SP[type/strength] = action` 마커
- Writer prompt에 SP 4종 강제 룰:
  - **keep**: ref 그대로 mirror (수치·단어 보존, 도메인만 치환)
  - **replace**: user value 박음
  - **rewrite_sp**: sp_type 유지하되 우리 도메인 generic SP angle
  - **drop**: SP 단어·수치 0개

**Phase C — server**
- `ScriptGenRequest.sp_decisions` 필드 추가
- `POST /api/script/reanalyze-sp/{shortcode}` (reels) + `/api/yt/script/reanalyze-sp/{shortcode}` (youtube) 엔드포인트
- preview-mapping 응답에 `sp_sentences` 포함

**Phase D — wizard UI**
- 옛 SP 패널(섹션 매핑) 제거 → v4-4 SP decisions 패널로 교체
- ref SP별 4종 action 버튼 (keep/replace/rewrite_sp/drop)
- "replace" 선택 시 inline value/label 입력
- default = keep (변경 안 한 자리는 ref 그대로)
- generate 호출 시 `sp_decisions` 배열로 전송

## 사용 흐름

1. (한 번) 분석 페이지에서 SP 분석 트리거 → `POST /api/script/reanalyze-sp/{sc}` → DB에 sp_sentences 저장
2. wizard에서 SP들 보고 각각 action 결정 (default keep)
3. 스크립트 생성 → Writer가 spec_block의 🚨 마커 + 4종 룰 따라 처리

## 베이스
v4-3 (sentence intent + section_planner 단순화) → v4-4 (SP 부활)
