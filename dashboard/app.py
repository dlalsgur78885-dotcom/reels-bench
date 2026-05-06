"""
Reels Trend Dashboard
실행: streamlit run dashboard/app.py
"""

import os
import re
import sys
import json
import base64
import tempfile
import subprocess
import logging
from datetime import datetime, timedelta
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import requests
from dotenv import load_dotenv

# .env 로드
ENV_PATH = Path(__file__).parent.parent / ".env"
load_dotenv(ENV_PATH)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
HIKER_API_KEY = os.getenv("HIKER_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# ffmpeg
try:
    import imageio_ffmpeg
    FFMPEG_PATH = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    FFMPEG_PATH = "ffmpeg"

try:
    sys.path.insert(0, str(Path(__file__).parent.parent))
    import gramsnap_util
except ImportError:
    gramsnap_util = None

SUPABASE_HEADERS = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Content-Type": "application/json"
}


# =============================================
# 썸네일 프록시 (Instagram CDN URL 만료 대응)
# =============================================
_thumb_cache = {}  # {url: data_uri}


def _fetch_one_thumb(url):
    """단일 썸네일을 가져와 base64 data URI로 변환"""
    try:
        r = requests.get(url, timeout=5, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        })
        if r.status_code == 200 and len(r.content) > 500:
            b64 = base64.b64encode(r.content).decode()
            ct = r.headers.get("content-type", "image/jpeg")
            return f"data:{ct};base64,{b64}"
    except Exception:
        pass
    return ""


def prefetch_thumbs(urls):
    """썸네일 목록을 병렬로 한번에 가져와 캐시에 저장"""
    todo = [u for u in urls if u and u not in _thumb_cache]
    if not todo:
        return
    with ThreadPoolExecutor(max_workers=20) as ex:
        results = ex.map(_fetch_one_thumb, todo)
    for url, result in zip(todo, results):
        _thumb_cache[url] = result


def thumb_src(url):
    """썸네일 URL → 표시 가능한 src (캐시 → 원본 폴백)"""
    if not url:
        return ""
    if url in _thumb_cache:
        return _thumb_cache[url] or url
    # 캐시 미스 시 단건 fetch
    result = _fetch_one_thumb(url)
    _thumb_cache[url] = result
    return result if result else url


# =============================================
# Supabase API 헬퍼
# =============================================
@st.cache_data(ttl=600)
def sb_get(table, params=""):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=SUPABASE_HEADERS, timeout=10)
    return r.json() if r.status_code == 200 else []


@st.cache_data(ttl=600)
def load_bench_data():
    """벤치마크 페이지 데이터를 병렬로 한번에 로드 (10분 캐시)"""
    with ThreadPoolExecutor(max_workers=5) as ex:
        f_reels = ex.submit(sb_get, "reels", "select=shortcode,url,author,account_category,collected_at&order=collected_at.desc&limit=100")
        f_meta = ex.submit(sb_get, "reels_metadata", "select=shortcode,play_count,like_count,comment_count,video_duration,thumbnail_url,video_url,caption_text,author_username,author_full_name,music_artist,music_title,taken_at&limit=10000")
        f_trans = ex.submit(sb_get, "reels_transcripts", "select=shortcode,transcript,duration_seconds,language&limit=10000")
        f_opus = ex.submit(sb_get, "opus_analyses", "select=shortcode,analysis,analyzed_at&limit=10000")
        f_cmts = ex.submit(sb_get, "reels_comments", "select=shortcode,comment_text,comment_author,comment_likes&limit=10000")

    return f_reels.result(), f_meta.result(), f_trans.result(), f_opus.result(), f_cmts.result()

def sb_post(table, data):
    h = {**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates"}
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=h, json=data)
    return r.status_code in [200, 201]


# =============================================
# 메타데이터 수집 (GramSnap 우선, HikerAPI 폴백)
# =============================================
def fetch_metadata(shortcode, username=None):
    # GramSnap 시도
    if gramsnap_util and username:
        try:
            post = gramsnap_util.find_by_shortcode(username, shortcode)
            if post:
                return {
                    "video_url": post.video_url,
                    "play_count": post.video_views,
                    "view_count": post.video_views,
                    "like_count": post.likes,
                    "comment_count": post.comments,
                    "caption_text": post.caption,
                    "thumbnail_url": post.display_url,
                    "user": {"username": username},
                    "taken_at": post.timestamp,
                }
        except Exception:
            pass

    # HikerAPI 폴백
    if HIKER_API_KEY:
        r = requests.get(
            "https://api.hikerapi.com/v1/media/by/code",
            params={"code": shortcode},
            headers={"accept": "application/json", "x-access-key": HIKER_API_KEY},
            timeout=30
        )
        if r.status_code == 200:
            return r.json()

    return None


def save_metadata(shortcode, data):
    row = {
        "shortcode": shortcode,
        "play_count": data.get("play_count") or data.get("view_count"),
        "like_count": data.get("like_count"),
        "comment_count": data.get("comment_count"),
        "video_url": data.get("video_url"),
        "video_duration": data.get("video_duration"),
        "thumbnail_url": data.get("thumbnail_url") or (data.get("image_versions", [{}])[0].get("url") if isinstance(data.get("image_versions"), list) and data.get("image_versions") else None),
        "caption_text": data.get("caption_text"),
        "author_username": data.get("user", {}).get("username") if isinstance(data.get("user"), dict) else None,
        "author_full_name": data.get("user", {}).get("full_name") if isinstance(data.get("user"), dict) else None,
        "author_follower_count": data.get("user", {}).get("follower_count") if isinstance(data.get("user"), dict) else None,
        "taken_at": data.get("taken_at") if isinstance(data.get("taken_at"), str) else (datetime.utcfromtimestamp(data["taken_at"]).isoformat() if data.get("taken_at_ts") or data.get("taken_at") else None),
    }

    # 음악 정보
    clips = data.get("clips_metadata", {})
    if isinstance(clips, dict):
        music = clips.get("music_info", {})
        if isinstance(music, dict):
            asset = music.get("music_asset_info", {})
            row["music_artist"] = asset.get("display_artist")
            row["music_title"] = asset.get("title")

    return sb_post("reels_metadata", row)


# =============================================
# HikerAPI: 댓글 수집
# =============================================
def fetch_comments_playwright(shortcode):
    """비로그인 Playwright로 인스타그램 댓글 스크래핑 (Windows 호환 스레드 격리)"""
    result_holder = []

    def _run_in_thread():
        import asyncio
        # Windows: ProactorEventLoop 필요
        if sys.platform == "win32":
            loop = asyncio.ProactorEventLoop()
            asyncio.set_event_loop(loop)

        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            return

        # 댓글 퍼머링크(/p/{sc}/c/{id}/) 기반 파서
        extract_js = r"""(shortcode) => {
    const results = [];
    const seen = new Set();
    const NOISE = /^(좋아요|답글 달기|번역 보기|로그인|가입하기|Meta|소개|블로그|채용|도움말|API|개인정보|약관|위치|Threads|한국어|©).*$/;
    const TIME_RE = /^\d+[초분시일주월년](전)?$|^\d+[smhdwy]$/;

    // 방법1: 댓글 permalink 링크 기반
    const commentLinks = document.querySelectorAll('a[href*="/c/"]');
    for (const a of commentLinks) {
        const href = a.getAttribute('href') || '';
        if (!href.includes('/p/' + shortcode + '/c/')) continue;
        // 댓글 컨테이너: permalink 위로 올라가며 username 찾기
        let container = a;
        for (let i = 0; i < 6; i++) {
            if (container.parentElement) container = container.parentElement;
        }
        const full = container.innerText || '';
        const lines = full.split('\n').map(l => l.replace(/\u00a0/g, '').trim()).filter(Boolean);
        if (lines.length < 2) continue;
        const author = lines[0];
        if (!/^[a-zA-Z0-9_.]+$/.test(author)) continue;
        const textLines = lines.slice(1).filter(l => !TIME_RE.test(l) && !NOISE.test(l));
        const text = textLines.join(' ').trim();
        if (text.length >= 1 && !seen.has(author + '|' + text.slice(0, 30))) {
            seen.add(author + '|' + text.slice(0, 30));
            results.push({ author, text });
        }
    }

    // 방법2: span[dir=auto] > a[href=/username/] 기반 (폴백)
    if (results.length === 0) {
        const spans = document.querySelectorAll('span[dir=auto]');
        for (const span of spans) {
            const a = span.querySelector('a[href]');
            if (!a) continue;
            const href = a.getAttribute('href') || '';
            const m = href.match(/^\/([a-zA-Z0-9_.]+)\/$/);
            if (!m) continue;
            const username = m[1];
            const spanText = span.innerText || '';
            if (!spanText.startsWith(username) || spanText.length <= username.length + 3) continue;
            const rest = spanText.slice(username.length);
            const lines = rest.split('\n').map(l => l.replace(/\u00a0/g, '').trim())
                .filter(l => l.length > 0 && !TIME_RE.test(l) && !NOISE.test(l));
            const text = lines.join(' ').trim();
            // 캡션 제외: 해시태그 3개 이상이면 캡션으로 간주
            if ((text.match(/#/g) || []).length >= 3) continue;
            if (text.length >= 1 && !seen.has(username + '|' + text.slice(0, 30))) {
                seen.add(username + '|' + text.slice(0, 30));
                results.push({ author: username, text });
            }
        }
    }
    return results;
}"""

        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                ctx = browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                    locale="ko-KR",
                )
                page = ctx.new_page()
                page.goto(f"https://www.instagram.com/reel/{shortcode}/", wait_until="domcontentloaded", timeout=20000)
                page.wait_for_timeout(4000)

                # 로그인 팝업 닫기 시도
                try:
                    close_btn = page.locator('[role="dialog"] button:has-text("닫기"), [role="dialog"] [aria-label="닫기"]')
                    if close_btn.count() > 0:
                        close_btn.first.click()
                        page.wait_for_timeout(1000)
                except Exception:
                    pass

                # 댓글 더보기 클릭 시도
                for _ in range(3):
                    try:
                        more_btn = page.locator('button:has-text("댓글 모두 보기"), button:has-text("댓글"), span:has-text("댓글 모두 보기")')
                        if more_btn.count() > 0:
                            more_btn.first.click()
                            page.wait_for_timeout(2000)
                    except Exception:
                        break

                # 스크롤로 추가 댓글 로드
                for _ in range(3):
                    page.evaluate("window.scrollBy(0, 500)")
                    page.wait_for_timeout(1000)

                raw = page.evaluate(extract_js, shortcode)
                browser.close()

            for c in raw:
                result_holder.append({
                    "shortcode": shortcode,
                    "comment_text": c.get("text", ""),
                    "comment_author": c.get("author", ""),
                    "comment_likes": 0,
                })
        except Exception as e:
            logger.warning("Playwright 댓글 수집 실패: %s", e)

    import threading
    t = threading.Thread(target=_run_in_thread, daemon=True)
    t.start()
    t.join(timeout=60)
    return result_holder


