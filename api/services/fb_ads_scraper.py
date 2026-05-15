"""
Facebook Ad Library 순수 DOM 스크래퍼 (Playwright)
API 키 없이 브라우저 자동화로 광고 수집
정렬순 전환 + 줌 조절 + 중복 제거
"""

import asyncio
import json
import random
import re
import sys
import logging
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs, urljoin

from playwright.async_api import async_playwright

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger(__name__)

# ── UA / 헤더 로테이션 풀 (조합 자동 생성 ~300+개) ─────────────

# OS 플랫폼 템플릿
_OS_PLATFORMS = [
    # Windows 10/11 (동일 NT 10.0)
    ("Windows NT 10.0; Win64; x64", '"Windows"'),
    ("Windows NT 10.0; Win64; x64", '"Windows"'),
    # macOS 다양한 버전
    ("Macintosh; Intel Mac OS X 10_15_7", '"macOS"'),
    ("Macintosh; Intel Mac OS X 10_14_6", '"macOS"'),
    ("Macintosh; Intel Mac OS X 11_0_0", '"macOS"'),
    ("Macintosh; Intel Mac OS X 12_0_0", '"macOS"'),
    ("Macintosh; Intel Mac OS X 13_0_0", '"macOS"'),
    ("Macintosh; Intel Mac OS X 14_0", '"macOS"'),
    ("Macintosh; Intel Mac OS X 14_5", '"macOS"'),
    ("Macintosh; Intel Mac OS X 15_0", '"macOS"'),
    # Linux
    ("X11; Linux x86_64", '"Linux"'),
    ("X11; Linux x86_64", '"Linux"'),
]

# Chrome 버전 (메이저.0.빌드.0)
_CHROME_VERSIONS = [
    "118.0.5993.0", "118.0.5993.70", "118.0.5993.117",
    "119.0.6045.0", "119.0.6045.105", "119.0.6045.159",
    "120.0.6099.0", "120.0.6099.71", "120.0.6099.130", "120.0.6099.224",
    "121.0.6167.0", "121.0.6167.85", "121.0.6167.139", "121.0.6167.184",
    "122.0.6261.0", "122.0.6261.57", "122.0.6261.95", "122.0.6261.128",
    "123.0.6312.0", "123.0.6312.58", "123.0.6312.86", "123.0.6312.122",
    "124.0.6367.0", "124.0.6367.60", "124.0.6367.91", "124.0.6367.118",
    "125.0.6422.0", "125.0.6422.53", "125.0.6422.76", "125.0.6422.112",
    "126.0.6478.0", "126.0.6478.55", "126.0.6478.114", "126.0.6478.182",
    "127.0.6533.0", "127.0.6533.72", "127.0.6533.88", "127.0.6533.119",
    "128.0.6613.0", "128.0.6613.84", "128.0.6613.113", "128.0.6613.137",
    "129.0.6668.0", "129.0.6668.58", "129.0.6668.89", "129.0.6668.100",
    "130.0.6723.0", "130.0.6723.58", "130.0.6723.91", "130.0.6723.117",
    "131.0.6778.0", "131.0.6778.69", "131.0.6778.108", "131.0.6778.139",
]

# Edge 버전 (Chrome 기반)
_EDGE_VERSIONS = [
    ("120.0.6099.130", "120.0.2210.61"),
    ("121.0.6167.139", "121.0.2277.83"),
    ("122.0.6261.95",  "122.0.2365.52"),
    ("123.0.6312.86",  "123.0.2420.65"),
    ("124.0.6367.91",  "124.0.2478.51"),
    ("125.0.6422.76",  "125.0.2535.51"),
    ("126.0.6478.114", "126.0.2592.61"),
    ("127.0.6533.88",  "127.0.2651.74"),
    ("128.0.6613.113", "128.0.2739.42"),
    ("129.0.6668.89",  "129.0.2792.52"),
    ("130.0.6723.91",  "130.0.2849.46"),
    ("131.0.6778.108", "131.0.2903.51"),
]

# Not A Brand 변형 (버전별로 실제로 다름)
_NOT_A_BRAND_VARIANTS = [
    '"Not_A Brand";v="8"',
    '"Not_A Brand";v="24"',
    '"Not)A;Brand";v="99"',
    '"Not/A)Brand";v="8"',
    '"Not.A/Brand";v="8"',
]


