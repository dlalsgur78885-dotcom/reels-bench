---
name: 릴스 벤치
description: 인스타그램 릴스 한 편을 깊게 해부하는 사내 분석 콘솔
colors:
  pretendard-blue: "#307df0"
  pretendard-blue-deep: "#2664c3"
  bg-base: "#F8F9FB"
  bg-surface: "#FFFFFF"
  bg-elevated: "#F2F3F7"
  bg-hover: "#F5F6FA"
  text-primary: "#121721"
  text-body: "#1A1B1C"
  text-secondary: "#6B7280"
  text-muted: "#8B94A9"
  text-dim: "#A7ABB6"
  border: "#E5E7EB"
  border-subtle: "#F0F1F5"
  success: "#10B981"
  error: "#EF4444"
  warning: "#F59E0B"
typography:
  display:
    fontFamily: "Pretendard Variable, Pretendard, -apple-system, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Pretendard Variable, Pretendard, -apple-system, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Pretendard Variable, Pretendard, -apple-system, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Pretendard Variable, Pretendard, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Pretendard Variable, Pretendard, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  eyebrow:
    fontFamily: "Pretendard Variable, Pretendard, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.08em"
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "18px"
  pill: "99px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "20px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.pretendard-blue}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    padding: "8px 20px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.pretendard-blue-deep}"
  button-ghost:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-body}"
    rounded: "{rounded.sm}"
    padding: "6px 14px"
    typography: "{typography.label}"
  kpi-card:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "18px 20px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    padding: "10px 20px"
    typography: "{typography.label}"
  tab-active:
    textColor: "{colors.text-primary}"
  input:
    backgroundColor: "{colors.bg-base}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "11px 13px"
  chip:
    backgroundColor: "{colors.bg-base}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "5px 9px"
    typography: "{typography.label}"
  status-pill-ok:
    backgroundColor: "rgba(16,185,129,0.10)"
    textColor: "{colors.success}"
    rounded: "{rounded.sm}"
    padding: "2px 7px"
  status-pill-wait:
    backgroundColor: "rgba(245,158,11,0.12)"
    textColor: "{colors.warning}"
    rounded: "{rounded.sm}"
    padding: "2px 7px"
---

# Design System: 릴스 벤치

## 1. Overview

**Creative North Star: "The Studio Console"**

이 시스템은 정밀 콘트롤판이다. 사용자는 마케팅 실무자라는 제작자이고, 화면은 그가 손에 쥔 음향 콘솔처럼 정확하게 반응해야 한다. 콘솔의 미덕은 자기를 드러내지 않는 것이다. 노브와 페이더의 위계, 라벨의 가독성, 미터의 색은 신호를 위해 존재할 뿐 자기 자신을 자랑하지 않는다. 같은 자세로, 이 대시보드는 데이터(프레임, 감정 곡선, 댓글)가 주인공이 되도록 자기를 비운다.

명백히 거부하는 것: AI 마케팅 광고의 보라·청록 그라데이션, glassmorphism 카드, "big number + 보조 stat 3개" 히어로 메트릭, gradient text, 둥근 일러스트와 친근한 마스코트. TikTok·Instagram 자체 UI를 흉내 내는 것도 거부한다. 우리는 분석 도구이지 또 하나의 인스타가 아니다. 한국 공공·은행 SaaS의 "정보 아쿠리움"(아이콘 과다 + 채도 높은 색 박스 + 반복 카드 그리드) 또한 안티 레퍼런스다.

집중하는 곳: 한글 우선 타이포그래피(Pretendard Variable), 단일 강조색의 절제된 운용(Pretendard Blue가 화면의 ≤10%), 평면 표면을 기본으로 하고 호버에만 미묘한 깊이, 그리고 폰트 굵기·크기·여백이 만드는 위계.

**Key Characteristics:**
- 한글 본문이 시각의 기준점. 라틴 폰트 fallback은 보조 역할
- 강조색은 `Pretendard Blue` 단 하나, 행동 가능한 요소에만
- Surface는 평면, 깊이는 호버 시점에만 1px ring + soft shadow로 짧게
- 컬러 배지나 아이콘 대신 폰트 굵기·크기·여백으로 위계
- 모든 픽셀 단위는 4의 배수 + 의도적 예외(11px eyebrow, 99px pill)

## 2. Colors: The Single-Voice Palette

15개 토큰, 그 중 강조 역할을 맡는 색은 단 하나. 나머지는 모두 중립 또는 시맨틱이다.

### Primary