def fetch_comments_hiker(shortcode):
    """HikerAPI로 릴스 댓글 수집 (by/code → pk → comments)"""
    if not HIKER_API_KEY:
        return []

    hiker_headers = {"accept": "application/json", "x-access-key": HIKER_API_KEY}

    # 1) shortcode → media pk 조회
    media_id = None
    try:
        r = requests.get(
            "https://api.hikerapi.com/v1/media/by/code",
            params={"code": shortcode},
            headers=hiker_headers,
            timeout=30,
        )
        if r.status_code == 200:
            media_id = r.json().get("pk")
    except Exception:
        pass

    if not media_id:
        return []

    # 2) pk → 댓글 조회
    comments = []
    try:
        r = requests.get(
            "https://api.hikerapi.com/v1/media/comments",
            params={"id": media_id},
            headers=hiker_headers,
            timeout=30,
        )
        if r.status_code == 200:
            data = r.json()
            items = data.get("comments", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
            for c in items:
                comments.append({
                    "shortcode": shortcode,
                    "comment_text": c.get("text", ""),
                    "comment_author": c.get("user", {}).get("username", "") if isinstance(c.get("user"), dict) else str(c.get("user_id", "")),
                    "comment_likes": c.get("comment_like_count") or c.get("likes") or 0,
                })
    except Exception:
        pass
    return comments


def save_comments(shortcode, comments):
    """댓글 목록을 Supabase에 batch upsert로 저장"""
    if not comments:
        return 0
    h = {**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates"}
    r = requests.post(f"{SUPABASE_URL}/rest/v1/reels_comments", headers=h, json=comments)
    if r.status_code in [200, 201]:
        return len(comments)
    logger.warning("댓글 batch 저장 실패: %s", r.text)
    return 0


# =============================================
# 영상 다운로드 + 프레임/오디오 추출 헬퍼
# =============================================
def _download_and_extract(video_url, tmpdir):
    """영상 다운로드 → 1초 단위 프레임 + 오디오 추출"""
    video_path = os.path.join(tmpdir, "reel.mp4")
    audio_path = os.path.join(tmpdir, "audio.mp3")
    frames_dir = os.path.join(tmpdir, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    r = requests.get(video_url, stream=True, timeout=60)
    with open(video_path, "wb") as f:
        for chunk in r.iter_content(8192):
            f.write(chunk)

    # 1초 단위 프레임 추출
    subprocess.run([FFMPEG_PATH, "-i", video_path, "-vf", "fps=1", "-q:v", "2",
                    os.path.join(frames_dir, "frame_%04d.jpg"), "-y"], capture_output=True)

    # 오디오 추출
    subprocess.run([FFMPEG_PATH, "-i", video_path, "-vn", "-acodec", "libmp3lame", audio_path, "-y"],
                   capture_output=True)

    frames = sorted(Path(frames_dir).glob("frame_*.jpg"))
    return video_path, audio_path, [str(f) for f in frames]


def _whisper_transcribe(audio_path, shortcode):
    """Whisper로 대본 추출 + Supabase 저장"""
    if not os.path.exists(audio_path) or os.path.getsize(audio_path) == 0:
        return None
    with open(audio_path, "rb") as f:
        wr = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files={"file": ("audio.mp3", f, "audio/mpeg")},
            data={"model": "whisper-1", "language": "ko", "response_format": "verbose_json"},
            timeout=120
        )
    if wr.status_code != 200:
        return None
    wd = wr.json()
    text = wd.get("text", "")

    # Whisper 환각 필터: 음성 없는 영상에서 랜덤 텍스트 생성하는 문제 대응
    _HALLUCINATION_PATTERNS = [
        r"(?i)wriggle", r"(?i)dimension of madness", r"(?i)MoistCr1tikal",
        r"(?i)subscribe", r"(?i)thank you for watching",
        r"(?i)amara\.org", r"(?i)subtitles by", r"(?i)caption",
        r"(?i)sil\b", r"(?i)you$",
    ]
    segments = wd.get("segments", [])
    # 환각 판별: (1) 알려진 패턴 매칭 (2) 세그먼트의 avg_logprob이 매우 낮음 (3) no_speech_prob이 높음
    is_hallucination = False
    if segments:
        avg_no_speech = sum(s.get("no_speech_prob", 0) for s in segments) / len(segments)
        avg_logprob = sum(s.get("avg_logprob", 0) for s in segments) / len(segments)
        if avg_no_speech > 0.5 or avg_logprob < -1.0:
            is_hallucination = True
    if any(re.search(p, text) for p in _HALLUCINATION_PATTERNS):
        is_hallucination = True
    # 한글이 거의 없는데 language=ko로 요청한 경우
    ko_chars = len(re.findall(r'[\uAC00-\uD7A3]', text))
    if len(text) > 10 and ko_chars < len(text) * 0.1:
        is_hallucination = True

    if is_hallucination:
        logger.info("[Whisper] 환각 감지 → 대본 없음 처리: %s", text[:80])
        text = ""
        segments = []

    transcript_data = {
        "transcript": text,
        "duration_seconds": wd.get("duration", 0),
        "language": wd.get("language", "ko"),
        "segments": segments,
    }
    if text:
        sb_post("reels_transcripts", {
            "shortcode": shortcode,
            "transcript": transcript_data["transcript"],
            "language": transcript_data["language"],
            "duration_seconds": transcript_data["duration_seconds"],
        })
    return transcript_data


def _analyze_audio_emotion(audio_path):
    """음성 초별 감정 분석 (Whisper Large V3 SER + librosa 피치/볼륨)"""
    try:
        import librosa
        import numpy as np
        from transformers import pipeline as hf_pipeline

        EMOTION_LABELS = {
            "happy": "😊 기쁨",
            "sad": "😢 슬픔",
            "angry": "😠 분노",
            "fearful": "😨 두려움",
            "disgusted": "🤢 혐오",
            "surprised": "😲 놀람",
            "neutral": "😐 중립",
        }

        ser = hf_pipeline(
            "audio-classification",
            model="firdhokk/speech-emotion-recognition-with-openai-whisper-large-v3",
            device=-1,
        )

        y_16k, _ = librosa.load(audio_path, sr=16000)
        y_22k, sr_22k = librosa.load(audio_path, sr=22050)
        duration = librosa.get_duration(y=y_22k, sr=sr_22k)
        total_secs = int(duration)
        if total_secs == 0:
            return {}

        try:
            import parselmouth
            snd = parselmouth.Sound(audio_path)
            pitch_obj = snd.to_pitch(time_step=0.1)
            use_praat = True
        except ImportError:
            use_praat = False

        results = {}
        for sec in range(1, total_secs + 1):
            start, end = sec - 1, sec
            seg_22k = y_22k[int(start * sr_22k):min(int(end * sr_22k), len(y_22k))]
            if len(seg_22k) == 0:
                continue

            rms = float(np.sqrt(np.mean(seg_22k ** 2)))
            is_silence = rms < 0.005

            if use_praat:
                pitches = []
                for t in np.arange(start, end, 0.1):
                    p = pitch_obj.get_value_at_time(t)
                    if p and not np.isnan(p):
                        pitches.append(p)
                avg_pitch = float(np.mean(pitches)) if pitches else 0
            else:
                f0, _, _ = librosa.pyin(seg_22k, fmin=50, fmax=500, sr=sr_22k)
                valid = f0[~np.isnan(f0)] if f0 is not None else []
                avg_pitch = float(np.mean(valid)) if len(valid) > 0 else 0

            ser_start = max(0, int((start - 1) * 16000))
            ser_end = min(int((end + 1) * 16000), len(y_16k))
            seg_16k = y_16k[ser_start:ser_end]

            if is_silence:
                emotion_key, emotion_label, confidence = "pause", "⏸ 멈춤", 1.0
            elif len(seg_16k) > 1600:
                pred = ser({"raw": seg_16k.astype(np.float32), "sampling_rate": 16000})
                top = pred[0]
                emotion_key = top["label"]
                emotion_label = EMOTION_LABELS.get(emotion_key, f"❓ {emotion_key}")
                confidence = round(top["score"], 2)
            else:
                emotion_key, emotion_label, confidence = "neutral", "😐 중립", 0

            results[sec] = {
                "pitch": round(avg_pitch, 1),
                "volume": round(rms * 1000, 1),
                "silence": is_silence,
                "emotion": emotion_key,
                "label": emotion_label,
                "confidence": confidence,
            }
        return results
    except Exception as e:
        logger.warning("음성 감정 분석 실패: %s", e)
        return {}


def _ocr_frame_subtitles(frame_paths):
    """프레임 하단 30% 영역을 크롭 → Gemini Vision으로 자막 텍스트 일괄 추출"""
    if not frame_paths or not GEMINI_API_KEY:
        return {}

    try:
        from PIL import Image
        import io
    except ImportError:
        return {}

    # 하단 30% 크롭 이미지들을 base64로 변환
    crop_b64_list = []
    for fp in frame_paths:
        try:
            img = Image.open(fp)
            w, h = img.size
            cropped = img.crop((0, int(h * 0.70), w, h))
            buf = io.BytesIO()
            cropped.save(buf, format="JPEG", quality=80)
            crop_b64_list.append(base64.b64encode(buf.getvalue()).decode())
        except Exception:
            crop_b64_list.append(None)

    # Gemini에 일괄 전송
    parts = [{"text": f"""이 이미지들은 영상의 1초 간격 프레임 {len(crop_b64_list)}장의 하단 자막 영역이야.
각 프레임에서 보이는 자막/텍스트 오버레이만 정확하게 읽어서 적어줘.
텍스트가 없으면 "없음"이라고 적어.

형식 (프레임마다 한 줄):
[N초] 자막텍스트
"""}]

    for i, b64 in enumerate(crop_b64_list):
        if b64:
            parts.append({"inline_data": {"mime_type": "image/jpeg", "data": b64}})

    try:
        resp = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}",
            json={"contents": [{"parts": parts}]},
            timeout=120
        )
        if resp.status_code != 200:
            return {}

        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        import re as _re_ocr
        ocr_results = {}
        for line in text.split('\n'):
            m = _re_ocr.match(r'\[?(\d+)\s*초?\]?\s*(.*)', line.strip())
            if m:
                sec_num = int(m.group(1))
                content = m.group(2).strip()
                if content and content != "없음" and len(content) > 1:
                    ocr_results[sec_num] = content
        return ocr_results
    except Exception as e:
        logger.warning("Gemini OCR 자막 추출 실패: %s", e)
        return {}


def _analyze_one_chunk_st(chunk_info):
    """단일 3장 묶음 Gemini 분석 (병렬용)"""
    import re as _re
    idx, chunk, total = chunk_info
    n = len(chunk)
    times = ", ".join([f"{idx+j}초" for j in range(n)])
    gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"

    prompt = f"""아래 이미지 {n}장은 인스타 릴스 영상에서 1초 간격으로 추출한 연속 프레임이야.
순서대로 {times} 시점 (전체 {total}장 중 {idx+1}~{idx+n}번째).

각 프레임마다 한 줄씩 분석해줘. 서두 없이 바로 시작:

형식: [N초] 장면설명 | 화면텍스트: "있으면 적기" | 컷전환: Y/N

규칙:
- 이전 프레임과의 맥락을 유지. 같은 장면이면 "이어서~" 형태.
- 장면이 바뀌었을 때만 새로운 설명, 동일하면 행동/변화 위주.
- 화면 자막/텍스트 오버레이는 정확하게 옮겨 적기.
- [N초]로 바로 시작할 것."""

    parts = [{"text": prompt}]
    for fp in chunk:
        with open(fp, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode()
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": img_b64}})

    import time as _time
    for attempt in range(3):
        try:
            resp = requests.post(
                gemini_url,
                json={"contents": [{"parts": parts}], "generationConfig": {"maxOutputTokens": 8192}},
                timeout=300
            )
            if resp.status_code == 200:
                content = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
                lines = []
                for line in content.strip().split('\n'):
                    line = line.strip()
                    if line.startswith(('*', '-')):
                        line = line.lstrip('*- ').strip()
                    if _re.match(r'\[?\d+\s*초?\]?', line):
                        lines.append(line)
                return (idx, lines)
            elif resp.status_code == 429:
                _time.sleep(10 * (attempt + 1))
            else:
                break
        except Exception as e:
            logger.warning("프레임 분석 chunk %d 에러: %s", idx, e)
            break
    return (idx, [])


def _analyze_frames_batch(frame_paths):
    """1초 단위 프레임들을 3장씩 묶어서 4개 병렬 분석"""
    if not frame_paths or not GEMINI_API_KEY:
        return ""

    total = len(frame_paths)
    chunks = []
    for i in range(0, total, 3):
        chunk = frame_paths[i:i+3]
        chunks.append((i, chunk, total))

    results = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(_analyze_one_chunk_st, chunks))

    results.sort(key=lambda x: x[0])
    all_lines = []
    for _, lines in results:
        all_lines.extend(lines)

    cut_count = sum(1 for line in all_lines if '컷전환' in line and 'Y' in line.split('컷전환')[-1][:5])
    all_lines.append(f"- 총 컷 전환 횟수: {cut_count}회")

    return "\n".join(all_lines)


