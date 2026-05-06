// =============================================
// Reels Collector - Content Script
// 인스타그램 페이지에서 릴스 데이터를 DOM에서 읽어 수집
// =============================================

(function () {
  'use strict';

  let collectCount = 0;

  // 원격 로그 헬퍼 — background로 위임
  function rlog(level, event, message, context) {
    try {
      chrome.runtime.sendMessage({
        action: 'remoteLog',
        level,
        event,
        message,
        context: { ...(context || {}), pathname: location.pathname, href: location.href },
      });
    } catch (_) { /* silent */ }
  }

  // 메시지 수신
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'collectReels') {
      // background가 사이클 관리. content는 grabSingle만 응답.
      // 단, mode === 'explore' 거나 'both' 면 기존 path.
      const mode = message.mode || 'reels';
      if (mode === 'reels') {
        // background가 사이클 시작
        chrome.runtime.sendMessage({ action: 'startReelsCycle' });
        sendResponse({ success: true });
        return;
      }
      handleCollect(mode).catch(err => {
        rlog('error', 'handle_collect_throw', String(err?.message || err),
             { stack: String(err?.stack || '').slice(0, 1000), mode });
      });
      sendResponse({ success: true });
      return;
    }
    if (message.action === 'grabSingle') {
      // 영상 길이만큼 시청 후 grabResult로 전달 (fire-and-forget)
      watchAndGrab().catch(err => {
        rlog('error', 'watch_grab_throw', String(err?.message || err), {});
      });
      sendResponse({ ok: true });
      return;
    }
  });

  // 수집 핸들러
  async function handleCollect(mode) {
    console.log(`[Reels Collector] 수집 시작 (mode: ${mode})...`);
    rlog('info', 'collect_start', `mode=${mode}`, { mode });

    if (mode === 'explore') {
      await collectFromExplore();
    } else if (mode === 'both') {
      // 두 탭 번갈아 — 호출마다 한 쪽만, 다음 호출 때 반대쪽
      const { lastMode = 'reels' } = await chrome.storage.local.get('lastMode');
      const nextMode = lastMode === 'reels' ? 'explore' : 'reels';
      await chrome.storage.local.set({ lastMode: nextMode });
      if (nextMode === 'explore') {
        await collectFromExplore();
      } else {
        await collectFromReels();
      }
    } else {
      await collectFromReels();
    }
  }

  // 릴스탭 수집 — 홈→릴스탭 사이클을 8번 반복하며 각 iteration마다 1개씩
  const TARGET_PER_CYCLE = 8;

  async function collectFromReels() {
    const collected = [];
    const seen = new Set();
    let dupCount = 0;

    for (let i = 0; i < TARGET_PER_CYCLE; i++) {
      // 1. 홈 진입
      await goHome();
      await wait(1800 + Math.random() * 1200);  // 1.8~3초

      // 2. 릴스탭 클릭
      clickReelsTab();
      await wait(2500 + Math.random() * 1800);  // 2.5~4.3초 (릴스 로드 대기)

      if (i === 0) {
        rlog('info', 'tab_clicked', 'reels', { on_reels: isOnReelsTab(), iter: i });
      }

      // 3. 현재 재생 중인 릴스 추출
      const cur = extractCurrentPlayingReel();
      if (cur && !seen.has(cur.shortcode)) {
        seen.add(cur.shortcode);
        collected.push(cur);
        rlog('info', 'reel_grabbed', `iter=${i+1} sc=${cur.shortcode}`,
             { iter: i + 1, shortcode: cur.shortcode, total: collected.length });
      } else if (cur && seen.has(cur.shortcode)) {
        // 같은 릴스가 또 나옴 — 알고리즘이 새 추천 안 줌
        dupCount++;
        rlog('warn', 'reel_duplicate', `iter=${i+1} sc=${cur.shortcode}`,
             { iter: i + 1, shortcode: cur.shortcode, dup: dupCount });
      } else {
        rlog('warn', 'reel_grab_failed', `iter=${i+1}`,
             { iter: i + 1, url: location.href });
      }

      // 4. 다음 iteration 전 자연스러운 시청
      await wait(1500 + Math.random() * 1500);  // 1.5~3초
    }

    if (collected.length > 0) {
      chrome.runtime.sendMessage({ action: 'saveReels', data: collected });
      collectCount++;
      console.log(`[Reels Collector] ${collected.length}개 릴스 수집 (총 ${collectCount}회)`);
      rlog('info', 'extract_done', `reels=${collected.length}/${TARGET_PER_CYCLE}`,
           { source: 'reels_tab', count: collected.length,
             target: TARGET_PER_CYCLE, dups: dupCount,
             samples: collected.slice(0, 5).map(r => r.shortcode) });
    } else {
      console.log('[Reels Collector] 릴스를 찾지 못했습니다.');
      rlog('warn', 'extract_zero', 'no reels collected',
           { source: 'reels_tab', dom_sample: domSample(),
             dups: dupCount, target: TARGET_PER_CYCLE });
    }
  }

  // 탐색탭 수집 — 매번 홈 진입 → 탐색탭 → 추출
  async function collectFromExplore() {
    await goHome();
    await wait(2000 + Math.random() * 1500);
    rlog('info', 'home_loaded', null, { step: 'before_explore' });

    clickExploreTab();
    await wait(2500 + Math.random() * 2000);
    rlog('info', 'tab_clicked', 'explore', { on_explore: isOnExploreTab() });

    // 그리드 lazy load 발화
    await scrollALittle();
    await wait(1500 + Math.random() * 1000);

    const items = extractFromExplore();
    if (items.length > 0) {
      chrome.runtime.sendMessage({ action: 'saveReels', data: items });
      collectCount++;
      console.log(`[Reels Collector] ${items.length}개 탐색탭 수집 (총 ${collectCount}회)`);
      rlog('info', 'extract_done', `explore=${items.length}`,
           { source: 'explore', count: items.length,
             reel_count: items.filter(i => i.is_reel).length,
             sample: items.slice(0, 3).map(i => ({ sc: i.shortcode, src: i.source })) });
    } else {
      console.log('[Reels Collector] 탐색탭에서 항목을 찾지 못했습니다.');
      rlog('warn', 'extract_zero', 'no items in explore',
           { source: 'explore', dom_sample: domSample(),
             link_counts: {
               reel: document.querySelectorAll('a[href*="/reel/"]').length,
               post: document.querySelectorAll('a[href*="/p/"]').length,
             }});
    }
  }

  // 현재 릴스탭인지 확인
  function isOnReelsTab() {
    return window.location.pathname.startsWith('/reels');
  }

  // 릴스탭 클릭
  function clickReelsTab() {
    // 릴스 탭 버튼 찾기 (여러 셀렉터 시도)
    const selectors = [
      'a[href="/reels/"]',
      'a[href="/reels"]',
      'svg[aria-label="릴스"]',
      'svg[aria-label="Reels"]'
    ];

    let reelsLink = null;

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        // svg인 경우 부모 a 태그를 찾음
        reelsLink = el.closest('a') || el;
        break;
      }
    }

    if (reelsLink) {
      // 실제 좌표 기반 클릭 (자연스럽게)
      const rect = reelsLink.getBoundingClientRect();
      const x = rect.left + rect.width / 2 + (Math.random() - 0.5) * 4;
      const y = rect.top + rect.height / 2 + (Math.random() - 0.5) * 4;

      // element.click() 사용 (isTrusted: true)
      reelsLink.click();
      console.log(`[Reels Collector] 릴스탭 클릭 (${x.toFixed(0)}, ${y.toFixed(0)})`);
    } else {
      // 직접 URL로 이동
      window.location.href = 'https://www.instagram.com/reels/';
      console.log('[Reels Collector] 릴스탭 URL 이동');
    }
  }

  // DOM에서 릴스 데이터 추출
  function extractReelsFromDOM() {
    const reels = [];
    const now = new Date().toISOString();

    // 방법 1: 릴스 링크 추출
    const reelLinks = document.querySelectorAll('a[href*="/reel/"]');

    reelLinks.forEach(link => {
      const href = link.getAttribute('href');
      if (!href) return;

      const url = href.startsWith('http')
        ? href
        : `https://www.instagram.com${href}`;

      // shortcode 추출
      const shortcodeMatch = href.match(/\/reel\/([A-Za-z0-9_-]+)/);
      const shortcode = shortcodeMatch ? shortcodeMatch[1] : null;

      if (!shortcode) return;

      // 주변 DOM에서 메타데이터 추출 시도
      const container = link.closest('div[class]') || link.parentElement;
      const metadata = extractMetadata(container);

      reels.push({
        url: url,
        shortcode: shortcode,
        collected_at: now,
        source: 'reels_tab',
        ...metadata
      });
    });

    // 방법 2: 현재 재생 중인 릴스 (릴스 뷰어 모드)
    const currentReel = extractCurrentPlayingReel();
    if (currentReel && !reels.some(r => r.shortcode === currentReel.shortcode)) {
      reels.push(currentReel);
    }

    // 중복 제거
    const unique = [];
    const seen = new Set();
    for (const reel of reels) {
      if (!seen.has(reel.shortcode)) {
        seen.add(reel.shortcode);
        unique.push(reel);
      }
    }

    return unique;
  }

  // 현재 재생 중인 릴스 추출
  function extractCurrentPlayingReel() {
    const now = new Date().toISOString();

    // URL에서 현재 릴스 shortcode 추출
    const urlMatch = window.location.pathname.match(/\/reels?\/([A-Za-z0-9_-]+)/);
    if (!urlMatch) return null;

    const shortcode = urlMatch[1];

    // 현재 화면의 비디오 요소
    const video = document.querySelector('video');

    // 작성자 정보 추출
    const authorEl = document.querySelector('header a[href*="/"]') ||
                     document.querySelector('span a[href*="/"]');
    const author = authorEl ? authorEl.textContent.trim() : null;

    // 캡션 추출
    const captionEl = document.querySelector('h1') ||
                      document.querySelector('span[class*="caption"]');
    const caption = captionEl ? captionEl.textContent.trim() : null;

    // 좋아요/조회수 텍스트 추출
    const statsText = extractStatsText();

    return {
      url: `https://www.instagram.com/reel/${shortcode}/`,
      shortcode: shortcode,
      collected_at: now,
      source: 'reels_tab_playing',
      author: author,
      caption: caption,
      has_video: !!video,
      video_src: video ? video.src : null,
      stats_text: statsText
    };
  }

  // 컨테이너에서 메타데이터 추출
  function extractMetadata(container) {
    if (!container) return {};

    const metadata = {};

    // 텍스트 노드에서 조회수/좋아요 패턴 찾기
    const allText = container.textContent || '';

    // 조회수 패턴: "조회 1.2만회", "1,234 views"
    const viewsMatch = allText.match(/조회\s*([\d,.만억]+)\s*회|(\d[\d,.KkMm만억]*)\s*views?/i);
    if (viewsMatch) {
      metadata.views_text = viewsMatch[0].trim();
    }

    // 좋아요 패턴: "좋아요 1,234개", "1,234 likes"
    const likesMatch = allText.match(/좋아요\s*([\d,.만억]+)\s*개|(\d[\d,.KkMm만억]*)\s*likes?/i);
    if (likesMatch) {
      metadata.likes_text = likesMatch[0].trim();
    }

    // 작성자명
    const authorLink = container.querySelector('a[href*="/"]');
    if (authorLink) {
      const href = authorLink.getAttribute('href');
      const username = href.replace(/\//g, '');
      if (username && username.length < 50) {
        metadata.author = username;
      }
    }

    return metadata;
  }

  // 화면에서 통계 텍스트 추출
  function extractStatsText() {
    const stats = {};

    // 모든 span/div에서 숫자 패턴 탐색
    const elements = document.querySelectorAll('span, div');
    for (const el of elements) {
      const text = el.textContent.trim();
      if (!text || text.length > 100) continue;

      if (/조회.*회|views?/i.test(text)) {
        stats.views = text;
      }
      if (/좋아요.*개|likes?/i.test(text)) {
        stats.likes = text;
      }
      if (/댓글.*개|comments?/i.test(text)) {
        stats.comments = text;
      }
    }

    return Object.keys(stats).length > 0 ? stats : null;
  }

  // ── 홈 진입 (피드 리프레시 효과) ──

  function isOnHome() {
    return location.pathname === '/' || location.pathname === '';
  }

  async function goHome() {
    if (isOnHome()) {
      // 이미 홈이면 로고 클릭 = 피드 새로고침 효과
      const logo = document.querySelector('a[href="/"][aria-label*="Instagram"], a[href="/"]');
      if (logo) { logo.click(); return; }
    }
    // 인스타 로고/홈 링크 찾기 (SPA 네비게이션)
    const selectors = [
      'a[href="/"][role="link"]',
      'a[href="/"]',
      'svg[aria-label="홈"]',
      'svg[aria-label="Home"]',
    ];
    let link = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { link = el.closest('a') || el; break; }
    }
    if (link) {
      link.click();
    } else {
      // 폴백: 주소창 치기 효과
      window.location.href = 'https://www.instagram.com/';
    }
  }

  // ── 탐색탭 (/explore/) ──

  function isOnExploreTab() {
    return window.location.pathname.startsWith('/explore');
  }

  function clickExploreTab() {
    const selectors = [
      'a[href="/explore/"]',
      'a[href="/explore"]',
      'svg[aria-label="탐색 탭"]',
      'svg[aria-label="Search"]',
      'svg[aria-label="Explore"]',
    ];
    let link = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { link = el.closest('a') || el; break; }
    }
    if (link) {
      link.click();
      console.log('[Reels Collector] 탐색탭 클릭');
    } else {
      window.location.href = 'https://www.instagram.com/explore/';
      console.log('[Reels Collector] 탐색탭 URL 이동');
    }
  }

  // 탐색탭 그리드에서 reel + post 추출
  function extractFromExplore() {
    const items = [];
    const now = new Date().toISOString();
    const seen = new Set();

    // /reel/ 또는 /p/ 링크 모두 그리드에 노출
    const links = document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]');
    links.forEach(link => {
      const href = link.getAttribute('href');
      if (!href) return;

      const reelMatch = href.match(/\/reel\/([A-Za-z0-9_-]+)/);
      const postMatch = href.match(/\/p\/([A-Za-z0-9_-]+)/);
      const m = reelMatch || postMatch;
      if (!m) return;
      const shortcode = m[1];
      if (seen.has(shortcode)) return;
      seen.add(shortcode);

      // 그리드 내부 이미지에서 미리보기 url 잡기 (썸네일 백업용)
      const img = link.querySelector('img');
      const thumbnail_src = img?.src || null;
      const alt_text = img?.alt || null;

      // 비디오 아이콘 / 릴스 아이콘 유무로 판단
      const hasVideoIcon = !!link.querySelector('svg[aria-label*="동영상"], svg[aria-label*="Video"], svg[aria-label*="릴스"], svg[aria-label*="Reels"]');
      const isReel = !!reelMatch;

      items.push({
        url: `https://www.instagram.com${href.startsWith('/') ? href : '/' + href}`,
        shortcode,
        collected_at: now,
        source: isReel ? 'explore_reel' : 'explore_post',
        is_reel: isReel,
        is_video: isReel || hasVideoIcon,
        thumbnail_src,
        alt_text,
      });
    });

    return items;
  }

  // 영상 길이만큼 시청 후 grab 결과 background로 전송
  async function watchAndGrab() {
    let video = document.querySelector('video');
    if (!video) {
      await wait(1500);
      video = document.querySelector('video');
    }

    let duration = 10;  // fallback 10초
    if (video) {
      // loadedmetadata 대기 (최대 3초)
      if (isNaN(video.duration) || video.duration === 0) {
        await new Promise(resolve => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            try { video.removeEventListener('loadedmetadata', finish); } catch {}
            resolve();
          };
          try { video.addEventListener('loadedmetadata', finish); } catch {}
          setTimeout(finish, 3000);
        });
      }
      if (!isNaN(video.duration) && video.duration > 0) {
        duration = video.duration;
      }
    }

    // 영상 길이의 80~120% 시청 (max 90초로 cap)
    const targetSec = duration * (0.8 + Math.random() * 0.4);
    const dwellMs = Math.min(targetSec * 1000, 90000);
    rlog('info', 'watching_full',
      `dur=${duration.toFixed(1)} dwell=${(dwellMs / 1000).toFixed(1)}`,
      { duration: Number(duration.toFixed(1)),
        dwell_sec: Number((dwellMs / 1000).toFixed(1)) });

    await wait(dwellMs);

    const cur = extractCurrentPlayingReel();
    try {
      chrome.runtime.sendMessage({
        action: 'grabResult',
        reel: cur,
        url: location.href,
        dwell_sec: Number((dwellMs / 1000).toFixed(1)),
      });
    } catch (_) { /* silent */ }
  }

  // 실패 진단용 DOM 샘플 (5KB만)
  function domSample() {
    try {
      const main = document.querySelector('main') || document.body;
      return main.outerHTML.slice(0, 5000);
    } catch (_) {
      return null;
    }
  }

  // 자연스러운 스크롤 — 그리드 lazy load 발화
  async function scrollALittle() {
    const distance = 800 + Math.random() * 1200;
    const steps = 6 + Math.floor(Math.random() * 4);
    for (let i = 0; i < steps; i++) {
      window.scrollBy({ top: distance / steps, behavior: 'smooth' });
      await wait(150 + Math.random() * 200);
    }
  }

  // 유틸: 대기
  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  console.log('[Reels Collector] Content script 로드 완료');
})();
