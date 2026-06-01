import { useTimelineUi, type SocialPreviewPlatform } from '../store/timelineUi'

/**
 * Phase 6 — SNS 플랫폼 미리보기.
 *
 * A purely visual, NON-INTERACTIVE overlay that mocks the UI chrome of
 * TikTok / YouTube Shorts / Instagram 릴스 on top of the preview video, so
 * the user can see how their video will look framed by each platform.
 *
 * INVARIANTS:
 *  - This layer never affects the video, audio, captions, transforms, or the
 *    export pipeline. It is a "UI position guide", not a real SNS asset.
 *  - `pointer-events: none` on the root so it never intercepts clicks.
 *  - Icons are simple inline SVG / unicode — deliberately generic mockups,
 *    not pixel-accurate copies of the real platforms.
 */

interface SocialPreviewOverlayProps {
  platform: SocialPreviewPlatform
  fittedWidth: number
  fittedHeight: number
}

const PLATFORM_CANVAS_W = 1080
const PLATFORM_CANVAS_H = 1920
const ACTION_STACK_RIGHT = 38
const ACTION_STACK_W = 150
const INSTAGRAM_STATUS_H = 96
const INSTAGRAM_APP_BOTTOM_NAV_H = 128
const INSTAGRAM_SYSTEM_NAV_H = 86
const INSTAGRAM_BOTTOM_CHROME_H =
  INSTAGRAM_APP_BOTTOM_NAV_H + INSTAGRAM_SYSTEM_NAV_H

// ---------------------------------------------------------------------------
// Minimal inline icons (stroke-based, generic). Each is a 24×24 viewBox.
// ---------------------------------------------------------------------------
const ICON_VB = '0 0 24 24'

function HeartIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <path
        d="M12 21s-7.5-4.6-9.5-9C1.2 9 2.6 5.5 6 5.5c2.1 0 3.3 1.3 4 2.4.7-1.1 1.9-2.4 4-2.4 3.4 0 4.8 3.5 3.5 6.5-2 4.4-9.5 9-9.5 9z"
        fill="currentColor"
      />
    </svg>
  )
}

function CommentIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <path
        d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 1-1z"
        fill="currentColor"
      />
    </svg>
  )
}

function ShareIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <path
        d="M3 12.5 21 4l-7 17-3.2-7L3 12.5z"
        fill="currentColor"
      />
    </svg>
  )
}

function SaveIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <path
        d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"
        fill="currentColor"
      />
    </svg>
  )
}

function MoreIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <circle cx="12" cy="5" r="2" fill="currentColor" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <circle cx="12" cy="19" r="2" fill="currentColor" />
    </svg>
  )
}

function HomeIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <path
        d="M3 11 12 3l9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SearchIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <circle
        cx="10.5"
        cy="10.5"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="m16 16 5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ReelsIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <rect
        x="4"
        y="5"
        width="16"
        height="15"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M9 5 6 10M15 5l-3 5M5 10h14" stroke="currentColor" strokeWidth="2" />
      <path d="m10 13 5 3-5 3v-6z" fill="currentColor" />
    </svg>
  )
}

// Reels 11 슬라이드 12 — 플랫폼별 추가 아이콘.
function ThumbsDownIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <path
        d="M7 14V4h10l3 6v4h-7l1 5a2 2 0 1 1-4 0L7 14z"
        fill="currentColor"
      />
    </svg>
  )
}

function PaperPlaneIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <path
        d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function FollowPlusBadge(): JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: -10,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 34,
        height: 34,
        borderRadius: '50%',
        background: '#fe2c55',
        color: '#fff',
        fontSize: 28,
        fontWeight: 900,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1
      }}
      aria-hidden="true"
    >
      +
    </div>
  )
}

function RotatingMusicDisc(): JSX.Element {
  return (
    <div
      data-testid="social-action-music-disc"
      style={{
        width: 72,
        aspectRatio: '1 / 1',
        borderRadius: '50%',
        background:
          'radial-gradient(circle, #1a1a1a 28%, #2a2a2a 30%, #1a1a1a 32%, #2a2a2a 100%)',
        border: '2px solid rgba(255,255,255,0.85)',
        position: 'relative',
        animation: 'reels-tiktok-disc-spin 6s linear infinite'
      }}
      aria-hidden="true"
    >
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '30%',
          height: '30%',
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #25f4ee, #fe2c55)'
        }}
      />
    </div>
  )
}

