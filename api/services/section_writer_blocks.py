"""섹션별 writer prompt 블록 — script_gen._build_section_writer_prompt에서 분리.

각 섹션(hook/intro/body/cta)의 가이드와 prev_chunks 블록을 여기 응집.
이 파일만 수정하면 섹션 한정 룰 변경 가능 (script_gen.py 안 건드림).
"""

# ──────────────────────────────────────────────────────────────────────────
# 섹션별 GUIDANCE — _section_specific_guidance에서 분리
# ──────────────────────────────────────────────────────────────────────────

HOOK_COMMON_GUIDANCE = """## 🎣 HOOK — **페르소나 욕망 우선 / ref 어휘는 제로**

⚠️⚠️⚠️ Hook은 ref와 다르게 나와야 정상. **ref 어휘를 그대로 가져오면 무효**. ⚠️⚠️⚠️

### 우선순위 (Hook 한정)
1. **광고 제품 도메인** ⭐⭐⭐⭐⭐ — Hook은 우리 제품 시청자가 듣고 "내 얘기다" 느껴야 함
2. **페르소나 LF8 + pain_scene/desire_scene 어휘** — 명사·동사 source
3. ref Hook의 **archetype(의도 메커니즘)** — 패턴 보존 (아래 archetype별 룰)
4. **어절 수 + 어절별 음절 패턴**은 ref 그대로 (어절 ±1, 어절별 음절 ±2)
   - 어휘는 ref에서 0% 차용 — **템포만 같고 단어는 완전히 새로**
5. **단독 modifier로 끝맺지 말 것** — 항상 명사 따라옴

### ⛔ 제품 도메인 mismatch 자가 검증
1. Hook의 **명사·동사**가 우리 제품(`product_name`) 사용 시나리오에 어울리는가?
2. ref 도메인 단어 ("꿀설정/매장/맛집/카페/잠옷")가 등장하면 → ❌ 무효
3. 페르소나의 desire_scene 어휘가 Hook에 등장하는가? → 등장해야 OK

### 페르소나마다 다르게 — 강제
- 페르소나 A (LF8 #4 매력) → 매력 angle / B (LF8 #5 편안) → 편안 angle / C (LF8 #6 우월) → 우월 angle
- 같은 ref여도 **페르소나 LF8/desire가 다르면 Hook 어휘·맥락 완전 다름**
"""

