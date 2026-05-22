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
}

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
          width: '11%',
          minWidth: 30,
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
            fontSize: 10,
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

/** Right-hand vertical action button stack — anchored bottom-right. */
function ActionStack(props: {
  bottomPct: number
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      data-testid="social-overlay-action-stack"
      style={{
        position: 'absolute',
        right: '3.5%',
        bottom: `${props.bottomPct}%`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '5.5%'
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
  return (
    <div
      data-testid="social-overlay-caption-block"
      style={{
        position: 'absolute',
        left: '4%',
        bottom: `${bottomPct}%`,
        right: `${rightPct}%`,
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
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #6a5acd, #ff5e8a)',
            border: '1.5px solid rgba(255,255,255,0.85)',
            flexShrink: 0
          }}
        />
        <span
          data-testid="social-overlay-account"
          style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}
        >
          {accountName}
        </span>
      </div>
      <span
        data-testid="social-overlay-caption-text"
        style={{
          color: '#f1f1f1',
          fontSize: 11,
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
            fontSize: 10
          }}
        >
          <span style={{ width: 12, height: 12, display: 'inline-block' }}>
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
          top: '3.5%',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 14,
          color: '#fff',
          fontSize: 12,
          fontWeight: 700,
          textShadow: '0 1px 3px rgba(0,0,0,0.7)'
        }}
      >
        <span style={{ opacity: 0.65 }}>팔로잉</span>
        <span style={{ borderBottom: '2px solid #fff', paddingBottom: 2 }}>
          추천
        </span>
      </div>
      <ActionStack bottomPct={17}>
        <ActionButton
          avatar
          icon={<HeartIcon />}
          label=""
          testid="social-action-profile"
        />
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
          icon={<ShareIcon />}
          label="공유"
          testid="social-action-share"
        />
      </ActionStack>
      <CaptionBlock
        accountName="@your_account"
        caption="여기에 영상 캡션이 표시됩니다 #릴스 #트렌드"
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
          top: '3%',
          left: '4%',
          color: '#fff',
          fontSize: 14,
          fontWeight: 800,
          textShadow: '0 1px 3px rgba(0,0,0,0.7)'
        }}
      >
        Shorts
      </div>
      <div
        style={{
          position: 'absolute',
          top: '3%',
          right: '4%',
          width: '6%',
          minWidth: 18,
          color: '#fff',
          filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.6))'
        }}
      >
        <MoreIcon />
      </div>
      <ActionStack bottomPct={14}>
        <ActionButton
          icon={<HeartIcon />}
          label="12K"
          testid="social-action-like"
        />
        <ActionButton
          icon={<CommentIcon />}
          label="843"
          testid="social-action-comment"
        />
        <ActionButton
          icon={<ShareIcon />}
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
          left: '4%',
          right: '20%',
          bottom: '5%',
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
          textShadow: '0 1px 4px rgba(0,0,0,0.8)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #ff4d4d, #ff8a3d)',
              border: '1.5px solid rgba(255,255,255,0.85)',
              flexShrink: 0
            }}
          />
          <span
            data-testid="social-overlay-account"
            style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}
          >
            @your_channel
          </span>
          <span
            data-testid="social-overlay-subscribe"
            style={{
              background: '#fff',
              color: '#0f0f0f',
              fontSize: 10,
              fontWeight: 700,
              padding: '3px 10px',
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
            fontSize: 11,
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
      <SafeZones topPct={8} bottomPct={15} />
      {/* Top bar — "릴스" title + camera. */}
      <div
        style={{
          position: 'absolute',
          top: '3%',
          left: '4%',
          color: '#fff',
          fontSize: 14,
          fontWeight: 800,
          textShadow: '0 1px 3px rgba(0,0,0,0.7)'
        }}
      >
        릴스
      </div>
      <ActionStack bottomPct={16}>
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
          icon={<ShareIcon />}
          label="공유"
          testid="social-action-share"
        />
        <ActionButton
          icon={<SaveIcon />}
          label="저장"
          testid="social-action-save"
        />
        <ActionButton
          icon={<MoreIcon />}
          label=""
          testid="social-action-more"
        />
        {/* Rotating audio thumbnail. */}
        <div
          data-testid="social-action-audio"
          style={{
            width: '11%',
            minWidth: 28,
            aspectRatio: '1 / 1',
            borderRadius: 6,
            border: '2px solid rgba(255,255,255,0.85)',
            background: 'linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045)'
          }}
        />
      </ActionStack>
      <CaptionBlock
        accountName="Your name"
        caption="여기에 릴스 캡션이 표시됩니다 #reels #instagram"
        bottomPct={9}
        rightPct={20}
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
  const { platform } = props
  if (platform === 'none') return null
  return (
    <div
      data-testid="social-preview-overlay"
      data-platform={platform}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        userSelect: 'none'
      }}
    >
      {platform === 'tiktok' && <TikTokChrome />}
      {platform === 'youtube' && <YouTubeShortsChrome />}
      {platform === 'instagram' && <InstagramReelsChrome />}
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