function MusicIcon(): JSX.Element {
  return (
    <svg viewBox={ICON_VB} width="100%" height="100%" aria-hidden="true">
      <path
        d="M9 17V5l11-2v12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="6" cy="17" r="3" fill="currentColor" />
      <circle cx="17" cy="15" r="3" fill="currentColor" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Shared building blocks.
// ---------------------------------------------------------------------------

/** One labelled action button in the right-hand vertical stack. */
function ActionButton(props: {
  icon: JSX.Element
  label: string
  /** Optional circular avatar instead of an icon (TikTok-style profile). */
  avatar?: boolean
  testid: string
}): JSX.Element {
  const { icon, label, avatar, testid } = props
  return (
    <div
      data-testid={testid}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3
      }}
    >
      <div
        style={{
          width: 72,
          aspectRatio: '1 / 1',
          color: '#fff',
          filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.6))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...(avatar
            ? {
                borderRadius: '50%',
                border: '2px solid #fff',
                background:
                  'linear-gradient(135deg, #6a5acd, #ff5e8a)',
                overflow: 'hidden'
              }
            : {})
        }}
      >
        {avatar ? null : icon}
      </div>
      {label ? (
        <span
          style={{
            color: '#fff',
            fontSize: 24,
            fontWeight: 600,
            textShadow: '0 1px 3px rgba(0,0,0,0.7)'
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Top + bottom "safe-zone" guides — dashed bands marking the regions a
 * platform's chrome can crop/cover. Purely informational.
 */
function SafeZones(props: { topPct: number; bottomPct: number }): JSX.Element {
  const { topPct, bottomPct } = props
  const band: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    background:
      'repeating-linear-gradient(45deg, rgba(255,255,255,0.05) 0 8px, rgba(255,255,255,0) 8px 16px)',
    boxSizing: 'border-box'
  }
  return (
    <div data-testid="social-overlay-safezones">
      <div
        data-testid="social-overlay-safezone-top"
        style={{
          ...band,
          top: 0,
          height: `${topPct}%`,
          borderBottom: '1px dashed rgba(255,255,255,0.35)'
        }}
      />
      <div
        data-testid="social-overlay-safezone-bottom"
        style={{
          ...band,
          bottom: 0,
          height: `${bottomPct}%`,
          borderTop: '1px dashed rgba(255,255,255,0.35)'
        }}
      />
    </div>
  )
}

function InstagramStatusBar(): JSX.Element {
  return (
    <div
      data-testid="instagram-status-bar"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        height: INSTAGRAM_STATUS_H,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 36px',
        boxSizing: 'border-box',
        color: '#fff',
        background: 'rgba(8, 12, 18, 0.94)',
        fontSize: 32,
        fontWeight: 800,
        textShadow: '0 1px 3px rgba(0,0,0,0.8)'
      }}
    >
      <span>1:06</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 26 }}>LTE</span>
        <span style={{ fontSize: 30 }}>▮▮▮</span>
        <span
          style={{
            border: '2px solid #fff',
            borderRadius: 14,
            padding: '1px 9px',
            fontSize: 24,
            lineHeight: 1.15
          }}
        >
          88
        </span>
      </span>
    </div>
  )
}

function InstagramBottomChrome(): JSX.Element {
  const navBtn: React.CSSProperties = {
    width: 58,
    height: 58,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  }
  return (
    <div data-testid="instagram-bottom-chrome">
      <div
        data-testid="instagram-app-bottom-nav"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: INSTAGRAM_SYSTEM_NAV_H,
          height: INSTAGRAM_APP_BOTTOM_NAV_H,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          background: 'rgba(8, 12, 18, 0.96)',
          borderTop: '1px solid rgba(255,255,255,0.14)'
        }}
      >
        <span style={navBtn}><HomeIcon /></span>
        <span style={navBtn}><ReelsIcon /></span>
        <span style={navBtn}><PaperPlaneIcon /></span>
        <span style={navBtn}><SearchIcon /></span>
        <span
          style={{
            ...navBtn,
            borderRadius: '50%',
            background: 'radial-gradient(circle at 45% 45%, #3b1111 0 35%, #070707 36% 100%)',
            border: '2px solid rgba(255,255,255,0.25)',
            position: 'relative'
          }}
        >
          <span
            style={{
              position: 'absolute',
              right: -2,
              bottom: -2,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: '#ff1fb3'
            }}
          />
        </span>
      </div>
      <div
        data-testid="instagram-system-nav"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: INSTAGRAM_SYSTEM_NAV_H,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          background: 'rgba(8, 12, 18, 0.98)',
          color: '#fff',
          fontSize: 42
        }}
      >
        <span style={{ opacity: 0.9 }}>|||</span>
        <span style={{ width: 42, height: 42, border: '4px solid #fff', borderRadius: '50%' }} />
        <span style={{ opacity: 0.9 }}>‹</span>
      </div>
    </div>
  )
}