# archetype별 한정 룰 — 분석 단계에서 분류된 archetype에 따라 1개만 prompt에 박힘
HOOK_ARCHETYPE_GUIDANCES: dict[str, str] = {
    "curiosity_teaser": """### 🎯 archetype: curiosity_teaser ([X]의 이유 / 비결 / 차이 / 방법)

이 패턴은 **core_word ("이유"/"비결"/"방법"/"차이")가 hook의 핵심**. core_word가 빠지면 curiosity 죽음.

**룰**:
- core_word는 **반드시 보존** (다른 명사로 치환 X)
- pattern "[X]의 [core_word]" 형태 그대로 — [X]만 우리 USP/페르소나 어휘로

**예**:
- ref="잠옷을 입는 이유" (core_word="이유")
  - ✅ "여행자들이 가격 알람을 켜는 **이유**" (이유 보존, 도메인만 교체)
  - ✅ "본전 뽑는 사람들의 **비결**" (core_word를 동급으로 교체 OK: 이유↔비결↔방법)
  - ❌ "건조기 돌려도 짱짱한 옷" (core_word 빠짐 → curiosity 죽음)
""",
    "list_teaser": """### 🎯 archetype: list_teaser (N가지 [X] / N개의 [X])

카운트가 호기심 trigger — 시청자가 "어떤 N개?" 궁금해함.

**룰**:
- 숫자 (3가지/5가지/7가지) **반드시 유지**
- "가지/개/방법/이유" 같은 카운터 명사 보존
- [X] 자리만 우리 도메인 어휘로

**예**:
- ref="여행 가기 전 알아야 할 5가지" → ✅ "예약 전에 알아야 할 **5가지**" (5가지 보존)
""",
    "confession": """### 🎯 archetype: confession (자기선언)

핵심: **사실 선언 → 다음 문장에서 풀어냄**. 광고형 직접 USP push와 thrust가 다름.

**룰**:
- 1인칭 ("저는/나는") + 시간 anchor ("오늘/어제/3년째/지금") + 강한 동사 + ~다/~습니다
- 짧고 단호한 종결
- 충격적이거나 호기심 자극하는 사실로 시청자 stop scroll

**예**:
- ref="저는 오늘 토스를 퇴사합니다" → ✅ "저는 오늘 여행자 5명을 만납니다" (자기선언 패턴)
- ref="공개 테스트가 망했습니다" → ✅ "첫 출시가 흔들렸습니다" (사실 선언)
- ref="나는 지금 3년째 호텔을 운영하고 있다" → ✅ "나는 지금 5년째 여행자들의 가격을 추적하고 있다"
""",
    "shock": """### 🎯 archetype: shock (충격 사실)

강한 부정 동사 (망했다/죽었다/끝났다/사라졌다) — 시청자 stop scroll.

**룰**:
- 충격적 fact 1개로 끝
- 다음 문장에서 그 충격을 풀어냄
- 페르소나 desire/pain과 연결되는 충격이어야 함

**예**:
- ref="이 X 모르면 손해" → ✅ "예약 가격 비교 안 하면 손해" (충격 + 페르소나 pain)
""",
    "empathy": """### 🎯 archetype: empathy (공감)

종결: ~잖아요 / ~죠? / ~잖아 — 시청자 일상 묘사로 끌어당김.

**룰**:
- 시청자가 매일 겪는 장면을 한 문장에
- "다들 그렇잖아" 톤
- desire_scene/pain_scene 어휘로 vivid

**예**:
- ref="잘 때는 편한 게 최고잖아요" → ✅ "여행 갈 때마다 가격 비교하잖아요"
""",
    "condition": """### 🎯 archetype: condition (조건절)

종결: ~한다면 / ~떴다면 / ~켜면 — 조건 시나리오로 상상 유도.

**룰**:
- 조건절 그대로 보존
- 다음 문장에서 결과 제시
- [X]면 [Y]된다 형태

**예**:
- ref="누군가 어디서 내릴지 힌트를 준다면 어떨까요?" → ✅ "누군가 호텔 가격 언제 떨어질지 알려준다면 어떨까요?"
""",
    "command": """### 🎯 archetype: command (직접 명령)

종결: ~하세요 / ~사지 마 / 지금 ~하세요 — 직접 행동 명령.

**룰**:
- 강한 동사 + 명령형 어미
- 페르소나가 즉각 행동할 수 있는 동작
- 우리 product 액션 (가격 비교/알람 켜기/저장 등)

**예**:
- ref="이거 사지 마세요" → ✅ "비싸게 예약하지 마세요"
""",
    "noun_label": """### 🎯 archetype: noun_label (정체성 라벨링)

수식어+명사 또는 명사구 — 시청자 정체성 자극 ("나도 그런 사람이다").

**룰**:
- modifier(~하는/~할/~된) + 명사 형태 (단독 modifier로 끝맺지 X)
- 명사는 페르소나 정체성 + 우리 USP 도메인
- 어절 ±1, 어절별 음절 ±2 미러링

**예**:
- ref="똥손은 무조건 사야하는 혼수 필수템" → ✅ "본전 뽑는 여행자들이 무조건 쓰는 **앱**"
- ref="여행 갈 때 챙겨야 할 꿀템" → ✅ "예약 전에 켜야 할 **가격 알람**"
""",
}


def _compose_hook_guidance(archetype: str | None) -> str:
    """COMMON + archetype별 한정 룰 조합. archetype 미분류 시 COMMON만 (8 archetype 안내 X — 토큰 낭비 방지)."""
    arch_block = HOOK_ARCHETYPE_GUIDANCES.get(archetype or "", "")
    if arch_block:
        return HOOK_COMMON_GUIDANCE + "\n" + arch_block
    return HOOK_COMMON_GUIDANCE


# Backward-compat alias — 기존 import (HOOK_GUIDANCE) 호출처용. archetype 없을 때 fallback.
HOOK_GUIDANCE = _compose_hook_guidance(None)

INTRO_GUIDANCE = """## 🚪 INTRO 자유 Transform — 어절·음절 보존 + 비유 처리
- **어절 수 ±1, 어절별 음절 ±2** 허용 범위
- **종결 형태** ref 그대로
- **비유·메타포 처리**: ref의 물리·감각 비유 ("모찌 같은")가 우리 도메인과 안 맞으면 비유 빼고 제품 기능 직접 묘사 (단어만 바꿔 미러 X)
- (톤·desire는 위 페르소나 block의 LF8/scene 룰 적용)
"""

