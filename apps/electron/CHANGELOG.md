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

## 0.2.44 (2026-05-27)

### 개선 (pptx12 슬라이드 12 — 사용자 보고 "자막 최대 크기가 너무 작음")
- 자막 글자 크기 슬라이더 max 96 → **500** 으로 확장.
- 숫자 입력란(`caption-fontsize-input`) 추가 — 슬라이더 1px 단위로 큰
  범위 미세 조정 번거로움 해소. [16, 500] clamp.

### e2e
- caption-fontsize-range.spec.ts 3 tests — slider max 속성 / slider 500
  set 시 store 반영 / number input clamp 검증.

---

## 0.2.43 (2026-05-27)

### 개선 (pptx12 슬라이드 13 — 사용자 보고 "자막 폰트 얼마 없음")
자막 폰트 카탈로그 8 → 20 으로 확장.

- 기존 8: Pretendard / 맑은 고딕 / Apple SD 고딕 Neo / Noto Sans KR /
  Arial / Impact / Georgia / Courier New
- **신규 한글 6**: 나눔고딕 / 나눔명조 / 나눔스퀘어 / 나눔손글씨 펜 /
  Noto Serif KR / G마켓 산스
- **신규 영문 6**: Helvetica / Times New Roman / Verdana / Tahoma /
  Trebuchet MS / Comic Sans MS

폰트는 시스템 + Pretendard fallback 체인을 따르므로 사용자 OS 에 설치
안 된 폰트는 Pretendard 로 자연 fallback. 시스템 폰트 + Pretendard 임
베디드만 가정.

### e2e
- caption-font-catalog.spec.ts 2 tests — selector 의 option ≥18 + 기존 8 +
  신규 12 id 모두 노출 / 새 폰트 선택 시 caption.style.fontFamilyId 저장.

---

## 0.2.42 (2026-05-27)

### 개선 (pptx12 슬라이드 18 — 사용자 재요청)
"조정 레이어 추가 기능 — 일반 효과에 있는 기능들 전부 삽입 (변형/속도/
애니메이션/조정/전환/레이아웃)". 0.2.35 에서 fade in/out 만 부분 적용
했던 걸 사용자가 다시 지적 — 일반 EffectsPanel 과 동일한 6탭 구조를
조정 레이어에도 노출.

- **AdjustmentLayerEditor**: 6탭 (변형/속도/애니메이션/조정/전환/레이아웃)
  바 + 활성 탭 state. 기본 활성 = 조정.
- **조정 탭**: 기존 콘텐츠 (필터 preset / 색 보정 / 곡선 / HSL).
- **전환 탭**: 기존 fade in/out (pptx11 슬라이드 23, 0.2.35 부터).
- **변형 / 속도 / 애니메이션 / 레이아웃 탭**: 조정 레이어 의미상 무관한
  탭은 명시적 안내문 표시 — UX 일관성 유지하면서 사용자 혼동 방지.
  애니메이션은 "키프레임 기반 grade 시간 변화는 추후 지원 예정" 으로
  TODO 명시.

### e2e
- adjustment-layer-tabs.spec.ts 4 tests — 6 탭 노출 + 기본 활성 / 안내문 /
  전환 탭 fade 슬라이더.

---

## 0.2.41 (2026-05-27)

### 버그 (pptx11 슬라이드 12 — 사용자 보고 "플랫폼 미리보기 오류")
릴스/숏츠/틱톡 오버레이의 좋아요/댓글/공유 아이콘들이 영상 오른쪽
가장자리가 아닌 **가운데**에 떠 있어 인물 얼굴 위로 겹치던 문제.

**원인**: `ActionStack` 에 explicit width 가 없어 ActionButton 의 label
텍스트("2.8K", "공유", "리믹스" 등) 가 stack 가로 폭을 늘림. CSS `right:
3.5%` 는 stack 의 **오른쪽 edge** 기준이라 stack 본체가 가운데 위치 →
icon 들이 alignItems:center 로 가운데 정렬.

**fix**: `ActionStack` 에 `width: 14%, minWidth: 48` 명시 → label 이
stack 폭을 못 늘리고 좁은 컬럼으로 우측 정렬 유지. 0.2.35 bench2 배치
때 SocialPreviewOverlay 자체는 들어왔지만 이 layout 버그는 못 잡혀
있었음.

### e2e
- social-preview-position.spec.ts 3 tests — 각 플랫폼(tiktok/youtube/
  instagram) 의 ActionStack 위치 회귀 가드. preview-fitted-rect 대비
  stack right edge ≥ 90% / left edge ≥ 65% / 폭 ≤ 30% 검증.
- 기존 social-preview-actions.spec.ts 3 tests (action 구성) 도 그대로 통과.

---

## 0.2.40 (2026-05-27)