# =============================================
# 심층 분석 (영상 + 대본 + 댓글 종합)
# =============================================
def run_opus_analysis(shortcode, meta, transcript_text, comments, caption, video_url=None):
    """영상 프레임 분석 + 대본 구조 분석 + 댓글 반응 분석"""
    plays = meta.get("play_count", 0) or 0
    likes = meta.get("like_count", 0) or 0
    comment_count = meta.get("comment_count", 0) or 0
    duration = meta.get("video_duration", 0) or 0
    author = meta.get("author_username", "?")
    music_title = meta.get("music_title", "")
    music_artist = meta.get("music_artist", "")

    comments_text = ""
    if comments:
        comments_text = "\n".join([
            f"@{c.get('comment_author', '?')}: {c.get('comment_text', '')[:100]}"
            for c in comments[:30]
        ])

    # ── Step 1: 영상 프레임 분석 (video_url이 있으면) ──
    import time as _time
    frame_analysis = ""
    new_transcript = None
    est_sec = int(duration) if duration else 30
    est_total = est_sec * 2 + 30
    timings = {}
    t_total_start = _time.time()

    if video_url:
        with tempfile.TemporaryDirectory() as tmpdir:
            status = st.status(f"심층 분석 중... (예상 {est_total//60}분 {est_total%60}초)", expanded=True)

            # Step 1: 다운로드 + 추출
            status.write("1/6 — 영상 다운로드 + 프레임/오디오 추출 중...")
            t0 = _time.time()
            video_path, audio_path, frame_paths = _download_and_extract(video_url, tmpdir)

            # video_url 만료 시 GramSnap/HikerAPI로 새 URL 가져와서 재시도
            if not frame_paths and (gramsnap_util or HIKER_API_KEY):
                status.write("⚠ 영상 URL 만료됨 — 새 URL 가져오는 중...")
                fresh = fetch_metadata(shortcode, username=author)
                if fresh:
                    new_video_url = fresh.get("video_url")
                    if new_video_url:
                        save_metadata(shortcode, fresh)
                        video_url = new_video_url
                        video_path, audio_path, frame_paths = _download_and_extract(video_url, tmpdir)
                        status.write(f"✓ 새 URL로 재다운로드 완료 ({len(frame_paths)}장 프레임)")
            timings["다운로드+추출"] = round(_time.time() - t0, 1)
            status.write(f"✓ 1/4 완료 — {timings['다운로드+추출']}초 ({len(frame_paths)}장 프레임)")

            # Step 2: 대본
            if not transcript_text:
                status.write("2/5 — Whisper 대본 추출 중...")
                t0 = _time.time()
                td = _whisper_transcribe(audio_path, shortcode)
                timings["Whisper"] = round(_time.time() - t0, 1)
                if td:
                    transcript_text = td["transcript"]
                    new_transcript = td
                status.write(f"✓ 2/4 완료 — {timings['Whisper']}초")
            else:
                status.write("✓ 2/5 — 대본 이미 있음 (스킵)")

            # Step 3: OCR 자막 추출 + 프레임 분석 + 이미지 저장
            if frame_paths:
                status.write(f"3/6 — {len(frame_paths)}장 프레임 하단 OCR 자막 추출 중...")
                t0 = _time.time()
                ocr_subtitles = _ocr_frame_subtitles(frame_paths)
                timings["OCR"] = round(_time.time() - t0, 1)
                status.write(f"✓ 3/6 완료 — {timings['OCR']}초 ({len(ocr_subtitles)}개 자막 감지)")

                if ocr_subtitles:
                    if "ocr_subtitles" not in st.session_state:
                        st.session_state.ocr_subtitles = {}
                    st.session_state.ocr_subtitles[shortcode] = ocr_subtitles

                status.write(f"4/6 — {len(frame_paths)}장 프레임 Gemini Vision 분석 중...")
                t0 = _time.time()
                frame_analysis = _analyze_frames_batch(frame_paths)
                timings["프레임분석"] = round(_time.time() - t0, 1)
                status.write(f"✓ 4/6 완료 — {timings['프레임분석']}초")

                # 프레임 이미지를 썸네일로 리사이즈 후 base64 저장
                if "frame_images" not in st.session_state:
                    st.session_state.frame_images = {}
                frame_b64_map = {}
                try:
                    from PIL import Image
                    import io
                    for i, fp in enumerate(frame_paths):
                        img = Image.open(fp)
                        img.thumbnail((360, 640))
                        buf = io.BytesIO()
                        img.save(buf, format="JPEG", quality=70)
                        frame_b64_map[i + 1] = base64.b64encode(buf.getvalue()).decode()
                except ImportError:
                    for i, fp in enumerate(frame_paths):
                        with open(fp, "rb") as f:
                            frame_b64_map[i + 1] = base64.b64encode(f.read()).decode()
                st.session_state.frame_images[shortcode] = frame_b64_map

            # Step 4: 음성 감정 분석
            status.write("4/5 — 음성 피치/볼륨/감정 분석 중...")
            t0 = _time.time()
            audio_emotions = _analyze_audio_emotion(audio_path)
            timings["음성감정"] = round(_time.time() - t0, 1)
            status.write(f"✓ 4/5 완료 — {timings['음성감정']}초")

            if audio_emotions:
                if "audio_emotions" not in st.session_state:
                    st.session_state.audio_emotions = {}
                st.session_state.audio_emotions[shortcode] = audio_emotions

            # Step 5: 대본 세그먼트 → 초별 매핑
            seg_by_sec = {}
            segments = (new_transcript or {}).get("segments", [])
            if segments:
                for seg in segments:
                    start_sec = int(seg.get("start", 0))
                    end_sec = int(seg.get("end", start_sec + 1))
                    text = seg.get("text", "").strip()
                    for s in range(start_sec + 1, end_sec + 2):  # 1-indexed
                        if s not in seg_by_sec:
                            seg_by_sec[s] = text
            if seg_by_sec:
                if "script_by_sec" not in st.session_state:
                    st.session_state.script_by_sec = {}
                st.session_state.script_by_sec[shortcode] = seg_by_sec

            status.write("완료!")

    # ── Step 6: 대본 구조 분석 (후킹/인트로/본문/CTA) ──
    if transcript_text:
        try:
            sys.path.insert(0, str(Path(__file__).parent.parent / "agents" / "analyzer"))
            from script_structure import analyze_script_structure
            t0 = _time.time()
            script_struct = analyze_script_structure(transcript_text, caption)
            timings["대본구조"] = round(_time.time() - t0, 1)
            if script_struct:
                if "script_structure" not in st.session_state:
                    st.session_state.script_structure = {}
                st.session_state.script_structure[shortcode] = script_struct
        except Exception as e:
            logger.warning("대본 구조 분석 실패: %s", e)

    # ── 대본에서 일본어 제거 ──
    if transcript_text:
        import re as _re
        lines = transcript_text.split('.')
        ko_lines = [l.strip() for l in lines if l.strip() and not _re.search(r'[\u3040-\u309F\u30A0-\u30FF]', l)]
        transcript_text = '. '.join(ko_lines)

    # ── 결과 조합 ──
    timings["총소요"] = round(_time.time() - t_total_start, 1)

    # 프레임 분석을 초별 딕셔너리로 파싱
    frame_by_sec = {}
    frame_summary = ""
    if frame_analysis:
        for line in frame_analysis.split('\n'):
            line = line.strip()
            sec_match = _re.match(r'\[?(\d+)\s*초?\]?\s*(.*)', line)
            if sec_match:
                sec_num = int(sec_match.group(1))
                frame_by_sec[sec_num] = sec_match.group(2)
            elif line.startswith('-') or line.startswith('*'):
                frame_summary += line + '\n'

    # 결과를 JSON-like 구조로 저장 (표시는 상세뷰에서)
    sections = []

    # BGM
    bgm_text = ""
    if music_title:
        bgm_text = f"**{music_title}**"
        if music_artist:
            bgm_text += f" - {music_artist}"
    sections.append(f"## BGM\n\n{bgm_text if bgm_text else '원본 오디오 (BGM 없음)'}")

    # 프레임 분석 (원본 텍스트 유지 + 초별 데이터 별도 저장)
    if frame_analysis:
        sections.append(f"## 영상 프레임 분석 (1초 단위)\n\n{frame_analysis}")

    # 대본
    if transcript_text:
        sections.append(f"## 대본\n\n{transcript_text}")

    # 댓글
    if comments_text:
        sections.append(f"## 댓글 ({len(comments)}개)\n\n{comments_text}")

    result_text = "\n\n".join(sections) if sections else None

    # 타이밍 로그 출력
    timing_summary = " | ".join(f"{k}: {v}초" for k, v in timings.items())
    logger.info("[분석완료] %s — %s", shortcode, timing_summary)
    print(f"[분석완료] {shortcode} - {timing_summary}")

    # 타이밍 요약 텍스트
    timing_text = " | ".join(f"{k}: {v}s" for k, v in timings.items())

    if result_text:
        # 타이밍 정보를 결과 하단에 추가
        result_text += f"\n\n---\n*분석 소요 시간: {timing_text}*"

        # Supabase 저장 시도 (테이블 없으면 무시)
        sb_post("opus_analyses", {
            "shortcode": shortcode,
            "analysis": result_text,
            "analyzed_at": datetime.now().isoformat()
        })
        # session_state에도 저장
        if "analyses" not in st.session_state:
            st.session_state.analyses = {}
        st.session_state.analyses[shortcode] = result_text

    return result_text, new_transcript


# =============================================
# Transcriber: 대본만 추출 (단독)
# =============================================
def process_reel_full(shortcode, video_url):
    """릴스 대본 추출만 수행"""
    results = {"transcript": None}

    with tempfile.TemporaryDirectory() as tmpdir:
        video_path, audio_path, _ = _download_and_extract(video_url, tmpdir)
        td = _whisper_transcribe(audio_path, shortcode)
        if td:
            results["transcript"] = td

    return results


# =============================================
# 페이지 설정
# =============================================
st.set_page_config(page_title="Reels Bench", page_icon="🎬", layout="wide", initial_sidebar_state="expanded")

st.markdown("<style>[data-testid='stAppDeployButton'] { display: none; }</style>", unsafe_allow_html=True)


# ── 숫자 포맷 헬퍼 ──
def fmt_num(n):
    """숫자를 약어로 포맷 (1.2M, 45.3K)"""
    if n is None:
        return "-"
    n = int(n)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return f"{n:,}"


def engagement_rate(likes, plays):
    """인게이지먼트 레이트 계산"""
    if not plays or not likes:
        return 0
    return round(likes / plays * 100, 2)


def er_color(er):
    """ER에 따른 색상 반환"""
    if er >= 5:
        return "#10B981"
    if er >= 2:
        return "#307df0"
    if er >= 1:
        return "#8B94A9"
    return "#EF4444"


# ── 외부 CSS 로드 (캐시) ──
@st.cache_resource
def _load_css():
    return (Path(__file__).parent / "style.css").read_text(encoding="utf-8")

st.markdown(f"<style>{_load_css()}</style>", unsafe_allow_html=True)
st.markdown("""<style>
[data-testid="stSelectbox"] input,
[data-testid="stSelectbox"] * {
    caret-color: transparent !important;
    cursor: default !important;
}
</style>""", unsafe_allow_html=True)