BODY_GUIDANCE = """## 💪 BODY 자유 Transform 모드 (USP 분절) ⭐

⚠️ Body도 **skeleton 강제 X — USP 의미를 자연스러운 한국어로 풀기**. 단, 시그니처·문장 수·길이는 보존.

### ⚠️⚠️⚠️ 명사 어휘 화이트리스트 — 가장 빈번한 실수 차단
**Body의 모든 핵심 명사는 반드시 다음 source 중 하나에서만 가져옴:**
1. spec_block의 **해당 spec의 usp_id에 매핑된 USP description** (문제/해결/혜택)
2. **그 USP의 사용자 리뷰 텍스트**
3. **타깃 페르소나 signals + 여행지명**
4. spec_block의 **slot_topic** (Section Planner가 추출)

⚠️ **위 source에 없는 명사는 절대 출력하지 말 것** — ref 원문에 있는 단어라도 우리 USP source에 없으면 금지.

### ⭐ 플랫폼 맥락어는 ref 그대로 유지 (예외)
릴스/피드/화면/스크롤/영상/이미지/저장/공유/팔로우/댓글/DM/링크 같은 **Instagram(시청자가 지금 스크롤 중인 플랫폼) 맥락어**는 product 도메인 치환 금지. 그대로 유지.
- ✅ ref "당신의 피드에 이 **릴스**가 떴다면" → 우리 "당신의 피드에 이 **릴스**가 떴다면" (릴스 그대로)
- ❌ ref "당신의 피드" → 우리 "**여행앱 피드**" (피드는 Instagram 맥락 → 치환 금지)
- ❌ ref "이 릴스" → 우리 "이 그래프" (릴스도 platform 맥락 → 그대로 유지하고, 그래프는 다른 자리에)
- 룰 정리: 시청자가 "지금 이 화면(인스타)을 보고 있다"는 맥락어는 ref 그대로

### ❌ 자주 나오는 실패 케이스
- ref가 **음식/맛집/식당/카페/마사지/쇼핑/면세** 어휘를 쓸 때 우리 광고가 다른 도메인이면:
  - ❌ 잘못: ref "맛집 할인 쿠폰" → 우리 "맛집 제휴 / 식당 할인" (맛집·식당이 우리 USP에 없으면 금지)
  - ❌ 잘못: ref "이 사이트 들어가면 클룩 쿠폰" → 우리 "앱 들어가면 맛집 제휴" (맛집은 우리 USP 무관)
  - ✅ 정답: USP가 "숙소 가격 추적"이면 → "앱 들어가면 호텔 가격 그래프" / "앱 들어가면 30일 변동 차트"
  - ✅ 정답: USP가 "가격 알람"이면 → "앱 들어가면 목표가 알람 설정"

### 룰
- spec의 `usp_id`에 매핑된 USP의 description·리뷰만 명사 source
- ref의 도메인 명사 (맛집/식당/쇼핑몰/카페/제휴/쿠폰 등)는 우리 USP source에 명시 없으면 **무조건 USP source 명사로 치환**
- USP 도메인 단어가 부족하면 → 추상 명사 (혜택/기능/포인트) 사용 가능
- 절대 ref 원문 도메인 명사 차용 X (slot_topic 명시 케이스 외)

### 보존 (필수)
- **참고 분절 문장 수와 동일** (N문장이면 우리도 N문장)
- **어절 수 ±1, 어절별 음절 ±2** 허용 범위 (의미 호응 우선)
- **분절 간 전환** 참고 패턴 따라 (참고가 "그리고"로 시작하면 우리도 그렇게)
- **각 spec의 usp_id에 맞는 USP 어휘만** — 다른 USP 어휘 침입 금지
- **⭐ 평가형 어구 보존** — ref의 "중요한/핵심/제일 좋은/마지막" 같은 추상명사 앞 평가어는 **그대로 유지**

### 종결어미 (spec_block의 🎯 ref 끝 어절 강제)
- spec_block에 표시된 ref 끝 어절과 **같은 어미 카테고리**로 끝맺기 (~돼요 → ~돼요, 명사 → 명사)
- ⛔ ref 종결어미(~돼요)를 임의로 연결어미(~돼서)로 바꾸면 무효 — 완전히 다른 호흡

### 자유롭게
- skeleton의 [SLOT] 골격 안 따라도 OK
- 동사·구문 자유 변형 (ref 구문 못 따라도 의미만 같으면 OK)
- USP 리뷰의 vivid 표현·일화를 직접 사용
- 예: ref "안쪽은 모달까지 넣어 / 완전니 부드럽잖아" → "겉면은 실크 / 진짜 매끈하잖아" (자유, 의미 + "잖아" 시그니처 보존)

### 추상명사+형용사 매칭 룰 (⚠️ 핵심)
- **추상명사**(포인트/순간/이유/장점/매력/팁) 앞에는 **평가형 형용사**(중요한/좋은/핵심/대단한/특별한)
- ❌ 잘못: "제일 시원한 포인트" (시원한=물리감각, 포인트=추상명사 — mismatch)
- ✅ 정답: "제일 중요한 포인트" (ref 그대로 유지)
- ❌ 잘못: "찰랑한 매력" / "쿨링 이유"
- ✅ 정답: "은은한 매력" / "확실한 이유"

### 절대 금지
- 시그니처 변형
- 다른 분절 USP 어휘 침입
- 가짜 인과 어미로 두 USP 묶기
- 단어 → 명사구 확장 (예: "편한" → "편안한 활동성" ❌)
- 잠옷 광고에 "야외/등산" 같은 도메인 부정합
- 추상명사 앞 형용사를 USP 키워드로 치환 (위 룰 참조)
"""