def _build_ua_pool() -> list[dict]:
    """OS × 브라우저 버전 조합으로 UA 풀 생성. 각 항목은 {ua, sec_ch_ua, platform} dict."""
    pool = []

    for os_str, platform in _OS_PLATFORMS:
        # ── Chrome UA ──
        for cv in _CHROME_VERSIONS:
            major = cv.split(".")[0]
            ua = f"Mozilla/5.0 ({os_str}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{cv} Safari/537.36"
            not_a_brand = random.choice(_NOT_A_BRAND_VARIANTS)
            sec = f'"Chromium";v="{major}", "Google Chrome";v="{major}", {not_a_brand}'
            pool.append({"ua": ua, "sec_ch_ua": sec, "platform": platform})

        # ── Edge UA (Windows/Mac만) ──
        if "Linux" not in os_str:
            for chrome_v, edge_v in _EDGE_VERSIONS:
                major = chrome_v.split(".")[0]
                ua = (
                    f"Mozilla/5.0 ({os_str}) AppleWebKit/537.36 (KHTML, like Gecko) "
                    f"Chrome/{chrome_v} Safari/537.36 Edg/{edge_v}"
                )
                not_a_brand = random.choice(_NOT_A_BRAND_VARIANTS)
                sec = f'"Chromium";v="{major}", "Microsoft Edge";v="{major}", {not_a_brand}'
                pool.append({"ua": ua, "sec_ch_ua": sec, "platform": platform})

    random.shuffle(pool)
    return pool


# 모듈 로드 시 풀 생성 (한 번만)
_UA_POOL = _build_ua_pool()
logger.info(f"UA 풀 생성: {len(_UA_POOL)}개")

# Playwright 자동화 탐지 우회 스크립트 (Facebook 호환)
STEALTH_JS = """
() => {
    // webdriver 플래그 숨기기
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // chrome 객체 위장 (없으면 생성, 있으면 유지)
    if (!window.chrome) {
        window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    }
}
"""


def _pick_ua_and_headers() -> tuple[str, dict, dict]:
    """랜덤 UA 선택. (ua, context_headers, navigation_headers) 반환.
    context_headers: 모든 요청에 안전하게 적용 가능한 헤더
    navigation_headers: page.goto()의 첫 navigation에만 사용할 헤더
    """
    entry = random.choice(_UA_POOL)

    # 모든 요청에 적용해도 안전한 헤더 (sec-fetch-* 제외)
    context_headers = {
        "sec-ch-ua": entry["sec_ch_ua"],
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": entry["platform"],
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    }

    # 첫 navigation에만 사용 (sec-fetch-* 포함)
    navigation_headers = {
        **context_headers,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    }

    return entry["ua"], context_headers, navigation_headers


def _parse_proxy(proxy_url: str) -> dict:
    """프록시 URL을 Playwright proxy dict로 변환.
    예: http://user:pass@host:port → {server, username, password}
    """
    parsed = urlparse(proxy_url)
    result = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        result["username"] = parsed.username
    if parsed.password:
        result["password"] = parsed.password
    return result


def _random_delay(base_ms: int, jitter_ms: int = 800) -> int:
    """base_ms ± jitter_ms 범위의 랜덤 딜레이(ms)"""
    return max(500, base_ms + random.randint(-jitter_ms, jitter_ms))


