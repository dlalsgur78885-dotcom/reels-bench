# script-gen v4-3 (2026-05-07)

writer prompt에 **문장별 micro-intent** 주입 + Section Planner 단순화.

## v4-2 → v4-3 변경

### 추가
1. `_build_sentence_intent_map(ref, all_ref_sents)` — emotion_timeline.reason + tts_script.direction을 시간 매칭해서 idx별 `{intent, direction, emotion, delivery, intensity}` 추출
2. multistep flow에서 `sentence_intents` 빌드 + 매칭률 로그
3. `_plan_section` ref_subset에 sentence_intent / direction / emotion / delivery / intensity 5필드 주입
4. 후처리에서 spec에 5필드 propagate
5. Writer spec_block에 `⭐ 문장 의도` + `연기` 라인 추가
6. 의도 우선 룰: 문장 의도 (1순위) > chunk 의도 (2순위) > 표면 미러링

### 단순화
- Section Planner: role/slot_topic 추출 제거 (중복) → skeleton+signature만 출력
- 후처리에서 role(surface 6-role) + slot_topic(chunk.topic) 직접 박음

## 의도 정보 흐름 (3단계)

```
DB (분석 결과)
├─ section_chunks[].role/topic/summary    ← chunk-level 의도
├─ section_roles[name].what_it_does       ← section-level 내러티브 역할
└─ pro_audio.emotion_timeline[].reason    ← sentence-level micro-intent
   pro_audio.tts_script[].direction       ← 연기 톤

Writer가 spec_block + section block에서 모두 봄
```

## 베이스
v4-2 (chunk + section_roles 주입) → v4-3 (sentence-level intent까지)