CTA_GUIDANCE = """## 📢 CTA 자유 Transform 모드 ⭐ — 도메인 적합 단어로 자유 재작성

⚠️ CTA도 **skeleton fixed text를 우리 도메인에 안 맞으면 변형 OK**.

### ⭐ usp_id가 null인 spec — 페르소나 + ref 톤 미러링
spec_block의 usp_id가 비어있는(null) CTA 문장은:
- **특정 USP에 묶지 말 것** — usp_block에 없으면 USP 어휘 도입 X
- **페르소나의 signals + scenario + tone_hint를 명사·동작 source로 사용**
- **ref 문장의 톤·구조·종결을 그대로 미러링** ("이 모든 ~ / 한 번에 / 받고 싶다면" 같은 통합 호소 패턴은 그대로)
- ref가 generic 행동 (팔로우/저장/댓글/DM/링크)을 쓰면 우리도 그대로 — 플랫폼 맥락어니까 도메인 치환 X
- 예: ref "이 모든 정보를 한 번에 받고 싶다면 / 팔로우하고 댓글에 일본 쿠폰 남겨줘 / DM으로 쏴줄게"
  → 우리(페르소나=임산부 잠옷): "이 모든 정보를 한 번에 받고 싶다면 / 팔로우하고 댓글에 임산부 잠옷 남겨줘 / DM으로 쏴줄게"
  (구조·종결·플랫폼 어휘 보존 + 페르소나 signal "임산부"만 치환)

### 보존 (필수)
- **어절 수 + 어절별 음절 패턴 강제** (각 ±2 자 허용)
- **CTA 패턴 구조** (행동 유도·마무리 흐름)
- 종결어미는 spec_block의 🎯 ref 끝 어절과 같은 카테고리로 (~돼요/~예요/명사 등 그대로)

### 도메인 mismatch 단어 변형 (⚠️ 핵심)
ref의 [SLOT] 외 fixed text 중 우리 제품 도메인과 안 맞는 단어는 **자유 변형**:
- ❌ ref "잘 때 [부위]도 안 불편" → 앱 광고에 "잘 때 눈도 안 불편" (앱은 "잘 때" 무관)
  - ✅ "사용할 때 [어디서]도 안 불편" / "비교할 때 헷갈림 없이"
- ❌ ref "노브라 [제품] 최고예요" → 앱에 "땡처리 잠옷 최고예요" ("잠옷" 그대로 박힘)
  - ✅ "정말 편한 가성비 멤버십 최고예요" (잠옷·노브라 도메인어 제거)

### 자유롭게
- skeleton fixed text 통째로 변경 가능
- 같은 emotion/intensity·CTA 흐름만 유지

### 절대 금지
- ref 도메인 특정 단어 그대로 박기 ("잠옷", "잘 때", "꿀잠" 같이 우리 도메인과 안 맞는 단어)
- 새 CTA 패턴 (예약·구독·다운로드 등 ref에 없는 패턴 금지)
- usp_id가 null인 spec에 USP 어휘를 억지로 끼워넣기
"""


