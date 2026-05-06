"""
Reels Trend CLI
릴스 수집/분석/트렌드를 CLI에서 처리합니다.

사용법:
  python cli.py run <shortcode>               # 한방에 전부 처리 (메타 + 대본 + 분석)
  python cli.py run --batch 10                # 미처리 10건 한방에
  python cli.py run --url <릴스URL>           # URL로 한방에
  python cli.py list                          # 수집된 릴스 목록
  python cli.py list --category beauty        # 카테고리별 필터
  python cli.py status                        # 전체 현황
  python cli.py meta <shortcode>              # 개별 메타데이터 수집
  python cli.py meta --batch 10               # 미수집 10건 일괄 처리
  python cli.py analyze <shortcode>           # 대본 + 프레임 분석
  python cli.py analyze --batch 5             # 미분석 5건 일괄 처리
  python cli.py trend                         # 트렌드 요약
  python cli.py trend --top 10                # 조회수 TOP 10
  python cli.py trend --audio                 # 인기 오디오
  python cli.py export                        # JSON 내보내기
  python cli.py design --screenshot "img.png" # 스크린샷 → 디자인 시스템 생성
  python cli.py design --prompt "미니멀 라이트" # 텍스트로 디자인 요청
  python cli.py design --refs "a.png" "b.png" # 레퍼런스 여러 장 분석
  python cli.py design --improve              # 현재 dashboard/style.css 개선
"""

import os
import sys
import json
import base64
import tempfile
import subprocess
from pathlib import Path
from datetime import datetime

import requests
from dotenv import load_dotenv

try:
    import gramsnap_util
except ImportError:
    gramsnap_util = None

# 인코딩 설정
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

# .env 로드
ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(ENV_PATH)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
HIKER_API_KEY = os.getenv("HIKER_API_KEY")
GEMMA4_API_URL = os.getenv("GEMMA4_API_URL")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

GEMINI_VISION_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"

try:
    import imageio_ffmpeg
    FFMPEG_PATH = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    FFMPEG_PATH = "ffmpeg"

SB_HEADERS = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Content-Type": "application/json"
}


# =============================================
# Supabase 헬퍼
# =============================================
def sb_get(table, params=""):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=SB_HEADERS)
    return r.json() if r.status_code == 200 else []

def sb_post(table, data):
    h = {**SB_HEADERS, "Prefer": "resolution=merge-duplicates"}
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=h, json=data)
    return r.status_code in [200, 201]


# =============================================
# status: 전체 현황
# =============================================
def cmd_status():
    reels = sb_get("reels", "select=id&limit=100000")
    meta = sb_get("reels_metadata", "select=id&limit=100000")
    transcripts = sb_get("reels_transcripts", "select=id&limit=100000")

    print("=" * 40)
    print("  Reels Trend - 현황")
    print("=" * 40)
    print(f"  수집된 릴스     : {len(reels)}")
    print(f"  메타데이터 완료 : {len(meta)}")
    print(f"  대본 추출 완료  : {len(transcripts)}")
    print(f"  메타 미처리     : {max(0, len(reels) - len(meta))}")
    print(f"  분석 미처리     : {max(0, len(reels) - len(transcripts))}")
    print("=" * 40)

    # 카테고리별
    reels_data = sb_get("reels", "select=account_category&limit=100000")
    if reels_data:
        cats = {}
        for r in reels_data:
            c = r.get("account_category") or "unknown"
            cats[c] = cats.get(c, 0) + 1
        print("\n  카테고리별:")
        for cat, count in sorted(cats.items(), key=lambda x: -x[1]):
            print(f"    {cat:12s} : {count}")


# =============================================
# list: 릴스 목록
# =============================================
def cmd_list(category=None, limit=20):
    params = f"select=shortcode,url,author,account_category,views_text,collected_at&order=collected_at.desc&limit={limit}"
    if category:
        params += f"&account_category=eq.{category}"

    data = sb_get("reels", params)
    if not data:
        print("���집된 릴스가 없습니다.")
        return

    print(f"\n{'#':>3} {'Shortcode':15s} {'작성자':15s} {'카테고리':10s} {'조회수':15s} {'수집일':12s}")
    print("-" * 75)
    for i, r in enumerate(data, 1):
        sc = r.get("shortcode", "")[:15]
        author = (r.get("author") or "-")[:15]
        cat = (r.get("account_category") or "-")[:10]
        views = (r.get("views_text") or "-")[:15]
        date = (r.get("collected_at") or "")[:10]
        print(f"{i:3d} {sc:15s} {author:15s} {cat:10s} {views:15s} {date:12s}")

    print(f"\n총 {len(data)}건")