# 광고 카드 파싱 JS (content.js 로직을 브라우저에서 실행)
PARSE_ADS_JS = """
() => {
  if (!document.body) return [];
  const ads = [];
  const seen = new Set();

  // "라이브러리 ID: 숫자" 또는 "Library ID: 숫자" 텍스트로 광고 카드 찾기
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const t = node.textContent;
      if (t.match(/라이브러리 ID:|Library ID:/)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_REJECT;
    }
  });

  const idNodes = [];
  let textNode;
  while ((textNode = walker.nextNode())) {
    const m = textNode.textContent.match(/(?:라이브러리 ID|Library ID):\\s*(\\d+)/);
    if (m) idNodes.push({ node: textNode, id: m[1] });
  }

  for (const { node, id: adId } of idNodes) {
    if (seen.has(adId)) continue;
    seen.add(adId);

    // 카드 컨테이너 찾기: ID 텍스트에서 위로 올라가며 적절한 크기의 컨테이너
    let el = node.parentElement;
    let cardEl = null;
    let depth = 0;
    while (el && el !== document.body && depth < 20) {
      const rect = el.getBoundingClientRect();
      if (rect.height >= 200 && rect.width >= 300) {
        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const similar = siblings.filter(s => {
            const sr = s.getBoundingClientRect();
            return sr.height >= 150 && sr.width >= 300;
          });
          if (similar.length >= 2) { cardEl = el; break; }
        }
        if (rect.height >= 250 && rect.height < 3000) { cardEl = el; break; }
      }
      el = el.parentElement;
      depth++;
    }
    if (!cardEl) continue;

    const fullText = cardEl.textContent || '';
    const ad = {
      id: adId,
      page_name: '',
      media_type: '',
      start_date: '',
      end_date: '',
      caption: '',
      video_thumbnail: '',
      video_url: '',
      banner_url: '',
      ad_title: '',
      ad_description: '',
      snapshot_url: '',
      link_url: '',
      instagram_url: '',
      platforms: [],
      media_urls: [],
    };

    // 광고주 이름 — "광고 N개" / "N ads" 뱃지 제외
    const isBadge = (t) => /^(광고|Ads?)\s*\d+\s*개?$/i.test(t) || /^\d+\s*ads?$/i.test(t);
    const isSkip = (t) => !t || isBadge(t) || /^(활성|비활성|Active|Inactive|Sponsored|광고|Ad)$/i.test(t)
        || t.includes('라이브러리 ID') || t.includes('Library ID')
        || /^게재 시작|^Started running/.test(t);

    // 1) 페이지 프로필 링크 우선: facebook.com/{username} 형태
    const pageLinks = cardEl.querySelectorAll('a[href*="facebook.com"]');
    for (const a of pageLinks) {
      const href = a.href || '';
      if (!/facebook\.com\/(?!ads\/library|business|help|policies|legal|privacy|policy|sharer|dialog)/i.test(href)) continue;
      const t = (a.textContent || '').trim();
      if (t.length > 1 && t.length < 80 && !isSkip(t)) {
        ad.page_name = t;
        break;
      }
    }
    // 2) strong/h3 (뱃지 제외)
    if (!ad.page_name) {
      const strongs = cardEl.querySelectorAll('strong, h3');
      for (const el of strongs) {
        const t = (el.textContent || '').trim();
        if (t.length > 1 && t.length < 100 && !isSkip(t)) {
          ad.page_name = t;
          break;
        }
      }
    }
    // 3) 모든 링크 fallback
    if (!ad.page_name) {
      const links = cardEl.querySelectorAll('a');
      for (const a of links) {
        const t = (a.textContent || '').trim();
        if (t.length > 1 && t.length < 80 && !isSkip(t)) {
          ad.page_name = t;
          break;
        }
      }
    }

    // 시작일/종료일 추출
    // 활성 광고: "2025. 10. 22.에 게재 시작함"
    // 비활성 광고: "2025. 10. 28.~2025. 11. 1." (시작 ~ 종료)
    // 영문: "Sep 29, 2025" / "Started running on Sep 29, 2025"
    const dateKoActive = fullText.match(/(\\d{4})\\. (\\d{1,2})\\. (\\d{1,2})\\.에 게재/);
    const dateKoInactive = fullText.match(/(\\d{4})\\. (\\d{1,2})\\. (\\d{1,2})\\.~(\\d{4})\\. (\\d{1,2})\\. (\\d{1,2})\\./);
    const dateKoSimple = fullText.match(/(\\d{4})\\. (\\d{1,2})\\. (\\d{1,2})\\./);
    const dateKo2 = fullText.match(/(\\d{4})년\\s*(\\d{1,2})월\\s*(\\d{1,2})일/);
    const dateEn = fullText.match(/([A-Z][a-z]{2})\\s+(\\d{1,2}),?\\s*(\\d{4})/);
    const months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
    const pad = (n) => String(n).padStart(2,'0');
    if (dateKoActive) {
      ad.start_date = dateKoActive[1] + '-' + pad(dateKoActive[2]) + '-' + pad(dateKoActive[3]);
    } else if (dateKoInactive) {
      ad.start_date = dateKoInactive[1] + '-' + pad(dateKoInactive[2]) + '-' + pad(dateKoInactive[3]);
      ad.end_date   = dateKoInactive[4] + '-' + pad(dateKoInactive[5]) + '-' + pad(dateKoInactive[6]);
    } else if (dateKoSimple) {
      // fallback: 첫 한국식 날짜 (활성/비활성 패턴 미일치 케이스)
      ad.start_date = dateKoSimple[1] + '-' + pad(dateKoSimple[2]) + '-' + pad(dateKoSimple[3]);
    } else if (dateKo2) {
      ad.start_date = dateKo2[1] + '-' + pad(dateKo2[2]) + '-' + pad(dateKo2[3]);
    } else if (dateEn) {
      ad.start_date = dateEn[3] + '-' + (months[dateEn[1]]||'01') + '-' + pad(dateEn[2]);
    }

    // 캡션
    const skipTexts = new Set([ad.page_name, '광고 세부 정보 보기', 'See ad details', 'Sponsored', '더 보기', 'See more', '활성', '비활성']);
    const textBlocks = [];
    cardEl.querySelectorAll('div, span, p').forEach(n => {
      let text = '';
      for (const child of n.childNodes) {
        if (child.nodeType === 3) text += child.textContent;
        else if (child.nodeType === 1 && ['span','em','strong','b','i','br','a'].includes(child.tagName.toLowerCase())) {
          text += child.textContent;
        }
      }
      text = text.replace(/\\s+/g, ' ').trim();
      if (text.length > 15 && text.length < 3000 && !skipTexts.has(text)
          && !text.match(/^\\d{4}[\\.년]/) && !text.match(/^Started running/)
          && !text.includes('라이브러리 ID') && !text.includes('Library ID')) {
        if (!textBlocks.some(t => t.includes(text) || text.includes(t))) textBlocks.push(text);
      }
    });
    if (textBlocks.length > 0) {
      textBlocks.sort((a, b) => b.length - a.length);
      ad.caption = textBlocks[0];
    }

    // 미디어
    const images = [];
    cardEl.querySelectorAll('img').forEach(img => {
      const src = img.src || '';
      if (!src || src.startsWith('data:')) return;
      const rect = img.getBoundingClientRect();
      if (rect.width < 50 && rect.height < 50) return;
      if (src.includes('emoji') || src.includes('icon') || src.includes('rsrc.php') || src.includes('static.xx')) return;
      if (src.includes('scontent') || src.includes('fbcdn')) {
        images.push({ url: src, width: rect.width, height: rect.height });
        ad.media_urls.push({ type: 'image', url: src });
      }
    });

    let hasVideo = false;
    cardEl.querySelectorAll('video').forEach(video => {
      hasVideo = true;
      const src = video.src || (video.querySelector('source') || {}).src || '';
      const poster = video.poster || '';
      if (src) { ad.video_url = src; ad.media_urls.push({ type: 'video', url: src }); }
      if (poster) { ad.video_thumbnail = poster; }
    });

    if (!hasVideo) {
      const playBtn = cardEl.querySelector('[aria-label*="재생"], [aria-label*="Play"], [aria-label*="play"]');
      if (playBtn) {
        hasVideo = true;
        if (images.length > 0) {
          images.sort((a, b) => (b.width * b.height) - (a.width * a.height));
          ad.video_thumbnail = images[0].url;
        }
      }
    }

    // 캐러셀
    let isCarousel = false;
    const arrowBtn = cardEl.querySelector('[aria-label*="다음"], [aria-label*="이전"], [aria-label*="Next"], [aria-label*="Previous"]');
    const dots = cardEl.querySelectorAll('[role="tablist"] [role="tab"]');
    if (arrowBtn || dots.length >= 2) isCarousel = true;
    if (!isCarousel && images.filter(i => i.width >= 200 && i.height >= 200).length >= 2) isCarousel = true;

    if (images.length > 0) {
      images.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      if (hasVideo) { if (!ad.video_thumbnail) ad.video_thumbnail = images[0].url; }
      else ad.banner_url = images[0].url;
    }

    ad.media_type = hasVideo ? 'video' : isCarousel ? 'carousel' : 'image';

    // 링크
    cardEl.querySelectorAll('a[href]').forEach(a => {
      const href = a.href || '';
      if (!href || href.startsWith('javascript')) return;
      if (href.includes('instagram.com')) { if (!ad.instagram_url) ad.instagram_url = href; return; }
      if (href.includes('facebook.com') || href.includes('fb.com')) return;
      ad.link_url = href;
    });

    // 플랫폼
    const pt = fullText.toLowerCase();
    if (pt.includes('facebook')) ad.platforms.push('facebook');
    if (pt.includes('instagram')) ad.platforms.push('instagram');
    if (pt.includes('messenger')) ad.platforms.push('messenger');

    ads.push(ad);
  }
  return ads;
}
"""