def get_section_guidance(section_name: str, hook_archetype: str | None = None) -> str:
    """섹션 타입별 미러링 가이드 반환.

    hook_archetype: 분석 단계에서 분류된 ref Hook archetype (8 카테고리 중 1개).
        지정 시 COMMON + archetype별 한정 룰만 prompt에 박힘 (instruction overload 방지).
    """
    name = (section_name or "").lower()
    if name == "hook":
        return _compose_hook_guidance(hook_archetype)
    if name == "intro":
        return INTRO_GUIDANCE
    if name.startswith("body"):
        return BODY_GUIDANCE
    if name == "cta":
        return CTA_GUIDANCE
    return ""


# ──────────────────────────────────────────────────────────────────────────
# prev_chunks_block builders — 섹션별로 분리
# ──────────────────────────────────────────────────────────────────────────

def _format_prev_lines(prev_chunks: list[dict]) -> list[tuple[str, str]]:
    """prev_chunks → [(section, formatted_line), ...]"""
    out: list[tuple[str, str]] = []
    for pc in prev_chunks:
        pc_section = (pc.get("section") or "").strip()
        pc_sents = pc.get("sentences") or []
        if not pc_sents:
            continue
        line = f"[{pc_section}] " + " / ".join(s.get("text", "").strip() for s in pc_sents if s.get("text"))
        out.append((pc_section, line))
    return out