# =============================================
# meta: 메타데이터 수집
# =============================================
def fetch_and_save_meta(shortcode, username=None):
    """메타데이터 수집 (GramSnap 우선, HikerAPI 폴백)"""
    data = None
    row = None

    # GramSnap 시도
    if gramsnap_util and username:
        try:
            print(f"[GramSnap] {username}/{shortcode} 수집 중...")
            post = gramsnap_util.find_by_shortcode(username, shortcode)
            if post:
                row = gramsnap_util.post_to_metadata(post)
                row["author_username"] = username
                # GramSnap 결과를 HikerAPI 호환 dict로도 만들어둠
                data = {
                    "video_url": post.video_url,
                    "play_count": post.video_views,
                    "view_count": post.video_views,
                    "like_count": post.likes,
                    "comment_count": post.comments,
                    "caption_text": post.caption,
                    "thumbnail_url": post.display_url,
                    "user": {"username": username},
                }
                print(f"[GramSnap] 수집 완료")
        except Exception as e:
            print(f"[GramSnap] 에러: {e}, HikerAPI로 폴백")

    # HikerAPI 폴백
    if not data and HIKER_API_KEY:
        print(f"[HikerAPI] {shortcode} 수집 중...")
        r = requests.get(
            "https://api.hikerapi.com/v1/media/by/code",
            params={"code": shortcode},
            headers={"accept": "application/json", "x-access-key": HIKER_API_KEY},
            timeout=30
        )
        if r.status_code != 200:
            print(f"  실패: {r.status_code}")
            return None

        data = r.json()
        row = {
            "shortcode": shortcode,
            "play_count": data.get("play_count") or data.get("view_count"),
            "like_count": data.get("like_count"),
            "comment_count": data.get("comment_count"),
            "video_url": data.get("video_url"),
            "video_duration": data.get("video_duration"),
            "thumbnail_url": data.get("thumbnail_url"),
            "caption_text": data.get("caption_text"),
            "author_username": data.get("user", {}).get("username") if isinstance(data.get("user"), dict) else None,
        }

        clips = data.get("clips_metadata", {})
        if isinstance(clips, dict):
            music = clips.get("music_info", {})
            if isinstance(music, dict):
                asset = music.get("music_asset_info", {})
                row["music_artist"] = asset.get("display_artist")
                row["music_title"] = asset.get("title")

    if not data or not row:
        print(f"  수집 실패")
        return None

    if sb_post("reels_metadata", row):
        plays = row.get("play_count") or 0
        likes = row.get("like_count") or 0
        print(f"  완료: 조회 {plays:,} | 좋아요 {likes:,} | 오디오: {row.get('music_title') or '-'}")
    else:
        print(f"  DB 저장 실패")

    return data


def cmd_meta(shortcode=None, batch=0):
    if shortcode:
        fetch_and_save_meta(shortcode)
    elif batch > 0:
        all_reels = sb_get("reels", "select=shortcode&limit=100000")
        all_meta = sb_get("reels_metadata", "select=shortcode&limit=100000")
        done = {m["shortcode"] for m in all_meta}
        pending = [r["shortcode"] for r in all_reels if r["shortcode"] not in done]

        if not pending:
            print("미수집 릴스가 없습니다.")
            return

        targets = pending[:batch]
        print(f"미수집 {len(pending)}건 중 {len(targets)}건 처리")
        print()

        for i, sc in enumerate(targets, 1):
            print(f"[{i}/{len(targets)}] ", end="")
            fetch_and_save_meta(sc)

        print(f"\n완료: {len(targets)}건 처리")


# =============================================
# analyze: 대본 + 프레임 분석
# =============================================
def cmd_analyze(shortcode=None, batch=0):
    if shortcode:
        analyze_single(shortcode)
    elif batch > 0:
        all_reels = sb_get("reels", "select=shortcode&limit=100000")
        all_trans = sb_get("reels_transcripts", "select=shortcode&limit=100000")
        done = {t["shortcode"] for t in all_trans}
        pending = [r["shortcode"] for r in all_reels if r["shortcode"] not in done]

        if not pending:
            print("미분석 릴스가 없습니다.")
            return

        targets = pending[:batch]
        print(f"미분석 {len(pending)}건 중 {len(targets)}건 처리\n")

        for i, sc in enumerate(targets, 1):
            print(f"\n[{i}/{len(targets)}] {sc}")
            try:
                analyze_single(sc)
            except Exception as e:
                print(f"  에러: {e}")