### 버그/개선 (pptx11 슬라이드 11 — 사용자 보고)
"비디오 트랙 / 음원 트랙 구분 필요. 음원파일 & 영상파일 둘다 서로 트랙에
넘어갈 수 있음 / 넘어올 수 없게 해야 됨". 이전엔 media clip 인 한 모든
media 트랙(video/audio) 에 drop 가능 — 사용자가 비디오 트랙에 음원을
올리는 등의 미스를 만들 수 있었음.

- **shared/project.ts**: 신규 헬퍼 `canPlaceMediaOnTrack(mediaKind,
  trackKind)` —
  - video track: video / image media OK
  - audio track: audio media만 OK
- **store addClip / moveClipToTrack**: media clip 추가/이동 시
  project.media[clip.mediaId].kind 를 lookup → canPlaceMediaOnTrack 위반
  이면 silently reject (기존 `canPlaceClipOnTrack` 가드와 동일 패턴).
  caption / overlay 트랙은 기존 canPlaceClipOnTrack 가 이미 차단.
- bench2 가 e2e 7 tests (A-1~A-7) 까지 다 작성한 상태였고 store 측 가드만
  손실되어 있었음. 이번에 복구.

### e2e
- track-kind-guard.spec.ts 7 tests 통과 (audio→video addClip reject /
  video→audio reject / image→audio reject / audio→audio OK / video→video
  OK / video clip→audio moveClipToTrack no-op / audio clip→video no-op).

---

## 0.2.39 (2026-05-27)

### 추가 (pptx11 슬라이드 10 — 사용자 보고 "자막칸 맨 상단으로 이동이 안됨")
캡션 트랙을 stack 맨 위로 옮길 방법이 없던 문제. bench2 가 e2e + 우클릭
메뉴 UI 까지 작성했지만 store `moveTrack` 액션과 Timeline 의 onMove /
trackIndex / trackCount 전달부가 corruption 으로 손실되어 메뉴 항목이
조건부 렌더 안 됨.

- **store/project.ts**: `moveTrack(trackId, newIndex)` — newIndex 가
  [0, tracks.length-1] 로 clamp, 불명 trackId / 동일 인덱스 면 no-op.
- **Timeline.tsx**: TrackContextMenu 에 `onMove` / `trackIndex` /
  `trackCount` prop 전달. 'top' → 0, 'bottom' → 마지막, 'up'/'down' →
  ±1. 우클릭 메뉴의 "맨 위로 이동 / 위로 이동 / 아래로 이동 / 맨 아래로
  이동" 4개 행이 이제 노출 + 동작.

### e2e
- track-reorder.spec.ts 4 tests 통과 (caption 0 이동 / clamp / no-op /
  UI 메뉴 클릭).

---

## 0.2.38 (2026-05-27)

### 추가 (pptx11 슬라이드 9 — 사용자 보고 "개선")
"빈 공간 선택 후 DEL 키 누르면 빈공간 삭제, 뒷 영상 붙어짐". 트랙의 두
클립 사이 빈 공간(gap) 을 선택 → DEL → gap 제거 + 뒷 클립 ripple
좌이동. bench2 가 이미 e2e 4 test + UI 상태(`selectedGap`) + Editor.tsx
Delete 핸들러까지 작성했지만, store 의 `rippleRemoveGap` 액션과
Timeline 의 highlight UI / 클릭 핸들러가 store/project.ts corruption
으로 손실되어 동작 안 함.

- **store/project.ts**: `rippleRemoveGap(trackId, startMs, endMs)` —
  갭 범위 [s, e) 안 / 걸친 클립 있으면 no-op (사용자 의도 모호); 갭
  뒤(startMs >= e) 클립 중 locked 있으면 전체 no-op; 그 외 모두를
  delta=-(e-s) 만큼 좌이동 (atomic, 단일 undo step).
- **Timeline.tsx**: 빈 lane 클릭 시 클릭 위치가 두 클립 사이 진짜 갭이면
  `setSelectedGap` 호출 → 트랙 lane 위에 흰색 반투명 highlight 표시
  (`data-testid="selected-gap-highlight"` + start/end ms attrs).
  하나의 클립 안쪽 또는 모든 클립 뒤 영역 클릭은 기존 동작(seek + 선택
  해제) 유지.

### e2e
- gap-ripple-delete.spec.ts 4 tests 모두 통과 (A-1 뒷 클립 좌이동 /
  A-2 걸친 클립 no-op / A-3 locked no-op / A-4 lane 클릭 highlight + DEL
  ripple).

---

## 0.2.37 (2026-05-27)

### 버그 (pptx11 슬라이드 8 — 사용자 보고 "급함")
"드래그 다중 선택 각종 효과들 안 먹힘 문제" — 세 가지 multi-select 동작
모두가 단일 클립에만 적용되던 문제.