def build_hook_prev_chunks_block(
    prev_chunks: list[dict],
    my_section_usps: list[dict],
    body_usps_for_common: list[dict],
    hook_archetype: dict | None = None,
) -> str:
    """Hook writer가 보는 prev_chunks_block — 본문/CTA 전체 + 매핑 USP / 공통 욕망.

    hook_archetype: 분석 단계에서 분류된 ref Hook의 의도 메타데이터.
        {archetype, pattern, core_word, reasoning}
    """
    if not prev_chunks:
        return ""
    block = "\n## 📜⭐ 이미 작성된 본문/CTA — Hook은 이 본문의 입구\n"
    for _, line in _format_prev_lines(prev_chunks):
        block += line + "\n"

    # archetype 메타데이터 — 분석 결과 동적 값만 (룰은 HOOK_GUIDANCE에 archetype별로 박힘)
    if hook_archetype and hook_archetype.get("archetype"):
        arch = hook_archetype["archetype"]
        pattern = hook_archetype.get("pattern") or ""
        core = hook_archetype.get("core_word") or ""
        block += f"\n## 🎯 ref Hook 분석 결과 (위 archetype별 룰과 매칭)\n"
        block += f"- **archetype**: `{arch}`\n"
        if pattern:
            block += f"- **pattern**: `{pattern}`\n"
        if core:
            block += f"- **core_word (반드시 보존)**: \"{core}\"\n"
    block += """
→ ⭐ Hook은 본문이 다루는 페르소나 desire/identity로 시청자를 끌어들이는 입구.
→ 본문에서 가장 강력한 1개 angle을 골라 그 angle로 Hook 만들 것 (본문 전체를 압축 X).
→ ref hook 구조·어휘에 묶일 필요 없음 — 페르소나 desire_scene + LF8 trigger가 우선.

⚠️⚠️ **본문 전체를 봐라 — 마지막 body만 보지 말 것**
LLM 경향: prev_chunks 끝쪽(마지막 body)에 weighting → 그 body의 spec·어휘를 Hook에 박음 (실패 패턴)
- ❌ 잘못: 마지막 body가 "그래프 시연"이면 Hook도 "그래프"가 박힘 (positional bias)
- ✅ 올바름: 위 본문을 통째로 읽고, body_1~body_N + cta 전체에서 페르소나가 얻는 **메인 혜택 1개** 추출 → 그 혜택을 Hook에
  - 모든 body가 공통으로 풀어내는 결과 (절약/본전/시간/안심)이 메인 혜택
  - 메인 혜택 = 페르소나 desire_scene과 일치
  - 마지막 body의 spec(그래프/알람/검색)은 일부 시연일 뿐 — Hook에 박지 말 것

⭐⭐⭐ Hook **메인 키워드 룰** (가장 중요)
Hook에는 **시청자의 욕구를 즉각 trigger하는 1개 메인 키워드**가 박혀야 함.
- 메인 키워드 = 페르소나 desire_scene/identity의 핵심 명사·동사 (위 페르소나 block 참조)
- 본문이 이 키워드를 어떻게 풀어내는지 이미 봤으니 — 그 흐름의 **입구**가 Hook
- 키워드는 추상명사 X (편안/만족/효율) — 구체 명사·동작 (절약/할인/본전/N분/N% 등)

⛔⛔⛔ **spec(기능 이름) 박지 말 것** — 가장 빈번한 실패
Hook에 product의 **기능·매커니즘 이름** ("그래프 / 알람 / 새로고침 / 검색 / 트래킹")이 박히면 무효.
시청자는 기능 이름이 아니라 **얻는 혜택·결과**에 반응.

❌ 잘못된 Hook (spec 박힘):
- "이 그래프를 써보세요" (그래프 = 기능)
- "새로고침 그만하세요" (새로고침 = 동작)
- "가격 알람 켜보세요" (알람 = 기능)
- "날짜별 가격 검색하세요" (검색 = 기능)

✅ 올바른 Hook (혜택·결과):
- "여행비 반 아끼는 앱" (혜택: 반 아끼기)
- "본전 뽑는 여행자가 쓰는 앱" (혜택: 본전)
- "30% 할인 받아본 사람만 아는 비결" (혜택: 30% 할인)
- "호텔 가격 손해 안 보는 법" (혜택: 손해 안 봄)

**룰**: spec(그래프/알람/새로고침/검색)은 body에서 풀어내고, Hook/Intro에선 그 spec이 가져다 주는 **결과 어휘**만 사용.

❌ Hook에 페르소나 desire 키워드가 없으면 무효 — 시청자가 자기 얘기로 못 느낌
❌ Hook에 spec 어휘가 박히면 무효 — feature pitching 됨
"""
    if my_section_usps:
        block += "\n## 🎯⭐⭐⭐ Hook 매핑 USP — 이 USP를 직접 사용 (매핑 단계 구조 따르기)\n"
        block += "사용자가 wizard에서 Hook chunk에 매핑한 USP. ref Hook의 **구조**를 이 USP의 **pain/혜택 어휘**로 채울 것.\n"
        block += "(본문 USP 평균이 아닌, **매핑된 USP를 직접** 호소 — 매핑 의도 존중)\n\n"
        for mu in my_section_usps:
            block += f"**USP{mu['id']} · {mu['name']}**\n"
            if mu['pain']:
                block += f"- 문제 (Hook이 trigger): {mu['pain']}\n"
            if mu['benefit']:
                block += f"- 혜택 (Hook이 약속): {mu['benefit']}\n"
            if mu['solution']:
                block += f"- 해결: {mu['solution']}\n"
        block += """
**Hook 작성 룰 (매핑 USP 직접 사용)**:
1. ref Hook의 **구조** (조건문/의문/명령/자기선언 등)를 그대로 따름
2. **명사·동사는 위 매핑 USP의 pain/혜택 어휘**에서 가져옴 (다른 body USP X)
3. ref 어휘 그대로 박지 말 것 (anti-mirror) — 매핑 USP 어휘로 50%+ 변경
4. 페르소나 desire_scene과 매핑 USP pain의 교집합을 Hook 메인 키워드로

⛔ 매핑 USP를 무시하고 본문 USP 평균으로 빠지면 무효
✅ ref 구조 + 매핑 USP 어휘 = Hook
"""
    elif body_usps_for_common:
        block += "\n## 🎯⭐ 본문 USP들의 공통 욕망 (Hook 매핑 없음 — fallback)\n"
        block += "Hook chunk에 매핑된 USP가 없음 → 본문 USP들의 **공통 결과 1개** 추출해서 Hook에.\n\n"
        block += "**본문에 박힌 USP 목록 (혜택 source)**:\n"
        for bu in body_usps_for_common:
            line = f"- USP{bu['id']} ({bu['name']})"
            if bu['benefit']:
                line += f" — 혜택: {bu['benefit']}"
            elif bu['solution']:
                line += f" — 해결: {bu['solution']}"
            block += line + "\n"
        block += """
**Hook 작성 전 self-check**:
1. 위 USP들의 **공통 결과 1개** (절약/본전/시간/안심/할인/손해방지) 추출
2. 그 결과의 **구체 명사·동작**을 Hook 메인 키워드로 (추상명사·spec X)
3. 마지막 body 1개에만 weighted되면 무효 — 모든 USP 공통 결과만 ✅
"""
    return block


