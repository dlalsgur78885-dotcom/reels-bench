/**
 * AI 영상 생성 백그라운드 잡 추적 store.
 *
 * 슬라이드 7~8 ④: "영상 생성을 걸어두고 편집을 계속할 수 있게끔" — 생성은
 * 백그라운드, 편집을 블로킹하지 않는다. 이 store는:
 *   1) Seedance 생성 잡을 등록 (submit 후)
 *   2) 잡별로 `getSeedanceStatus`를 폴링 (단일 인터벌)
 *   3) COMPLETED 되면 영상 URL을 받아 미디어로 자동 import
 *
 * 진행 중 잡은 transient(미persist) — 앱 재시작 시 사라진다. fal queue의
 * request_id를 영속 저장하려면 Phase 2 작업 필요 (백엔드 결정 항목 참고).
 */
import { create } from 'zustand'
import { ulid } from 'ulid'
import { getSeedanceStatus } from '../lib/api'
import { importFromUrl } from '../lib/mediaImport'

export type AiJobPhase =
  | 'queued' // fal 큐 대기
  | 'running' // 생성 진행 중
  | 'importing' // 완료 → 영상 다운로드/import 중
  | 'done' // 미디어 패널에 추가 완료
  | 'error' // 실패

export interface AiJob {
  /** 로컬 잡 id. */
  id: string
  /** fal queue request_id (status 폴링용). */
  requestId: string
  /** 표시용 라벨 (프롬프트 앞부분). */
  label: string
  phase: AiJobPhase
  /** 큐 위치 (queued 동안). */
  queuePosition?: number
  /** 완료 후 import된 미디어 id. */
  mediaId?: string
  error?: string
  createdAt: number
}

interface AiJobsStore {
  jobs: Record<string, AiJob>
  /** 새 생성 잡 등록 — 폴링 인터벌이 자동으로 가동된다. */
  registerJob(requestId: string, label: string): string
  /** 잡 1건 제거 (완료/실패 항목 정리). */
  dismissJob(id: string): void
  /** 내부용 — 잡 상태 패치. */
  _patch(id: string, patch: Partial<AiJob>): void
}

const POLL_INTERVAL_MS = 6_000
let pollTimer: ReturnType<typeof setInterval> | null = null

export const useAiJobs = create<AiJobsStore>((set, get) => ({
  jobs: {},

  registerJob(requestId: string, label: string): string {
    const id = ulid()
    const job: AiJob = {
      id,
      requestId,
      label: label.slice(0, 60),
      phase: 'queued',
      createdAt: Date.now()
    }
    set((s) => ({ jobs: { ...s.jobs, [id]: job } }))
    ensurePolling()
    return id
  },

  dismissJob(id: string): void {
    set((s) => {
      const next = { ...s.jobs }
      delete next[id]
      return { jobs: next }
    })
  },

  _patch(id: string, patch: Partial<AiJob>): void {
    set((s) => {
      const cur = s.jobs[id]
      if (!cur) return s
      return { jobs: { ...s.jobs, [id]: { ...cur, ...patch } } }
    })
  }
}))

/** 진행 중인 잡이 하나라도 있으면 폴링 인터벌을 가동, 없으면 멈춘다. */
function ensurePolling(): void {
  const anyActive = Object.values(useAiJobs.getState().jobs).some(
    (j) => j.phase === 'queued' || j.phase === 'running'
  )
  if (anyActive && !pollTimer) {
    pollTimer = setInterval(() => {
      void pollOnce()
    }, POLL_INTERVAL_MS)
  } else if (!anyActive && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/** 진행 중인 모든 잡의 상태를 1회 조회 + 완료 잡 import. */
async function pollOnce(): Promise<void> {
  const store = useAiJobs.getState()
  const active = Object.values(store.jobs).filter(
    (j) => j.phase === 'queued' || j.phase === 'running'
  )
  if (active.length === 0) {
    ensurePolling()
    return
  }
  for (const job of active) {
    try {
      const st = await getSeedanceStatus(job.requestId)
      if (st.status === 'COMPLETED') {
        if (!st.video_url) {
          store._patch(job.id, {
            phase: 'error',
            error: st.result_error || '생성 결과에 영상 URL이 없습니다'
          })
          continue
        }
        // 폴링이 같은 잡을 다시 import하지 않도록 즉시 phase 전환.
        store._patch(job.id, { phase: 'importing' })
        const dl = await importFromUrl(st.video_url, {
          suggestedName: `ai-${job.requestId}.mp4`,
          displayName: `AI · ${job.label}`
        })
        if (dl.ok && dl.asset) {
          store._patch(job.id, { phase: 'done', mediaId: dl.asset.id })
        } else {
          store._patch(job.id, {
            phase: 'error',
            error: dl.error || 'AI 영상 import 실패'
          })
        }
      } else if (st.status === 'IN_PROGRESS') {
        store._patch(job.id, { phase: 'running', queuePosition: undefined })
      } else {
        // IN_QUEUE 등.
        store._patch(job.id, {
          phase: 'queued',
          queuePosition: st.queue_position ?? undefined
        })
      }
    } catch (err) {
      // 단발 폴링 실패는 치명적이지 않다 — 다음 틱에서 재시도.
      console.warn('[aiJobs] poll failed', job.requestId, err)
    }
  }
  ensurePolling()
}