- **다중 선택 후 이동하면 1개만 이동**: 신규 store 액션
  `moveClipsByDelta(clipIds, anchorId, desiredAnchorStart)`. anchor 의
  새 startMs 로부터 delta 계산 → 모든 멤버에 적용. 트랙별 non-moving
  clip 과 no-overlap clamp + earliest 0 floor + locked 1개라도 있으면
  전체 거부. Timeline drag 핸들러가 selectedClipIds.size > 1 이면 이
  액션을 호출.
- **우클릭 효과 안 먹힘**: ClipContextMenu 의 onSpeedChange /
  onTransitionChange / onFilterChange / onColorAdjustChange /
  onColorAdjustReset 콜백이 multi-select 일 때 모든 선택된 클립에 일괄
  적용. onMenuAction 의 delete / duplicate / detach-audio / split 도
  동일.
- **DEL 키 1개만 삭제**: bench2 가 이미 multi-select 일괄 삭제 코드를
  작성했지만 store/project.ts corruption 으로 moveClipsByDelta 액션이
  손실되어 multi-select 흐름이 끊겨 있었음. 이 릴리스로 흐름 복구.

### e2e
- multi-select-actions.spec.ts 5 tests (A-1 anchor delta / A-2 locked
  거부 / A-3 0 floor / A-4 per-member overlap clamp / A-5 DEL 일괄 삭제).

---

## 0.2.36 (2026-05-27)

### 버그 (pptx11 슬라이드 7 — 사용자 보고 "끝 버튼 오류")
- "영상 1개만 있을 땐 잘 작동, 영상 여러개일 때 타임라인 끝으로 가서
  검은 화면". `getTotalDurationMs` 가 video 외 audio (BGM) / caption /
  overlay 트랙 endMs 까지 포함하기 때문에 BGM/자막이 비디오보다 길면
  Transport "끝" 버튼이 playhead 를 마지막 비디오 클립 너머로 보내서
  composite 가 빈 프레임이 됨.
- **fix**: 신규 헬퍼 `getLastVisualMs(project)` — video 트랙의 max endMs
  만 계산 (없으면 totalMs fallback). Transport.skipEnd / Editor.tsx End
  키 모두 이 헬퍼 사용. 선택 클립이 있을 땐 그 클립 endMs 유지 (기존
  동작 — 슬라이드 10 의미 보존).

---

## 0.2.35 (2026-05-27)

### 버그 (pptx11 슬라이드 4 — 사용자 보고 "음원 파일 트랙 이동 시 다른 음악 or 음성 틀어짐")
- BGM 트랙 간 오디오 클립 이동 시 stale 버퍼와 충돌해 이전 클립(예: TTS)
  소리가 들리던 문제. `<audio>` element 가 `<video>` 와 달리
  `onLoadedData`/`onCanPlay` 자동재생 핸들러 부재 + src 교체 후 paused
  로 stuck 됨.
- **fix**: src 교체 직후 playing 이면 명시적 `a.play()` 호출 +
  `<audio>` 에도 onLoadedData/onCanPlay 자동재생 핸들러 부착 (cold src
  보장). PreviewCanvas.tsx.

### 버그 (pptx11 슬라이드 15 — 사용자 보고 "Ctrl+A 안 먹힘")
- Application Menu accelerator (CmdOrCtrl+A) 만 있고 renderer keydown
  fallback 부재로 focus 위치에 따라 OS/browser 가 Ctrl+A 를 먼저
  가로채면 무동작. Cut/Copy/Paste 도 동일 패턴이라 같이 보강.
- **fix**: Editor.tsx keydown 에 Ctrl+A (selectAll) / Ctrl+X (cut) /
  Ctrl+C (copy) / Ctrl+V (paste) renderer fallback 추가. clipboardRef
  공유 — 메뉴 클릭이든 키보드든 동일 buffer.

### 버그 (pptx11 슬라이드 22 — 사용자 보고 "조정 레이어 색 보정 후 Ctrl+Z 안 먹힘")
- 색보정/필터 슬라이더(input[type=range]) focus 상태에서 Ctrl+Z 가
  Editor.tsx keydown guard 의 input early-return 에 막혀 undo 가 호출
  안 되던 문제. store/zundo 자체는 정상 동작.
- **fix**: keydown guard 정교화. range/number/checkbox/radio/button/
  submit/reset 같이 텍스트 편집과 무관한 input 타입은 통과 (native
  cut/copy/paste/undo 없음). textarea / 텍스트 input / contenteditable
  은 그대로 가드.

### 추가 (pptx11 슬라이드 24 — 사용자 보고 "조정 레이어 우클릭 시 일반 영상처럼 기능 떠야 함")
- 조정 레이어 우클릭 = 잠금 / 여기서 자르기 (S) / 복제 (Ctrl+D) / 삭제
  (Delete) 컨텍스트 메뉴. 새 컴포넌트 `AdjustmentLayerContextMenu.tsx`.
