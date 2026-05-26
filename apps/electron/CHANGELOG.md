# Reels Studio — CHANGELOG

매 release에 진행률 + "지금 재시작" 배너로 인앱 알람이 발사됨
(`src/main/auto-update.ts` + `components/UpdateBanner.tsx`). 사용자는
설정 → 옵션 popover의 "업데이트 확인" 버튼으로 수동 트리거도 가능
(`components/UpdateStatusPanel.tsx`).

배포 (한 줄):
```
npm run release:minor && npm run publish
```
GitHub Releases로 publish됨 (https://github.com/dlalsgur78885-dotcom/reels-bench/releases).
Supabase Storage Free tier 50MB per-file limit 때문에 호스팅을 옮김.
electron-builder가 GH_TOKEN을 `gh auth token`에서 자동 추출 → 추가 환경
변수 설정 없이 동작.

기존에 0.1.x를 깐 사용자는 한 번만 수동으로 0.2.0 .exe를 받아야 함
(`publish.url`이 Supabase → GitHub로 바뀌어 0.1.x 클라이언트의
auto-updater가 더 이상 latest.yml을 찾지 못함). 0.2.0부터는 다시 정상
인앱 알람.

---

## 0.2.7 (2026-05-26)

### 버그 (슬라이드 6 후속)
- 두 번째 클립으로 스왑은 되는데 "스페이스를 눌러야 재생됨" 증상 해결.
  원인: src 교체 + `v.load()`가 <video>를 paused로 reset. play/pause
  useEffect의 deps는 `[playing, audioTracks, videoTracks]` 뿐이라 src
  교체만으로 re-fire 안 됨. swap useEffect에서 src 교체 직후 `playing`이
  true면 새 <video>에 `play()` 직접 호출 + swap effect deps에 `playing`
  추가(closure-stale 방지).

---

## 0.2.6 (2026-05-26)

### 버그
- 두 클립이 연속된 타임라인에서 재생이 두 번째 클립으로 넘어가도 프리뷰
  가 첫 번째 클립의 마지막 프레임에서 멈추는 문제(PPT 슬라이드 6) 해결.
  원인: PreviewCanvas의 `<video>`가 `preload` 미지정이라 browser 기본값
  `metadata`만 받음 → src 교체 후 frame data buffering 동안 이전 frame
  freeze. `preload="auto"` + src 변경 직후 명시 `v.load()` 호출로 frame
  data 즉시 fetch 시작.

---

## 0.2.5 (2026-05-26)

### UX
- "📱 플랫폼 미리보기" picker(SocialPreviewSelector) 위치 우상단 → 좌상단.
  우상단은 AudioMeter / ColorScopes / 풀스크린 / 1× preview-speed가 같은
  absolute slot을 차지해 picker가 시각적으로 가려졌음. 좌상단으로 옮기니
  발견성 100%. SocialPreviewOverlay 기능 자체는 0.1.x부터 이미 구현돼
  있던 Phase 6 — 이번엔 위치만 fix.
  (PPT 슬라이드 17 — "프리뷰 화면에서 SNS 플랫폼 선택하면 왼쪽 사진처럼"
   매칭 작업.)

---

## 0.2.4 (2026-05-26)

### UX
- 이모지 모두 제거 — IMPORT_TABS (music/sfx/brand) + Editor 좌측 rail
  (media/overlay/text/transcript). icon 비면 span skip하도록 조건 렌더링,
  layout 영향 없음. label 텍스트만 남음.

---

## 0.2.3 (2026-05-26)

### UX
- 사운드 탭 라벨 명확화 — 사용자 혼란 해소.
  - 🎵 음악 → 🎵 **사운드 라이브러리** (큐레이션 시드 카탈로그 + 1-클릭 import)
  - 🔊 효과음 → 🔍 **효과음 검색 (Freesound)** (키워드로 라이브 검색,
    수십만 개, CC0/Attribution 라이선스 필터링)

### 백엔드 (0.2.2 이후 누적)
- /api/audio-library 시드 8→3 (403 URL 5개 제거) + require_user 해제.
  "효과음 누르면 불러오기 실패: Failed to fetch" 직접 해결.

---

## 0.2.2 (2026-05-26)

### 성능
- Playhead(빨간 선) 부드러운 60fps. 이전엔 zustand `playheadMs`를 큰
  Timeline(~3500 LoC) 전체가 구독해서 매 rAF tick(16ms)마다 React
  reconciliation — stutter 원인. 새 `SmoothPlayhead` 컴포넌트가 zustand
  subscribe로 DOM `style.transform`만 직접 갱신(reconciliation 우회) +
  `translate3d` + `will-change: transform`으로 GPU compositor 레이어 promotion.

---

## 0.2.1 (2026-05-26)

인앱 자동 알람 실제 fire 확인용 patch — electron app 자체 동작 변경은 없음.

### 백엔드 + 인프라
- `/api/editor/latest` 옛 Supabase 파서 제거, GitHub Releases 기반 단일
  endpoint로 정리.
- Supabase Storage 잔여 manifest(latest.yml + blockmap) cleanup —
  scripts/cleanup-supabase.mjs 신규.

이 patch가 publish되면 깔린 0.2.0 클라이언트는 부팅 5분 후 자동 알람 OR
옵션 popover → "업데이트 확인" 즉시 클릭으로 update 배너를 받게 됨.

---

## 0.2.0 (2026-05-25)

UI/UX harness 5 사이클 + 분석 영상 reproduce 격차 3종.

### 추가
- **그린/블루스크린 chromakey** — `VideoAudioClip.chromaKey` + ffmpeg
  `format=yuva420p,chromakey=` 필터. 다중 video track 위에 띄우면 진짜
  합성 동작.
- **카운트다운/카운트업 자막** — `addCountdownCaptions({from, to, intervalMs,
  prefix?, suffix?})` — N개 정적 caption 자동 생성. 한글/폰트픽커/preview
  1:1.
- **음원·SFX 카탈로그** — `GET /api/audio-library` + Pixabay CDN 시드 8곡
  (music 5 + sfx 3). ImportPanel → MusicLibraryTab 즉시 사용 가능.
- **자막 폰트 픽커** — 8종 폰트 카탈로그 (`CAPTION_FONT_FAMILIES`). 한글
  fallback 항상 꼬리에 — 어떤 family를 골라도 한글 글리프 안전.
- **한글 SRT 임포트 데모** — `/my-scripts` → SRT 다운 → 에디터 import →
  export까지 풀파이프 작동.

### a11y / UX (audit 100% 처리)
- Critical: 클립 삭제 후 "X 삭제됨 · Ctrl+Z로 되돌리기" Toast (메뉴 +
  Delete 키 양쪽).
- High: Toast `role="alert"` (error variant) · AudioMeter 색만 → ⚠ +
  hatched gradient + `role="meter"` · 6 다이얼로그
  `role="dialog"`+`aria-modal`+`aria-labelledby` · `useFocusTrap` Tab 트랩 +
  opener focus 복원 · `prefers-reduced-motion` 전역 hook + CSS fallback ·
  `:focus-visible` 글로벌 ring · `theme/tokens.ts` 디자인 토큰 인프라.
- Medium: AI 다이얼로그 "되돌릴 수 있어요 · Ctrl+Z" hint · AutoEdit dry-run
  silence preview · STT lowConfidence 캡션 점선 underline · Tooltip 컴포넌트
  (키보드/포커스 hear) · 닫기 버튼 hit-area 24px 이상.
- Low: previewSpeed setTimeout race → MutationObserver · eslint-disable
  코멘트 보강.

### 인프라
- 신규 `src/renderer/src/theme/tokens.ts` — surface/text/accent/space/font/
  radius/shadow.
- 신규 `src/renderer/src/global.css` — `:focus-visible` + reduced-motion
  CSS fallback.
- 신규 `src/renderer/src/lib/usePrefersReducedMotion.ts`,
  `src/renderer/src/lib/useFocusTrap.ts`.
- 신규 `src/renderer/src/components/Tooltip.tsx`,
  `UpdateStatusPanel.tsx`.
- `apps/electron/.claude/` harness 자산 — 8 sub-agent + `/ui-improve`
  slash command + crit skill.
- 신규 `scripts/publish-supabase.mjs` — `release/win/` 산출물을 Supabase
  Storage `electron-releases/win/` bucket에 업로드.

### 수동 업데이트 확인
- `updater:checkNow` IPC + `updater:notAvailable` / `updater:error`
  push events. 옵션 popover의 "업데이트 확인" 버튼이 5분 대기 없이 트리거.

### 회귀
- 5사이클 합산 1000+ e2e spec 통과, 0 회귀.

---

## 0.1.0 (이전)

초기 베타. OpenCut fork + ffmpeg 네이티브 export + 자동 자막(Whisper)
+ 자동 리프레임(BlazeFace) + 무음 자동 제거 + 비트 컷 + STT/karaoke 자막.
