# script_gen v5 — Anthropic direct + Sonnet writer + cache + SP overhaul (2026-05-07)

## 변경점 (v4-sonnet 대비)

### 1. Anthropic 직접 API + Prompt Cache
- `call_anthropic` 추가 (`api.anthropic.com/v1/messages` 직접 호출, OpenRouter markup 제거)
- `call_llm` 라우터: anthropic prefix + ANTHROPIC_API_KEY 있으면 → 직접, 없으면 OpenRouter
- Writer prompt에 `<<<CACHE_BOUNDARY>>>` 마커로 static prefix 분리, `cache_control: ephemeral` 부착
- 1st writer sequential (cache write, ~5s 동안 cache 전파) → 6 parallel (cache hit, 0.1x)
- cost_meter에 cached_tokens / cache_create_tokens 트래킹

### 2. Pre-planner Flash 강등
- preview-mapping + generate 내부 pre-planner: gemini-3.1-pro-preview → gemini-3-flash-preview

### 3. Section Writer = Sonnet 4.6
- `WRITER_MODEL` env var (anthropic/claude-sonnet-4-6)

### 4. ref 도메인 단어 자동 치환 (domain_block)
- `extract_ref_domain_keywords(primary)` — Flash로 ref 대본에서 product 도메인 단어 추출 (예: "바지", "버터팬스")
- Writer prompt에 ⭐⭐⭐⭐⭐ 최우선 룰: 도메인 단어 100% 우리 제품으로 치환

### 5. Social Proof per-section 매핑 (sp_section_block) + 전역 leak 차단
- `social_proof_override` (위저드에서 ref SP × user SP 매핑) 백엔드 처리
- `sp_section_map`: {section: [{user_value, user_label, ref_evidence}]} 빌드
- Writer prompt에서 sp_section_block만 사용 (전역 sp_block 제거 → SP 단어 leak 방지)
- 매핑된 섹션: "value(숫자)만 inject, ref 본문 단어 보존" 룰 강화 (`칭찬` → `후기` 치환 금지)
- 매핑 안 된 섹션: ⛔ "SP 관련 단어 사용 금지" 명시 차단 블록

### 6. Wizard UI
- product 페르소나 + ref desire 페르소나 max 2 합산 선택
- 결과 탭에 unique key (`name #1`, `name #2`) — 중복 이름도 안 덮어씌워짐
- 생성 중 표시: `selectedPersonaIdx + selectedRefDesireIdx` 합산 카운트
- 디버그 console.log 추가 (`[script/gen] personas count: N settled: N OK/FAILED`)

## 비용 (대본 1개당, 추정)
- Pre-planner ×2: $0.004 (Flash)
- Section planner ×4: $0.21 (Pro)
- Section writer × ~7 (1 sequential cache write + 6 cache hit): $0.10~0.20
- Refine ×1: $0.166 (Pro)
- **합계: ~$0.5~0.6 / 대본** (v4-sonnet $0.75 대비 ~30% 절감)

## 알려진 이슈
- Section_planner의 [SLOT] 추출이 종종 너무 공격적 ("깔별로", "칭찬" 같은 도메인-무관 단어를 SLOT 처리)
- 구조적 해결 (skeleton-less rewrite) 미구현 — 별도 트랙

## 복구
- `git checkout script-gen-v5` (현재 commit이 tag될 예정)
- 또는 `backup/v5/script_gen.py` + `server.py` 복사
- 환경변수: `WRITER_MODEL=anthropic/claude-sonnet-4-6`, `ANTHROPIC_API_KEY=...`

## v4로 돌리기
- `git checkout script-gen-v4 -- api/services/script_gen.py api/server.py`
- 또는 `cp backup/v4/script_gen.py api/services/ && cp backup/v4/server.py api/`