- `AdjustmentLayer.locked?` 필드 + `isAdjustmentLayerLocked` helper.
- store 신규 액션: `setAdjustmentLayerLocked` / `duplicateAdjustmentLayer`
  (원본 직후 같은 길이로 sibling) / `splitAdjustmentLayerAt` (playhead
  지점 split, MIN_CLIP_MS 양쪽 보장). 기존 grade/move/trim/delete 도
  locked 가드 (clip lock 과 동일 패턴, 토글 자체는 항상 허용).

### 추가 (pptx11 슬라이드 23 — 사용자 보고 "조정 레이어 추가 기능: 일반 효과 기능 전부 삽입")
- 조정 레이어에 일반 클립처럼 **fade in / fade out** 도입. layer 시작/끝
  에서 grade 강도가 0→1 또는 1→0 으로 점진 적용.
- `AdjustmentLayer.fadeInMs?` / `fadeOutMs?` 필드 + helper
  `getAdjustmentLayerFadeFactor(layer, ms): number → [0..1]`.
- store: `setAdjustmentLayerFade(id, fin, fout)` — clamp [0, halfDur],
  0 일 때 field drop, locked 면 no-op.
- AdjustmentLayerEditor 에 "전환 (페이드)" 섹션 추가 (slider + number
  input).
- preview: filterPreset intensity + colorAdjust (brightness/contrast/
  saturation/temperature) 모두 fade factor 비례 scale. curves / HSL 은
  비선형 보간 비용 때문에 full-strength 유지.
- export: `adjustmentLayerToFfmpeg` 가 fade 있으면 N=10 step sub-window
  로 분할 → 각 step intensity-scaled grade 를 enable-gated 로 emit.
  같은 layer 내 enable window 비중복이라 한 시점에 한 segment 만 활성.

### 기타
- `getAdjustmentLayers` 가 신규 필드 (fadeInMs/fadeOutMs/locked) 보존
  하도록 수정.

---

## 0.2.34 (2026-05-27)

### 정정 (슬라이드 20 — 사용자 명시 정정)
- **Shift+click = range selection** (캡컷/Premiere/VS Code 표준). 사용자
  인용: "4개가 있다면 첫번째 클릭 네번째 shift 클릭하면 1,2,3,4 가
  선택되는게 아니라 1,4만 선택됨" — 이전 0.2.32 는 toggle (1,4 만) 였음.
  이제 anchor (마지막 단독 클릭한 clip) 부터 Shift+clicked clip 까지
  timeline 순서 (트랙 인덱스 + startMs) 모든 clip 선택. Ctrl/Cmd+click 은
  toggle 그대로 (개별 추가/제거).
- **anchor 추적** — `selectionAnchorRef`. 평범 클릭 / marquee drag 끝 시
  갱신. 재 Shift+click 시 같은 anchor 기준 range 재계산.

### 버그 (marquee selection 안 됨 사용자 보고)
- mousemove 의 setState 가 race 로 빠뜨려지는 케이스 보장 — mouseup
  시점에 마지막 마우스 좌표로 hit set 한 번 더 계산 + 적용.
  `lastMouseX/Y` ref 로 capture.

---

## 0.2.33 (2026-05-27)

### 추가 (슬라이드 13 확장 — 사용자 요청 "Electron 창 밖으로도")
- 프리뷰 분리가 main window 안 floating div 가 아닌 **진짜 별도
  Electron BrowserWindow**. 다른 모니터 / main 창 밖 자유 이동 가능.
- 새 module:
  - `main/window.ts` — `openDetachedPreviewWindow()` / `closeDetachedPreviewWindow()`
  - `main/ipc/preview-window.ts` — `preview:openDetached` / `closeDetached`
    / `isDetached` IPC handlers + `preview-sync:broadcast` hub (다른
    window 로 forward).
  - `renderer/pages/PreviewOnly.tsx` — `?previewOnly=1` URL 진입점,
    PreviewCanvas 만 큰 화면으로 render.
- zustand 양방향 sync: main → broadcast (project / playheadMs / playing
  변경 시 자동) → detached 가 apply. detached 의 control 도 역방향
  broadcast → main 적용. `applyingSyncRef` 로 echo 방지.
- 기존 toggle 버튼 그대로 → 분리 ON 시 IPC `openDetached` 호출, OFF 시
  `closeDetached`. floating placeholder 는 그대로 (main 안 표시용).

---

## 0.2.32 (2026-05-27)

### 버그 (0.2.31 marquee detect 보완)
- 0.2.31 의 marquee mousedown 핸들러가 `e.target` 의 attribute 만 직접
  검사 → lane 자손 element (e.g., guideline, marker) 위에서 시작하면 무시.
- 수정: `target.closest('[data-testid^="track-lane-"]')` 로 자손도 lane
  으로 인정, `closest('[data-clip-id]')` 면 clip drag 우선이라 skip.

---

## 0.2.31 (2026-05-27)