- **Pretendard Blue** (`#307df0`): 단 하나의 강조색. 활성 탭 하단 보더, primary 버튼, 활성 사이드바 항목, 입력 포커스 보더, 진행 바 채움, eyebrow 라벨에만 사용. 화면 면적의 10%를 절대 넘지 않는다.
- **Pretendard Blue Deep** (`#2664c3`): primary 버튼 호버 한정. 그 외 어디서도 등장하지 않는다.
- **Accent Tint Light** (`rgba(48,125,240,0.08)`): 활성 사이드바 항목 배경, 단축코드 미리보기 박스. 칠해진 면적에만, 호버 강조에 절대 쓰지 않는다.
- **Accent Tint Medium** (`rgba(48,125,240,0.12)`): 채널 행 호버 보더 한정.

### Neutral

- **Bg Base** (`#F8F9FB`): 페이지 배경. body 직속.
- **Bg Surface** (`#FFFFFF`): 카드·패널·사이드바·모달.
- **Bg Elevated** (`#F2F3F7`): 트랜스크립트 박스, 진행바 트랙, 이미지 placeholder. Surface보다 한 단계 안쪽.
- **Bg Hover** (`#F5F6FA`): 호버 상태의 사이드바·뒤로가기 버튼. Surface와 Elevated 사이.
- **Text Primary** (`#121721`): 헤딩, KPI 값, 사이드바 로고, 카드 작성자명.
- **Text Body** (`#1A1B1C`): 본문 텍스트.
- **Text Secondary** (`#6B7280`): 사이드바 비활성, 본문 보조 설명, 칩 텍스트.
- **Text Muted** (`#8B94A9`): 메타정보, KPI 라벨, 페이지 헤더 부제, eyebrow.
- **Text Dim** (`#A7ABB6`): 이미지 placeholder 폴백 글자만.
- **Border** (`#E5E7EB`): 카드·패널·인풋 보더, 페이지 헤더 디바이더.
- **Border Subtle** (`#F0F1F5`): 리스트 행 구분선, 사이드바 디바이더, manage-row 구분선.

### Semantic

- **Success** (`#10B981`): `.status-ok` 텍스트색. 배경은 항상 동일 색의 10% 알파.
- **Error** (`#EF4444`): 삭제 버튼 텍스트, 에러 메시지, 채널 삭제. 배경은 `#FEF2F2`(success/warning과 같은 10% 가벼운 알파 대신 별도 핑크 톤).
- **Warning** (`#F59E0B`): `.status-wait` 텍스트색. 배경은 동일 색 12% 알파.

### Named Rules

**The Single-Voice Rule.** 한 화면에 강조색은 Pretendard Blue 단 하나, 그것도 행동 가능한 요소에만. 라벨·카테고리·구분 표시에는 절대 쓰지 않는다. 위계는 폰트와 여백이 만든다.

**The Tint, Not Stripe Rule.** 그룹 정체성을 컬러로 표시할 때는 면 전체를 8% 이하 알파로 칠한다. 사이드 보더 스트라이프는 절대 금지(2px 이상의 colored side border). 학습 데이터 반사 신호 1순위.

**The 10% Ceiling Rule.** Pretendard Blue가 화면 면적의 10%를 넘으면 디자인이 망가진 것이다. 칸반 보드처럼 강조가 도배되면 강조의 의미가 사라진다.

## 3. Typography: The Pretendard Hierarchy

**Display Font:** Pretendard Variable (한글 우선)
**Body Font:** Pretendard Variable (Display와 동일 — 단일 폰트 시스템)
**Fallback:** -apple-system, sans-serif

**Character:** 한글이 시각의 기준점. Pretendard는 한·영 혼용 시 라틴 글자가 한글 옆에서 어색하지 않도록 설계된 한국어 우선 가변 폰트다. 굵기 변화로 위계를 만들고, 글자 폭을 시스템 전체에서 일정하게 유지한다.

### Hierarchy

- **Display** (`weight 700, 24px, line-height 1.2, letter-spacing -0.03em`): KPI 값, 단일 큰 숫자. KPI 카드의 시각 무게 중심.
- **Headline** (`weight 650, 22px, letter-spacing -0.03em`): 페이지 헤더 h1. 한 페이지에 1회.
- **Title** (`weight 600, 21px, letter-spacing -0.02em`): 워크스페이스 섹션 제목, intake 페이지 메인 카피.
- **Body** (`weight 400, 15px, line-height 1.6`): 본문 기본. 한글 본문 가독성을 위해 line-height 1.6 고정.
- **Label** (`weight 500, 12px`): KPI 라벨, 칩, 상태 표시, 작은 인터랙션 요소.
- **Eyebrow** (`weight 700, 11px, letter-spacing 0.08em, uppercase`): 워크스페이스 진입 위 라벨. Pretendard Blue로만 사용한다(중립색 eyebrow는 만들지 않는다).