/** Right-hand vertical action button stack — anchored bottom-right.
 *
 * pptx11 슬라이드 12 — explicit width 가 없으면 label 텍스트("2.8K",
 * "공유" 등) 가 stack 가로 폭을 늘려서 `right: 3.5%` 가 stack 의 오른쪽
 * 끝이 되고 본체는 영상 중앙쯤에 위치 → 아이콘이 인물 얼굴 위로 겹침.
 * 좁은 컬럼(viewport 의 ~14%) 으로 폭 고정 + alignItems:center 유지.
 */
function ActionStack(props: {
  bottomPct: number
  children: React.ReactNode
}): JSX.Element {
  const bottomPx = Math.round(PLATFORM_CANVAS_H * (props.bottomPct / 100))
  return (
    <div
      data-testid="social-overlay-action-stack"
      style={{
        position: 'absolute',
        right: ACTION_STACK_RIGHT,
        bottom: bottomPx,
        width: ACTION_STACK_W,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18
      }}
    >
      {props.children}
    </div>
  )
}

/** Bottom-left caption + account block. */
function CaptionBlock(props: {
  accountName: string
  caption: string
  bottomPct: number
  /** Right edge — keep clear of the action stack. */
  rightPct: number
  /** Music/sound ticker row shown under the caption (TikTok / Reels). */
  showMusic?: boolean
}): JSX.Element {
  const { accountName, caption, bottomPct, rightPct, showMusic } = props
  const bottomPx = Math.round(PLATFORM_CANVAS_H * (bottomPct / 100))
  const rightPx = Math.round(PLATFORM_CANVAS_W * (rightPct / 100))
  return (
    <div
      data-testid="social-overlay-caption-block"
      style={{
        position: 'absolute',
        left: 43,
        bottom: bottomPx,
        right: rightPx,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        textShadow: '0 1px 4px rgba(0,0,0,0.8)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #6a5acd, #ff5e8a)',
            border: '1.5px solid rgba(255,255,255,0.85)',
            flexShrink: 0
          }}
        />
        <span
          data-testid="social-overlay-account"
          style={{ color: '#fff', fontSize: 28, fontWeight: 700 }}
        >
          {accountName}
        </span>
      </div>
      <span
        data-testid="social-overlay-caption-text"
        style={{
          color: '#f1f1f1',
          fontSize: 24,
          lineHeight: 1.35,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}
      >
        {caption}
      </span>
      {showMusic ? (
        <div
          data-testid="social-overlay-music-row"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: '#fff',
            fontSize: 22
          }}
        >
          <span style={{ width: 26, height: 26, display: 'inline-block' }}>
            <MusicIcon />
          </span>
          <span>원본 오디오 · {accountName}</span>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Platform layouts.
// ---------------------------------------------------------------------------

/** TikTok — action stack low-right, profile + follow on top of it. */
function TikTokChrome(): JSX.Element {
  return (
    <div data-testid="social-overlay-tiktok" style={fillStyle}>
      <SafeZones topPct={9} bottomPct={16} />
      {/* Top center tabs (팔로잉 / 추천). */}
      <div
        style={{
          position: 'absolute',
          top: 67,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 30,
          color: '#fff',
          fontSize: 28,
          fontWeight: 700,
          textShadow: '0 1px 3px rgba(0,0,0,0.7)'
        }}
      >
        <span style={{ opacity: 0.65 }}>팔로잉</span>
        <span style={{ borderBottom: '4px solid #fff', paddingBottom: 4 }}>
          추천
        </span>
      </div>
      <ActionStack bottomPct={17}>
        {/* Reels 11 슬라이드 12 — TikTok 실제 순서: profile(+팔로우 배지) →
            like → comment → bookmark(저장) → share(공유) → 회전 음원 디스크. */}
        <div style={{ position: 'relative' }}>
          <ActionButton
            avatar
            icon={<HeartIcon />}
            label=""
            testid="social-action-profile"
          />
          <FollowPlusBadge />
        </div>
        <ActionButton
          icon={<HeartIcon />}
          label="328.4K"
          testid="social-action-like"
        />
        <ActionButton
          icon={<CommentIcon />}
          label="1,204"
          testid="social-action-comment"
        />
        <ActionButton
          icon={<SaveIcon />}
          label="저장"
          testid="social-action-save"
        />
        <ActionButton
          icon={<PaperPlaneIcon />}
          label="공유"
          testid="social-action-share"
        />
        <RotatingMusicDisc />
      </ActionStack>
      <CaptionBlock
        accountName="@your_account"
        caption="여기에 영상 캡션이 표시됩니다 #fyp #foryou"
        bottomPct={8}
        rightPct={22}
        showMusic
      />
    </div>
  )
}

/** YouTube Shorts — title under account, channel + 구독 row, action stack. */
function YouTubeShortsChrome(): JSX.Element {
  return (
    <div data-testid="social-overlay-youtube" style={fillStyle}>
      <SafeZones topPct={8} bottomPct={13} />
      {/* Top-left "Shorts" wordmark + search/more on the right. */}
      <div
        style={{
          position: 'absolute',
          top: 58,
          left: 43,
          color: '#fff',
          fontSize: 32,
          fontWeight: 800,
          textShadow: '0 1px 3px rgba(0,0,0,0.7)'
        }}
      >
        Shorts
      </div>
      <div
        style={{
          position: 'absolute',
          top: 58,
          right: 43,
          width: 54,
          color: '#fff',
          filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.6))'
        }}
      >
        <MoreIcon />
      </div>
      <ActionStack bottomPct={14}>
        {/* Reels 11 슬라이드 12 — YouTube Shorts 실제 순서: 좋아요 → 싫어요 →
            댓글 → 공유 → 리믹스 → 더보기 → 채널 아바타. */}
        <ActionButton
          icon={<HeartIcon />}
          label="12K"
          testid="social-action-like"
        />
        <ActionButton
          icon={<ThumbsDownIcon />}
          label="싫어요"
          testid="social-action-dislike"
        />
        <ActionButton
          icon={<CommentIcon />}
          label="843"
          testid="social-action-comment"
        />
        <ActionButton
          icon={<PaperPlaneIcon />}
          label="공유"
          testid="social-action-share"
        />
        <ActionButton
          icon={<MoreIcon />}
          label="리믹스"
          testid="social-action-remix"
        />
        <ActionButton
          avatar
          icon={<HeartIcon />}
          label=""
          testid="social-action-profile"
        />
      </ActionStack>
      {/* Bottom: channel row + 구독 pill + title. */}
      <div
        data-testid="social-overlay-caption-block"
        style={{
          position: 'absolute',
          left: 43,
          right: 216,
          bottom: 96,
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
          textShadow: '0 1px 4px rgba(0,0,0,0.8)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #ff4d4d, #ff8a3d)',
              border: '1.5px solid rgba(255,255,255,0.85)',
              flexShrink: 0
            }}
          />
          <span
            data-testid="social-overlay-account"
            style={{ color: '#fff', fontSize: 28, fontWeight: 700 }}
          >
            @your_channel
          </span>
          <span
            data-testid="social-overlay-subscribe"
            style={{
              background: '#fff',
              color: '#0f0f0f',
              fontSize: 22,
              fontWeight: 700,
              padding: '7px 22px',
              borderRadius: 999
            }}
          >
            구독
          </span>
        </div>
        <span
          data-testid="social-overlay-caption-text"
          style={{
            color: '#f1f1f1',
            fontSize: 24,
            lineHeight: 1.35,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}
        >
          여기에 Shorts 제목이 표시됩니다 #shorts
        </span>
      </div>
    </div>
  )
}

/** Instagram 릴스 — top-right safe area, action stack, caption + 음원 row. */
function InstagramReelsChrome(): JSX.Element {
  return (
    <div data-testid="social-overlay-instagram" style={fillStyle}>
      <SafeZones topPct={18} bottomPct={24} />
      <InstagramStatusBar />
      <InstagramBottomChrome />
      {/* Top bar — app chrome starts below the phone status bar. */}
      <div
        data-testid="instagram-reels-title"
        style={{
          position: 'absolute',
          top: INSTAGRAM_STATUS_H + 26,
          left: 43,
          color: '#fff',
          fontSize: 32,
          fontWeight: 800,
          textShadow: '0 1px 3px rgba(0,0,0,0.7)'
        }}
      >
        릴스
      </div>
      <ActionStack bottomPct={23}>
        {/* Reels 11 슬라이드 12 — Instagram 릴스 실제 순서: 좋아요 → 댓글 →
            보내기(종이비행기) → 더보기 → 회전 음원 썸네일. 저장은 더보기 안에. */}
        <ActionButton
          icon={<HeartIcon />}
          label="2.8K"
          testid="social-action-like"
        />
        <ActionButton
          icon={<CommentIcon />}
          label="146"
          testid="social-action-comment"
        />
        <ActionButton
          icon={<PaperPlaneIcon />}
          label="공유"
          testid="social-action-share"
        />
        <ActionButton
          icon={<MoreIcon />}
          label=""
          testid="social-action-more"
        />
        {/* 회전 audio 썸네일. */}
        <div
          data-testid="social-action-audio"
          style={{
            width: 72,
            aspectRatio: '1 / 1',
            borderRadius: 6,
            border: '2px solid rgba(255,255,255,0.85)',
            background: 'linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045)',
            animation: 'reels-tiktok-disc-spin 8s linear infinite'
          }}
        />
      </ActionStack>
      <CaptionBlock
        accountName="Your name"
        caption="여기에 릴스 캡션이 표시됩니다 #reels #instagram"
        bottomPct={15.5}
        rightPct={22}
        showMusic
      />
    </div>
  )
}

const fillStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0
}

// ---------------------------------------------------------------------------
// Public component.
// ---------------------------------------------------------------------------
export function SocialPreviewOverlay(
  props: SocialPreviewOverlayProps
): JSX.Element | null {
  const { fittedHeight, fittedWidth, platform } = props
  if (platform === 'none') return null
  const scaleX =
    fittedWidth > 0 ? fittedWidth / PLATFORM_CANVAS_W : 1
  const scaleY =
    fittedHeight > 0 ? fittedHeight / PLATFORM_CANVAS_H : 1
  return (
    <div
      data-testid="social-preview-overlay"
      data-platform={platform}
      data-coordinate-space={`${PLATFORM_CANVAS_W}x${PLATFORM_CANVAS_H}`}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        userSelect: 'none',
        overflow: 'hidden'
      }}
    >
      <div
        data-testid="social-preview-coordinate-space"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: PLATFORM_CANVAS_W,
          height: PLATFORM_CANVAS_H,
          transform: `scale(${scaleX}, ${scaleY})`,
          transformOrigin: 'top left'
        }}
      >
        {platform === 'tiktok' && <TikTokChrome />}
        {platform === 'youtube' && <YouTubeShortsChrome />}
        {platform === 'instagram' && <InstagramReelsChrome />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Selector — a small <select> the user picks the mock platform from. Lives
// in the preview panel (Editor.tsx). State is the transient
// `socialPreviewPlatform` in the timelineUi store.
// ---------------------------------------------------------------------------

/** Human labels for each platform option (matches slide 15-2 wording). */
const PLATFORM_LABELS: Record<SocialPreviewPlatform, string> = {
  tiktok: 'TikTok',
  youtube: 'YouTube Shorts',
  instagram: 'Instagram 릴스',
  none: '없음'
}

const PLATFORM_ORDER: SocialPreviewPlatform[] = [
  'tiktok',
  'youtube',
  'instagram',
  'none'
]

export function SocialPreviewSelector(): JSX.Element {
  const platform = useTimelineUi((s) => s.socialPreviewPlatform)
  const setPlatform = useTimelineUi((s) => s.setSocialPreviewPlatform)

  return (
    <label
      data-testid="social-preview-selector"
      title="소셜 미디어용 동영상 미리 보기"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'rgba(13, 13, 13, 0.82)',
        border: '1px solid #2a2a2a',
        borderRadius: 6,
        padding: '4px 8px',
        color: '#cbd5e1',
        fontSize: 11
      }}
    >
      <span aria-hidden="true" style={{ opacity: 0.8 }}>
        📱
      </span>
      <span style={{ whiteSpace: 'nowrap' }}>플랫폼 미리보기</span>
      <select
        data-testid="social-preview-select"
        value={platform}
        onChange={(e) =>
          setPlatform(e.target.value as SocialPreviewPlatform)
        }
        style={{
          background: '#1f2937',
          color: '#f5f5f5',
          border: '1px solid #374151',
          borderRadius: 4,
          padding: '3px 6px',
          fontSize: 11,
          cursor: 'pointer'
        }}
      >
        {PLATFORM_ORDER.map((p) => (
          <option key={p} value={p} data-testid={`social-preview-option-${p}`}>
            {PLATFORM_LABELS[p]}
          </option>
        ))}
      </select>
    </label>
  )
}