def build_intro_prev_chunks_block(
    prev_chunks: list[dict],
    my_section_usps: list[dict],
    body_usps_for_common: list[dict],
) -> str:
    """Intro writer가 보는 prev_chunks_block — Hook+body+cta 보고 bridge 작성."""
    if not prev_chunks:
        return ""
    header = "📜⭐ 이미 작성된 본문/CTA (intro는 본문 보고 작성 — 페르소나 pain 도입)"
    block = f"\n## {header}\n"
    hook_text_intro_bridge = ""
    body1_first_intro_bridge = ""
    for pc in prev_chunks:
        pc_section = (pc.get("section") or "").strip()
        pc_sents = pc.get("sentences") or []
        if not pc_sents:
            continue
        line = f"[{pc_section}] " + " / ".join(s.get("text", "").strip() for s in pc_sents if s.get("text"))
        block += line + "\n"
        # Intro bridge: hook 전체 + body_1 첫 문장 capture
        if pc_section.lower() == "hook" and not hook_text_intro_bridge:
            hook_text_intro_bridge = " ".join((s.get("text") or "").strip() for s in pc_sents if (s.get("text") or "").strip())
        if pc_section.lower().startswith("body_1") and not body1_first_intro_bridge:
            first_text = next(((s.get("text") or "").strip() for s in pc_sents if (s.get("text") or "").strip()), "")
            if first_text:
                body1_first_intro_bridge = first_text
    block += """
→ ⭐⭐ 중복 체크 강제: 위 본문/CTA가 이미 다룬 USP 시연·기능·proof·CTA action을 **intro에서 반복 X**.
→ intro의 역할은 페르소나 **pain 진술 + 솔루션 도입** — 본문이 풀어낼 내용은 미리 다 말하지 말 것 (호기심 남기기)
→ 본문이 "가격 알람/검색 통합/N% 할인"을 시연했으면 intro는 그 결과만 암시 ("매번 비싸게 잡았던 호텔" 같은 pain) — USP 이름·기능 설명 X
→ 어휘·연결어는 본문과 일관성 유지 (다른 톤 X)

⚠️⚠️ **본문 전체에서 페르소나 pain 추출 — 마지막 body만 보지 말 것**
LLM 경향: prev_chunks 끝(마지막 body)의 어휘에 weighting됨 → intro에 그 body spec 박힘 (실패)
- ❌ 잘못: 마지막 body가 "그래프 보여요"면 intro에 "그래프" 박힘 (positional bias)
- ✅ 올바름: body_1~body_N 통째로 읽고 **공통 pain** 추출 → 그 pain을 intro에
  - 공통 pain = 페르소나가 product 쓰기 전 겪던 일 (매번 비싸게 호텔 잡음 / 검색 지침 / 손해 봄)
  - intro는 그 pain의 vivid scene 1개 표현 (spec X, 결과·감정 어휘만)
"""
    if my_section_usps:
        block += "\n## 🎯⭐⭐⭐ Intro 매핑 USP — 이 USP를 직접 사용 (매핑 단계 구조 따르기)\n"
        block += "사용자가 wizard에서 Intro chunk에 매핑한 USP. ref Intro의 **구조**를 이 USP의 **pain/혜택 어휘**로 채움.\n"
        block += "(본문 USP 평균 X — **매핑된 USP를 직접** 호소. 예: 'X 싸게 잡고 싶어서 Y 매번 다 열어보셨던 분이라면' 같은 ref 구조에 매핑 USP의 pain·동작 박기)\n\n"
        for mu in my_section_usps:
            block += f"**USP{mu['id']} · {mu['name']}**\n"
            if mu['pain']:
                block += f"- 문제 (Intro pain 어휘 source): {mu['pain']}\n"
            if mu['benefit']:
                block += f"- 혜택 (Intro 솔루션 도입): {mu['benefit']}\n"
            if mu['solution']:
                block += f"- 해결: {mu['solution']}\n"
        block += """
**Intro 작성 룰 (매핑 USP 직접 사용)**:
1. ref Intro의 **구조** (조건문/페르소나 묘사/문제 진술 등)를 그대로 따름
2. **명사·동사는 위 매핑 USP의 pain·동작 어휘**에서 가져옴 (다른 body USP X)
3. ref 어휘 그대로 박지 말 것 — 매핑 USP 어휘로 50%+ 변경
4. 매핑 USP의 pain을 vivid scene으로 표현 (시청자가 "내 얘기다" 느끼게)

**예 (ref Intro="누군가 어디서 내릴지 힌트를 준다면 어떨까요?", 매핑 USP="땡처리 항공권 검색")**:
- ✅ "항공권 싸게 잡고 싶어서 땡처리 사이트 5개를 매번 다 열어보셨던 분이라면" (ref 조건문 구조 + 매핑 USP의 pain 동작 박힘)
- ❌ "매번 비싸게 호텔 잡고 후회한 적 있으시죠?" (호텔=다른 body USP, 매핑 USP 무시)

⛔ 매핑 USP를 무시하고 본문 USP 평균으로 빠지면 무효
✅ ref Intro 구조 + 매핑 USP의 pain·동작 어휘 = Intro
"""
    elif body_usps_for_common:
        block += "\n## 🎯⭐ 본문 USP들의 공통 pain (Intro 매핑 없음 — fallback)\n"
        block += "Intro chunk에 매핑된 USP가 없음 → 본문 USP들의 **공통 pain 1개** 추출해서 Intro에.\n\n"
        block += "**본문에 박힌 USP 목록 (pain source)**:\n"
        for bu in body_usps_for_common:
            line = f"- USP{bu['id']} ({bu['name']})"
            if bu['pain']:
                line += f" — 문제: {bu['pain']}"
            elif bu['benefit']:
                line += f" — 혜택(역추적 가능): {bu['benefit']}"
            block += line + "\n"
        block += """
**Intro 작성 전 self-check**:
1. 위 USP들이 모두 해결하는 **공통 pain 1개** 추출
2. 그 pain의 vivid 어휘를 Intro에 (spec X, 결과·감정 어휘만)
"""
    if hook_text_intro_bridge or body1_first_intro_bridge:
        block += "\n## 🔗⭐⭐⭐ Hook → Intro → body_1 자연 bridge 강제\n"
        block += "Intro는 **Hook 끝과 body_1 첫 문장 사이를 잇는 다리**. 호흡 안 끊김.\n\n"
        if hook_text_intro_bridge:
            block += f"**Hook 전체**: \"{hook_text_intro_bridge}\"\n"
        if body1_first_intro_bridge:
            block += f"**body_1 첫 문장**: \"{body1_first_intro_bridge}\"\n"
        block += """
**Intro 작성 룰**:
1. Intro 첫 문장 = Hook 끝 호흡 그대로 받기 (같은 주어/topic — 화자 점프 X)
2. Intro 마지막 문장 = body_1 첫 문장으로 자연 연결 (어휘·연결어 매끄러움)
3. Hook이 의문/충격 → Intro가 답·풀이로 받음
4. Hook이 자기선언 → Intro가 그 선언의 배경·이유로 받음
5. Hook이 명사구 stop → Intro가 그 명사를 받아서 펼침

**예시 (Hook="본전 뽑는 여행자들이 매일 켜는 앱", body_1 첫="가격 알람을 켜두면 매일 변동을 감지해요")**:
- ✅ Intro: "매번 호텔 비싸게 잡고 후회한 적 있으시죠? / 그 손해를 막으려고 만든 도구예요." (Hook의 "본전" pain → body_1의 "감지" 도입으로 bridge)
- ❌ Intro: "오늘은 새로운 앱을 소개할게요." (Hook 무관, body_1 무관 — 점프)
- ❌ Intro: "가격 알람 켜두면 좋아요." (body_1과 어휘 중복 — 호기심 죽임)
"""
    return block


def build_generic_prev_chunks_block(prev_chunks: list[dict]) -> str:
    """Body/CTA writer용 — 직전 chunks를 단순 노출, 어휘 일관성 유지 룰만."""
    if not prev_chunks:
        return ""
    block = "\n## 📜 이미 생성된 직전 chunks (이 톤·어휘에 자연스럽게 이어가기)\n"
    for _, line in _format_prev_lines(prev_chunks):
        block += line + "\n"
    block += "→ 위는 이미 발화된 텍스트. 같은 ref·페르소나·톤. 어휘·연결어 일관성 유지.\n"
    block += "→ 이미 다룬 USP/시연/proof/CTA를 다시 말하지 말 것 (chunk별 역할 충실).\n"
    return block