### Named Rules

**The Korean-First Rule.** 본문 단위는 한글이 끊기지 않게 word-break, 줄바꿈, max-width를 검토한다. 65–75ch 룰은 라틴 본문 기준이며, 한글은 더 짧게(45–55em) 끊는 편이 가독성이 좋다.

**The Weight-Over-Color Rule.** 강조는 굵기 변화(400 → 600 → 700)로. 색상으로 강조하지 않는다. 색상은 행동 가능 요소(링크, 버튼, 활성 탭)에만 허용된다.

**The Single-Family Rule.** Pretendard Variable 외의 폰트를 추가하지 않는다. 모노스페이스가 필요하면 별도 도입 전에 정말 필요한지 두 번 묻는다.

## 4. Elevation: Flat-by-Default

이 시스템은 거의 평면이다. Surface는 휴식 상태에서 그림자가 없고, 1px 보더만으로 구획을 만든다. 깊이는 사용자 액션(호버)에 대한 응답으로만 잠깐 등장한다. 정적 그림자(decorative shadow)는 시스템 어디에도 없다.

### Shadow Vocabulary

- **shadow-sm** (`0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)`): KPI 카드·분석 카드 호버 한정. 보더가 미묘하게 진해지는 것과 함께 짧게.
- **shadow-md** (`0 4px 12px rgba(0,0,0,0.06)`): 릴 카드 호버 한정. translate-Y와 함께 카드가 살짝 떠오른다.
- **focus-ring** (`0 0 0 1px rgba(48,125,240,0.15)`): 릴 카드 호버 시 shadow-md 위에 추가되는 1px 후광. accent의 존재만 부드럽게 알린다.

### Named Rules

**The Stillness-At-Rest Rule.** 어떤 요소도 휴식 상태에서 그림자를 갖지 않는다. 그림자는 상호작용의 보상이다.

**The Hover-Only Rule.** 호버에 등장하는 그림자는 200ms 이내에 들어왔다 나가야 하고, 한 번에 하나의 요소에만 보인다. 동시에 여러 카드에 그림자가 떠 있는 화면은 망가진 화면이다.

## 5. Components

### Buttons

- **Shape:** 둥근 모서리 10px(`rounded-md`). 기본 버튼은 거의 모두 이 모양.
- **Primary:** Pretendard Blue 배경, 흰 글자, 8×20 패딩, weight 600, 14px. 호버 시 Pretendard Blue Deep로 전환(150ms ease).
- **Ghost / Secondary:** 흰 배경, 1px border, text-body 색, 6×14 패딩. "뒤로가기" 같은 비주력 액션 전용.
- **Danger:** 흰 배경, `#FCA5A5` 보더, error 글자색, `#FEF2F2` 호버 배경. 채널 삭제·계정 삭제 등 비가역 액션에만.
- **Disabled:** opacity 0.5, cursor not-allowed.

### Cards / Containers

- **Corner Style:** KPI 카드 14px(`rounded-lg`), 릴 카드 18px(`rounded-xl`), 패널·인풋 컨테이너 10px(`rounded-md`).
- **Background:** 항상 `bg-surface`(흰색). 인터랙티브하지 않은 박스는 `bg-elevated`.
- **Shadow Strategy:** 휴식 상태 그림자 없음. 호버에만 등장(Elevation 섹션 참조).
- **Border:** 1px solid `border` 토큰. 호버 시 `#d1d5db`로 한 단계 진해지거나, 인터랙티브한 경우 accent로 전환.
- **Internal Padding:** `lg`(20px) 표준. 작은 카드는 `md`(14px). nested padding(카드 안에 카드)은 금지.

### Inputs / Fields

- **Style:** `bg-base` 배경, 1px `border`, `rounded-sm` 6px 모서리, 11×13 패딩, 14px 본문.
- **Focus:** 보더만 accent로 전환. glow ring 없음, animation 없음, 150ms.
- **Disabled:** opacity 0.5.
- **Error:** 인라인 메시지로 처리. 인풋 자체는 변형하지 않는다(빨간 테두리 금지 — 색에 의존하지 않는 에러 표시).

### Chips / Pills