### 추가 (PPTX10 슬라이드 20)
- **Marquee (사각형 영역) drag 으로 다중 clip 선택**. timeline body 의
  빈 lane mousedown → drag → 파란 사각형 그리며 그 영역과 intersect 하는
  clip 모두 `selectedClipIds` 에 set. 여러 track 가로질러도 한 번에.
  Shift 누른 채 marquee → 기존 선택에 union.
- **Shift+click** 도 Ctrl/Cmd+click 처럼 toggle-select. clip body
  mousedown 시 Shift 면 drag 시작 안 함 → onClick 의 toggle 만 fire.

---

## 0.2.30 (2026-05-27)

### 추가 (PPTX10 슬라이드 19)
- 타임라인 **트랙 높이 압축 slider** — 캡컷처럼 트랙이 많을 때 (V1~V6 +
  A1~A6 등 20+) 작게 만들면 한 화면에 모두 표시. zoom slider 옆 ↕ 모양
  range input. range 16~120 px, 기본 60. `localStorage persist`
  (`reels-track-height-px`). 모든 트랙 row 에 동일 height 적용.

---

## 0.2.29 (2026-05-27)

### 추가 (PPTX10 슬라이드 17)
- 상단 **Application Menu — Edit** 항목 모두 동작. 이전엔 default Electron
  menu 의 native role 들이 timeline clip 에 안 통했음 (browser native 는
  textfield/contenteditable 만 대상). 새 `main/appMenu.ts` 가 menu click
  을 `webContents.send('app-menu:action', ...)` 으로 renderer 에 dispatch,
  Editor 가 IPC listener 로 받아 store 액션 호출.
- Undo / Redo / Cut / Copy / Paste / Delete / Duplicate / Split / Select All —
  9 action. clip clipboard 는 `useRef<Clip[]>` (in-memory, 앱 종료 시
  사라짐). paste 는 현재 playhead 위치부터 cluster offset 유지.
- Split 단축키는 Ctrl+B (캡컷 표준). 단독 'S' 단축키는 timeline 내부에서
  계속 동작 (사용자 보고 "단축키 S 가 이미 있음" 와 충돌 회피).
- preload 에 `electron.appMenu.onAction(cb)` 노출.

---

## 0.2.28 (2026-05-27)

### 추가 (PPTX10 슬라이드 15 — 급함)
- **Alt + 드래그 = clip 복사**. clip 본문 mousedown 시 e.altKey 캡쳐 →
  dragging 시작 시점에 `duplicateClip` + 새 clip 의 startMs/endMs 를
  원본과 동일 위치로 강제 → 그 후 drag delta 따라 새 clip 이 옆으로
  이동. 원본은 자리에 그대로. snap / overlap clamp / cross-track drop
  의 ignoreId 도 새 clip id 사용. media/caption/overlay 3 종 clip 모두
  지원.

---

## 0.2.27 (2026-05-27)

### 버그 (PPTX10 슬라이드 14 — 급함)
- TTS 가져오기 (`onPick`) 시 자막만 timeline 에 자동 추가되고 **audio
  clip 은 미디어 라이브러리에만 들어갔음** → 사용자 보고 "오디오 파일
  재생 시 소리 안 들림". 자막 path 동작에 audio clip 자동 추가도 포함.
  `ensureAudioTrack('voice')` 후 `0..durationMs` clip 1개 add. drag
  경로(`addCaptions: false`)는 Timeline drop handler 가 별도 처리하므로
  그쪽엔 영향 없음.

---

## 0.2.26 (2026-05-27)

### 추가 (PPTX10 슬라이드 13)
- 프리뷰 **분리(pop-out)** 기능. 미리보기 우상단 ⧉ 분리 버튼 클릭 →
  previewArea 전체가 `position: fixed` floating window 로 변환. drag
  가능 titlebar + 우하단 resize handle. 합치기 버튼/× / 다른 토글로
  복귀. 분리 상태 + rect 좌표/크기 `localStorage` persist.
- PreviewCanvas DOM 자체는 wrapper style 만 변경, unmount/remount 안
  됨 → video element src reload 없음 (슬라이드 6 와 동일 안전 패턴).
- 진짜 별도 Electron BrowserWindow 가 아니라 main 안 floating 이지만
  사용자가 원하는 "프리뷰 영역만 자유 위치/크기" 의도 충족. 듀얼 모니터
  필요시 차후 BrowserWindow + IPC 동기화로 확장.

---

## 0.2.25 (2026-05-27)

### 추가 (PPTX10 슬라이드 12)
- preview ↔ timeline 사이 **drag 가능한 splitter**. 캡컷 처럼 위로
  끌어올려 한 번에 여러 트랙(Video1/Video2/Voice1/BGM 등) 동시 가시.
  range: 160 ~ window.innerHeight × 0.7 (preview 최소 영역 보장).
  더블클릭 = 기본값(280px) 복원. 높이는 `localStorage` 에 persist
  (`reels-timeline-panel-height`).
