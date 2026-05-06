// popup.js — driver for the collection UI
const $status = document.getElementById('status');
const $info = document.getElementById('info');
const $collect = document.getElementById('collect');
const $download = document.getElementById('download');
const $copy = document.getElementById('copy');
const $preview = document.getElementById('preview');
const $maxPages = document.getElementById('maxPages');

let collected = null;

function setStatus(msg, type = 'warn') {
  $status.textContent = msg;
  $status.className = 'status ' + type;
}

function isSupported(url) {
  return /^https:\/\/(([^./]+\.)?smartstore|([^./]+\.)?brand)\.naver\.com\/.+\/products\/\d+/.test(url || '');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  const tab = await getActiveTab();
  if (!tab || !isSupported(tab.url)) {
    setStatus('스마트스토어/브랜드스토어 상품 페이지로 이동해주세요.', 'warn');
    return;
  }
  setStatus('상품 페이지 감지됨. 수집 가능합니다.', 'ok');
  $collect.disabled = false;
}

// This function is injected into the page (MAIN world) and runs in the user's session.
// It reads window.__PRELOADED_STATE__ and calls the same-origin reviews API.
function pageScript(maxPages) {
  return new Promise(async (resolve) => {
    const debug = { steps: [] };
    function collectReviewsFromState(root) {
      const found = [];
      const seen = new WeakSet();
      const textKeys = ['reviewContent', 'content', 'contents', 'text', 'body'];
      const scoreKeys = ['reviewScore', 'score', 'starScore', 'rating'];
      const dateKeys = ['createDate', 'createdDate', 'writeDate', 'registeredDate'];
      function walk(value, path, depth) {
        if (!value || depth > 8) return;
        if (typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);
        if (!Array.isArray(value)) {
          const textKey = textKeys.find(k => typeof value[k] === 'string' && value[k].trim().length >= 8);
          if (textKey) {
            const haystack = [path, value.id, value.type, value.__typename, value[textKey]].join(' ').toLowerCase();
            const looksLikeReview =
              /review|리뷰|구매평|상품평/.test(haystack) ||
              scoreKeys.some(k => value[k] != null) ||
              dateKeys.some(k => value[k] != null);
            if (looksLikeReview) {
              found.push({
                id: value.id || value.reviewId || value.no || `${path}:${found.length}`,
                score: scoreKeys.map(k => value[k]).find(v => v != null) || '',
                date: dateKeys.map(k => value[k]).find(v => v != null) || '',
                option: value.productOptionContent || value.standardPurchaseConditionText || value.optionContent || '',
                text: value[textKey].trim(),
                helpful: value.helpfulCount || value.likeCount || 0,
                _path: path,
              });
            }
          }
        }
        if (Array.isArray(value)) {
          value.slice(0, 200).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
          return;
        }
        for (const [key, child] of Object.entries(value).slice(0, 300)) {
          walk(child, path ? `${path}.${key}` : key, depth + 1);
        }
      }
      walk(root, 'STATE', 0);
      const deduped = [];
      const keys = new Set();
      for (const item of found) {
        const key = item.text.replace(/\s+/g, ' ').slice(0, 120);
        if (keys.has(key)) continue;
        keys.add(key);
        deduped.push(item);
      }
      return deduped;
    }
    function summarizeStateBranch(value, depth = 0) {
      if (value == null) return value;
      if (typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 120) : value;
      if (Array.isArray(value)) {
        return {
          type: 'array',
          length: value.length,
          sample: value.slice(0, 3).map(item => summarizeStateBranch(item, depth + 1)),
        };
      }
      const keys = Object.keys(value);
      const out = { type: 'object', keys: keys.slice(0, 40), keyCount: keys.length };
      if (depth >= 2) return out;
      for (const key of keys.slice(0, 20)) {
        const child = value[key];
        if (child == null || typeof child !== 'object' || Array.isArray(child)) {
          out[key] = summarizeStateBranch(child, depth + 1);
        } else {
          out[key] = summarizeStateBranch(child, depth + 1);
        }
      }
      return out;
    }
    try {
      const STATE = window.__PRELOADED_STATE__;
      if (!STATE) {
        resolve({ ok: false, error: '__PRELOADED_STATE__ 없음', debug });
        return;
      }
      debug.stateKeys = Object.keys(STATE);
      debug.reviewStateSummary = {};
      for (const key of [
        'productReviews',
        'detailReviews',
        'productReviewSummary',
        'productBestReviews',
        'reviewsFilter',
        'reviewDetail',
        'customReview',
        'productReviewContentSummaryTags',
        'productReviewGalleryAttaches',
      ]) {
        if (STATE[key] != null) debug.reviewStateSummary[key] = summarizeStateBranch(STATE[key]);
      }
      const A = STATE.simpleProductForDetailPage?.A;
      if (!A) {
        resolve({ ok: false, error: 'simpleProductForDetailPage.A 없음', debug });
        return;
      }
      debug.aKeys = Object.keys(A);
      const ch = A.channel || {};
      debug.channelKeys = Object.keys(ch);
      debug.channelSample = {
        channelUid: ch.channelUid,
        checkoutMerchantNo: ch.checkoutMerchantNo,
        accountNo: ch.accountNo,
        channelName: ch.channelName,
        channelNo: ch.channelNo,
        merchantNo: ch.merchantNo,
        payReferenceKey: ch.payReferenceKey,
      };
      const product = {
        id: A.id,
        productNo: A.productNo,
        originalProductNo: A.originalProductNo,
        name: A.name,
        category: A.category?.wholeCategoryName,
        salePrice: A.salePrice,
        reviewAmount: A.reviewAmount,
        channelUid: ch.channelUid,
        checkoutMerchantNo: ch.checkoutMerchantNo || ch.merchantNo || ch.channelNo,
        accountNo: ch.accountNo,
        mallName: ch.channelName,
        tags: A.tags || [],
        descriptionText: (A.detailContentText || '').slice(0, 2000),
      };
      debug.product = { ...product, descriptionText: product.descriptionText?.slice(0, 50) };

      const apiBase = location.host === 'brand.naver.com'
        ? 'https://brand.naver.com/n/v1/contents/reviews/query-pages'
        : 'https://smartstore.naver.com/i/v1/contents/reviews/query-pages';
      const headers = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      };
      const reviews = [];
      let total = 0;
      let last = false;
      const merchantNo = Number(product.checkoutMerchantNo || product.channelUid || 0);
      const productNo = Number(product.originalProductNo || product.productNo || 0);
      const detailProductNo = Number(product.id || 0);
      debug.requestKeys = { merchantNo, productNo, detailProductNo };
      if (!merchantNo || !productNo) {
        resolve({ ok: false, error: `필수 필드 없음: merchantNo=${merchantNo} productNo=${productNo}`, debug, product });
        return;
      }
      const requestVariants = [
        {
          name: 'checkoutMerchantNo+originProductNo+reviewSearchSortType',
          makeBody: (page) => ({
            checkoutMerchantNo: merchantNo,
            originProductNo: productNo,
            page,
            pageSize: 30,
            reviewSearchSortType: 'REVIEW_RANKING',
          }),
        },
        {
          name: 'merchantNo+originProductNo+sortType',
          makeBody: (page) => ({
            merchantNo,
            originProductNo: productNo,
            page,
            pageSize: 30,
            sortType: 'REVIEW_RANKING',
          }),
        },
        {
          name: 'checkoutMerchantNo+originProductNo+sortType',
          makeBody: (page) => ({
            checkoutMerchantNo: merchantNo,
            originProductNo: productNo,
            page,
            pageSize: 30,
            sortType: 'REVIEW_RANKING',
          }),
        },
        ...(detailProductNo && detailProductNo !== productNo ? [{
          name: 'merchantNo+detailProductNo+sortType',
          makeBody: (page) => ({
            merchantNo,
            originProductNo: detailProductNo,
            page,
            pageSize: 30,
            sortType: 'REVIEW_RANKING',
          }),
        }] : []),
      ];
      let activeVariant = null;
      for (const variant of requestVariants) {
        const body = variant.makeBody(1);
        const r = await fetch(apiBase, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          credentials: 'include',
        });
        debug.steps.push(`try ${variant.name}: HTTP ${r.status}`);
        debug.firstStatus = r.status;
        debug.firstUrl = apiBase;
        if (r.status === 204) continue;
        if (!r.ok) {
          let bodyText = '';
          try { bodyText = (await r.text()).slice(0, 300); } catch (_) {}
          debug.steps.push(`try ${variant.name}: body=${bodyText}`);
          continue;
        }
        const d = await r.json();
        if ((d.contents || []).length || d.totalElements) {
          activeVariant = variant;
          total = d.totalElements || 0;
          debug.firstResponseKeys = Object.keys(d);
          debug.firstTotalElements = d.totalElements;
          debug.firstContentsLen = (d.contents || []).length;
          debug.activeVariant = variant.name;
          if (d.contents) reviews.push(...d.contents);
          last = !!d.last;
          break;
        }
      }
      if (!activeVariant) {
        debug.steps.push('all request variants returned no review content');
      }
      if (!reviews.length) {
        const stateReviews = collectReviewsFromState(STATE);
        debug.stateFallbackCount = stateReviews.length;
        debug.stateFallbackPaths = stateReviews.slice(0, 10).map(r => r._path);
        if (stateReviews.length) {
          resolve({ ok: true, product, reviews: stateReviews, total: stateReviews.length, debug });
          return;
        }
      }
      for (let page = 2; activeVariant && page <= maxPages && !last; page++) {
        const body = activeVariant.makeBody(page);
        const r = await fetch(apiBase, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          credentials: 'include',
        });
        if (r.status === 204) { debug.steps.push(`p${page}: 204 no content`); break; }
        if (!r.ok) {
          let bodyText = '';
          try { bodyText = (await r.text()).slice(0, 300); } catch (_) {}
          debug.steps.push(`p${page}: HTTP ${r.status} body=${bodyText}`);
          break;
        }
        const d = await r.json();
        if (d.contents) reviews.push(...d.contents);
        last = !!d.last;
        await new Promise(res => setTimeout(res, 200));
      }
      const cleaned = reviews.map(r => ({
        id: r.id,
        score: r.reviewScore,
        date: r.createDate,
        option: r.productOptionContent || r.standardPurchaseConditionText || '',
        text: r.reviewContent || '',
        helpful: r.helpfulCount || 0,
      }));
      resolve({ ok: true, product, reviews: cleaned, total, debug });
    } catch (e) {
      resolve({ ok: false, error: e.message || String(e), debug });
    }
  });
}