- **Tag chip** (`stat-pill`, `tag-strip span`): `bg-base` 배경, `border` 1px, text-secondary, `rounded-sm` 6px, 5×9 패딩, 11–12px 라벨.
- **Status pill** (`status-ok`, `status-wait`): 색상 텍스트 + 동일 색 10–12% 알파 배경, 보더 없음. radius-sm. 시맨틱 의미 전용.

### Tabs

- **Style:** 하단 보더 only. 비활성은 `text-muted` + transparent 보더, 활성은 `text-primary` + 2px Pretendard Blue 하단 보더 + weight 600.
- **No top/side borders ever.** 탭 컨테이너의 다른 면은 전부 透明.

### Sidebar Navigation

- **Width 220px 고정**, position fixed. 모바일(900px 이하)에서 static으로 전환.
- **Item style:** 9×12 패딩, `rounded-sm`, 14px label, 비활성은 text-secondary. 호버 시 `bg-hover` + text-body. 활성은 `accent-light` 배경 + Pretendard Blue 텍스트 + weight 600.
- **Icon:** 폰트 16px, 비활성 opacity 0.6 / 활성 1.0. 컬러 아이콘 금지.

### Progress Bar

- 6px 높이, `bg-elevated` 트랙, Pretendard Blue 채움. radius 3px(절반). 컨테이너는 `rounded-md` 카드 안에 둔다.

### Frame Timeline (Signature Component)

- `FrameTimeline.tsx`. 캔버스 기반 차트, 120px 높이, 누적 컷 라인 한 줄, 호버 vline은 Pretendard Blue 2px. 차트는 그리드도 라벨도 최소화하고 데이터 곡선만 보여준다. 정확히 "콘솔의 미터"가 들어갈 자리.

## 6. Do's and Don'ts

### Do

- **Do** Pretendard Blue를 "행동 가능한 요소"에만 쓴다. 활성 탭, primary 버튼, 활성 사이드바, 인풋 포커스, 진행바, eyebrow.
- **Do** 위계를 폰트 굵기(400/500/600/650/700)와 크기 비율(11/12/13/14/15/21/22/24)로 만든다.
- **Do** 카드에 보더는 1px solid `border`만 쓴다. 호버 시 보더가 살짝 진해지는 정도로 충분하다.
- **Do** 한국어 본문은 line-height 1.6, max-width 45–55em으로 끊는다.
- **Do** 그림자는 호버에만, 200ms 안에 들어왔다 나가게.
- **Do** `radius-sm 6 / md 10 / lg 14 / xl 18`만 사용한다. 21이나 12는 시스템 밖.
- **Do** 시맨틱 색(success/error/warning)은 텍스트 + 동일 색 10–12% 알파 배경 조합으로만.

### Don't

- **Don't** 보라·청록 그라데이션, 형광 글로우, glassmorphism 카드를 만든다. AI 마케팅 광고 텔.
- **Don't** "big number + small label + 보조 stat 3개" hero-metric 카드 템플릿을 만든다. SaaS 클리셰.
- **Don't** 컬러 사이드 스트라이프 보더(`border-left: 2px+ solid <color>`)를 만든다. 절대 금지. 학습 데이터 반사 1번. (현재 `BenchDetail.tsx:373/398/582`에 있음 — 제거 대상.)
- **Don't** 이모지를 버튼·라벨·헤더에 장식으로 쓴다(🎙 📋 ✓ 등). Pretendard Blue가 단어로 충분히 강조한다.
- **Don't** TikTok·Instagram 공식 UI를 모사한다. 분석 도구 정체성을 흐린다.
- **Don't** 강조색을 Pretendard Blue 외 다른 hue로 추가한다. 카테고리·반응·섹션 정체성은 라벨 칩과 폰트 굵기로 표현한다.
- **Don't** Pretendard 외의 폰트를 도입한다(모노스페이스 포함, 정말 필요할 때까지).
- **Don't** gradient text(`background-clip: text` + 그라데이션 배경)를 쓴다.
- **Don't** 둥근 일러스트, 친근한 마스코트, "당신의 비즈니스를 성장시키세요" 류 마케팅 카피를 등장시킨다.
- **Don't** 휴식 상태 카드에 그림자를 둔다. flat이 기본이다.
- **Don't** 인풋 에러를 빨간 테두리로 표시한다. 인라인 메시지로.
- **Don't** nested 카드(카드 안에 카드)를 만든다. 위계는 여백으로.

오디트 한 줄 테스트: *화면을 1분간 들여다본 뒤 "강조색이 무엇이었는지" 물었을 때 답이 단 하나(Pretendard Blue)가 아니면, 시스템 밖이다.*
