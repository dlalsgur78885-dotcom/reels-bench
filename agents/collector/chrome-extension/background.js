// =============================================
// Reels Collector - Background Service Worker
// =============================================

// Supabase 설정
const SUPABASE_URL = 'https://mrpbovbxtablvawszhey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_BevcIvJOcRgb5hOm1YKEog_pv_DYKyF';
const EXT_VERSION = chrome.runtime.getManifest().version;

// session_id — 익스텐션 인스턴스마다 1개. 재설치/재로드 시 갱신.
async function getSessionId() {
  const { sessionId } = await chrome.storage.local.get('sessionId');
  if (sessionId) return sessionId;
  const newId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await chrome.storage.local.set({ sessionId: newId });
  return newId;
}

// fire-and-forget 원격 로그
async function remoteLog(level, event, message, context = {}, pageUrl = null) {
  try {
    const sid = await getSessionId();
    const row = {
      session_id: sid,
      version: EXT_VERSION,
      level,
      event,
      message: message || null,
      context: context && Object.keys(context).length ? context : null,
      user_agent: navigator.userAgent,
      page_url: pageUrl,
    };
    fetch(`${SUPABASE_URL}/rest/v1/extension_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(row),
    }).catch(() => {}); // 네트워크 실패 무시
  } catch (e) {
    // 로깅 자체가 실패해도 사용자 작업엔 영향 없도록 silent
  }
}

// 알람 생성: 30~90분 랜덤 간격
const COLLECT_MIN_MINUTES = 30;
const COLLECT_MAX_MINUTES = 90;

function scheduleNextCollect() {
  const delayMinutes =
    COLLECT_MIN_MINUTES + Math.random() * (COLLECT_MAX_MINUTES - COLLECT_MIN_MINUTES);

  chrome.alarms.create('collectReels', {
    delayInMinutes: delayMinutes,
  });

  console.log(`[Reels Collector] 다음 수집: ${delayMinutes.toFixed(1)}분 후`);
  remoteLog('info', 'next_scheduled', null,
    { delay_min: Number(delayMinutes.toFixed(1)) });
}

// 인스타 탭에 sendMessage — 실패 시 content.js 재주입 후 재시도
async function sendToInstagramTab(payload) {
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (tabs.length === 0) {
    remoteLog('warn', 'no_instagram_tab',
      'alarm fired but no instagram tab open', { mode: payload.mode });
    return;
  }
  const tab = tabs[0];

  // 1차 시도
  try {
    await chrome.tabs.sendMessage(tab.id, payload);
    return;
  } catch (err) {
    // receiver 없음 → content.js 강제 주입
    remoteLog('warn', 'content_not_ready', 'injecting content.js',
      { tabId: tab.id, error: String(err?.message || err).slice(0, 200) });
  }

  // content.js 주입
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    // 주입 후 listener 등록까지 약간 대기
    await new Promise(r => setTimeout(r, 500));
    // 2차 시도
    await chrome.tabs.sendMessage(tab.id, payload);
    remoteLog('info', 'inject_success', 'content.js injected and message delivered',
      { tabId: tab.id });
  } catch (err) {
    remoteLog('error', 'inject_failed', String(err?.message || err).slice(0, 300),
      { tabId: tab.id });
  }
}

// 알람 이벤트 핸들러
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'collectReels') {
    chrome.storage.local.get('collectMode', ({ collectMode }) => {
      const mode = collectMode || 'reels';
      if (mode === 'reels') {
        // 자동 탭 생성 → 사이클 → 종료 시 자동 닫기
        startReelsCycleAutoTab();
      } else {
        // explore / both 는 기존 인스타 탭 사용
        sendToInstagramTab({ action: 'collectReels', mode });
      }
    });
    scheduleNextCollect();
  }
});

// =============================================
// 릴스탭 Hard Navigate 사이클 매니저
// =============================================
const REELS_TARGET_MIN = 6;
const REELS_TARGET_MAX = 10;
let cycleState = null;
let autoCreatedTabId = null;  // 익스텐션이 자동 생성한 탭 ID — 끝나면 닫음

// 자동 탭 생성 → 사이클 시작 → 끝나면 자동 종료
async function startReelsCycleAutoTab() {
  if (cycleState) {
    remoteLog('warn', 'cycle_busy_auto', 'previous cycle still running', {});
    return;
  }
  // 사용자가 이미 인스타 탭을 열어두고 있으면 그걸 사용 (자동 종료 X)
  const existing = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (existing.length > 0) {
    remoteLog('info', 'cycle_use_existing_tab', `tab_id=${existing[0].id}`,
      { tabId: existing[0].id, will_close: false });
    autoCreatedTabId = null;
    startReelsCycle(existing[0].id);
    return;
  }

  // 활성 탭으로 새로 열기 (백그라운드 X — 봇 디텍션 회피)
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: 'https://www.instagram.com/',
      active: true,  // 사용자에게 보이는 일반 탭
    });
  } catch (err) {
    remoteLog('error', 'auto_tab_create_failed', String(err?.message || err), {});
    return;
  }
  autoCreatedTabId = tab.id;
  remoteLog('info', 'auto_tab_created', `tab_id=${tab.id}`,
    { tabId: tab.id, will_close: true });

  // 첫 페이지 로드 대기
  await new Promise(r => setTimeout(r, 2500));
  startReelsCycle(tab.id);
}

async function startReelsCycle(tabId) {
  if (cycleState) {
    remoteLog('warn', 'cycle_busy', 'previous cycle still running',
      { iter: cycleState.iter, collected: cycleState.collected.length });
    return;
  }
  // 사이클당 5~8개 랜덤 (디텍션 회피)
  const target = REELS_TARGET_MIN +
    Math.floor(Math.random() * (REELS_TARGET_MAX - REELS_TARGET_MIN + 1));
  cycleState = {
    tabId,
    target,
    collected: [],
    seen: new Set(),
    iter: 0,
    phase: null,
    startedAt: Date.now(),
  };
  remoteLog('info', 'cycle_begin', `target=${target}`,
    { target, tabId });
  nextIteration();
}

async function nextIteration() {
  if (!cycleState) return;
  cycleState.iter++;
  if (cycleState.iter > cycleState.target) {
    finishCycle();
    return;
  }
  remoteLog('info', 'iter_start', `iter=${cycleState.iter}/${cycleState.target}`,
    { iter: cycleState.iter, total: cycleState.collected.length });
  cycleState.phase = 'home';
  await navigateHard(cycleState.tabId, 'https://www.instagram.com/');
}

async function navigateHard(tabId, baseUrl) {
  // cache-buster + window.location.assign으로 강제 풀 페이지 로드
  const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (u) => { window.location.assign(u); },
      args: [url],
    });
  } catch (err) {
    // fallback
    chrome.tabs.update(tabId, { url });
  }
}

// 페이지 로드 완료 → 다음 phase 진행
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!cycleState || tabId !== cycleState.tabId) return;
  if (info.status !== 'complete') return;

  const url = (tab && tab.url) || '';

  if (cycleState.phase === 'home' && url.includes('instagram.com/?_t=')) {
    // 홈 로드 완료 → 잠깐 후 릴스탭으로 navigate
    const wait = 1500 + Math.random() * 1500;
    setTimeout(async () => {
      if (!cycleState) return;
      cycleState.phase = 'reels';
      await navigateHard(cycleState.tabId, 'https://www.instagram.com/reels/');
    }, wait);
  } else if (cycleState.phase === 'reels' && /instagram\.com\/reels?\//.test(url)) {
    // 릴스 로드 완료 → 짧은 안정화 wait 후 grabSingle (시청은 content.js가 video.duration 기반)
    const stabilize = 2500 + Math.random() * 1500;
    setTimeout(() => {
      if (!cycleState) return;
      cycleState.phase = 'grab';
      chrome.tabs.sendMessage(cycleState.tabId, { action: 'grabSingle' })
        .catch(err => {
          remoteLog('error', 'grab_error',
            String(err?.message || err).slice(0, 200),
            { iter: cycleState.iter });
          // 다음 iteration
          setTimeout(() => nextIteration(), 1500);
        });
    }, stabilize);
  }
});

function finishCycle() {
  if (!cycleState) return;
  const tabIdToClose = (autoCreatedTabId !== null && autoCreatedTabId === cycleState.tabId)
    ? autoCreatedTabId : null;
  const data = cycleState.collected;
  const elapsedSec = ((Date.now() - cycleState.startedAt) / 1000).toFixed(1);
  remoteLog('info', 'extract_done',
    `reels=${data.length}/${cycleState.target} elapsed=${elapsedSec}s`,
    { source: 'reels_tab', count: data.length, target: cycleState.target,
      elapsed_sec: Number(elapsedSec),
      samples: data.slice(0, 5).map(r => r.shortcode) });
  if (data.length > 0) {
    saveReelsData(data);
  }
  cycleState = null;

  // 자동 생성한 탭이면 닫기
  if (tabIdToClose !== null) {
    autoCreatedTabId = null;
    chrome.tabs.remove(tabIdToClose).then(() => {
      remoteLog('info', 'auto_tab_closed', null, { tabId: tabIdToClose });
    }).catch((err) => {
      remoteLog('warn', 'auto_tab_close_failed',
        String(err?.message || err), { tabId: tabIdToClose });
    });
  }
}

// content script에서 메시지 수신
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startReelsCycle') {
    if (sender?.tab?.id) {
      startReelsCycle(sender.tab.id);
    }
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'grabResult') {
    if (cycleState) {
      const r = message.reel;
      if (r && r.shortcode && !cycleState.seen.has(r.shortcode)) {
        cycleState.seen.add(r.shortcode);
        cycleState.collected.push(r);
        remoteLog('info', 'reel_grabbed',
          `iter=${cycleState.iter} sc=${r.shortcode} dwell=${message.dwell_sec}s`,
          { iter: cycleState.iter, shortcode: r.shortcode,
            total: cycleState.collected.length, dwell_sec: message.dwell_sec });
      } else if (r && r.shortcode) {
        remoteLog('warn', 'reel_duplicate',
          `iter=${cycleState.iter} sc=${r.shortcode}`,
          { iter: cycleState.iter, shortcode: r.shortcode });
      } else {
        remoteLog('warn', 'reel_grab_failed', `iter=${cycleState.iter}`,
          { iter: cycleState.iter, url: message.url });
      }
      const cooldown = 1000 + Math.random() * 1500;
      setTimeout(() => nextIteration(), cooldown);
    }
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'remoteLog') {
    remoteLog(
      message.level || 'info',
      message.event || 'unknown',
      message.message || null,
      message.context || {},
      sender?.tab?.url || null,
    );
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'saveReels') {
    saveReelsData(message.data);
    sendResponse({ success: true });
  }

  if (message.action === 'getStatus') {
    getStatus().then(sendResponse);
    return true;
  }

  if (message.action === 'startCollecting') {
    chrome.storage.local.set({ isRunning: true });
    scheduleNextCollect();
    chrome.storage.local.get('collectMode', ({ collectMode }) => {
      const mode = collectMode || 'reels';
      if (mode === 'reels') {
        startReelsCycleAutoTab();
      } else {
        sendToInstagramTab({ action: 'collectReels', mode });
      }
    });
    sendResponse({ success: true });
  }

  if (message.action === 'setMode') {
    chrome.storage.local.set({ collectMode: message.mode });
    sendResponse({ success: true });
  }

  if (message.action === 'stopCollecting') {
    chrome.storage.local.set({ isRunning: false });
    chrome.alarms.clear('collectReels');
    sendResponse({ success: true });
  }

  if (message.action === 'exportData') {
    exportData().then(sendResponse);
    return true;
  }

  if (message.action === 'clearData') {
    chrome.storage.local.set({ collectedReels: [] });
    sendResponse({ success: true });
  }

  if (message.action === 'setCategory') {
    chrome.storage.local.set({ accountCategory: message.category });
    sendResponse({ success: true });
  }
});

// =============================================
// 릴스 데이터 저장 (로컬 + Supabase)
// =============================================
async function saveReelsData(reelsArray) {
  // 로컬 저장
  const result = await chrome.storage.local.get(['collectedReels', 'accountCategory']);
  const existing = result.collectedReels || [];
  const category = result.accountCategory || 'unknown';

  const newReels = reelsArray
    .filter(reel => !existing.some(e => e.url === reel.url))
    .map(reel => ({ ...reel, account_category: category }));

  if (newReels.length === 0) return;

  const updated = [...existing, ...newReels];
  await chrome.storage.local.set({ collectedReels: updated });
  console.log(`[Reels Collector] ${newReels.length}개 새 릴스 저장 (총 ${updated.length}개)`);

  // Supabase 전송
  await sendToSupabase(newReels);
}

// =============================================
// Supabase 전송
// =============================================
async function sendToSupabase(reelsArray) {
  const rows = reelsArray.map(reel => ({
    shortcode: reel.shortcode,
    url: reel.url,
    views_text: reel.views_text || null,
    likes_text: reel.likes_text || null,
    stats_text: reel.stats_text || null,
    source: reel.source || 'reels_tab',
    account_category: reel.account_category || null,
    video_src: reel.video_src || null,
    collected_at: reel.collected_at
  }));

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/reels?on_conflict=shortcode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer': 'resolution=ignore-duplicates,return=minimal'
      },
      body: JSON.stringify(rows)
    });

    if (response.ok) {
      console.log(`[Supabase] ${rows.length}개 릴스 전송 성공 (중복은 자동 무시)`);
      remoteLog('info', 'supabase_insert_ok', `${rows.length} attempted`,
                { count: rows.length, sources: [...new Set(rows.map(r => r.source))] });
    } else if (response.status === 409) {
      // 모두 중복 — duplicate constraint. 정상 처리.
      console.log(`[Supabase] 409 — 모두 중복 (정상)`);
      remoteLog('info', 'supabase_all_duplicate', `409 — all duplicates`,
                { count: rows.length });
    } else {
      const error = await response.text();
      console.error(`[Supabase] 전송 실패: ${response.status} ${error}`);
      remoteLog('error', 'supabase_insert_fail', `${response.status}`,
                { status: response.status, body: error.slice(0, 500), count: rows.length });
      await savePendingSync(rows);
    }
  } catch (err) {
    console.error(`[Supabase] 네트워크 오류:`, err);
    remoteLog('error', 'supabase_network', String(err?.message || err),
              { count: rows.length });
    await savePendingSync(rows);
  }
}

// 전송 실패 시 대기열에 저장
async function savePendingSync(rows) {
  const result = await chrome.storage.local.get('pendingSync');
  const pending = result.pendingSync || [];
  await chrome.storage.local.set({ pendingSync: [...pending, ...rows] });
  console.log(`[Supabase] ${rows.length}개 대기열에 저장 (재시도 예정)`);
}

// 대기열 재시도 (5분마다)
chrome.alarms.create('retrySync', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'retrySync') {
    const result = await chrome.storage.local.get('pendingSync');
    const pending = result.pendingSync || [];
    if (pending.length === 0) return;

    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/reels?on_conflict=shortcode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Prefer': 'resolution=ignore-duplicates,return=minimal'
        },
        body: JSON.stringify(pending)
      });

      if (response.ok || response.status === 409) {
        await chrome.storage.local.set({ pendingSync: [] });
        console.log(`[Supabase] 대기열 ${pending.length}개 재전송 완료`);
      }
    } catch (err) {
      console.log(`[Supabase] 재시도 실패, 다음에 다시 시도`);
    }
  }
});

// 상태 조회
async function getStatus() {
  const result = await chrome.storage.local.get(['collectedReels', 'isRunning', 'pendingSync', 'accountCategory', 'collectMode']);
  return {
    totalCollected: (result.collectedReels || []).length,
    isRunning: result.isRunning || false,
    pendingSync: (result.pendingSync || []).length,
    accountCategory: result.accountCategory || '',
    collectMode: result.collectMode || 'reels',
  };
}

// 데이터 내보내기
async function exportData() {
  const result = await chrome.storage.local.get('collectedReels');
  return { data: result.collectedReels || [] };
}