# ── Plotly 라이트 테마 (TetherMax Elevate) ──
PLOTLY_LAYOUT = dict(
    paper_bgcolor="#FFFFFF",
    plot_bgcolor="#FFFFFF",
    font=dict(family="Pretendard Variable, sans-serif", color="#474B56", size=12),
    xaxis=dict(gridcolor="#F0F1F5", zerolinecolor="#E5E7EB", tickfont=dict(color="#8B94A9", size=11)),
    yaxis=dict(gridcolor="#F0F1F5", zerolinecolor="#E5E7EB", tickfont=dict(color="#8B94A9", size=11)),
    margin=dict(l=40, r=20, t=10, b=40),
    hoverlabel=dict(bgcolor="#FFFFFF", font_color="#121721", bordercolor="#E5E7EB"),
    colorway=["#307df0", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899"],
)
PLOTLY_CONFIG = {"displayModeBar": False}

# 사이드바 — 페이지 상태
_PAGE_MAP = {"home": "홈", "bench": "벤치마크", "analyze": "분석", "trend": "트렌드", "channels": "채널"}
_PAGE_SLUG = {v: k for k, v in _PAGE_MAP.items()}

# URL query param → session_state 초기화
_qp_page = st.query_params.get("page", "")
if _qp_page in _PAGE_MAP:
    st.session_state.page = _PAGE_MAP[_qp_page]
elif "page" not in st.session_state:
    st.session_state.page = "홈"

with st.sidebar:
    # ── 프로필 영역 ──
    st.markdown("""
    <div class="sb-profile">
        <div class="sb-profile-avatar">R</div>
        <div class="sb-profile-info">
            <div class="sb-profile-name">Reels Bench</div>
            <div class="sb-profile-sub">Trend Analysis</div>
        </div>
        <div class="sb-profile-chevron">&#9662;</div>
    </div>
    <hr class="sb-divider">
    """, unsafe_allow_html=True)

    # ── 메인 네비게이션 (버튼 방식) ──
    nav_items = ["홈", "벤치마크", "분석", "트렌드", "채널"]
    for label in nav_items:
        btn_type = "primary" if label == st.session_state.page else "secondary"
        if st.button(label, key=f"nav_{label}", use_container_width=True, type=btn_type):
            st.session_state.page = label
            st.session_state.selected_reel = None
            st.query_params.clear()
            st.query_params["page"] = _PAGE_SLUG[label]
            st.rerun()

    page = st.session_state.page
    # URL 동기화
    st.query_params["page"] = _PAGE_SLUG.get(page, "home")

    st.markdown('<hr class="sb-divider">', unsafe_allow_html=True)

    # ── 하단 ──
    st.markdown("""
    <div class="sb-bottom">
        <div class="sb-bottom-item">
            <div class="sb-nav-icon">&#x2139;</div>Help Center
        </div>
    </div>
    """, unsafe_allow_html=True)


# =============================================
# 홈
# =============================================
if page == "홈":

    st.markdown("""
    <div class="main-header">
        <h1>홈</h1>
        <p>인스타 릴스 벤치마크 현황을 한눈에 확인합니다</p>
    </div>
    """, unsafe_allow_html=True)

    # ── 데이터 로드 (bench 캐시 재활용) ──
    channels = sb_get("monitored_channels", "select=*&order=created_at.desc")
    all_reels, all_meta, _, _, _ = load_bench_data()

    active_channels = [c for c in channels if c.get("is_active", True)]
    total_reels = len(all_meta)
    total_views = sum(m.get("play_count") or 0 for m in all_meta)
    total_likes = sum(m.get("like_count") or 0 for m in all_meta)
    channels_with_data = len(set(m.get("author_username") for m in all_meta if m.get("author_username")))

    # 최근 24시간 수집
    from datetime import timezone
    now_utc = datetime.now(timezone.utc)
    recent_24h = 0
    for r in all_reels:
        ca = r.get("collected_at", "")
        if ca:
            try:
                dt = datetime.fromisoformat(ca.replace("Z", "+00:00"))
                if (now_utc - dt).total_seconds() < 86400:
                    recent_24h += 1
            except Exception:
                pass

    # URL 만료 체크 (video_url이 없는 릴스)
    no_url = sum(1 for m in all_meta if not m.get("video_url"))

    # ── KPI 카드 ──
    st.markdown(f"""
    <div class="kpi-row">
        <div class="kpi-card">
            <div class="kpi-label">모니터링 채널</div>
            <div class="kpi-value">{len(active_channels)}</div>
            <div class="kpi-sub">등록 {len(channels)}개 / 활성 {len(active_channels)}개</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">수집된 릴스</div>
            <div class="kpi-value">{total_reels:,}</div>
            <div class="kpi-sub">최근 24시간 +{recent_24h}</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">총 조회수</div>
            <div class="kpi-value">{total_views:,.0f}</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">총 좋아요</div>
            <div class="kpi-value">{total_likes:,.0f}</div>
        </div>
    </div>
    """, unsafe_allow_html=True)

    # ── 빠른 액션 ──
    st.markdown("### 빠른 실행")
    col_a, col_c = st.columns(2)

    with col_a:
        if st.button("채널 추가", use_container_width=True, type="primary"):
            st.session_state.page = "채널"
            st.query_params["page"] = "channels"
            st.rerun()

    with col_c:
        if st.button("벤치마크 보기", use_container_width=True, type="primary"):
            st.session_state.page = "벤치마크"
            st.session_state.selected_reel = None
            st.query_params["page"] = "bench"
            st.rerun()

    # ── 채널 현황 ──
    if channels:
        st.markdown("### 채널 현황")
        for ch in channels[:10]:
            username = ch.get("username", "?")
            is_active = ch.get("is_active", True)
            last = ch.get("last_collected_at", "")
            reel_count = ch.get("reel_count", 0)
            last_display = last[:10] if last else "미수집"

            cols = st.columns([0.3, 2, 1.5, 1])
            with cols[0]:
                st.markdown("🟢" if is_active else "🔴")
            with cols[1]:
                st.markdown(f"**@{username}**")
            with cols[2]:
                st.caption(f"릴스 {reel_count}개")
            with cols[3]:
                st.caption(last_display)
    else:
        st.info("등록된 채널이 없습니다. '채널 추가' 버튼을 눌러 시작하세요.")


# =============================================
# 0. 벤치마크 영상 등록
# =============================================
def extract_shortcode(text):
    """URL 또는 shortcode에서 shortcode 추출"""
    text = text.strip()
    # instagram.com/reel/XXXXX 또는 /p/XXXXX 패턴
    m = re.search(r'instagram\.com/(?:reel|p)/([A-Za-z0-9_-]+)', text)
    if m:
        return m.group(1)
    # 이미 shortcode인 경우 (영문숫자_- 만)
    if re.match(r'^[A-Za-z0-9_-]+$', text) and len(text) >= 8:
        return text
    return None


if page == "벤치마크":

    st.markdown("""
    <div class="main-header">
        <h1>벤치마크</h1>
        <p>수집된 릴스의 성과를 비교 분석합니다</p>
    </div>
    """, unsafe_allow_html=True)

    # ── 데이터 로드 (병렬 + 캐시) ──
    bench_reels, all_meta, all_transcripts, all_opus, all_comments = load_bench_data()
    meta_map = {m["shortcode"]: m for m in all_meta} if all_meta else {}
    transcript_map = {t["shortcode"]: t for t in all_transcripts} if all_transcripts else {}
    opus_map = {o["shortcode"]: o for o in all_opus} if all_opus else {}
    comments_map = {}
    if all_comments:
        for c in all_comments:
            comments_map.setdefault(c["shortcode"], []).append(c)

    if "compare_reels" not in st.session_state:
        st.session_state.compare_reels = []

    # 선택된 릴스 상태 (쿼리 파라미터와 동기화)
    if "selected_reel" not in st.session_state:
        st.session_state.selected_reel = None
    qp_reel = st.query_params.get("reel")
    if qp_reel:
        st.session_state.selected_reel = qp_reel
    elif not qp_reel and st.session_state.selected_reel:
        # URL에 reel 없으면 상세뷰 해제
        st.session_state.selected_reel = None

    # ─────────────────────────────────────────
    # 상세 워크플로우 뷰
    # ─────────────────────────────────────────
    if st.session_state.selected_reel and bench_reels:
        selected = st.session_state.selected_reel
        m = meta_map.get(selected, {})
        t = transcript_map.get(selected, {})
        o = opus_map.get(selected, {})
        # session_state에 저장된 분석 결과가 있으면 우선 사용
        if not o and "analyses" in st.session_state and selected in st.session_state.analyses:
            o = {"analysis": st.session_state.analyses[selected]}
        cmts = comments_map.get(selected, [])
        reel_row = next((r for r in bench_reels if r["shortcode"] == selected), {})
        author = m.get("author_username") or reel_row.get("author") or "?"
        author_full = m.get("author_full_name") or ""
        thumb = thumb_src(m.get("thumbnail_url", ""))
        video_url = m.get("video_url", "")
        caption = m.get("caption_text") or ""
        category = reel_row.get("account_category") or "-"

        _ad_keywords = r"(광고|협찬|유료광고|paid\s*partnership|#ad\b|#sponsored|#광고|#협찬|소정의\s*원고료|제품\s*협찬|경제적\s*대가)"
        is_sponsored = bool(re.search(_ad_keywords, caption, re.IGNORECASE))

        taken_at_str = m.get("taken_at") or ""
        publish_date = ""
        if taken_at_str:
            try:
                publish_date = taken_at_str.split("T")[0]
            except Exception:
                publish_date = taken_at_str

        # ── 메트릭 준비 ──
        plays_n = m.get("play_count") or 0
        likes_n = m.get("like_count") or 0
        comments_n = m.get("comment_count") or 0
        duration_n = m.get("video_duration") or 0
        er = engagement_rate(likes_n, plays_n)
        er_c = er_color(er)
        ig_url = f"https://www.instagram.com/reel/{selected}/"

        # ── 브레드크럼 + 액션 바 ──
        _analysis_from_ss_pre = st.session_state.get("analyses", {}).get(selected, "")
        _analysis_from_db_pre = o.get("analysis", "") if o else ""
        _has_analysis = bool(_analysis_from_db_pre or _analysis_from_ss_pre)
        analyze_label = "재분석" if _has_analysis else "분석하기"
        need_transcribe = not t and video_url

        btn_cols = [1, 3]  # Back, spacer
        btn_cols.append(1)  # 분석
        if need_transcribe:
            btn_cols.append(1)  # Transcribe
        if video_url and _has_analysis:
            btn_cols.append(1)  # 다운로드

        btn_slots = st.columns(btn_cols)
        slot_idx = 0

        with btn_slots[slot_idx]:
            if st.button("← 벤치마크 목록", key="btn_back_detail"):
                st.session_state.selected_reel = None
                st.query_params.pop("reel", None)
                st.rerun()
        slot_idx += 1
        slot_idx += 1  # spacer

        with btn_slots[slot_idx]:
            if st.button(analyze_label, type="primary", key="btn_analyze", use_container_width=True):
                try:
                    result_text, new_transcript = run_opus_analysis(
                        selected, m, t.get("transcript", ""), cmts, caption, video_url=video_url
                    )
                    if result_text:
                        st.toast("분석 완료")
                        load_bench_data.clear()
                        st.rerun()
                    else:
                        st.error("분석에 실패했습니다.")
                except Exception as e:
                    st.error(f"분석 중 오류: {e}")
                    import traceback
                    st.code(traceback.format_exc())
        slot_idx += 1

        if need_transcribe:
            with btn_slots[slot_idx]:
                if st.button("대본 추출", type="primary", key="btn_transcribe_thumb", use_container_width=True):
                    with st.spinner("오디오 추출 중... → Whisper 변환 중..."):
                        result = process_reel_full(selected, video_url)
                    if result.get("transcript"):
                        st.toast("대본 추출 완료")
                        load_bench_data.clear()
                        st.rerun()
            slot_idx += 1

        if video_url and _has_analysis:
            with btn_slots[slot_idx]:
                if st.button("다운로드", key="btn_download", use_container_width=True):
                    with st.spinner("영상 다운로드 중..."):
                        # 새 URL 가져오기 (만료 대비)
                        _dl_url = video_url
                        _dl_r = requests.get(_dl_url, stream=True, timeout=15)
                        if _dl_r.status_code != 200 and HIKER_API_KEY:
                            fresh = fetch_metadata(selected)
                            if fresh and fresh.get("video_url"):
                                _dl_url = fresh["video_url"]
                                save_metadata(selected, fresh)
                                _dl_r = requests.get(_dl_url, stream=True, timeout=30)
                        if _dl_r.status_code == 200:
                            _dl_bytes = b"".join(_dl_r.iter_content(8192))
                            st.session_state[f"dl_{selected}"] = _dl_bytes
                            st.toast(f"다운로드 준비 완료 ({len(_dl_bytes)//1024}KB)")
                            st.rerun()
                        else:
                            st.error("영상을 가져올 수 없습니다.")
            slot_idx += 1

        # 다운로드 버튼 (준비된 데이터가 있으면)
        if st.session_state.get(f"dl_{selected}"):
            st.download_button(
                "💾 영상 저장",
                data=st.session_state[f"dl_{selected}"],
                file_name=f"{selected}.mp4",
                mime="video/mp4",
                key=f"dl_btn_{selected}",
            )

        # ── KPI 메트릭 카드 ──
        bgm_display = m.get("music_title") or "원본 오디오"
        bgm_artist = m.get("music_artist") or ""
        bgm_sub = f'<div class="kpi-sub">{bgm_artist}</div>' if bgm_artist else ''
        st.markdown(f'''<div class="kpi-row">
<div class="kpi-card"><div class="kpi-label">조회수</div><div class="kpi-value">{fmt_num(plays_n)}</div></div>
<div class="kpi-card"><div class="kpi-label">좋아요</div><div class="kpi-value">{fmt_num(likes_n)}</div></div>
<div class="kpi-card"><div class="kpi-label">참여율</div><div class="kpi-value" style="color:{er_c};">{er}%</div></div>
<div class="kpi-card"><div class="kpi-label">배경음악</div><div class="kpi-value" style="font-size:16px;">{bgm_display}</div>{bgm_sub}</div>
</div>''', unsafe_allow_html=True)

        detail_tab1, detail_tab2, detail_tab3 = st.tabs(["개요", "프레임 분석", "대본 구조"])

        with detail_tab1:
            col_thumb, col_main = st.columns([1, 2])

            with col_thumb:
                # ── 썸네일 ──
                if thumb:
                    thumb_link = f'<a href="{ig_url}" target="_blank" style="display:block;text-decoration:none;"><img src="{thumb}" style="width:100%;border-radius:12px;object-fit:cover;aspect-ratio:9/16;display:block;" /></a>'
                else:
                    thumb_link = f'<a href="{ig_url}" target="_blank" style="display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:9/16;border-radius:12px;background:var(--bg-surface);color:var(--text-muted);font-size:48px;text-decoration:none;">&#9654;</a>'
                st.markdown(thumb_link, unsafe_allow_html=True)

            with col_main:
                # ── 프로필 바 ──
                sponsor_badge = '<span style="background:var(--error)20;color:var(--error);padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-left:4px;">AD</span>' if is_sponsored else ''
                music_html = (
                    f'<div style="color:var(--text-muted);font-size:11px;margin-top:3px;">&#x266B; {m.get("music_artist","")} — {m["music_title"]}</div>'
                    if m.get("music_title") else ""
                )
                meta_parts = " &middot; ".join(part for part in [category if category != "-" else "", publish_date, f"{duration_n:.0f}s" if duration_n else ""] if part)
                profile_html = (
                    f'<div style="padding-bottom:14px;border-bottom:1px solid var(--border);margin-bottom:16px;">'
                    f'<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">'
                    f'<a href="{ig_url}" target="_blank" style="color:var(--text-primary);font-size:16px;font-weight:700;text-decoration:none;">@{author}</a>'
                    f'{sponsor_badge}'
                    f'</div>'
                    f'<div style="color:var(--text-muted);font-size:12px;margin-top:4px;">{meta_parts}</div>'
                    f'{music_html}'
                    f'</div>'
                )
                st.markdown(profile_html, unsafe_allow_html=True)

                # ── 대본 ──
                st.markdown('<p style="color:var(--text-muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin:0 0 8px;">대본</p>', unsafe_allow_html=True)
                if t:
                    st.markdown(
                        f'<div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:14px 16px;'
                        f'color:var(--text-body);font-size:13px;line-height:1.75;max-height:150px;overflow-y:auto;">'
                        f'{t.get("transcript","")}</div>',
                        unsafe_allow_html=True
                    )
                    st.markdown(f'<div style="color:var(--text-muted);font-size:11px;margin-top:5px;">{t.get("duration_seconds",0):.1f}s · {t.get("language","-")}</div>', unsafe_allow_html=True)
                else:
                    st.markdown('<div style="color:var(--text-muted);font-size:12px;margin-bottom:6px;">No transcript</div>', unsafe_allow_html=True)
                    if video_url:
                        if st.button("대본 추출", type="primary", key="btn_transcribe"):
                            with st.spinner("Transcribing..."):
                                result = process_reel_full(selected, video_url)
                            if result.get("transcript"):
                                st.success("Done")
                                load_bench_data.clear()
                                st.rerun()

                # ── 캡션 + 댓글 2컬럼 ──
                ctx_left, ctx_right = st.columns(2)
                with ctx_left:
                    st.markdown('<p style="color:var(--text-muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin:16px 0 8px;">캡션</p>', unsafe_allow_html=True)
                    if caption:
                        st.markdown(
                            f'<div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:12px 16px;'
                            f'color:var(--text-body);font-size:13px;line-height:1.75;max-height:280px;overflow-y:auto;white-space:pre-wrap;">'
                            f'{caption}</div>',
                            unsafe_allow_html=True
                        )
                    else:
                        st.markdown('<div style="color:var(--text-muted);font-size:12px;">캡션 없음</div>', unsafe_allow_html=True)

                with ctx_right:
                    pinned = [c for c in cmts if c.get("is_pinned")]
                    regular = sorted([c for c in cmts if not c.get("is_pinned")], key=lambda c: c.get("comment_likes") or 0, reverse=True)

                    if cmts:
                        st.markdown(f'<p style="color:var(--text-muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin:16px 0 8px;">Comments <span style="color:var(--text-dim);">({len(cmts)})</span></p>', unsafe_allow_html=True)
                        cmt_html = ""
                        for c in (pinned + regular)[:40]:
                            likes = c.get("comment_likes") or 0
                            likes_badge = f'<span style="color:var(--text-secondary);font-size:11px;margin-left:4px;">♥{likes}</span>' if likes else ""
                            cmt_html += (
                                f'<div style="padding:8px 0;border-bottom:1px solid var(--border-subtle);display:flex;gap:8px;align-items:baseline;">'
                                f'<span style="color:var(--accent);font-weight:600;font-size:11px;flex-shrink:0;">@{c.get("comment_author","?")}</span>'
                                f'<span style="color:var(--text-body);font-size:12px;line-height:1.5;">{c.get("comment_text","")}{likes_badge}</span>'
                                f'</div>'
                            )
                        if len(cmts) > 40:
                            cmt_html += f'<div style="padding:6px 0;color:var(--text-muted);font-size:11px;">+{len(cmts)-40}개 더</div>'
                        st.markdown(
                            f'<div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:0 14px;max-height:280px;overflow-y:auto;">'
                            f'{cmt_html}</div>',
                            unsafe_allow_html=True
                        )
                    else:
                        st.markdown('<p style="color:var(--text-muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin:16px 0 8px;">Comments</p>', unsafe_allow_html=True)
                        if st.button("댓글 수집", type="primary", key="btn_comments"):
                            with st.spinner("댓글 수집 중..."):
                                new_comments = fetch_comments_playwright(selected)
                            if new_comments:
                                save_comments(selected, new_comments)
                                load_bench_data.clear()
                                st.rerun()
                            else:
                                st.warning("댓글을 가져오지 못했습니다.")

        with detail_tab2:
            # ── 심층 분석 결과 (있으면 표시) ──
            # DB 또는 session_state에서 분석 결과 가져오기
            _analysis_from_ss = st.session_state.get("analyses", {}).get(selected, "")
            _analysis_from_db = o.get("analysis", "") if o else ""
            analysis_text = _analysis_from_db or _analysis_from_ss
            if analysis_text:
                st.markdown('<hr style="border-color:var(--border);margin:24px 0 20px;">', unsafe_allow_html=True)

                # 프레임 분석을 초별로 파싱
                import re as _re
                _frame_lines = {}
                _summary_lines = []
                _other_sections = []
                current_section = ""
                in_frame_section = False

                for line in analysis_text.split('\n'):
                    stripped = line.strip()
                    if stripped.startswith('## 영상 프레임 분석'):
                        in_frame_section = True
                        continue
                    elif stripped.startswith('## '):
                        in_frame_section = False
                        current_section = stripped
                        _other_sections.append(line)
                        continue

                    if in_frame_section:
                        if stripped == '---' or not stripped:
                            continue
                        sec_match = _re.match(r'\[?(\d+)\s*초?\]?\s*(.*)', stripped)
                        if sec_match:
                            _frame_lines[int(sec_match.group(1))] = sec_match.group(2)
                        elif stripped.startswith(('-', '*')) and len(stripped) > 3:
                            _summary_lines.append(stripped)
                    else:
                        _other_sections.append(line)

                # 프레임 타임라인 차트 (인스타 분석 스타일)
                if _frame_lines:
                    st.markdown('<p style="color:var(--text-muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin:0 0 4px;">프레임 타임라인</p>', unsafe_allow_html=True)

                    sorted_secs = sorted(_frame_lines.keys())
                    # 컷 전환 감지
                    cut_markers = []
                    text_markers = []
                    for sec in sorted_secs:
                        info = _frame_lines[sec]
                        is_cut = 'Y' in info.split('컷전환')[-1][:5] if '컷전환' in info else ('Y' in info.split('컷')[-1][:5] if '컷' in info else False)
                        has_text = '화면텍스트' in info and '없음' not in info.split('화면텍스트')[0:2][-1][:10] if '화면텍스트' in info else False
                        cut_markers.append(1 if is_cut else 0)
                        text_markers.append(1 if has_text else 0)

                    # 호버 텍스트 (줄바꿈 처리)
                    hover_texts = []
                    for sec in sorted_secs:
                        raw = _frame_lines[sec]
                        # | 구분자를 줄바꿈으로
                        parts = [p.strip() for p in raw.split('|')]
                        hover_texts.append(f"[{sec}초]<br>" + "<br>".join(parts))

                    # 누적 컷 전환 라인
                    cumulative_cuts = []
                    total = 0
                    for c in cut_markers:
                        total += c
                        cumulative_cuts.append(total)

                    time_labels = [f"0:{sec:02d}" for sec in sorted_secs]

                    fig = go.Figure()

                    # ── 커스텀 HTML 타임라인 스크러버 ──
                    frame_imgs = st.session_state.get("frame_images", {}).get(selected, {})
                    import json as _json

                    # JS에 넘길 데이터 준비
                    audio_emo = st.session_state.get("audio_emotions", {}).get(selected, {})
                    script_sec = st.session_state.get("script_by_sec", {}).get(selected, {})
                    ocr_subs = st.session_state.get("ocr_subtitles", {}).get(selected, {})
                    js_frames = {}
                    for sec in sorted_secs:
                        emo = audio_emo.get(sec, {})
                        js_frames[sec] = {
                            "img": frame_imgs.get(sec, ""),
                            "desc": _frame_lines.get(sec, ""),
                            "cut": cut_markers[sorted_secs.index(sec)],
                            "pitch": emo.get("pitch", 0),
                            "volume": emo.get("volume", 0),
                            "emotion": emo.get("label", ""),
                            "script": script_sec.get(sec, ""),
                            "ocr": ocr_subs.get(sec, ""),
                        }
                    js_cuts = _json.dumps(cumulative_cuts)
                    js_data = _json.dumps(js_frames, ensure_ascii=False)
                    js_secs = _json.dumps(sorted_secs)
                    max_cut = max(cumulative_cuts) if cumulative_cuts else 1
                    # 볼륨 최대값 (차트 스케일용)
                    max_vol = max((audio_emo.get(s, {}).get("volume", 0) for s in sorted_secs), default=1) or 1

                    import streamlit.components.v1 as components
                    components.html(f"""
    <style>
    * {{ margin:0; padding:0; box-sizing:border-box; }}
    body {{ background:transparent; font-family:'Pretendard Variable',sans-serif; color:#474B56; }}
    .section-title {{ font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:#8B94A9; margin:0 0 6px; }}
    .chart-area {{ position:relative; width:100%; height:120px; cursor:crosshair; user-select:none; -webkit-user-select:none; }}
    .chart-area canvas {{ width:100%; height:100%; }}
    #vline {{ position:absolute; top:0; width:2px; height:100%; background:#307df0; pointer-events:none; z-index:10; }}
    #vline::after {{ content:attr(data-label); position:absolute; top:-18px; left:50%; transform:translateX(-50%); background:#307df0; color:#fff; font-size:11px; font-weight:700; padding:1px 6px; border-radius:3px; white-space:nowrap; }}
    #emo-bar {{ display:flex; width:100%; height:22px; margin-top:2px; border-radius:6px; overflow:hidden; }}
    #emo-bar .seg {{ flex:1; display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:600; color:#fff; }}
    #viewer {{ display:flex; gap:16px; margin-top:12px; }}
    #frame-img {{ width:180px; min-height:320px; border-radius:10px; object-fit:cover; background:#F2F3F7; flex-shrink:0; }}
    #frame-desc {{ flex:1; }}
    #frame-sec {{ color:#307df0; font-size:18px; font-weight:700; margin-bottom:4px; }}
    #frame-emo {{ font-size:14px; margin-bottom:8px; color:#474B56; }}
    #frame-ocr {{ background:#FFF9E6; border:1px solid #F59E0B; border-radius:6px; padding:6px 12px; margin:6px 0; font-size:13px; line-height:1.5; color:#92400E; display:none; }}
    #frame-ocr::before {{ content:"CC "; font-weight:700; color:#F59E0B; opacity:0.7; }}
    .desc-line {{ color:#474B56; font-size:13px; line-height:1.7; margin-bottom:4px; }}
    .legend {{ display:flex; gap:14px; margin-bottom:6px; font-size:11px; color:#8B94A9; flex-wrap:wrap; }}
    .legend span {{ display:flex; align-items:center; gap:4px; }}
    .ldot {{ width:8px; height:8px; border-radius:50%; }}
    </style>

    <p class="section-title">프레임 타임라인</p>
    <div class="legend">
      <span><span class="ldot" style="background:#8B5CF6;"></span> 컷 전환</span>
      <span><span class="ldot" style="background:#10B981;"></span> 볼륨</span>
      <span><span class="ldot" style="background:#307df0;border-radius:0;height:2px;"></span> 현재 위치</span>
      <span>😊기쁨 😠강조 😢슬픔 😐중립 ⏸멈춤</span>
    </div>
    <div class="chart-area" id="timeline">
      <canvas id="chart"></canvas>
      <div id="vline" data-label="0:01"></div>
    </div>
    <div id="emo-bar"></div>
    <div id="viewer">
      <img id="frame-img" src="" alt="" />
      <div id="frame-desc">
        <div id="frame-sec">[1초]</div>
        <div id="frame-emo"></div>
        <div id="frame-ocr"></div>
        <div id="frame-text"></div>
      </div>
    </div>

    <script>
    const DATA = {js_data};
    const SECS = {js_secs};
    const CUTS = {js_cuts};
    const MAX_CUT = {max_cut} || 1;
    const MAX_VOL = {max_vol} || 1;

    const EMO_COLORS = {{
      'happy':'#F59E0B','angry':'#EF4444','sad':'#307df0','neutral':'#D1D5DB','pause':'#E5E7EB'
    }};

    // ── 프레임 타임라인 차트 ──
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');
    const timeline = document.getElementById('timeline');
    const vline = document.getElementById('vline');
    const frameImg = document.getElementById('frame-img');
    const frameSec = document.getElementById('frame-sec');
    const frameEmo = document.getElementById('frame-emo');
    const frameOcr = document.getElementById('frame-ocr');
    const frameText = document.getElementById('frame-text');
    const emoBar = document.getElementById('emo-bar');

    // 감정 바 생성
    SECS.forEach(s => {{
      const d = DATA[s] || {{}};
      const emo = d.emotion || '';
      const color = EMO_COLORS[
        emo.includes('기쁨') ? 'happy' :
        emo.includes('강조') ? 'angry' :
        emo.includes('슬픔') ? 'sad' :
        emo.includes('멈춤') ? 'pause' : 'neutral'
      ] || '#555';
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.style.background = color;
      seg.setAttribute('data-sec', s);
      emoBar.appendChild(seg);
    }});

    function resize() {{
      canvas.width = timeline.clientWidth;
      canvas.height = timeline.clientHeight;
      draw();
    }}

    function draw() {{
      const w = canvas.width, h = canvas.height;
      const pad = {{l:30, r:10, t:8, b:22}};
      const cw = w - pad.l - pad.r;
      const ch = h - pad.t - pad.b;
      ctx.clearRect(0, 0, w, h);

      // grid
      ctx.strokeStyle = '#E5E7EB'; ctx.lineWidth = 1;
      for (let i = 0; i <= 3; i++) {{
        const y = pad.t + ch * (1 - i/3);
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w-pad.r, y); ctx.stroke();
      }}

      // x labels
      ctx.fillStyle = '#8B94A9'; ctx.font = '10px Pretendard Variable,sans-serif'; ctx.textAlign = 'center';
      const step = Math.max(1, Math.floor(SECS.length / 8));
      for (let i = 0; i < SECS.length; i += step) {{
        const x = pad.l + (i / (SECS.length-1)) * cw;
        ctx.fillText('0:' + String(SECS[i]).padStart(2,'0'), x, h - 4);
      }}

      // 볼륨 영역 (반투명)
      ctx.fillStyle = 'rgba(16,185,129,0.1)';
      ctx.beginPath();
      ctx.moveTo(pad.l, pad.t + ch);
      for (let i = 0; i < SECS.length; i++) {{
        const x = pad.l + (i / (SECS.length-1)) * cw;
        const vol = (DATA[SECS[i]] || {{}}).volume || 0;
        const y = pad.t + ch * (1 - vol / MAX_VOL);
        ctx.lineTo(x, y);
      }}
      ctx.lineTo(pad.l + cw, pad.t + ch);
      ctx.closePath(); ctx.fill();

      // 볼륨 라인
      ctx.strokeStyle = '#10B981'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < SECS.length; i++) {{
        const x = pad.l + (i / (SECS.length-1)) * cw;
        const vol = (DATA[SECS[i]] || {{}}).volume || 0;
        const y = pad.t + ch * (1 - vol / MAX_VOL);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }}
      ctx.stroke();

      // 컷 전환 라인
      ctx.strokeStyle = '#8B5CF6'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < SECS.length; i++) {{
        const x = pad.l + (i / (SECS.length-1)) * cw;
        const y = pad.t + ch * (1 - CUTS[i] / MAX_CUT);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }}
      ctx.stroke();

      // 컷 전환 점
      for (let i = 0; i < SECS.length; i++) {{
        const d = DATA[SECS[i]] || {{}};
        if (d.cut) {{
          const x = pad.l + (i / (SECS.length-1)) * cw;
          const y = pad.t + ch * (1 - CUTS[i] / MAX_CUT);
          ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2);
          ctx.fillStyle = '#307df0'; ctx.fill();
        }}
      }}
    }}

    function getSecFromX(clientX) {{
      const rect = timeline.getBoundingClientRect();
      const pad = {{l:30, r:10}};
      const cw = rect.width - pad.l - pad.r;
      let ratio = (clientX - rect.left - pad.l) / cw;
      ratio = Math.max(0, Math.min(1, ratio));
      return SECS[Math.round(ratio * (SECS.length - 1))];
    }}

    function update(sec) {{
      const rect = timeline.getBoundingClientRect();
      const pad = {{l:30, r:10}};
      const cw = rect.width - pad.l - pad.r;
      const idx = SECS.indexOf(sec);
      const x = pad.l + (idx / (SECS.length-1)) * cw;
      vline.style.left = x + 'px';
      vline.setAttribute('data-label', '0:' + String(sec).padStart(2,'0'));

      const d = DATA[sec] || {{}};
      frameSec.textContent = '[' + sec + '초]';
      // 감정 + 수치
      let emoHtml = '<span style="font-size:15px;">' + (d.emotion || '—') + '</span>';
      if (d.volume) emoHtml += ' <span style="color:#10B981;font-size:12px;">vol:' + d.volume + '</span>';
      if (d.pitch) emoHtml += ' <span style="color:#8B5CF6;font-size:12px;">pitch:' + d.pitch + 'Hz</span>';
      frameEmo.innerHTML = emoHtml;

      // 대본 (해당 초에 말하고 있는 내용)
      let scriptHtml = '';
      if (d.script) {{
        scriptHtml = '<div style="background:#F0F3F9;border:1px solid #E5E7EB;border-radius:8px;padding:8px 12px;margin:8px 0;font-size:14px;line-height:1.6;color:#121721;">"' + d.script + '"</div>';
      }}

      // OCR 자막 표시
      if (d.ocr) {{
        frameOcr.textContent = d.ocr;
        frameOcr.style.display = 'block';
      }} else {{
        frameOcr.style.display = 'none';
      }}

      if (d.img) {{
        frameImg.src = 'data:image/jpeg;base64,' + d.img;
        frameImg.style.display = 'block';
      }} else {{ frameImg.style.display = 'none'; }}

      if (d.desc) {{
        const parts = d.desc.split('|').map(p => p.trim()).filter(Boolean);
        frameText.innerHTML = scriptHtml + parts.map(p => '<div class="desc-line">' + p + '</div>').join('');
      }} else {{
        frameText.innerHTML = scriptHtml + '<div class="desc-line" style="color:#8B94A9;">프레임 데이터 없음</div>';
      }}

      // 감정 바 하이라이트
      emoBar.querySelectorAll('.seg').forEach(seg => {{
        seg.style.opacity = parseInt(seg.getAttribute('data-sec')) === sec ? '1' : '0.5';
      }});
    }}

    let dragging = false;
    timeline.addEventListener('mousedown', e => {{ dragging = true; const s = getSecFromX(e.clientX); update(s); }});
    window.addEventListener('mousemove', e => {{ if (dragging) {{ const s = getSecFromX(e.clientX); update(s); }} }});
    window.addEventListener('mouseup', () => {{ dragging = false; }});
    timeline.addEventListener('touchstart', e => {{ dragging = true; const s = getSecFromX(e.touches[0].clientX); update(s); }}, {{passive:true}});
    window.addEventListener('touchmove', e => {{ if (dragging) {{ const s = getSecFromX(e.touches[0].clientX); update(s); }} }}, {{passive:true}});
    window.addEventListener('touchend', () => {{ dragging = false; }});

    window.addEventListener('resize', resize);
    resize();
    update(SECS[0]);
    </script>
    """, height=560)

                    # JSON 내보내기
                    export_data = []
                    for sec in sorted_secs:
                        emo = audio_emo.get(sec, {})
                        export_data.append({
                            "timestamp": f"0:{sec:02d}" if sec < 60 else f"{sec//60}:{sec%60:02d}",
                            "second": sec,
                            "visual_caption": _frame_lines.get(sec, ""),
                            "ocr_text": ocr_subs.get(sec, ""),
                            "script": script_sec.get(sec, ""),
                            "emotion": emo.get("label", ""),
                            "pitch": emo.get("pitch", 0),
                            "volume": emo.get("volume", 0),
                            "cut_transition": bool(cut_markers[sorted_secs.index(sec)]),
                            "cut_transition_cumulative": cumulative_cuts[sorted_secs.index(sec)],
                        })
                    import json as _json2
                    json_str = _json2.dumps(export_data, ensure_ascii=False, indent=2)
                    st.download_button(
                        "📥 프레임 분석 JSON 다운로드",
                        data=json_str,
                        file_name=f"{selected}_frame_analysis.json",
                        mime="application/json",
                    )

                    # 요약
                    if _summary_lines:
                        st.markdown('\n'.join(_summary_lines))

                    # 전체 프레임 목록 (접기)
                    with st.expander("전체 프레임 보기"):
                        for sec in sorted_secs:
                            ocr_tag = f' 🔤 "{ocr_subs.get(sec, "")}"' if ocr_subs.get(sec) else ""
                            st.markdown(f"**[{sec}초]** {_frame_lines[sec]}{ocr_tag}")

                else:
                    # 파싱 실패 시 원본 텍스트 표시
                    st.markdown(analysis_text)

                # 나머지 섹션 (대본, 댓글 등)
                other_text = '\n'.join(_other_sections).strip()
                if other_text:
                    st.markdown(other_text)

        with detail_tab3:
            # ── 대본 구조 분석 ──
            ss = st.session_state.get("script_structure", {}).get(selected)
            if ss:
                st.markdown('<hr style="border-color:var(--border);margin:20px 0 16px;">', unsafe_allow_html=True)
                st.markdown('<p style="color:var(--text-muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin:0 0 12px;">대본 구조</p>', unsafe_allow_html=True)

                struct_cols = st.columns(4)
                sections_info = [
                    ("후킹", "hook", "#EF4444"),
                    ("인트로", "intro", "#8B5CF6"),
                    ("본문", "body", "#307df0"),
                    ("CTA", "cta", "#F59E0B"),
                ]
                for i, (title, key, color) in enumerate(sections_info):
                    with struct_cols[i]:
                        sec_data = ss.get(key, {})
                        sec_text = sec_data.get("text", "") if isinstance(sec_data, dict) else ""
                        sec_type = sec_data.get("type", "") if isinstance(sec_data, dict) else ""
                        sec_time = sec_data.get("seconds", "") if isinstance(sec_data, dict) else ""
                        sec_analysis = sec_data.get("analysis", "") if isinstance(sec_data, dict) else ""

                        st.markdown(f'''<div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:14px;border-top:3px solid {color};">
<div style="font-size:14px;font-weight:700;color:{color};margin-bottom:4px;">{title}</div>
<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">{sec_time}{(" | " + sec_type) if sec_type else ""}</div>
<div style="font-size:13px;color:var(--text-body);line-height:1.6;margin-bottom:8px;">"{sec_text[:150]}{"..." if len(sec_text) > 150 else ""}"</div>
<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">{sec_analysis}</div>
</div>''', unsafe_allow_html=True)

                # 전체 흐름 요약
                overall = ss.get("overall", {})
                if overall:
                    st.markdown(f'''<div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-top:12px;">
<div style="font-size:13px;color:var(--text-body);line-height:1.7;">
<strong>흐름:</strong> {overall.get("flow", "")}<br>
<strong style="color:var(--success);">강점:</strong> {overall.get("strength", "")}<br>
<strong style="color:var(--error);">개선:</strong> {overall.get("weakness", "")}
</div></div>''', unsafe_allow_html=True)
            else:
                st.info("대본 구조 분석 결과가 없습니다. '분석하기' 버튼을 눌러주세요.")

            analyzed_at = o.get("analyzed_at", "")
            if analyzed_at:
                st.markdown(f'<div style="color:var(--text-muted);font-size:11px;margin-top:6px;">analyzed: {analyzed_at[:10]}</div>', unsafe_allow_html=True)

    # ─────────────────────────────────────────
    # 그리드 리스트 뷰
    # ─────────────────────────────────────────
    elif bench_reels:
        # ── KPI 요약 ──
        total_reels = len(bench_reels)
        total_plays = sum(meta_map.get(r["shortcode"], {}).get("play_count") or 0 for r in bench_reels)
        avg_er_vals = [engagement_rate(meta_map.get(r["shortcode"], {}).get("like_count") or 0, meta_map.get(r["shortcode"], {}).get("play_count") or 0) for r in bench_reels if meta_map.get(r["shortcode"], {}).get("play_count")]
        avg_er = round(sum(avg_er_vals) / len(avg_er_vals), 2) if avg_er_vals else 0
        analyzed_count = sum(1 for r in bench_reels if r["shortcode"] in opus_map)

        st.markdown(f'''<div class="kpi-row">
<div class="kpi-card"><div class="kpi-label">전체 릴스</div><div class="kpi-value">{total_reels}</div></div>
<div class="kpi-card"><div class="kpi-label">총 조회수</div><div class="kpi-value">{fmt_num(total_plays)}</div></div>
<div class="kpi-card"><div class="kpi-label">평균 참여율</div><div class="kpi-value" style="color:{er_color(avg_er)};">{avg_er}%</div></div>
<div class="kpi-card"><div class="kpi-label">분석 완료</div><div class="kpi-value">{analyzed_count}<span style="font-size:14px;color:var(--text-muted);">/{total_reels}</span></div></div>
</div>''', unsafe_allow_html=True)

        # ── 필터 바 ──
        f_col1, f_col2 = st.columns([3, 1])
        with f_col1:
            _default_search = st.session_state.pop("bench_search", "")
            search_query = st.text_input("검색", value=_default_search, placeholder="작성자 또는 shortcode 검색...", label_visibility="collapsed")
        with f_col2:
            sort_option = st.pills("Sort", ["조회수순", "좋아요순", "ER순", "최신순"], default="조회수순", label_visibility="collapsed")

        filtered_reels = list(bench_reels)
        if search_query:
            q = search_query.lower()
            filtered_reels = [r for r in filtered_reels if q in (meta_map.get(r["shortcode"], {}).get("author_username") or r.get("author") or "").lower() or q in r["shortcode"].lower()]

        if sort_option == "조회수순":
            filtered_reels = sorted(filtered_reels, key=lambda r: meta_map.get(r["shortcode"], {}).get("play_count") or 0, reverse=True)
        elif sort_option == "좋아요순":
            filtered_reels = sorted(filtered_reels, key=lambda r: meta_map.get(r["shortcode"], {}).get("like_count") or 0, reverse=True)
        elif sort_option == "ER순":
            filtered_reels = sorted(filtered_reels, key=lambda r: engagement_rate(meta_map.get(r["shortcode"], {}).get("like_count") or 0, meta_map.get(r["shortcode"], {}).get("play_count") or 0), reverse=True)
        elif sort_option == "최신순":
            pass  # already ordered by collected_at desc

        if search_query and not filtered_reels:
            st.info(f'"{search_query}"에 대한 검색 결과가 없습니다.')

        # 카드 그리드 (페이지네이션 — 20개씩)
        CARDS_PER_PAGE = 20
        total_pages = max(1, (len(filtered_reels) + CARDS_PER_PAGE - 1) // CARDS_PER_PAGE)
        if "bench_page" not in st.session_state:
            st.session_state.bench_page = 0
        current_page = min(st.session_state.bench_page, total_pages - 1)
        page_reels = filtered_reels[current_page * CARDS_PER_PAGE:(current_page + 1) * CARDS_PER_PAGE]

        # 현재 페이지 썸네일 병렬 프리페치
        prefetch_thumbs([meta_map.get(r["shortcode"], {}).get("thumbnail_url", "") for r in page_reels])

        for row_start in range(0, len(page_reels), 5):
            cols = st.columns(5)
            for col_idx, r in enumerate(page_reels[row_start:row_start+5]):
                sc = r["shortcode"]
                m = meta_map.get(sc, {})
                author = m.get("author_username") or r.get("author") or "?"
                thumb = thumb_src(m.get("thumbnail_url", ""))

                target_date_str = m.get("taken_at")
                date_display = ""
                if target_date_str:
                    try:
                        date_part = target_date_str.split("T")[0]
                        dt_obj = datetime.strptime(date_part, "%Y-%m-%d")
                        delta = (datetime.now() - dt_obj).days
                        date_display = dt_obj.strftime("%y%m%d")
                    except Exception:
                        date_display = ""

                card_plays = m.get("play_count") or 0
                card_likes = m.get("like_count") or 0
                card_comments = m.get("comment_count") or 0
                card_er = engagement_rate(card_likes, card_plays)
                card_er_c = er_color(card_er)

                if thumb:
                    thumb_html = f'<img class="card-thumb" src="{thumb}" alt="">'
                else:
                    thumb_html = '<div class="card-thumb-placeholder">&#x25B6;</div>'

                er_badge_html = f'<div class="er-badge" style="color:{card_er_c}; border-color:{card_er_c}30;">{card_er}%</div>' if card_plays else ''

                # AD 뱃지 (캡션에서 광고 키워드 감지)
                card_caption = meta_map.get(sc, {}).get("caption_text") or ""
                _ad_kw = r"(광고|협찬|유료광고|paid\s*partnership|#ad\b|#sponsored|#광고|#협찬)"
                card_ad_html = '<div class="card-ad-badge">AD</div>' if re.search(_ad_kw, card_caption, re.IGNORECASE) else ''

                with cols[col_idx]:
                    st.markdown(f"""<div class="bench-card">
<div class="card-thumb-wrap">
{thumb_html}
{er_badge_html}
{card_ad_html}
</div>
<div class="card-info">
<div class="card-title">
  <span class="card-author">@{author}</span>
  <span class="card-days">{date_display}</span>
</div>
<div class="card-stats">
  <span class="stat-pill"><span class="stat-icon">&#x25B6;</span><span class="stat-value">{fmt_num(card_plays)}</span></span>
  <span class="stat-pill"><span class="stat-icon">&#x2764;</span><span class="stat-value">{fmt_num(card_likes)}</span></span>
  <span class="stat-pill"><span class="stat-icon">&#x1F4AC;</span><span class="stat-value">{fmt_num(card_comments)}</span></span>
</div>
</div>
</div>""", unsafe_allow_html=True)
                    if st.button(" ", key=f"sel_{sc}", use_container_width=True):
                        st.session_state.selected_reel = sc
                        st.query_params["page"] = "bench"
                        st.query_params["reel"] = sc
                        st.rerun()

        # 페이지네이션 (번호 버튼)
        if total_pages > 1:
            # 표시할 페이지 번호 계산 (최대 7개, 현재 페이지 중심)
            MAX_VISIBLE = 7
            if total_pages <= MAX_VISIBLE:
                visible_pages = list(range(total_pages))
            else:
                half = MAX_VISIBLE // 2
                start = max(0, current_page - half)
                end = start + MAX_VISIBLE
                if end > total_pages:
                    end = total_pages
                    start = end - MAX_VISIBLE
                visible_pages = list(range(start, end))

            btn_cols = st.columns([1] + [0.5] * (len(visible_pages) + 2 + (2 if visible_pages[0] > 0 else 0) + (2 if visible_pages[-1] < total_pages - 1 else 0)) + [1])
            col_idx = 1

            # ← 이전
            with btn_cols[col_idx]:
                if st.button("←", disabled=current_page == 0, key="pg_prev", use_container_width=True):
                    st.session_state.bench_page = current_page - 1
                    st.rerun()
            col_idx += 1

            # 첫 페이지 + ...
            if visible_pages[0] > 0:
                with btn_cols[col_idx]:
                    if st.button("1", key="pg_1", use_container_width=True):
                        st.session_state.bench_page = 0
                        st.rerun()
                col_idx += 1
                with btn_cols[col_idx]:
                    st.markdown("<div style='text-align:center;padding:6px;color:var(--text-muted);'>…</div>", unsafe_allow_html=True)
                col_idx += 1

            # 페이지 번호들
            for p in visible_pages:
                with btn_cols[col_idx]:
                    label = f"**{p+1}**" if p == current_page else str(p+1)
                    btn_type = "primary" if p == current_page else "secondary"
                    if st.button(str(p+1), key=f"pg_{p+1}", type=btn_type, use_container_width=True):
                        st.session_state.bench_page = p
                        st.rerun()
                col_idx += 1

            # ... + 마지막 페이지
            if visible_pages[-1] < total_pages - 1:
                with btn_cols[col_idx]:
                    st.markdown("<div style='text-align:center;padding:6px;color:var(--text-muted);'>…</div>", unsafe_allow_html=True)
                col_idx += 1
                with btn_cols[col_idx]:
                    if st.button(str(total_pages), key=f"pg_{total_pages}", use_container_width=True):
                        st.session_state.bench_page = total_pages - 1
                        st.rerun()
                col_idx += 1

            # → 다음
            with btn_cols[col_idx]:
                if st.button("→", disabled=current_page >= total_pages - 1, key="pg_next", use_container_width=True):
                    st.session_state.bench_page = current_page + 1
                    st.rerun()

        # ── 릴스 비교 ──
        compare_options = [f"@{meta_map.get(r['shortcode'], {}).get('author_username', '?')} — {r['shortcode']}" for r in filtered_reels[:50]]
        compare_selected = st.multiselect("비교할 릴스 선택 (최대 4개)", compare_options, max_selections=4, label_visibility="collapsed")

        if len(compare_selected) >= 2:
            st.markdown('<hr style="border-color:var(--border);margin:16px 0;">', unsafe_allow_html=True)
            st.markdown("### 릴스 비교")
            compare_cols = st.columns(len(compare_selected))
            for i, label in enumerate(compare_selected):
                csc = label.split(" — ")[1]
                cm = meta_map.get(csc, {})
                c_plays = cm.get("play_count") or 0
                c_likes = cm.get("like_count") or 0
                c_comments = cm.get("comment_count") or 0
                c_er = engagement_rate(c_likes, c_plays)
                c_er_c = er_color(c_er)
                c_author = cm.get("author_username") or "?"
                c_thumb = thumb_src(cm.get("thumbnail_url", ""))
                c_duration = cm.get("video_duration") or 0

                with compare_cols[i]:
                    if c_thumb:
                        st.markdown(f'<img src="{c_thumb}" style="width:100%;border-radius:10px;aspect-ratio:9/16;object-fit:cover;">', unsafe_allow_html=True)
                    st.markdown(f'''<div style="padding:10px 0;">
<div style="font-weight:600;font-size:14px;color:var(--text-primary);">@{c_author}</div>
<div style="font-size:12px;color:var(--text-muted);margin:4px 0 8px;">{csc}</div>
<div style="display:flex;flex-direction:column;gap:4px;font-size:13px;">
<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-secondary);">조회수</span><span style="font-weight:600;">{fmt_num(c_plays)}</span></div>
<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-secondary);">좋아요</span><span style="font-weight:600;">{fmt_num(c_likes)}</span></div>
<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-secondary);">댓글</span><span style="font-weight:600;">{fmt_num(c_comments)}</span></div>
<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-secondary);">참여율</span><span style="font-weight:600;color:{c_er_c};">{c_er}%</span></div>
<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-secondary);">길이</span><span style="font-weight:600;">{c_duration:.0f}초</span></div>
</div>
</div>''', unsafe_allow_html=True)
                    if st.button("상세 보기", key=f"compare_go_{csc}"):
                        st.session_state.selected_reel = csc
                        st.query_params["page"] = "bench"
                        st.query_params["reel"] = csc
                        st.rerun()

        # 하단 액션 바
        pending = [r["shortcode"] for r in bench_reels if r["shortcode"] not in meta_map]
        col_info, col_action = st.columns([3, 1])
        with col_info:
            st.caption(f"{len(filtered_reels)} / {len(bench_reels)} reels")
        with col_action:
            if pending:
                if st.button(f"메타데이터 {len(pending)}개 수집", use_container_width=True):
                    progress = st.progress(0)
                    for i, sc in enumerate(pending):
                        data = fetch_metadata(sc)
                        if data:
                            save_metadata(sc, data)
                        progress.progress((i + 1) / len(pending))
                    st.cache_data.clear()
                    st.rerun()

    else:
        st.info("등록된 벤치마크 영상이 없습니다. 아래에서 릴스 URL을 등록해주세요.")



# =============================================
# 분석
# =============================================
elif page == "분석":
    st.markdown("""
    <div class="main-header">
        <h1>분석</h1>
        <p>릴스 개별 심층 분석 결과를 확인합니다</p>
    </div>
    """, unsafe_allow_html=True)

    bench_reels_a, all_meta_a, _, all_opus_a, _ = load_bench_data()
    meta_map_a = {m["shortcode"]: m for m in all_meta_a} if all_meta_a else {}
    opus_map_a = {o["shortcode"]: o for o in all_opus_a} if all_opus_a else {}

    analyzed_reels = [r for r in bench_reels_a if r["shortcode"] in opus_map_a]

    if not analyzed_reels:
        st.info("분석된 릴스가 없습니다.")
        if st.button("벤치마크로 이동", type="primary"):
            st.session_state.page = "벤치마크"
            st.query_params["page"] = "bench"
            st.rerun()
    else:
        # KPI
        total_analyzed = len(analyzed_reels)
        total_all = len(bench_reels_a)
        avg_plays = int(sum(meta_map_a.get(r["shortcode"], {}).get("play_count") or 0 for r in analyzed_reels) / max(total_analyzed, 1))
        avg_er_vals = [engagement_rate(meta_map_a.get(r["shortcode"], {}).get("like_count") or 0, meta_map_a.get(r["shortcode"], {}).get("play_count") or 0) for r in analyzed_reels if meta_map_a.get(r["shortcode"], {}).get("play_count")]
        avg_er = round(sum(avg_er_vals) / max(len(avg_er_vals), 1), 2)

        st.markdown(f'''<div class="kpi-row">
<div class="kpi-card"><div class="kpi-label">분석 완료</div><div class="kpi-value">{total_analyzed}<span style="font-size:14px;color:var(--text-muted);">/{total_all}</span></div></div>
<div class="kpi-card"><div class="kpi-label">평균 조회수</div><div class="kpi-value">{fmt_num(avg_plays)}</div></div>
<div class="kpi-card"><div class="kpi-label">평균 참여율</div><div class="kpi-value">{avg_er}%</div></div>
</div>''', unsafe_allow_html=True)

        a_col1, a_col2 = st.columns([3, 1])
        with a_col1:
            a_search = st.text_input("검색", placeholder="작성자 또는 shortcode 검색...", key="analysis_search", label_visibility="collapsed")
        with a_col2:
            a_sort = st.pills("정렬", ["최신순", "조회수순", "참여율순"], default="최신순", key="analysis_sort", label_visibility="collapsed")

        display_reels = list(analyzed_reels)
        if a_search:
            q = a_search.lower()
            display_reels = [r for r in display_reels if q in (meta_map_a.get(r["shortcode"], {}).get("author_username") or r.get("author") or "").lower() or q in r["shortcode"].lower()]

        if a_sort == "조회수순":
            display_reels = sorted(display_reels, key=lambda r: meta_map_a.get(r["shortcode"], {}).get("play_count") or 0, reverse=True)
        elif a_sort == "참여율순":
            display_reels = sorted(display_reels, key=lambda r: engagement_rate(meta_map_a.get(r["shortcode"], {}).get("like_count") or 0, meta_map_a.get(r["shortcode"], {}).get("play_count") or 0), reverse=True)

        if not display_reels and a_search:
            st.info(f'"{a_search}"에 대한 검색 결과가 없습니다.')

        for r in display_reels:
            sc = r["shortcode"]
            ma = meta_map_a.get(sc, {})
            oa = opus_map_a.get(sc, {})
            a_author = ma.get("author_username") or r.get("author") or "?"
            a_plays = ma.get("play_count") or 0
            a_likes = ma.get("like_count") or 0
            a_er = engagement_rate(a_likes, a_plays)
            a_er_c = er_color(a_er)
            thumb = thumb_src(ma.get("thumbnail_url", ""))
            analyzed_at = oa.get("analyzed_at", "")[:10] if oa.get("analyzed_at") else ""

            # 분석 요약 첫 2줄 추출
            analysis_full = oa.get("analysis", "")
            summary_lines = [l.strip() for l in analysis_full.split("\n") if l.strip() and not l.strip().startswith("#")][:2]
            summary_text = " ".join(summary_lines)[:150]

            # 카드형 요약
            thumb_html = f'<img src="{thumb}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;">' if thumb else '<div style="width:48px;height:48px;border-radius:8px;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;color:var(--text-dim);">▶</div>'

            st.markdown(f'''<div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px 16px;margin-bottom:8px;display:flex;gap:14px;align-items:flex-start;">
{thumb_html}
<div style="flex:1;min-width:0;">
<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
<span style="font-weight:600;font-size:14px;color:var(--text-primary);">@{a_author}</span>
<span style="font-size:12px;color:var(--text-muted);">{sc}</span>
<span style="margin-left:auto;font-size:11px;color:{a_er_c};font-weight:600;background:{a_er_c}15;padding:2px 7px;border-radius:4px;">ER {a_er}%</span>
</div>
<div style="display:flex;gap:12px;font-size:12px;color:var(--text-secondary);margin-bottom:6px;">
<span>조회 {fmt_num(a_plays)}</span><span>좋아요 {fmt_num(a_likes)}</span>{f'<span>분석일 {analyzed_at}</span>' if analyzed_at else ''}
</div>
<div style="font-size:13px;color:var(--text-muted);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{summary_text}{"..." if len(summary_text) >= 150 else ""}</div>
</div>
</div>''', unsafe_allow_html=True)

            with st.expander("전체 분석 보기"):
                st.markdown(analysis_full)
                if st.button("벤치마크에서 보기", key=f"goto_{sc}"):
                    st.session_state.page = "벤치마크"
                    st.session_state.selected_reel = sc
                    st.query_params["page"] = "bench"
                    st.query_params["reel"] = sc
                    st.rerun()


# =============================================
# 트렌드
# =============================================
elif page == "트렌드":
    st.markdown("""
    <div class="main-header">
        <h1>트렌드</h1>
        <p>수집된 릴스의 트렌드와 성과를 분석합니다</p>
    </div>
    """, unsafe_allow_html=True)

    @st.cache_data(ttl=30)
    def load_trend_data():
        with ThreadPoolExecutor(max_workers=2) as ex:
            f_meta = ex.submit(sb_get, "reels_metadata", "select=*&order=fetched_at.desc&limit=500")
            f_reels = ex.submit(sb_get, "reels", "select=shortcode,account_category&limit=10000")
        return f_meta.result(), f_reels.result()

    meta_data, trend_reels_data = load_trend_data()

    if not meta_data:
        st.info("메타데이터가 부족합니다. 먼저 메타데이터를 수집해주세요.")
    else:
        df = pd.DataFrame(meta_data)
        meta_map_t = {m["shortcode"]: m for m in meta_data}

        # ── 트렌드 필터 ──
        fil_col1, fil_col2 = st.columns(2)
        with fil_col1:
            period = st.pills("기간", ["전체", "7일", "30일", "90일"], default="전체", label_visibility="collapsed")
        with fil_col2:
            reels_cat_df = pd.DataFrame(trend_reels_data) if trend_reels_data else pd.DataFrame()
            cat_list = ["전체 카테고리"]
            if not reels_cat_df.empty and "account_category" in reels_cat_df.columns:
                cat_list += sorted(reels_cat_df["account_category"].dropna().unique().tolist())
            category_filter = st.selectbox("카테고리", cat_list, label_visibility="collapsed")

        if "taken_at" in df.columns and period != "전체":
            df["_taken_dt"] = pd.to_datetime(df["taken_at"], errors="coerce")
            days_map = {"7일": 7, "30일": 30, "90일": 90}
            cutoff = datetime.now() - timedelta(days=days_map.get(period, 9999))
            df = df[df["_taken_dt"] >= cutoff]

        if category_filter != "전체 카테고리" and trend_reels_data:
            cat_scs = {r["shortcode"] for r in trend_reels_data if r.get("account_category") == category_filter}
            df = df[df["shortcode"].isin(cat_scs)]

        # 조회수 TOP 10
        if "play_count" in df.columns:
            df["play_count"] = pd.to_numeric(df["play_count"], errors="coerce")
            top = df.dropna(subset=["play_count"]).nlargest(10, "play_count")
            if not top.empty:
                fig = go.Figure(go.Bar(
                    x=top["shortcode"],
                    y=top["play_count"],
                    marker=dict(
                        color=top["play_count"],
                        colorscale=[[0, "#307df0"], [1, "#8B5CF6"]],
                    ),
                    hovertemplate="<b>%{x}</b><br>Views: %{y:,.0f}<extra></extra>",
                ))
                fig.update_layout(**PLOTLY_LAYOUT, xaxis_title="", yaxis_title="Views")
                st.markdown('<div class="chart-title">조회수 TOP 10</div>', unsafe_allow_html=True)
                st.plotly_chart(fig, use_container_width=True, config=PLOTLY_CONFIG)
                top_scs = top["shortcode"].tolist()
                top_labels = [f"@{meta_map_t.get(sc, {}).get('author_username', '?')} — {sc}" for sc in top_scs]
                drill = st.selectbox("릴스 상세 보기", ["선택하세요..."] + top_labels, key="trend_drill_top10", label_visibility="collapsed")
                if drill != "선택하세요...":
                    drill_sc = drill.split(" — ")[1]
                    st.session_state.page = "벤치마크"
                    st.session_state.selected_reel = drill_sc
                    st.query_params["page"] = "bench"
                    st.query_params["reel"] = drill_sc
                    st.rerun()

        # 인기 오디오 — 가로 바 차트
        if "music_title" in df.columns:
            music = df["music_title"].dropna().value_counts().head(10)
            if not music.empty:
                fig2 = go.Figure(go.Bar(
                    x=music.values[::-1],
                    y=music.index[::-1],
                    orientation='h',
                    marker=dict(
                        color=music.values[::-1],
                        colorscale=[[0, "#10B981"], [1, "#307df0"]],
                    ),
                    hovertemplate="<b>%{y}</b><br>Count: %{x}<extra></extra>",
                ))
                fig2.update_layout(**PLOTLY_LAYOUT, xaxis_title="사용 횟수", yaxis_title="")
                st.markdown('<div class="chart-title">인기 오디오 TOP 10</div>', unsafe_allow_html=True)
                st.plotly_chart(fig2, use_container_width=True, config=PLOTLY_CONFIG)
                pass  # chart title only, no wrapper needed

        # 좋아요 vs 조회수 — 스캐터 + 트렌드라인
        col_scatter, col_cat = st.columns(2)

        with col_scatter:
            if "like_count" in df.columns and "play_count" in df.columns:
                df["like_count"] = pd.to_numeric(df["like_count"], errors="coerce")
                scatter_df = df.dropna(subset=["play_count", "like_count"])
                if not scatter_df.empty:
                    fig3 = px.scatter(scatter_df, x="play_count", y="like_count",
                                      hover_data=["shortcode"], trendline="ols",
                                      color_discrete_sequence=["#307df0"])
                    fig3.update_traces(marker=dict(size=8, opacity=0.7, line=dict(width=1, color="#8B5CF6")))
                    fig3.update_layout(**PLOTLY_LAYOUT, xaxis_title="Views", yaxis_title="Likes")
                    if len(fig3.data) > 1:
                        fig3.data[1].line.color = "#10B981"
                        fig3.data[1].line.dash = "dot"
                    st.markdown('<div class="chart-title">조회수 vs 좋아요 상관관계</div>', unsafe_allow_html=True)
                    st.plotly_chart(fig3, use_container_width=True, config=PLOTLY_CONFIG)
                    pass  # chart title only, no wrapper needed

        with col_cat:
            # 카테고리별 평균 조회수
            if trend_reels_data and "play_count" in df.columns:
                reels_df = pd.DataFrame(trend_reels_data)
                merged = df.merge(reels_df, on="shortcode", how="left")
                if "account_category" in merged.columns:
                    cat_avg = merged.groupby("account_category")["play_count"].mean().sort_values(ascending=False)
                    if not cat_avg.empty:
                        fig4 = go.Figure(go.Bar(
                            x=cat_avg.index,
                            y=cat_avg.values,
                            marker=dict(
                                color=cat_avg.values,
                                colorscale=[[0, "#307df0"], [0.5, "#8B5CF6"], [1, "#F59E0B"]],
                            ),
                            hovertemplate="<b>%{x}</b><br>Avg Views: %{y:,.0f}<extra></extra>",
                        ))
                        fig4.update_layout(**PLOTLY_LAYOUT, xaxis_title="", yaxis_title="Avg Views")
                        st.markdown('<div class="chart-title">카테고리별 평균 조회수</div>', unsafe_allow_html=True)
                        st.plotly_chart(fig4, use_container_width=True, config=PLOTLY_CONFIG)
                        pass  # chart title only, no wrapper needed


# =============================================
# 4. 채널 관리 페이지
# =============================================
elif page == "채널":

    st.markdown("""
    <div class="main-header">
        <h1>채널 관리</h1>
        <p>모니터링할 인스타그램 채널을 등록하면 매일 자동으로 릴스를 수집합니다</p>
    </div>
    """, unsafe_allow_html=True)

    # ── 채널 등록 ──
    st.markdown("### 채널 추가")
    with st.form("add_channel", clear_on_submit=True):
        channel_input = st.text_area(
            "인스타그램 채널",
            placeholder="한 줄에 하나씩 입력 (URL, @username, username 모두 가능)\n\nhttps://instagram.com/username1\n@username2\nusername3",
            height=120,
            label_visibility="collapsed",
        )
        submitted = st.form_submit_button("추가", use_container_width=True)

        if submitted and channel_input:
            import re as _re
            lines = [l.strip() for l in channel_input.strip().splitlines() if l.strip()]
            success_list = []
            fail_list = []

            for line in lines:
                _m = _re.search(r'instagram\.com/([A-Za-z0-9._]+)', line)
                username = _m.group(1) if _m else line.lstrip("@").strip()
                if not username or not _re.match(r'^[A-Za-z0-9._]+$', username):
                    fail_list.append(line)
                    continue

                if sb_post("monitored_channels", {"username": username, "is_active": True}):
                    success_list.append(username)
                else:
                    fail_list.append(f"@{username} (이미 등록됨)")

            if success_list:
                st.success(f"{len(success_list)}개 등록 완료: {', '.join(f'@{u}' for u in success_list)}")

                # 등록 즉시 자동 수집
                if gramsnap_util:
                    progress = st.progress(0)
                    status = st.empty()
                    total_collected = 0
                    for i, username in enumerate(success_list):
                        status.text(f"[{i+1}/{len(success_list)}] @{username} 릴스 수집 중...")
                        try:
                            reels = gramsnap_util.fetch_reels(username)
                            for r in reels:
                                meta = gramsnap_util.post_to_metadata(r)
                                meta["author_username"] = username
                                sb_post("reels", {
                                    "shortcode": r.shortcode,
                                    "url": f"https://www.instagram.com/reel/{r.shortcode}/",
                                    "author": username,
                                    "caption": (r.caption or "")[:200],
                                    "source": "gramsnap",
                                    "collected_at": datetime.utcnow().isoformat(),
                                })
                                sb_post("reels_metadata", meta)
                                total_collected += 1
                            requests.patch(
                                f"{SUPABASE_URL}/rest/v1/monitored_channels?username=eq.{username}",
                                headers={**SUPABASE_HEADERS, "Prefer": "return=minimal"},
                                json={"last_collected_at": datetime.utcnow().isoformat(), "reel_count": len(reels)},
                            )
                            status.text(f"[{i+1}/{len(success_list)}] @{username}: {len(reels)}개 완료")
                        except Exception as e:
                            status.text(f"[{i+1}/{len(success_list)}] @{username}: 수집 실패 - {e}")
                        progress.progress((i + 1) / len(success_list))
                    status.success(f"자동 수집 완료! {total_collected}개 릴스")

                st.cache_data.clear()
            if fail_list:
                st.warning(f"{len(fail_list)}개 실패: {', '.join(fail_list)}")

    # ── 등록된 채널 목록 ──
    st.markdown("### 등록된 채널")
    channels = sb_get("monitored_channels", "select=*&order=created_at.desc")

    if not channels:
        st.info("등록된 채널이 없습니다. 위 입력란에 인스타그램 @username을 입력하고 '추가'를 눌러주세요.")
    else:
        for ch in channels:
            username = ch.get("username", "?")
            last_collected = ch.get("last_collected_at", "")
            reel_count = ch.get("reel_count", 0)
            last_display = last_collected[:10] if last_collected else "미수집"

            cols = st.columns([2.5, 1, 1, 0.7, 0.5])
            with cols[0]:
                st.markdown(f"**@{username}**")
            with cols[1]:
                st.caption(f"릴스 {reel_count}개")
            with cols[2]:
                st.caption(last_display)
            with cols[3]:
                if reel_count and st.button("릴스", key=f"reels_{username}"):
                    st.session_state.page = "벤치마크"
                    st.session_state.bench_search = username
                    st.query_params["page"] = "bench"
                    st.rerun()
            with cols[4]:
                with st.popover("삭제"):
                    st.warning(f"@{username} 채널을 삭제하시겠습니까?")
                    if st.button("삭제 확인", key=f"confirm_delete_{username}", type="primary"):
                        requests.delete(
                            f"{SUPABASE_URL}/rest/v1/monitored_channels?username=eq.{username}",
                            headers=SUPABASE_HEADERS,
                        )
                        st.cache_data.clear()
                        st.rerun()
