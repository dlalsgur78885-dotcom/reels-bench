# TetherMax Design System Reference

> TetherMax (https://tethermax.io) 실제 CSS에서 추출한 디자인 시스템.
> Designer Agent가 대시보드 디자인 시 이 파일을 레퍼런스로 참조한다.
> 추출일: 2026-04-09

---

## 핵심 디자인 원칙

1. **절제된 미니멀리즘** — 그림자는 극도로 가볍게, 구분은 border 1px로. 색상은 Blue-600 하나로 시스템 전체를 이끈다.
2. **넓은 여백과 큰 radius** — 카드 16~20px, 팝업 24px. 답답하지 않은 간격(24~32px).
3. **Cool Neutral 톤** — 순수 회색 대신 푸른 기운의 Cool Neutral로 차갑지만 세련된 느낌.

---

## 1. 색상 시스템

### Primary (Blue)
| Token | Value | 용도 |
|-------|-------|------|
| `--Blue-50` | `#e9f3fd` | 선택 배경, 뱃지 배경 |
| `--Blue-100` | `#cde4ff` | 하이라이트 배경 |
| `--Blue-200` | `#9fcaff` | 보조 |
| `--Blue-400` | `#59a4ff` | 호버 보조 |
| `--Blue-600` | `#0b7aff` | **Primary 액션** (버튼, 링크, 활성 상태) |
| `--Blue-700` | `#0051b2` | 호버 상태 |

### Cool Neutral (푸른 기운의 회색)
| Token | Value | 용도 |
|-------|-------|------|
| `--Cool-Neutral-50` | `#f0f3f9` | 페이지 배경, elevated 배경 |
| `--Cool-Neutral-100` | `#dde1e9` | **Border** 기본 |
| `--Cool-Neutral-200` | `#b2bccd` | Border 보조, 비활성 |
| `--Cool-Neutral-300` | `#8b94a9` | **Muted text**, 보조 텍스트 |
| `--Cool-Neutral-400` | `#5f687b` | Secondary text |
| `--Cool-Neutral-500` | `#404858` | Body text (다크 보조) |
| `--Cool-Neutral-900` | `#121721` | **Primary text**, 제목 |

### Neutral (순수 회색)
| Token | Value | 용도 |
|-------|-------|------|
| `--Neutral-200` | `#a7abb6` | dim text |
| `--Neutral-300` | `#8b8c96` | 보조 |
| `--Neutral-400` | `#76787e` | secondary |
| `--Neutral-500` | `#5a5b60` | body text |
| `--Neutral-900` | `#1a1b1c` | primary text (대체) |

### Semantic
| Token | Value | 용도 |
|-------|-------|------|
| `--Red-50` | `#ffebec` | 에러 배경 |
| `--Red-600` | `#d74c45` | **에러/하락** |
| `--Red-700` | `#c94842` | 에러 호버 |
| `--Red-800` | `#bc352f` | 에러 강조 |
| `--Green-600` | (추정) `#00c853` | 상승/성공 |
| `--Yellow-200` | `#fff1b2` | 경고 배경 |
| `--Orange-600` | `#ff8a00` | 경고 |
| `--Indigo-100` | `#c8c5fb` | 인디고 배경 |
| `--Indigo-600` | `#3e2ed9` | 인디고 액센트 |

### System
| Token | Value |
|-------|-------|
| `--System-White` | `#fff` (라이트) / `#121212` (다크) |
| `--System-Black` | `#000` |
| `--System-White_btn` | `#fff` |
| `--System-Dark_btn` | `#1a1b1c` |
| `--Dimmed-85` | `rgba(0,0,0,0.85)` |
| `--Dimmed-70` | `rgba(0,0,0,0.7)` |
| `--Dimmed-30` | `rgba(0,0,0,0.3)` |

---

## 2. 타이포그래피

### Font Family
```css
font-family: 'Pretendard', 'Pretendard Variable', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
/* font-weight: 400, 500, 600, 700, 800 지원 */
/* font-display: swap */
```

### Type Scale
| Token | Size | Weight | Line Height | 용도 |
|-------|------|--------|-------------|------|
| `--font-size-title2` | 28px | 700 | 36px | 페이지 타이틀 |
| `--font-size-heading1` | 22px | 700 | 30px | 섹션 제목 |
| heading2 | 20px | 700 | 30px | 서브 제목 |
| large body | 17px | 500 | 24px | 강조 본문 |
| `--font-size-body1` | 16px | 400~500 | 24px | 기본 본문 |
| `--font-size-body2` | 15px | 400~500 | 22px | 본문 (compact) |
| `--font-size-label1` | 14px | 500 | 20px | 라벨 |
| `--font-size-label2` | 13px | 500 | 18px | 작은 라벨 |
| `--font-size-caption1` | 12px | 400 | 18px | 캡션 |
| `--font-size-caption2` | 11px | 400 | 16px | 작은 캡션 |

---

## 3. 간격 체계

| 용도 | 값 |
|------|-----|
| 카드 내부 패딩 | 16px ~ 24px |
| 팝업 패딩 | 32px 24px 16px |
| 토스트 패딩 | 12px |
| 버튼 패딩 | 14px 12px (세로x가로) |
| 섹션 간 간격 | 24px ~ 32px |
| 아이템 간 간격 | 8px ~ 16px |
| 리스트 아이템 간 | 12px |

---

## 4. Border Radius

| 용도 | 값 |
|------|-----|
| 원형 (아바타) | `100px` 또는 `50%` |
| 모달/팝업 | `24px` |
| 카드 (대형) | `20px` |
| 카드 (중형) | `16px` |
| 버튼 | `12px` |
| 입력/토스트/작은 버튼 | `8px` |
| 뱃지/태그 | `4px` |

---

## 5. Box Shadow

```css
/* 팝업/모달 — 가장 강한 그림자 */
box-shadow: 0 16px 20px 0 rgba(58, 66, 85, 0.08);

/* 카드 — 기본 */
box-shadow: 4px 4px 16px 0 rgba(58, 66, 85, 0.08);

/* 카드 — 약한 */
box-shadow: 6px 6px 12px 6px rgba(22, 34, 64, 0.04);

/* 토스트 */
box-shadow: 0 0 12px 0 rgba(176, 174, 191, 0.28);

/* 글로우 (액센트 강조) */
box-shadow: 0 0 20px 0 rgba(11, 122, 255, 0.35);
```

> **특징**: 모든 그림자가 매우 가볍다 (opacity 0.04~0.08). 구분은 주로 border로.

---

## 6. Border 패턴

```css
/* 기본 구분선 */
border: 1px solid var(--Cool-Neutral-100, #dde1e9);

/* 카드 구분 */
border: 1px solid var(--Cool-Neutral-100);
border-radius: 16px; /* 또는 20px */

/* 입력 필드 */
border: 1px solid var(--Cool-Neutral-100);
/* focus 시 */
border-color: var(--Blue-600, #0b7aff);
```

---

## 7. 컴포넌트 스펙

### Button
```css
/* Primary */
background: var(--Blue-600, #0b7aff);
color: #fff;
border-radius: 12px;
padding: 14px 12px;
font-weight: 600;
transition: all 0.3s ease;
/* hover */
background: var(--Blue-700, #0051b2);

/* Secondary */
background: var(--System-White, #fff);
color: var(--Blue-600);
border: 1px solid var(--Cool-Neutral-100);
border-radius: 12px;

/* Dark Button */
background: var(--System-Dark_btn, #1a1b1c);
color: #fff;
```

### Card
```css
background: var(--System-White, #fff);
border: 1px solid var(--Cool-Neutral-100, #dde1e9);
border-radius: 16px; /* 또는 20px */
padding: 16px ~ 24px;
/* 그림자 선택 사용 */
box-shadow: 4px 4px 16px 0 rgba(58, 66, 85, 0.08);
/* 또는 그림자 없이 border만 */
```

### Popup / Modal
```css
background: var(--System-White, #fff);
border-radius: 20px; /* 또는 24px */
box-shadow: 0 16px 20px 0 rgba(58, 66, 85, 0.08);
padding: 32px 24px 16px;
```

### Toast
```css
background: var(--Cool-Neutral-300, #8894a9);
border-radius: 8px;
box-shadow: 0 0 12px 0 rgba(176, 174, 191, 0.28);
padding: 12px;
color: #fff;
```

### Header
```css
height: 56px; /* 모바일 */
height: 64px; /* PC */
background: var(--System-White, #fff);
/* 또는 그래디언트 */
background: linear-gradient(90deg, #fff 82.22%, #cde4ff 100%);
z-index: 20;
```

---

## 8. 레이아웃

| 속성 | 값 |
|------|-----|
| Max width | 1200px |
| 헤더 높이 (모바일) | 56px |
| 헤더 높이 (PC) | 64px |
| z-index: 사이드메뉴 | 19 |
| z-index: 헤더 | 20 |
| z-index: 모달 | 22 |

### 반응형 Breakpoints
```css
@media (max-width: 1200px) { /* 태블릿 */ }
@media screen and (max-width: 810px) { /* 모바일 */ }
```

### 배경 그래디언트 패턴
```css
/* 히어로/헤더 영역 */
background: linear-gradient(90deg, #fff 82.22%, #cde4ff 100%);

/* 반투명 블러 */
background: hsla(0, 0%, 100%, 0.8);
backdrop-filter: blur(12px);
```

---

## 9. Transition / Animation

```css
/* 기본 전환 */
transition: all 0.3s ease;
transition: background-color 0.3s ease;

/* 호버 */
transition: all 0.3s ease;
```

---

## 10. Dark Mode 토큰 변환

```css
[data-theme="dark"] {
    --white: #121212;
    --System-White: #121212;
    /* Cool Neutral 반전 */
    --Cool-Neutral-50: #1d2028;
    --Cool-Neutral-100: #2a2d38;
    --Cool-Neutral-900: #f0f3f9;
    /* mockup 이미지 교체 */
    --mockup-image: url(/static/images/demoTrading/mockup_dark.png);
}
```

---

## CSS 변수 종합 (복사용)

```css
:root {
    /* ── Primary ── */
    --color-primary: #0b7aff;
    --color-primary-hover: #0051b2;
    --color-primary-light: #e9f3fd;
    --color-primary-100: #cde4ff;

    /* ── Text ── */
    --color-text-primary: #121721;
    --color-text-body: #1a1b1c;
    --color-text-secondary: #5f687b;
    --color-text-muted: #8b94a9;
    --color-text-dim: #a7abb6;

    /* ── Background ── */
    --color-bg: #ffffff;
    --color-bg-secondary: #f0f3f9;
    --color-bg-elevated: #f0f3f9;

    /* ── Border ── */
    --color-border: #dde1e9;
    --color-border-subtle: #ebedf2;
    --color-border-hover: #b2bccd;

    /* ── Semantic ── */
    --color-success: #00c853;
    --color-error: #d74c45;
    --color-warning: #ff8a00;
    --color-info: #0b7aff;

    /* ── Typography ── */
    --font-family: 'Pretendard Variable', 'Pretendard', -apple-system, sans-serif;
    --font-title: 22px;
    --font-body1: 16px;
    --font-body2: 15px;
    --font-label1: 14px;
    --font-label2: 13px;
    --font-caption: 12px;

    /* ── Radius ── */
    --radius-xs: 4px;
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --radius-xl: 20px;
    --radius-2xl: 24px;

    /* ── Shadow ── */
    --shadow-sm: 6px 6px 12px 6px rgba(22, 34, 64, 0.04);
    --shadow-md: 4px 4px 16px 0 rgba(58, 66, 85, 0.08);
    --shadow-lg: 0 16px 20px 0 rgba(58, 66, 85, 0.08);

    /* ── Layout ── */
    --max-width: 1200px;
    --header-height-mobile: 56px;
    --header-height-pc: 64px;
}
```