- splitter drag 중 hover/active 색 강조 (#4f46e5) + cursor `row-resize`.

---

## 0.2.24 (2026-05-27)

### 추가 (PPTX10 슬라이드 11)
- 조정 레이어 선택 + **Delete/Backspace** 키로 삭제. 이전엔 효과 탭의
  빨간 "조정 레이어 삭제" 버튼만 동작. clip 키보드 핸들러 (Editor) 가
  `selectedClipIds` 검사 전에 `selectedAdjustmentLayerId` 도 검사 →
  `store.removeAdjustmentLayer` + clearSelection + 토스트 ("조정 레이어
  삭제됨 · Ctrl+Z로 되돌리기").

---

## 0.2.23 (2026-05-27)

### 재해석 (PPTX10 슬라이드 10 v2 — 사용자 정정)
- 0.2.20 은 "끝" 을 **전체 timeline 끝 - 1ms** 로 해석했는데, 사용자
  의도는 **현재 선택된 clip 기준**. 사용자 인용: "영상을 누른 상태에서
  끝 누르면 영상의 맨 끝으로 이동... 처음부터 그 영상의 맨 앞으로".
- 수정: Transport `skipStart` / `skipEnd` 가 `selectedClipIds` 검사 →
  선택 있으면 `clip.startMs` / `clip.endMs - 1`, 없으면 종전 처럼 0 /
  `totalMs - 1`. End/Home 키 동작은 종전(전체 기준) 유지.

---

## 0.2.22 (2026-05-27)

### 시각 (PPTX10 슬라이드 5 잔여 — 사용자 보고 "그래도 여기에 놓아주세요 뜬다")
- 0.2.16 에서 drop receiver 는 wrap 전체로 확장했지만 **시각 표시는
  여전히 작은 점선 박스에만** 활성화 → 사용자가 fix 적용 안 됐다고 인지.
- dragOver 시 **wrap 전체**에 inset boxShadow + 옅은 녹색 배경 + 가운데
  안내 텍스트("여기에 놓아주세요 — 패널 어디든 OK") overlay. overlay 는
  pointer-events: none 이라 drop 이벤트는 그대로 wrap 이 받음.

---

## 0.2.21 (2026-05-27)

### 발견성 (PPTX10 슬라이드 7 보강)
- 라이브러리 카드 우상단에 **✎ rename 버튼** 추가 (삭제 ✕ 옆). 더블클릭
  으로도 가능하지만 hint 없이는 사용자가 발견 못 함.
- 타임라인 clip hover title 에 "— 더블클릭으로 이름 변경" suffix 추가.
- 양방향 연동 본체(0.2.19) + 자동 라벨(0.2.18) 그대로. 발견성 patch.

---

## 0.2.20 (2026-05-27)

### 버그 (PPTX10 슬라이드 10)
- "끝" 버튼 / End 키 / ArrowRight 끝 도달 / 재생 자연 종료 — 4 경로
  모두 `setPlayhead(totalMs)` 호출해서 마지막 clip 의 endMs 와 정확히
  일치 → activeVideoLayers half-open 범위(`ms < endMs`) 에서 active
  아님 → 빈 검은 화면 + "재생 헤드 위치에 클립이 없습니다" 토스트.
- 수정: 4 경로 모두 `Math.max(0, totalMs - 1)` 로 1ms 안쪽 clamp →
  마지막 clip 의 마지막 프레임에 정확히 park.

---

## 0.2.19 (2026-05-27)

### 추가 (PPTX10 슬라이드 7)
- 미디어 이름 변경 + 양방향 연동.
  - 라이브러리 카드: 파일명 더블클릭 → inline input (Enter 저장, Esc 취소)
  - 타임라인 클립: 클립 본문 더블클릭 → inline input (caption 더블클릭은
    기존대로 자막 편집 dialog 열림)
  - 양쪽 다 `project.media[mediaId].fileName` 한 곳을 갱신 → 라이브러리
    카드 + 모든 사용 clip 라벨이 동시 rerender. 단일 source of truth.
- 신규 store action `renameMedia(mediaId, newName)` — 빈 문자열 / 변화
  없는 입력은 no-op.

---

## 0.2.18 (2026-05-27)

### 개선 (PPTX10 슬라이드 6)
- 타임라인 미디어 클립 라벨이 원본 파일명을 표시. 이전엔 `clip JGAK`
  처럼 clip.id 마지막 4글자만 보여 미디어 라이브러리의 파일명과 매칭
  불가. 이제 `project.media[clip.mediaId].fileName` (확장자 제거) 사용.
  mediaId lookup 실패 시(미디어 삭제)만 옛 패턴 fallback.

---

## 0.2.17 (2026-05-27)

### 버그 (0.2.15 회귀 fix)
- VideoLibraryTab 안 `useCallback(onDragImport, ...)` 가 early returns
  (loading/error/empty) 뒤에 위치 → tab이 loading→ready 전환 시 hook
  count 불일치 → **React error #310 ("Rendered more hooks than during
  the previous render")** → ImportPanel + tab bar 통째로 React unmount →
  사용자 보고는 페이지 black. e2e probe로 잡음 (`tabs visible: 0` 후
  console.error #310).
- 수정: useCallback을 모든 early return 이전으로 이동.

---

## 0.2.16 (2026-05-27)

### 개선 (PPTX10 슬라이드 5)
- OS 파일 탐색기 → 미디어 가져오기 패널 drop 영역을 **패널 전체로 확장**.
  이전엔 좁은 점선 박스(`styles.drop`) 안에만 떨어뜨려야 import 됐음.
  사용자 보고: "파란박스 아무곳에 놔도 적용되게끔". wrap-level
  onDragOver/onDrop 으로 받고 점선 박스는 시각 안내만 담당. dragLeave는
  자식 element 가로지름 무시 (relatedTarget contains 체크).

---

## 0.2.15 (2026-05-26)

### 추가 (PPTX10 슬라이드 4)
- 미디어 가져오기 패널의 **모든 탭에서** 카드 → 타임라인 drag & drop.
  이전엔 내 PC 탭만 가능했음. 적용 탭: 영상 라이브러리, TTS & SRT, 내부
  영상, 사운드 라이브러리, 효과음 검색 (Freesound).
- 비동기 import 처리 패턴 — drag 시작 시 download/ingest 백그라운드 시작
  + `pendingImport` 모듈에 Promise 등록 + Timeline drop handler 가 await
  → 완료 후 drop 위치에 clip 자동 생성. drop 좌표는 동기 capture (rect/
  altKey) 후 async resolve에 사용. AI 영상 생성은 job 완료까지 너무 길어
  제외, 브랜드 키트는 overlay라 별도 path 유지.

---

## 0.2.14 (2026-05-26)

### 인프라 (지난 4 버전 모두 무효였던 진짜 root)
- **publish-github.mjs가 `electron-vite build`를 안 호출**해서 0.2.10
  ~0.2.13의 renderer 코드 변경이 단 한 번도 packaging 안 됨. asar 안
  `index-CXFE9UcK.js` 가 4 버전 동일 hash (extract 후 grep으로 검증 —
  새 추가된 `needsTightSync` / `prevPlayheadMs` 식별자가 minified 안에
  없음). 결과: 사용자 환경에서 매번 같은 버그 재현.
- 수정: publish script 첫 단계에 `npx electron-vite build` 추가. 이제
  publish할 때마다 renderer/main/preload 다시 빌드 → 새 hash → 진짜
  코드 들어감.

### 버그 (이제 진짜로 적용되는 slide-6 fix — 0.2.11~0.2.13 누적)
- 평범한 clip(speed=1, no curve/freeze/deletion)의 currentTime override를
  매 16ms tick에서 절대 안 함. src 교체 시 initial seek 1회 + native
  engine 1x 자연 재생.
- bg blur video + audio elements도 같은 패턴.
- 사용자 scrub은 prevPlayheadMs ref로 한 tick 1000ms+ 점프 detect (자연
  rAF에서 절대 trigger 안 됨).
- curve/freeze/deletion clip은 매 tick 0.08s threshold tight sync 유지.

---

## 0.2.13 (2026-05-26)

### 버그 (slide-6 — 진짜 끝)
- 0.2.12에서 main video는 처리됐지만 **blur background `<video>` + audio
  `<audio>`** elements는 여전히 매 tick `currentTime` override. probe
  로 `setCt val=0.864 prev=0.012` 패턴 확인 (prev=0 stuck).
- 수정: bg/audio elements 둘 다 main video와 같은 패턴 적용 — src 교체
  시 1회 initial seek + 그 후 native engine 1x 자연 재생. curve/freeze/
  deletion clip만 tight sync 유지.
- isUserScrub threshold 100ms → 1000ms. probe / 느린 React rerender batch
  에서 false-positive trigger 방지. 진짜 seek-bar 클릭만 잡힘.

---

## 0.2.12 (2026-05-26)

### 버그 (0.2.11에서도 못 잡은 slide-6 진짜 root)
- 0.2.11이 drift threshold만 늘렸는데 사용자 재생 시 여전히 freeze. probe
  에 video element method instrument 붙여 보니 매 16ms tick마다 우리
  effect가 `v.currentTime = target` 호출하고 set 후에도 `prev=0` 유지
  ("setCt val=1.792 prev=0", "setCt val=1.808 prev=0" 패턴 반복) →
  video 내부의 seek pending이 다음 set 도착 전에 못 끝남 → ct 영원히 0
  stuck → frame 영원히 안 진행. 사용자 보고 "5.917s 압축 + freeze" 의
  진짜 메커니즘.
- 수정: 평범한 (curve/freeze/deletion 없는) clip은 매 tick currentTime/
  playbackRate 건드리지 않음. **src 교체 시 1회 initial seek**(0.2.11에서
  추가됨) + **native engine 1x 자연 재생**으로 끝. drift 누적은 자연 발생
  하지만 60fps + 16ms tick이라 시각 영향 없음.
- 사용자 scrub(seek bar 클릭, 키보드 점프) detect — prevPlayheadMs ref로
  한 tick 변화 > 100ms 이면 scrub → 그때만 명시 sync. natural rAF
  진행(~16ms/tick)은 절대 trigger 안 됨.
- curve/freeze/deletion clip은 mapping이 비선형이라 매 tick 0.08s
  threshold sync 유지 (그 경우는 seek storm 없음 — drift가 정상적으로
  발생).

---

## 0.2.11 (2026-05-26)

### 버그 (0.2.10 도입 회귀 fix)
- 0.2.10이 rAF wrap을 제거하면서 swap useEffect가 매 16ms tick마다 fire
  되도록 했는데, 그 effect의 `v.currentTime = target` (drift > 0.05s)
  분기가 native engine의 자연 재생과 fight해 fast-forward + freeze 사고
  유발. 사용자 보고: clip A(trimOut 3.17s)의 원본 5.917s 영상 전체가
  3.5s 안에 압축 재생 + clip B는 첫 프레임 freeze.
- mapping 수식(`offsetMs = (timelineMs - startMs) * speed; sourceMs =
  offsetMs + trimInMs`)은 정확 검증 (probe로 t=3000ms swap + currentTime
  reset 0.004s 확인). 문제는 매 tick override 빈도.
- 수정: **src 교체 시점에만** currentTime + playbackRate를 initial set.
  그 후엔 native engine 1x 자연 재생에 양보. 매 tick은 큰 drift(0.4s+
  scrub / pause→resume) 만 보정. curve/freeze/deletion clip은 mapping이
  비선형이라 tight sync(0.08s threshold) 유지.

---

## 0.2.10 (2026-05-26)

### 버그 (슬라이드 6 진짜 root)
- 사용자 진단 정확히 맞춤: clip A가 endMs(trimOut) 지나도 원본 끝까지
  자연 재생 + clip B로 swap 안 됨. 원인 = PreviewCanvas swap useEffect가
  매 playheadMs 변경(매 16ms)마다 fire되는데 cleanup의 `cancelAnimation
  Frame(swapRaf.current)` 가 매번 직전 schedule을 cancel → 영원히 rAF
  callback 실행 안 됨 → src 교체 / currentTime 동기화 / play() 다 안
  일어남. video element는 그냥 src의 native duration까지 자연 재생.
- 수정: rAF wrap 통째 제거. swap work를 effect에서 inline 실행. React
  batching이 이미 충분한 throttle. swapRaf ref + cleanup 제거.
- 이전 0.2.6/0.2.7/0.2.8의 fix들(preload="auto", swap-내 play(),
  onLoadedData/onCanPlay)도 모두 동작 안 했던 이유 = 같은 root.
  rAF callback 자체가 fire 안 됐으니 그 안의 어떤 코드도 실행 X.

---

## 0.2.9 (2026-05-26)

### 버그 (슬라이드 6 진단 종결)
- import한 video file을 사용자 원본 path가 아닌 `%APPDATA%/Reels Studio/
  imports/<mediaId>.<ext>` 로 **자동 복사** 후 그 경로 사용. uninstall/
  reinstall 사이클이 install 폴더를 통째 지워도 import는 user-data dir
  안 안전한 사본을 reference 함 (이전 0.2.7→0.2.8 reinstall 시 사용자가
  install 폴더 안 `새 폴더/`에 둔 video file이 사라져 재생 불가했던 실제
  사고). main IPC `media.copyToImports` 신규 + ingestLocalFile에서 호출.
  copy 실패는 graceful — 원본 path fallback.

### 인프라
- `publish-github.mjs` verify step이 CWD에서 `extract-file package.json` +
  `del package.json` 실행해 우리 repo의 진짜 package.json을 한 번 삭제
  하는 자체 사고 발생. 격리된 temp dir에서 probe 수행하도록 fix —
  scoped `mkdirSync(probeDir)` + `cwd: probeDir` + `rmSync(probeDir)`.

---

## 0.2.8 (2026-05-26)

### 버그 (슬라이드 6 추가 후속)
- 재생 중 자연스럽게 boundary 통과 시점 — playhead가 rAF로 진행되며 두
  번째 클립으로 swap되는 순간 — 새 src의 load가 아직 안 끝나서 swap
  effect의 즉시 `play()`가 reject되고 그 후 영원히 paused. (0.2.7의
  swap-내 play()는 spec에선 PASS 했지만 실제 사용자 환경의 cold src
  load엔 부족했음.) `<video>`에 `onLoadedData` + `onCanPlay` 두 이벤트
  핸들러 추가 — load 완료 시 `playing` true면 자동 play() 호출. 첫
  reject돼도 곧 두 이벤트 중 하나가 fire되어 따라잡음.

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