def analyze_single(shortcode):
    # 비디오 URL 가져오기
    meta = sb_get("reels_metadata", f"select=video_url&shortcode=eq.{shortcode}&limit=1")
    video_url = None

    if meta and meta[0].get("video_url"):
        video_url = meta[0]["video_url"]
    else:
        print("  메타데이터에서 비디오 URL 없음, HikerAPI 호출...")
        data = fetch_and_save_meta(shortcode)
        if data:
            video_url = data.get("video_url")

    if not video_url:
        print("  비디오 URL 없음. 건너뜀.")
        return

    with tempfile.TemporaryDirectory() as tmpdir:
        video_path = os.path.join(tmpdir, "reel.mp4")
        audio_path = os.path.join(tmpdir, "audio.mp3")
        frames_dir = os.path.join(tmpdir, "frames")

        # 다운로드
        print("  다운로드 중...")
        r = requests.get(video_url, stream=True, timeout=60)
        with open(video_path, "wb") as f:
            for chunk in r.iter_content(8192):
                f.write(chunk)

        # 오디오 → Whisper
        print("  대본 추출 중...")
        subprocess.run([FFMPEG_PATH, "-i", video_path, "-vn", "-acodec", "libmp3lame", audio_path, "-y"],
                       capture_output=True)

        transcript_text = ""
        duration = 0
        if os.path.exists(audio_path) and os.path.getsize(audio_path) > 0:
            with open(audio_path, "rb") as f:
                wr = requests.post(
                    "https://api.openai.com/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                    files={"file": ("audio.mp3", f, "audio/mpeg")},
                    data={"model": "whisper-1", "language": "ko", "response_format": "verbose_json"},
                    timeout=120
                )
            if wr.status_code == 200:
                wd = wr.json()
                transcript_text = wd.get("text", "")
                duration = wd.get("duration", 0)
                sb_post("reels_transcripts", {
                    "shortcode": shortcode,
                    "transcript": transcript_text,
                    "language": wd.get("language", "ko"),
                    "duration_seconds": duration
                })
                print(f"  대본: {transcript_text[:100]}...")

        # 프레임 → Gemma 4
        print("  프레임 분석 중...")
        os.makedirs(frames_dir, exist_ok=True)
        subprocess.run([FFMPEG_PATH, "-i", video_path, "-vf", "fps=3.33", "-q:v", "2",
                        os.path.join(frames_dir, "frame_%04d.jpg"), "-y"], capture_output=True)

        frames = sorted(Path(frames_dir).glob("frame_*.jpg"))
        if frames:
            step = max(1, len(frames) // 6)
            selected = [frames[i] for i in range(0, len(frames), step)][:6]

            analyses = []
            for frame in selected:
                with open(frame, "rb") as f:
                    img_b64 = base64.b64encode(f.read()).decode()
                try:
                    gr = requests.post(
                        f"{GEMMA4_API_URL}/api/chat",
                        headers={"ngrok-skip-browser-warning": "true"},
                        json={
                            "model": "gemma4:31b",
                            "messages": [{"role": "user",
                                          "content": "이 릴스 프레임 분석: 1) 텍스트 2) 장면 3) 편집 스타일. 간결하게.",
                                          "images": [img_b64]}],
                            "stream": False
                        },
                        timeout=180
                    )
                    if gr.status_code == 200:
                        analyses.append(gr.json()["message"]["content"])
                except:
                    pass

            # 종합 분석
            if analyses:
                frames_text = "\n".join([f"프레임{i+1}: {a[:150]}" for i, a in enumerate(analyses)])
                try:
                    sr = requests.post(
                        f"{GEMMA4_API_URL}/api/chat",
                        headers={"ngrok-skip-browser-warning": "true"},
                        json={
                            "model": "gemma4:31b",
                            "messages": [{"role": "user", "content": f"""릴스 분석 종합해줘.

대본: {transcript_text or '(없음)'}

프레임:
{frames_text}

정리: 1) 주제 2) 후킹 3) 편집 4) 화법 5) 잘 될 이유. 간결하게 한국어로."""}],
                            "stream": False
                        },
                        timeout=180
                    )
                    if sr.status_code == 200:
                        synthesis = sr.json()["message"]["content"]
                        print(f"\n  === 종합 분석 ===\n{synthesis}")
                except:
                    pass

        print(f"\n  완료: {shortcode} ({duration:.0f}초)")


# =============================================
# run: 한방에 전부 처리 (HikerAPI + Whisper + Gemma4)
# =============================================
def cmd_run(shortcode=None, url=None, batch=0, collect_only=False):
    if url:
        # URL에서 shortcode 추출
        import re
        match = re.search(r'/reel/([A-Za-z0-9_-]+)', url)
        if match:
            shortcode = match.group(1)
        else:
            print(f"URL에서 shortcode를 추출할 수 없습니다: {url}")
            return

    if shortcode:
        run_single(shortcode, collect_only=collect_only)
    elif batch > 0:
        all_reels = sb_get("reels", "select=shortcode&limit=100000")
        all_trans = sb_get("reels_transcripts", "select=shortcode&limit=100000")
        done = {t["shortcode"] for t in all_trans}
        pending = [r["shortcode"] for r in all_reels if r["shortcode"] not in done]

        if not pending:
            print("미처리 릴스가 없습니다.")
            return

        targets = pending[:batch]
        print(f"미처리 {len(pending)}건 중 {len(targets)}건 처리\n")

        for i, sc in enumerate(targets, 1):
            print(f"\n{'='*50}")
            print(f"[{i}/{len(targets)}] {sc}")
            print('='*50)
            try:
                run_single(sc, collect_only=collect_only)
            except Exception as e:
                print(f"  에러: {e}")
    else:
        print("shortcode, --url, 또는 --batch를 지정하세요.")


def run_single(shortcode, collect_only=False):
    """
    풀 파이프라인: HikerAPI → 댓글 스크래핑 → ffmpeg → Whisper → Gemma4 → (Opus)
    collect_only=True: 1~6단계만 실행, JSON 출력 (Opus는 외부에서 처리)
    """
    start_time = datetime.now()

    # ── STEP 1: HikerAPI 메타데이터 ──
    print("\n[1/7] HikerAPI 메타데이터 수집")
    data = fetch_and_save_meta(shortcode)
    if not data:
        print("  HikerAPI 실패. 중단.")
        return

    video_url = data.get("video_url")
    if not video_url:
        print("  비디오 URL 없음. 중단.")
        return

    plays = data.get("play_count") or data.get("view_count") or 0
    likes = data.get("like_count") or 0
    comment_count = data.get("comment_count") or 0
    caption = data.get("caption_text") or ""
    author = data.get("user", {}).get("username") if isinstance(data.get("user"), dict) else ""

    music_title = None
    music_artist = None
    clips = data.get("clips_metadata", {})
    if isinstance(clips, dict):
        music = clips.get("music_info", {})
        if isinstance(music, dict):
            asset = music.get("music_asset_info", {})
            music_title = asset.get("title")
            music_artist = asset.get("display_artist")

    # ── STEP 2: 댓글 스크래핑 (비로그인) ──
    print("\n[2/7] 댓글 스크래핑 (비로그인)")
    comments_list = scrape_comments(shortcode)
    if comments_list:
        print(f"  {len(comments_list)}개 댓글 수집")
        # Supabase 저장
        for c in comments_list:
            sb_post("reels_comments", {
                "shortcode": shortcode,
                "comment_text": c.get("text"),
                "comment_author": c.get("author"),
                "comment_likes": c.get("likes", 0),
            })
    else:
        print("  댓글 수집 실패 또는 댓글 없음")

    with tempfile.TemporaryDirectory() as tmpdir:
        video_path = os.path.join(tmpdir, "reel.mp4")
        audio_path = os.path.join(tmpdir, "audio.mp3")
        frames_dir = os.path.join(tmpdir, "frames")

        # ── STEP 3: 영상 다운로드 ──
        print("\n[3/7] 영상 다운로드")
        r = requests.get(video_url, stream=True, timeout=60)
        with open(video_path, "wb") as f:
            for chunk in r.iter_content(8192):
                f.write(chunk)
        size_mb = os.path.getsize(video_path) / (1024*1024)
        print(f"  완료 ({size_mb:.1f}MB)")

        # ── STEP 4: ffmpeg 프레임 + 오디오 추출 ──
        print("\n[4/7] ffmpeg 프레임 + 오디오 추출")
        os.makedirs(frames_dir, exist_ok=True)

        # 오디오 추출
        subprocess.run([FFMPEG_PATH, "-i", video_path, "-vn", "-acodec", "libmp3lame", audio_path, "-y"],
                       capture_output=True)

        # 프레임 추출 (1초 간격 + 480p 리사이즈로 속도 최적화)
        subprocess.run([FFMPEG_PATH, "-i", video_path, "-vf", "fps=1,scale=480:-2", "-q:v", "4",
                        os.path.join(frames_dir, "frame_%04d.jpg"), "-y"], capture_output=True)

        frames = sorted(Path(frames_dir).glob("frame_*.jpg"))
        print(f"  프레임 {len(frames)}장 (480p) | 오디오 {'있음' if os.path.exists(audio_path) else '없음'}")

        # ── STEP 5: Whisper 대본 추출 ──
        print("\n[5/7] Whisper 대본 추출")
        transcript_text = ""
        duration = 0

        if os.path.exists(audio_path) and os.path.getsize(audio_path) > 0:
            with open(audio_path, "rb") as f:
                wr = requests.post(
                    "https://api.openai.com/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                    files={"file": ("audio.mp3", f, "audio/mpeg")},
                    data={"model": "whisper-1", "language": "ko", "response_format": "verbose_json"},
                    timeout=120
                )
            if wr.status_code == 200:
                wd = wr.json()
                transcript_text = wd.get("text", "")
                duration = wd.get("duration", 0)
                sb_post("reels_transcripts", {
                    "shortcode": shortcode,
                    "transcript": transcript_text,
                    "language": wd.get("language", "ko"),
                    "duration_seconds": duration
                })
                print(f"  {duration:.0f}초 | {transcript_text[:80]}...")
            else:
                print(f"  Whisper 실패: {wr.status_code}")
        else:
            print("  오디오 없음 (음악만 있는 릴스일 수 있음)")

        # ── STEP 6: Gemini Vision 프레임 분석 ──
        print("\n[6/7] Gemini Vision 프레임 분석")
        frame_analyses = []

        if frames:
            # 3장 선별: 시작(후킹), 중간, 끝
            if len(frames) >= 3:
                selected = [frames[0], frames[len(frames)//2], frames[-1]]
            else:
                selected = frames
            print(f"  {len(frames)}장 중 {len(selected)}장 선별 (시작/중간/끝)")

            for idx, frame in enumerate(selected):
                with open(frame, "rb") as f:
                    img_b64 = base64.b64encode(f.read()).decode()
                try:
                    gr = requests.post(
                        GEMINI_VISION_URL,
                        json={
                            "contents": [{
                                "parts": [
                                    {"text": "이 인스타 릴스 프레임을 분석해줘: 1) 화면에 보이는 모든 텍스트 2) 장면 설명 (인물, 배경, 구도, 카메라 앵글) 3) 편집 스타일 (자막 디자인, 색감, 필터). 간결하게 한국어로."},
                                    {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}}
                                ]
                            }]
                        },
                        timeout=60
                    )
                    if gr.status_code == 200:
                        content = gr.json()["candidates"][0]["content"]["parts"][0]["text"]
                        frame_analyses.append({"index": idx + 1, "analysis": content})
                        print(f"  프레임 {idx+1}/{len(selected)} 완료")
                    else:
                        print(f"  프레임 {idx+1} 실패: {gr.status_code} {gr.text[:100]}")
                except Exception as e:
                    print(f"  프레임 {idx+1} 에러: {e}")
        else:
            print("  프레임 추출 실패")

    # ── 수집 결과 정리 ──
    collected = {
        "shortcode": shortcode,
        "url": f"https://www.instagram.com/reel/{shortcode}/",
        "author": author,
        "plays": plays,
        "likes": likes,
        "comment_count": comment_count,
        "caption": caption,
        "music_title": music_title,
        "music_artist": music_artist,
        "duration": duration,
        "transcript": transcript_text,
        "frame_analyses": [fa["analysis"] for fa in frame_analyses],
        "comments": comments_list,
    }

    if collect_only:
        # ── collect-only: JSON 출력 (Opus 분석은 외부에서) ──
        elapsed = (datetime.now() - start_time).total_seconds()
        print(f"\n[수집 완료] {elapsed:.0f}초 소요")
        print("\n===COLLECT_RESULT_JSON_START===")
        print(json.dumps(collected, ensure_ascii=False, indent=2))
        print("===COLLECT_RESULT_JSON_END===")
        return collected

    else:
        # ── STEP 7: Opus 종합 분석 ──
        print("\n[7/7] Claude Opus 종합 분석")
        synthesis = opus_synthesize(
            shortcode=shortcode,
            plays=plays,
            likes=likes,
            comment_count=comment_count,
            caption=caption,
            author=author,
            music_title=music_title,
            music_artist=music_artist,
            duration=duration,
            transcript=transcript_text,
            frame_analyses=frame_analyses,
            comments=comments_list
        )

    # ── 결과 출력 ──
    elapsed = (datetime.now() - start_time).total_seconds()

    print("\n" + "=" * 60)
    print(f"  릴스 분석 완료: {shortcode}")
    print("=" * 60)
    print(f"\n  URL: https://www.instagram.com/reel/{shortcode}/")
    print(f"  작성자: @{author}")
    print(f"  조회수: {plays:,} | 좋아요: {likes:,} | 댓글: {comment_count:,}")
    print(f"  오디오: {music_title or '원본'} {('- ' + music_artist) if music_artist else ''}")
    print(f"  영상 길이: {duration:.0f}초")
    print(f"  처리 시간: {elapsed:.0f}초")

    if transcript_text:
        print(f"\n  ── 대본 ──")
        print(f"  {transcript_text}")

    if comments_list:
        print(f"\n  ── 주요 댓글 ({len(comments_list)}개) ──")
        for c in comments_list[:5]:
            print(f"  @{c.get('author', '?')}: {c.get('text', '')[:60]}")

    if synthesis:
        print(f"\n  ── Opus 종합 분석 ──")
        print(f"  {synthesis}")

    print("\n" + "=" * 60)


# =============================================
# save-opus: Opus 분석 결과를 Supabase에 저장
# =============================================
def cmd_save_opus(shortcode, analysis_text):
    """Opus 분석 결과를 Supabase에 저장"""
    if sb_post("opus_analyses", {"shortcode": shortcode, "analysis": analysis_text}):
        print(f"[Supabase] Opus 분석 저장 완료: {shortcode}")
    else:
        print(f"[Supabase] 저장 실패")


# =============================================
# 댓글 스크래핑 (비로그인)
# =============================================
def scrape_comments(shortcode):
    """인스타 릴스 페이지에서 댓글 추출 (비로그인, 웹 스크래핑)"""
    url = f"https://www.instagram.com/reel/{shortcode}/"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    }

    try:
        resp = requests.get(url, headers=headers, timeout=30)
        if resp.status_code != 200:
            return []

        html = resp.text
        comments = []

        # 방법 1: JSON-LD / SharedData에서 추출
        import re

        # window._sharedData 패턴
        shared_match = re.search(r'window\._sharedData\s*=\s*({.+?});</script>', html)
        if shared_match:
            try:
                shared = json.loads(shared_match.group(1))
                media = shared.get("entry_data", {}).get("PostPage", [{}])[0].get("graphql", {}).get("shortcode_media", {})
                edges = media.get("edge_media_to_parent_comment", {}).get("edges", [])
                for edge in edges:
                    node = edge.get("node", {})
                    comments.append({
                        "text": node.get("text", ""),
                        "author": node.get("owner", {}).get("username", ""),
                        "likes": node.get("edge_liked_by", {}).get("count", 0),
                    })
                if comments:
                    return comments
            except:
                pass

        # 방법 2: 메타 태그 / og:description에서 댓글 힌트
        # (비로그인에서는 제한적)

        # 방법 3: __a=1 GraphQL 요청
        try:
            gql_url = f"https://www.instagram.com/p/{shortcode}/?__a=1&__d=dis"
            gql_resp = requests.get(gql_url, headers=headers, timeout=15)
            if gql_resp.status_code == 200:
                gql_data = gql_resp.json()
                items = gql_data.get("items", [])
                if items:
                    preview = items[0].get("preview_comments", [])
                    for c in preview:
                        comments.append({
                            "text": c.get("text", ""),
                            "author": c.get("user", {}).get("username", ""),
                            "likes": c.get("comment_like_count", 0),
                        })
        except:
            pass

        return comments

    except Exception as e:
        print(f"  스크래핑 에러: {e}")
        return []


# =============================================
# Claude Opus 종합 분석
# =============================================
def opus_synthesize(shortcode, plays, likes, comment_count, caption, author,
                    music_title, music_artist, duration, transcript,
                    frame_analyses, comments):
    """Claude Opus로 모든 데이터를 종합 분석"""

    # 프레임 분석 텍스트
    frames_text = ""
    if frame_analyses:
        frames_text = "\n".join([
            f"프레임 {fa['index']}: {fa['analysis'][:300]}"
            for fa in frame_analyses
        ])

    # 댓글 텍스트
    comments_text = ""
    if comments:
        comments_text = "\n".join([
            f"@{c.get('author', '?')} (좋아요 {c.get('likes', 0)}): {c.get('text', '')[:100]}"
            for c in comments[:15]
        ])

    prompt = f"""당신은 인스타그램 릴스 트렌드 분석 전문가입니다.
아래 데이터는 하나의 인스타 릴스를 여러 도구로 분석한 결과입니다. 이를 종합적으로 분석해주세요.

## 기본 정보
- URL: https://www.instagram.com/reel/{shortcode}/
- 작성자: @{author}
- 조회수: {plays:,}
- 좋아요: {likes:,} (좋아요율: {(likes/max(plays,1)*100):.2f}%)
- 댓글: {comment_count:,}
- 영상 길이: {duration:.0f}초
- 오디오: {music_title or '원본 오디오'} {('- ' + music_artist) if music_artist else ''}

## 캡션
{caption[:500] if caption else '(없음)'}

## 대본 (Whisper로 추출한 음성 텍스트)
{transcript if transcript else '(음성 없음 - 음악/효과음만 있는 릴스)'}

## 프레임별 영상 분석 (Gemma4 Vision)
{frames_text if frames_text else '(프레임 분석 없음)'}

## 댓글 반응 (웹 스크래핑)
{comments_text if comments_text else '(댓글 수집 안 됨)'}

---

다음 항목을 분석해주세요:

### 1. 콘텐츠 분석
- 주제/카테고리
- 핵심 메시지

### 2. 영상 구조 분석
- 후킹 방식 (첫 1~2초에 어떻게 시선을 잡는지)
- 영상 전개 구조 (도입-전개-마무리)
- 장면 전환 패턴

### 3. 편집 분석
- 자막 스타일 (폰트, 색상, 위치, 애니메이션)
- 색감/필터
- 컷 빈도와 리듬

### 4. 화법 분석
- 말투/톤 (격식, 비격식, 자극적, 친근 등)
- 대본 구조 (질문형 시작, 스토리텔링, 정보 나열 등)

### 5. 댓글 반응 분석
- 긍정/부정 비율
- 가장 많이 공감받는 반응
- 시청자가 관심 갖는 포인트

### 6. 성과 분석
- 이 릴스가 잘 된 이유 (조회수 {plays:,} 기준)
- 좋아요율 {(likes/max(plays,1)*100):.2f}%의 의미

### 7. 벤치마킹 포인트
- 이 릴스에서 배울 수 있는 것 3가지
- 비슷한 릴스를 만든다면 어떻게 할지

한국어로 상세하게 분석해주세요."""

    # Anthropic API 호출
    if ANTHROPIC_API_KEY:
        try:
            resp = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json"
                },
                json={
                    "model": "claude-opus-4-0-20250514",
                    "max_tokens": 4096,
                    "messages": [{"role": "user", "content": prompt}]
                },
                timeout=120
            )
            if resp.status_code == 200:
                result = resp.json()
                return result["content"][0]["text"]
            else:
                print(f"  Opus API 실패: {resp.status_code} {resp.text[:200]}")
        except Exception as e:
            print(f"  Opus API 에러: {e}")

    # 폴백: Gemma4로 종합 분석
    print("  Anthropic API 키 없음 또는 실패. Gemma4로 폴백.")
    try:
        sr = requests.post(
            f"{GEMMA4_API_URL}/api/chat",
            headers={"ngrok-skip-browser-warning": "true"},
            json={
                "model": "gemma4:31b",
                "messages": [{"role": "user", "content": prompt}],
                "stream": False
            },
            timeout=300
        )
        if sr.status_code == 200:
            return sr.json()["message"]["content"]
    except Exception as e:
        print(f"  Gemma4 폴백 에러: {e}")

    return None