GET_EXPECTED_COUNT_JS = """
() => {
  if (!document.body) return 0;
  const body = document.body.textContent || '';
  let m = body.match(/결과\\s*[~약]?\\s*([\\d,]+)\\s*개/);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  m = body.match(/[~About]*\\s*([\\d,]+)\\s*results/i);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  return 0;
}
"""


class AdLibraryScraper:
    """Facebook Ad Library DOM 스크래퍼"""

    def __init__(self, headless: bool = True, output_dir: str = "./output", user_data_dir: str = "", proxy: str = ""):
        self.headless = headless
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.collected = {}  # id → ad dict (중복 제거)
        # 브라우저 프로필 경로 (로그인 세션 유지)
        self.user_data_dir = user_data_dir or str(Path(__file__).parent.parent / ".browser_profile")
        # 프록시 (예: http://user:pass@host:port)
        self.proxy = proxy

    async def scrape(
        self,
        keyword: str,
        country: str = "KR",
        max_ads: int = 0,
    ) -> list[dict]:
        """키워드로 광고 수집 (정렬 전환 + 줌 조절 + 중복 제거)"""

        sorts = [
            ("total_impressions", "desc", "노출높은순"),
        ]
        zooms = [100]  # 100%로 수집 (200%는 필요시에만)

        async with async_playwright() as p:
            # ── UA / 헤더 랜덤 선택 ──
            ua, ctx_headers, nav_headers = _pick_ua_and_headers()
            logger.info(f"UA: {ua[:60]}...")

            # ── 브라우저 런치 옵션 ──
            launch_opts = {"headless": self.headless}
            if self.proxy:
                launch_opts["proxy"] = _parse_proxy(self.proxy)
                logger.info(f"프록시: {self.proxy}")

            browser = await p.chromium.launch(**launch_opts)
            context = await browser.new_context(
                viewport={"width": 1400, "height": 900},
                locale="ko-KR",
                user_agent=ua,
                extra_http_headers=ctx_headers,
            )

            # ── 스텔스: 자동화 탐지 우회 ──
            await context.add_init_script(STEALTH_JS)

            # ── 첫 navigation에만 sec-fetch-* 헤더 주입 ──
            nav_done = {"value": False}

            async def _inject_nav_headers(route):
                if not nav_done["value"]:
                    nav_done["value"] = True
                    await route.continue_(headers={**route.request.headers, **nav_headers})
                else:
                    await route.continue_()

            page = await context.new_page()
            await page.route("**/ads/library/**", _inject_nav_headers)

            import time as _time

            total_start = _time.time()

            for sort_mode, sort_dir, sort_label in sorts:
                url = self._build_url(keyword, country, sort_mode, sort_dir)

                # 페이지 로드 시간 측정
                t0 = _time.time()
                logger.info(f"[{sort_label}] 페이지 로드...")

                goto_timeout = 120000 if self.proxy else 60000
                await page.goto(url, wait_until="domcontentloaded", timeout=goto_timeout)
                try:
                    await page.wait_for_function(
                        "() => document.body && (document.body.textContent.includes('게재 시작') || document.body.textContent.includes('Library ID'))",
                        timeout=20000,
                    )
                except:
                    logger.warning("  광고 카드 대기 타임아웃")
                post_load_ms = 2500 if self.proxy else 1500
                await page.wait_for_timeout(_random_delay(post_load_ms, 500))

                t_load = _time.time() - t0
                logger.info(f"  페이지 로드: {t_load:.1f}초")

                expected = await page.evaluate(GET_EXPECTED_COUNT_JS)
                if expected:
                    logger.info(f"  예상 결과: ~{expected}개")

                # 줌 100%로 수집
                t1 = _time.time()
                before = len(self.collected)
                await self._scroll_and_extract(page, max_ads, expected)
                gained = len(self.collected) - before
                logger.info(f"  100%: +{gained}개 ({_time.time() - t1:.1f}초) (전체: {len(self.collected)})")

                # 예상 대비 70% 미만이면 줌 200%로 추가 수집 시도
                target = max_ads if max_ads > 0 else expected
                if target and len(self.collected) < target * 0.7:
                    logger.info(f"  부족 ({len(self.collected)}/{target}) → 줌 200% 추가 수집")
                    await page.evaluate("document.body.style.zoom = '200%'")
                    await page.wait_for_timeout(_random_delay(800, 300))
                    await page.evaluate("window.scrollTo({top: 0})")
                    await page.wait_for_timeout(_random_delay(800, 300))

                    t2 = _time.time()
                    before2 = len(self.collected)
                    await self._scroll_and_extract(page, max_ads, expected)
                    gained2 = len(self.collected) - before2
                    logger.info(f"  200%: +{gained2}개 ({_time.time() - t2:.1f}초) (전체: {len(self.collected)})")
                    await page.evaluate("document.body.style.zoom = '100%'")

                t_sort = _time.time() - t0
                logger.info(f"[{sort_label}] 완료: {len(self.collected)}개 ({t_sort:.1f}초)")

            total_time = _time.time() - total_start
            logger.info(f"총 소요 시간: {total_time:.1f}초")

            await browser.close()

        ads = list(self.collected.values())
        # collected_at 추가
        now = datetime.now().isoformat()
        for ad in ads:
            ad["collected_at"] = now

        logger.info(f"수집 완료: 총 {len(ads)}개 (중복 제거됨)")
        return ads

    async def scrape_single_by_id(self, ad_id: str) -> dict | None:
        """단일 ad_id로 광고 1개 fetch — /ads/library/?id={ad_id} 페이지에서 추출."""
        if not (ad_id or "").strip():
            return None
        url = f"https://www.facebook.com/ads/library/?id={ad_id}"

        async with async_playwright() as p:
            ua, ctx_headers, nav_headers = _pick_ua_and_headers()
            launch_opts = {"headless": self.headless}
            if self.proxy:
                launch_opts["proxy"] = _parse_proxy(self.proxy)
            browser = await p.chromium.launch(**launch_opts)
            context = await browser.new_context(
                viewport={"width": 1400, "height": 900},
                locale="ko-KR",
                user_agent=ua,
                extra_http_headers=ctx_headers,
            )
            await context.add_init_script(STEALTH_JS)
            nav_done = {"value": False}

            async def _inject_nav_headers(route):
                if not nav_done["value"]:
                    nav_done["value"] = True
                    await route.continue_(headers={**route.request.headers, **nav_headers})
                else:
                    await route.continue_()

            page = await context.new_page()
            await page.route("**/ads/library/**", _inject_nav_headers)
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                try:
                    await page.wait_for_function(
                        "() => document.body && (document.body.textContent.includes('게재 시작') || document.body.textContent.includes('Library ID'))",
                        timeout=20000,
                    )
                except Exception:
                    logger.warning("[scrape_single] 광고 카드 대기 타임아웃")
                # 비디오 로드 대기
                await page.wait_for_timeout(2000)
                # 비디오 src 추출 위해 hover/play 시뮬레이션 (FB가 hover 시에만 video.src 설정하는 경우)
                try:
                    await page.evaluate("""
                        () => {
                            for (const v of document.querySelectorAll('video')) {
                                try { v.play(); } catch(e) {}
                            }
                        }
                    """)
                    await page.wait_for_timeout(1500)
                except Exception:
                    pass
                ads = await page.evaluate(PARSE_ADS_JS)
            finally:
                await browser.close()

        if not ads:
            return None
        # ad_id로 정확 매칭, 없으면 첫 항목
        match = next((a for a in ads if str(a.get("id")) == str(ad_id)), None)
        ad = match or ads[0]
        ad["collected_at"] = datetime.now().isoformat()
        return ad

    async def _scroll_and_extract(self, page, max_ads: int, expected: int = 0):
        """스크롤하며 광고 추출"""
        no_new = 0
        max_empty = 5  # 연속 빈 스크롤 허용 횟수 (lazy load 대응)

        while True:
            if max_ads > 0 and len(self.collected) >= max_ads:
                break

            before = len(self.collected)

            # 추출
            ads = await page.evaluate(PARSE_ADS_JS)
            for ad in ads:
                ad_id = ad.get("id", "")
                if ad_id and ad_id not in self.collected:
                    self.collected[ad_id] = ad

            new_count = len(self.collected) - before

            if new_count > 0:
                no_new = 0
                logger.info(f"    +{new_count} (전체: {len(self.collected)})")
            else:
                no_new += 1

            # 바닥 도달 체크
            at_bottom = await page.evaluate(
                "(window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 100)"
            )

            # 종료 조건: 바닥 + 빈 스크롤 2회, 또는 빈 스크롤이 max_empty 초과
            if at_bottom and no_new >= 2:
                break
            if no_new >= max_empty:
                break

            # 빈 스크롤이면 더 오래 대기 (lazy load 기다리기)
            if no_new > 0 and not at_bottom:
                await page.wait_for_timeout(_random_delay(1500, 500))

            # 스크롤 속도·거리 랜덤화 (봇 패턴 회피)
            scroll_ratio = round(random.uniform(0.55, 0.85), 2)
            await page.evaluate(f"window.scrollBy({{top: window.innerHeight * {scroll_ratio}, behavior: 'smooth'}})")
            await page.wait_for_timeout(_random_delay(1800, 600))

    def _build_url(self, keyword: str, country: str, sort_mode: str, sort_dir: str) -> str:
        params = {
            "active_status": "all",
            "ad_type": "all",
            "country": country,
            "q": keyword,
            "search_type": "keyword_unordered",
            "media_type": "all",
            "sort_data[mode]": sort_mode,
            "sort_data[direction]": sort_dir,
        }
        return f"https://www.facebook.com/ads/library/?{urlencode(params)}"

    def save_json(self, ads: list[dict], keyword: str) -> str:
        safe = re.sub(r'[<>:"/\\|?*\s]', "_", keyword)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = self.output_dir / f"scrape_{safe}_{ts}.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(ads, f, ensure_ascii=False, indent=2)
        return str(path)

    def save_csv(self, ads: list[dict], keyword: str) -> str:
        import csv
        safe = re.sub(r'[<>:"/\\|?*\s]', "_", keyword)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = self.output_dir / f"scrape_{safe}_{ts}.csv"

        headers = [
            "id", "page_name", "media_type", "start_date", "caption",
            "video_thumbnail", "video_url", "banner_url",
            "ad_title", "ad_description", "snapshot_url",
            "link_url", "instagram_url", "platforms", "collected_at",
        ]

        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
            writer.writeheader()
            for ad in ads:
                row = dict(ad)
                if isinstance(row.get("platforms"), list):
                    row["platforms"] = " | ".join(row["platforms"])
                writer.writerow(row)

        return str(path)