$collect.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab || !isSupported(tab.url)) {
    setStatus('상품 페이지가 아닙니다.', 'err');
    return;
  }
  $collect.disabled = true;
  setStatus('수집 중…', 'warn');
  try {
    const max = Math.max(1, Math.min(34, parseInt($maxPages.value, 10) || 10));
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: pageScript,
      args: [max],
    });
    if (!result || !result.ok) {
      setStatus('수집 실패: ' + (result?.error || '알 수 없음'), 'err');
      $preview.style.display = 'block';
      $preview.textContent = JSON.stringify(result?.debug || {}, null, 2);
      $collect.disabled = false;
      return;
    }
    collected = { source_url: tab.url, ...result };
    setStatus(`수집 완료 — 리뷰 ${result.reviews.length}/${result.total}개`, 'ok');
    $info.style.display = 'block';
    $info.innerHTML = `
      <div><b>${escapeHtml(result.product.name)}</b></div>
      <div>카테고리: ${escapeHtml(result.product.category || '-')}</div>
      <div>가격: ${(result.product.salePrice || 0).toLocaleString()}원</div>
      <div>리뷰 총: ${result.total}개 / 수집: ${result.reviews.length}개</div>
    `;
    const preview = result.reviews.length
      ? result.reviews.slice(0, 5).map(r => `★${r.score} ${r.text.slice(0, 80)}`).join('\n')
      : ('리뷰 0개. 디버그 정보:\n' + JSON.stringify(result.debug || {}, null, 2));
    $preview.style.display = 'block';
    $preview.textContent = preview;
    $download.disabled = false;
    $copy.disabled = false;
    $collect.disabled = false;
  } catch (e) {
    setStatus('실행 오류: ' + e.message, 'err');
    $collect.disabled = false;
  }
});

$download.addEventListener('click', () => {
  if (!collected) return;
  const blob = new Blob([JSON.stringify(collected, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safeName = (collected.product.name || 'product').replace(/[^가-힣a-zA-Z0-9]+/g, '_').slice(0, 40);
  chrome.downloads.download({
    url,
    filename: `naver_${safeName}_${collected.product.productNo}.json`,
    saveAs: true,
  });
});

$copy.addEventListener('click', async () => {
  if (!collected) return;
  const txt = collected.reviews.map((r, i) =>
    `[${i + 1}] ★${r.score} ${r.option ? '['+r.option+']' : ''}\n${r.text}`
  ).join('\n\n');
  try {
    await navigator.clipboard.writeText(txt);
    setStatus('리뷰 텍스트를 클립보드에 복사했습니다.', 'ok');
  } catch (e) {
    setStatus('복사 실패: ' + e.message, 'err');
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
