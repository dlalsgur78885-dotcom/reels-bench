# Designer Agent

## 역할
UI/UX 디자인 에이전트. 3개 LLM을 조합하여 대시보드 디자인을 분석·설계·코드화하는 파이프라인.

## 모델 구성
| 단계 | 모델 | 역할 |
|------|------|------|
| 시각 분석 | Gemini 2.5 Flash | 스크린샷/레퍼런스 → 디자인 요소 추출 (색상, 레이아웃, 타이포, 간격) |
| 디자인 설계 | GPT-4o | 추출된 요소 기반 디자인 시스템 설계 (컬러팔레트, 컴포넌트 스펙, 스타일 가이드) |
| 코드 생성 | Claude Sonnet 4.6 | 설계 스펙 → CSS/HTML/Streamlit 코드 생성 |

## 파이프라인
```
[입력] 스크린샷 or 디자인 요청
        ↓
[Gemini] 시각 분석
  - 스크린샷: 색상코드, 폰트, 간격, 레이아웃 구조 추출
  - 텍스트 요청: 스킵
        ↓
[GPT-4o] 디자인 설계
  - 컬러 팔레트 (primary, secondary, accent, neutral, semantic)
  - 타이포그래피 스케일 (h1~body, weight, line-height)
  - 간격 체계 (spacing scale)
  - 컴포넌트 스펙 (카드, 버튼, 테이블, 차트 컨테이너)
  - 레이아웃 그리드
        ↓
[Sonnet] 코드 생성
  - CSS 변수 + 클래스
  - Streamlit 커스텀 CSS
  - HTML/컴포넌트 코드
        ↓
[출력] design_system.json + style.css + 컴포넌트 코드
```

## 사용법
```bash
# 스크린샷 분석 → 디자인 시스템 생성
python designer.py --screenshot "path/to/screenshot.png"

# 텍스트로 디자인 요청
python designer.py --prompt "미니멀 라이트 테마 대시보드, 파란 계열 액센트"

# 기존 CSS 개선
python designer.py --improve "dashboard/style.css"

# 레퍼런스 여러 장 분석
python designer.py --references "ref1.png" "ref2.png" "ref3.png"
```

## 상태
- active: true
- version: 1.0.0
- updated: 2026-04-09

## 입력
- orchestrator 또는 직접 CLI 호출

## 출력
- `design_system.json` — 디자인 토큰 (색상, 타이포, 간격)
- `style.css` — 생성된 CSS
- Supabase `design_versions` 테이블에 버전 기록 (선택)