# =============================================
# trend: 트렌드
# =============================================
def cmd_trend(top=10, audio=False):
    meta = sb_get("reels_metadata", "select=*&order=fetched_at.desc&limit=500")
    if not meta:
        print("메타데이터가 없습니다. 먼저 'python cli.py meta --batch 10'을 실행하세요.")
        return

    if audio:
        # 인기 오디오
        print("\n  인기 오디오 TOP 10")
        print("=" * 50)
        music_count = {}
        for m in meta:
            title = m.get("music_title")
            if title:
                artist = m.get("music_artist") or "unknown"
                key = f"{title} - {artist}"
                music_count[key] = music_count.get(key, 0) + 1

        for i, (title, count) in enumerate(sorted(music_count.items(), key=lambda x: -x[1])[:10], 1):
            print(f"  {i:2d}. {title:40s} ({count}회)")
    else:
        # 조회수 TOP
        print(f"\n  조회수 TOP {top}")
        print("=" * 70)
        sorted_meta = sorted(meta, key=lambda x: x.get("play_count") or 0, reverse=True)[:top]

        print(f"  {'#':>3} {'Shortcode':15s} {'조회수':>12s} {'좋아요':>10s} {'댓글':>8s} {'작성자':15s}")
        print("  " + "-" * 65)
        for i, m in enumerate(sorted_meta, 1):
            sc = (m.get("shortcode") or "")[:15]
            plays = m.get("play_count") or 0
            likes = m.get("like_count") or 0
            comments = m.get("comment_count") or 0
            author = (m.get("author_username") or "-")[:15]
            print(f"  {i:3d} {sc:15s} {plays:>12,} {likes:>10,} {comments:>8,} {author:15s}")

    # 카테고리별 평균
    reels_data = sb_get("reels", "select=shortcode,account_category&limit=100000")
    if reels_data:
        cat_map = {r["shortcode"]: r.get("account_category") or "unknown" for r in reels_data}
        cat_stats = {}
        for m in meta:
            cat = cat_map.get(m.get("shortcode"), "unknown")
            plays = m.get("play_count") or 0
            if cat not in cat_stats:
                cat_stats[cat] = {"total": 0, "count": 0}
            cat_stats[cat]["total"] += plays
            cat_stats[cat]["count"] += 1

        print(f"\n  카테고리별 평균 조회수")
        print("  " + "-" * 35)
        for cat, s in sorted(cat_stats.items(), key=lambda x: -x[1]["total"] / max(x[1]["count"], 1)):
            avg = s["total"] / max(s["count"], 1)
            print(f"  {cat:12s} : 평균 {avg:>10,.0f} ({s['count']}건)")


