# script-gen v4-2 (2026-05-07)

writer prompt에 chunk-level 의도(role/topic/summary/relation_to_prev) + section_roles(role/what_it_does/must_not_repeat) 주입.

## 문제
writer가 ref_text 표면(skeleton·어절·시그니처)만 보고 작성 → "후기도 보지 마세요" (역설적 칭찬 의도) 가 "딴잠옷 찾지 마세요" (단순 거부) 로 변질.

## 원인
- DB `reels_script_structure.overall.section_chunks/section_roles`에 chunk별 의도가 풍부하게 저장돼 있음
- 하지만 `_build_section_writer_prompt`는 chunk 의도를 prompt에 포함하지 않음 (ref_text + role + topic 한 줄만)
- 표면 미러링 룰만 강조 → 의도 무시

## 변경
1. `_build_section_writer_prompt` 시그니처: `section_chunks`, `section_roles` 추가
2. spec_block의 같은 slot_id 묶음에 **chunk_role / chunk_topic / chunk_summary / relation_to_prev** 박음
3. prompt 본문에 **섹션 내러티브 역할 블록** (section_roles[name].role / what_it_does / must_not_repeat) 추가
4. ⭐⭐⭐⭐⭐ **의도 우선 룰** 추가 — chunk 의도가 표면 미러링·시그니처보다 우선
5. multistep 호출부에 `section_chunks` + `section_roles_db` 전달

## 베이스
- v5 (Anthropic Prompt Cache + Sonnet writer) 위에 의도 주입 패치
- writer model 자체는 v5 그대로 (Sonnet, prompt cache)