async def login():
    """Facebook 로그인용 브라우저 열기 (최초 1회)"""
    profile_dir = str(Path(__file__).parent.parent / ".browser_profile")
    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            profile_dir,
            headless=False,
            viewport={"width": 1400, "height": 900},
            locale="ko-KR",
        )
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto("https://www.facebook.com/login")
        print("\n브라우저에서 Facebook 로그인하세요.")
        print("로그인 완료 후 이 터미널에서 Enter를 누르세요...")
        input()
        await context.close()
        print("로그인 세션 저장 완료. 이제 scraper를 실행하면 로그인 없이 수집됩니다.")


async def main():
    import argparse
    parser = argparse.ArgumentParser(description="Facebook Ad Library 스크래퍼")
    parser.add_argument("--keyword", "-k", help="검색 키워드")
    parser.add_argument("--country", "-c", default="KR", help="국가 코드")
    parser.add_argument("--max", "-m", type=int, default=0, help="최대 수집 수 (0=전체)")
    parser.add_argument("--headless", action="store_true", default=True, help="헤드리스 모드")
    parser.add_argument("--show", action="store_true", help="브라우저 표시")
    parser.add_argument("--output", "-o", default="./output", help="출력 디렉토리")
    parser.add_argument("--proxy", default="", help="프록시 서버 (예: http://host:port)")
    parser.add_argument("--login", action="store_true", help="Facebook 로그인 (최초 1회)")
    args = parser.parse_args()

    if args.login:
        await login()
        return

    if not args.keyword:
        parser.error("--keyword 또는 --login 필요")
        return

    from .config import PROXY_SERVER
    proxy = args.proxy or PROXY_SERVER

    scraper = AdLibraryScraper(
        headless=not args.show,
        output_dir=args.output,
        proxy=proxy,
    )

    ads = await scraper.scrape(
        keyword=args.keyword,
        country=args.country,
        max_ads=args.max,
    )

    if ads:
        json_path = scraper.save_json(ads, args.keyword)
        csv_path = scraper.save_csv(ads, args.keyword)
        print(f"\nJSON: {json_path}")
        print(f"CSV:  {csv_path}")
        print(f"총 {len(ads)}개 광고 수집 (중복 제거)")
    else:
        print("수집된 광고 없음")


if __name__ == "__main__":
    asyncio.run(main())