# =============================================
# design: 디자이너 에이전트
# =============================================
def cmd_design(screenshot=None, prompt=None, references=None, improve=False):
    if not any([screenshot, prompt, references, improve]):
        print("사용법:")
        print('  python cli.py design --screenshot "screenshot.png"')
        print('  python cli.py design --prompt "미니멀 라이트 대시보드"')
        print('  python cli.py design --refs "ref1.png" "ref2.png"')
        print('  python cli.py design --improve')
        return

    from agents.designer.designer import (
        analyze_screenshot, analyze_multiple_references,
        design_system, generate_code, OUTPUT_DIR
    )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # 1단계: Gemini 시각 분석
    visual_analysis = None
    if screenshot:
        print(f"\n[1/3] Gemini — 스크린샷 분석: {screenshot}")
        visual_analysis = analyze_screenshot(screenshot)
    elif references:
        print(f"\n[1/3] Gemini — 레퍼런스 {len(references)}장 분석")
        visual_analysis = analyze_multiple_references(references)
    else:
        print(f"\n[1/3] Gemini — 스킵 (텍스트 요청)")

    if visual_analysis:
        path = OUTPUT_DIR / f"visual_analysis_{timestamp}.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(visual_analysis, f, ensure_ascii=False, indent=2)
        print(f"  → 저장: {path}")

    # 2단계: GPT-4o 디자인 설계
    current_css = None
    if improve:
        css_path = Path(__file__).parent / "dashboard" / "style.css"
        if css_path.exists():
            with open(css_path, "r", encoding="utf-8") as f:
                current_css = f.read()
            print(f"\n[2/3] GPT-4o — 기존 CSS 개선 모드 ({len(current_css)}자)")
        else:
            print(f"\n[2/3] GPT-4o — dashboard/style.css 없음, 새로 생성")
    else:
        print(f"\n[2/3] GPT-4o — 디자인 시스템 설계")

    tokens = design_system(
        visual_analysis=visual_analysis,
        user_prompt=prompt,
        current_css=current_css
    )

    if not tokens:
        print("[실패] 디자인 시스템 설계 실패")
        return

    tokens_path = OUTPUT_DIR / f"design_system_{timestamp}.json"
    with open(tokens_path, "w", encoding="utf-8") as f:
        json.dump(tokens, f, ensure_ascii=False, indent=2)
    print(f"  → 저장: {tokens_path}")

    # 3단계: Sonnet 코드 생성
    print(f"\n[3/3] Sonnet — CSS 코드 생성")
    css = generate_code(tokens, target="streamlit")

    if css:
        css_out = OUTPUT_DIR / f"style_{timestamp}.css"
        with open(css_out, "w", encoding="utf-8") as f:
            f.write(css)
        latest = OUTPUT_DIR / "style_latest.css"
        with open(latest, "w", encoding="utf-8") as f:
            f.write(css)
        print(f"  → 저장: {css_out}")
        print(f"  → 최신: {latest}")

    # 결과 요약
    print("\n" + "=" * 50)
    print(f"  디자인: {tokens.get('name', 'N/A')} ({tokens.get('theme', 'N/A')})")
    if tokens.get("design_rationale"):
        print(f"  근거: {tokens['design_rationale'][:150]}")
    print(f"\n  적용하려면:")
    print(f"    cp agents/designer/output/style_latest.css dashboard/style.css")
    print("=" * 50)


# =============================================
# export: JSON 내보내기
# =============================================
def cmd_export():
    reels = sb_get("reels", "select=*&limit=100000")
    meta = sb_get("reels_metadata", "select=*&limit=100000")
    transcripts = sb_get("reels_transcripts", "select=*&limit=100000")

    export = {
        "exported_at": datetime.now().isoformat(),
        "reels": reels,
        "metadata": meta,
        "transcripts": transcripts
    }

    filename = f"reels_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(export, f, ensure_ascii=False, indent=2)

    print(f"내보내기 완료: {filename}")
    print(f"  릴스: {len(reels)}건 | 메타: {len(meta)}건 | 대본: {len(transcripts)}건")


# =============================================
# 메인
# =============================================
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    cmd = sys.argv[1]

    if cmd == "run":
        shortcode = None
        url = None
        batch = 0
        collect_only = "--collect-only" in sys.argv
        for i, arg in enumerate(sys.argv[2:], 2):
            if arg == "--batch" and i + 1 < len(sys.argv):
                batch = int(sys.argv[i + 1])
            elif arg == "--url" and i + 1 < len(sys.argv):
                url = sys.argv[i + 1]
            elif not arg.startswith("-"):
                shortcode = arg
        cmd_run(shortcode=shortcode, url=url, batch=batch, collect_only=collect_only)

    elif cmd == "status":
        cmd_status()

    elif cmd == "list":
        category = None
        limit = 20
        for i, arg in enumerate(sys.argv[2:], 2):
            if arg == "--category" and i + 1 < len(sys.argv):
                category = sys.argv[i + 1]
            if arg == "--limit" and i + 1 < len(sys.argv):
                limit = int(sys.argv[i + 1])
        cmd_list(category=category, limit=limit)

    elif cmd == "meta":
        shortcode = None
        batch = 0
        for i, arg in enumerate(sys.argv[2:], 2):
            if arg == "--batch" and i + 1 < len(sys.argv):
                batch = int(sys.argv[i + 1])
            elif not arg.startswith("-"):
                shortcode = arg
        cmd_meta(shortcode=shortcode, batch=batch)

    elif cmd == "analyze":
        shortcode = None
        batch = 0
        for i, arg in enumerate(sys.argv[2:], 2):
            if arg == "--batch" and i + 1 < len(sys.argv):
                batch = int(sys.argv[i + 1])
            elif not arg.startswith("-"):
                shortcode = arg
        cmd_analyze(shortcode=shortcode, batch=batch)

    elif cmd == "trend":
        top = 10
        audio = False
        for i, arg in enumerate(sys.argv[2:], 2):
            if arg == "--top" and i + 1 < len(sys.argv):
                top = int(sys.argv[i + 1])
            if arg == "--audio":
                audio = True
        cmd_trend(top=top, audio=audio)

    elif cmd == "export":
        cmd_export()

    elif cmd == "design":
        screenshot = None
        prompt = None
        references = []
        improve = "--improve" in sys.argv
        i = 2
        while i < len(sys.argv):
            arg = sys.argv[i]
            if arg == "--screenshot" and i + 1 < len(sys.argv):
                i += 1
                screenshot = sys.argv[i]
            elif arg == "--prompt" and i + 1 < len(sys.argv):
                i += 1
                prompt = sys.argv[i]
            elif arg == "--refs":
                i += 1
                while i < len(sys.argv) and not sys.argv[i].startswith("--"):
                    references.append(sys.argv[i])
                    i += 1
                continue
            i += 1
        cmd_design(
            screenshot=screenshot,
            prompt=prompt,
            references=references if references else None,
            improve=improve
        )

    else:
        print(f"알 수 없는 명령: {cmd}")
        print(__doc__)


if __name__ == "__main__":
    main()
