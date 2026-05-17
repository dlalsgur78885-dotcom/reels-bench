"""Main analysis pipeline: orchestrates all analysis steps"""

import os
import base64
import tempfile
import subprocess
import logging
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

import requests
from dotenv import load_dotenv

from . import supabase, whisper, gemini, gemini3_audio, frame_storage, comments as comments_svc

logger = logging.getLogger(__name__)

ENV_PATH = Path(__file__).parent.parent.parent / ".env"
load_dotenv(ENV_PATH)

HIKER_API_KEY = os.getenv("HIKER_API_KEY")

try:
    import imageio_ffmpeg
    FFMPEG_PATH = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    FFMPEG_PATH = "ffmpeg"

# In-memory state
analysis_status: dict[str, dict] = {}
analysis_cache: dict[str, dict] = {}

# Extra cache with disk persistence
import json as _json

_EXTRA_DIR = Path(__file__).parent.parent.parent / "extra_cache"
try:
    _EXTRA_DIR.mkdir(exist_ok=True)
except OSError:
    # Read-only FS (e.g. Vercel /var/task) → fall back to /tmp
    _EXTRA_DIR = Path("/tmp/extra_cache")
    _EXTRA_DIR.mkdir(exist_ok=True)


class _ExtraCache:
    """Dict-like with JSON file persistence per shortcode."""
    def get(self, sc, default=None):
        # memory first
        p = _EXTRA_DIR / f"{sc}.json"
        if p.exists():
            try:
                return _json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                pass
        return default

    def __setitem__(self, sc, data):
        # exclude frame_images (too large for JSON), skip None values
        save = {k: v for k, v in data.items() if k != "frame_images" and v is not None}
        p = _EXTRA_DIR / f"{sc}.json"
        # merge with existing (new values override, but None won't overwrite)
        if p.exists():
            try:
                existing = _json.loads(p.read_text(encoding="utf-8"))
                existing.update(save)
                save = existing
            except Exception:
                pass
        p.write_text(_json.dumps(save, ensure_ascii=False), encoding="utf-8")

    def __contains__(self, sc):
        return (_EXTRA_DIR / f"{sc}.json").exists()


extra_cache = _ExtraCache()


def _download_video(video_url, output_path):
    r = requests.get(video_url, stream=True, timeout=60)
    r.raise_for_status()
    with open(output_path, "wb") as f:
        for chunk in r.iter_content(8192):
            f.write(chunk)


def _extract_frames(video_path, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    # 1초 단위 프레임
    cmd = [FFMPEG_PATH, "-i", video_path, "-vf", "fps=1", "-q:v", "2",
           os.path.join(output_dir, "frame_%04d.jpg"), "-y"]
    subprocess.run(cmd, capture_output=True, text=True)
    # ⭐ 마지막 프레임 보정 — fps=1은 26.44초 비디오에서 26초 프레임을 놓침 (소수점 끝 컷)
    # ffprobe로 duration 가져와서 마지막 0.05초 지점 frame 추가 추출
    try:
        probe = subprocess.run(
            [FFMPEG_PATH, "-i", video_path],
            capture_output=True, text=True, timeout=10,
        )
        # stderr에 "Duration: HH:MM:SS.MS" 형식으로 들어있음
        import re as _re
        m = _re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", probe.stderr)
        duration = 0.0
        if m:
            h, mn, sec = int(m.group(1)), int(m.group(2)), float(m.group(3))
            duration = h * 3600 + mn * 60 + sec
        existing = sorted(Path(output_dir).glob("frame_*.jpg"))
        n_existing = len(existing)
        # fps=1은 round-down이라 N초 비디오에서 N개 frame (0초~N-1초). N+1초 frame이 없음
        # 비디오 끝부분 (duration - 0.05) 시점이 마지막 frame보다 0.5초 이상 뒤면 last frame 추출
        last_existing_sec = n_existing - 1  # 0-based
        last_pos = max(0.0, duration - 0.1)  # 끝 0.1초 전
        if last_pos > last_existing_sec + 0.4:
            last_idx = n_existing + 1
            last_path = os.path.join(output_dir, f"frame_{last_idx:04d}.jpg")
            subprocess.run(
                [FFMPEG_PATH, "-ss", f"{last_pos:.3f}", "-i", video_path,
                 "-vframes", "1", "-q:v", "2", last_path, "-y"],
                capture_output=True, text=True, timeout=15,
            )
    except Exception as e:
        logger.warning("last-frame extraction failed: %s", e)
    return sorted(Path(output_dir).glob("frame_*.jpg"))


def _extract_audio(video_path, output_path):
    cmd = [FFMPEG_PATH, "-i", video_path, "-vn", "-acodec", "libmp3lame",
           "-q:a", "2", output_path, "-y"]
    subprocess.run(cmd, capture_output=True, text=True)
    return output_path if os.path.exists(output_path) else None


def _get_video_url(shortcode, username=None):
    """Get fresh video URL: FB Ads Library for fb_*, otherwise GramSnap → HikerAPI"""
    # FB 광고 — Ad Library 페이지를 다시 열어서 video_url 재발급
    if shortcode.startswith("fb_"):
        ad_id = shortcode[3:]
        if not ad_id:
            return None
        try:
            from api.services.fb_ads_scraper import AdLibraryScraper
            import asyncio as _asyncio
            ad = _asyncio.run(AdLibraryScraper(headless=True).scrape_single_by_id(ad_id))
            v = (ad or {}).get("video_url")
            if v:
                return v
        except Exception as e:
            logger.warning("FB Ads re-scrape error: %s", e)
        return None

    # GramSnap (always fresh URLs)
    try:
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent.parent))
        import gramsnap_util
        # username이 없으면 메타데이터에서 가져오기
        if not username:
            meta = supabase.sb_get("reels_metadata", f"shortcode=eq.{shortcode}&select=author_username&limit=1")
            if meta:
                username = meta[0].get("author_username")
        if username:
            post = gramsnap_util.find_by_shortcode(username, shortcode)
            if post and post.video_url:
                return post.video_url
    except Exception as e:
        logger.warning("GramSnap error: %s", e)

    # HikerAPI fallback
    if HIKER_API_KEY:
        r = requests.get(
            "https://api.hikerapi.com/v1/media/by/code",
            params={"code": shortcode},
            headers={"accept": "application/json", "x-access-key": HIKER_API_KEY},
            timeout=30,
        )
        if r.status_code == 200:
            return r.json().get("video_url")
    return None


def run(shortcode: str, skip_pro_audio: bool = False):
    """Full analysis pipeline (runs in background).

    skip_pro_audio=True 면 Gemini 3 Pro 오디오 분석 생략 (B 단계만, ≈$0.025)
    """
    analysis_status[shortcode] = {"status": "running", "step": "비디오 다운로드", "progress": 0}

    try:
        # 1. Video URL
        meta = supabase.sb_get("reels_metadata", f"shortcode=eq.{shortcode}&limit=1")
        video_url = meta[0].get("video_url") if meta else None

        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "reel.mp4")
            audio_path = os.path.join(tmpdir, "audio.mp3")
            frames_dir = os.path.join(tmpdir, "frames")

            # 2. Download + extract (with GramSnap retry on 403)
            analysis_status[shortcode] = {"status": "running", "step": "다운로드 + 추출", "progress": 5}
            downloaded = False
            if video_url:
                try:
                    _download_video(video_url, video_path)
                    downloaded = True
                except Exception:
                    pass

            if not downloaded:
                # Fresh URL via GramSnap/HikerAPI
                fresh_url = _get_video_url(shortcode)
                if not fresh_url:
                    analysis_status[shortcode] = {"status": "error", "message": "비디오 URL 없음 (만료)"}
                    return
                video_url = fresh_url
                _download_video(video_url, video_path)
                # Update DB with fresh URL
                supabase.sb_post("reels_metadata", {"shortcode": shortcode, "video_url": video_url})

            frame_paths = _extract_frames(video_path, frames_dir)
            audio_file = _extract_audio(video_path, audio_path)

            # ⭐ 썸네일 자동 업로드 — 첫 프레임을 webp로 변환 후 thumbs bucket에 저장
            try:
                from api.services import thumb as _thumb
                if frame_paths and not _thumb.exists_in_storage(shortcode):
                    first_frame = frame_paths[0]
                    if os.path.isfile(first_frame):
                        with open(first_frame, "rb") as fp:
                            jpg_bytes = fp.read()
                        webp = _thumb._to_webp(jpg_bytes)
                        if _thumb._upload_to_storage(shortcode, webp):
                            _thumb._update_db_url(shortcode)
                            try:
                                _thumb._webp_path(shortcode).write_bytes(webp)
                            except Exception:
                                pass
                            logger.info("[pipeline] thumbnail uploaded from first frame for %s", shortcode)
            except Exception as e:
                logger.warning("[pipeline] thumbnail upload failed for %s: %s", shortcode, e)

            # 3. Whisper (always run for segments)
            analysis_status[shortcode] = {"status": "running", "step": "대본 추출 (Whisper)", "progress": 15}
            existing_trans = supabase.sb_get("reels_transcripts", f"shortcode=eq.{shortcode}&limit=1")
            transcript_text = ""
            whisper_segments = []
            if audio_file:
                td = whisper.transcribe(audio_file)
                if td:
                    transcript_text = td["transcript"]
                    whisper_segments = td.get("segments", [])
                    if not existing_trans:
                        # segments도 함께 저장 → /api/extra에서 sentences/script_by_sec 복원 가능
                        seg_save = [
                            {
                                "start": round(s.get("start", 0), 1),
                                "end": round(s.get("end", 0), 1),
                                "text": s.get("text", "").strip(),
                            }
                            for s in (td.get("segments") or [])
                        ]
                        supabase.sb_post("reels_transcripts", {
                            "shortcode": shortcode,
                            "transcript": td["transcript"],
                            "language": td.get("language"),
                            "segments": seg_save,
                        })
            elif existing_trans:
                transcript_text = existing_trans[0].get("transcript", "")

            # 4. Save frame images to disk + load base64 for memory
            _FRAMES_DIR = Path(__file__).parent.parent.parent / "frames" / shortcode
            _FRAMES_DIR.mkdir(parents=True, exist_ok=True)
            frame_images = {}
            frame_str_paths = []
            if frame_paths:
                for idx, fp in enumerate(frame_paths):
                    raw = fp.read_bytes()
                    frame_images[idx + 1] = base64.b64encode(raw).decode()
                    # save to disk
                    (_FRAMES_DIR / f"{idx + 1}.jpg").write_bytes(raw)
                    frame_str_paths.append(str(fp))

            # 5-7. Parallel: OCR + frames + emotion (text analysis deferred to Claude Code)
            analysis_status[shortcode] = {"status": "running", "step": "병렬 분석 (OCR + 프레임 + 감정)", "progress": 30}
            caption = meta[0].get("caption_text", "") if meta else ""

            with ThreadPoolExecutor(max_workers=5) as ex:
                f_ocr = ex.submit(gemini.ocr_subtitles, frame_str_paths)
                f_frames = ex.submit(gemini.analyze_frames, frame_str_paths)
                f_storage = ex.submit(frame_storage.upload_dir, shortcode, _FRAMES_DIR)
                if audio_file and not skip_pro_audio:
                    f_pro_audio = ex.submit(
                        gemini3_audio.analyze_from_video,
                        video_path, audio_file, whisper_segments,
                    )
                else:
                    f_pro_audio = None

                ocr_subtitles = f_ocr.result()
                frame_analysis = f_frames.result()
                pro_audio_bundle = f_pro_audio.result() if f_pro_audio else {}
                f_storage.result()  # frame Storage 업로드 완료 대기

            pro_audio = pro_audio_bundle.get("pro_audio")
            audio_emotions = pro_audio_bundle.get("audio_emotions") or {}
            bgm_changes = pro_audio_bundle.get("bgm_changes") or []

            # DB 영구 저장 (Vercel/외부에서 조회 가능하도록)
            if pro_audio or audio_emotions:
                try:
                    requests.post(
                        f"{supabase.SUPABASE_URL}/rest/v1/reels_pro_audio?on_conflict=shortcode",
                        headers={**supabase.SUPABASE_HEADERS,
                                 "Prefer": "resolution=merge-duplicates,return=minimal"},
                        json={
                            "shortcode": shortcode,
                            "audio_emotions": audio_emotions,
                            "pro_audio": pro_audio,
                            "bgm_changes": bgm_changes,
                        },
                        timeout=15,
                    )
                except Exception as e:
                    logger.warning("reels_pro_audio insert failed: %s", e)

            # script_structure & category via Gemini (cheap text calls)
            analysis_status[shortcode] = {"status": "running", "step": "대본구조 + 카테고리 분석", "progress": 80}
            script_structure = gemini.analyze_script_structure(transcript_text, caption) if transcript_text else None
            category = gemini.categorize(transcript_text, frame_analysis, caption)

            # Save to DB
            if script_structure:
                supabase.sb_post("reels_script_structure", {
                    "shortcode": shortcode,
                    "hook": script_structure.get("hook"),
                    "intro": script_structure.get("intro"),
                    "body": script_structure.get("body"),
                    "cta": script_structure.get("cta"),
                    "overall": script_structure.get("overall"),
                })
            if category:
                supabase.sb_post("reels_category", {
                    "shortcode": shortcode,
                    "topic": category.get("topic"),
                    "topic_detail": category.get("topic_detail"),
                    "style": category.get("style"),
                    "tags": category.get("tags"),
                })

            # 10. Sentence timeline
            script_by_sec = {}
            sentences = []
            for seg in whisper_segments:
                start_sec = int(seg.get("start", 0))
                end_sec = int(seg.get("end", start_sec + 1))
                text = seg.get("text", "").strip()
                sentences.append({"start": round(seg.get("start", 0), 1), "end": round(seg.get("end", 0), 1), "text": text})
                for s in range(start_sec + 1, end_sec + 2):
                    if s not in script_by_sec:
                        script_by_sec[s] = text

            # OCR 폴백 — transcript가 빈약하면 OCR 결과를 sentences로 합성 (자막 영상 대응)
            transcript_total_chars = sum(len(s["text"]) for s in sentences)
            if transcript_total_chars < 30 and ocr_subtitles:
                # OCR 자막이 있으면 그것을 sentences로 변환
                ocr_items = sorted(ocr_subtitles.items())  # [(sec, text), ...]
                sentences = []
                script_by_sec = {}
                for i, (sec, text) in enumerate(ocr_items):
                    text = text.strip()
                    if not text:
                        continue
                    end = ocr_items[i+1][0] if i+1 < len(ocr_items) else sec + 2
                    sentences.append({"start": float(sec), "end": float(end), "text": text})
                    for s in range(sec, end + 1):
                        script_by_sec[s] = text
                # transcripts 테이블에 합성된 텍스트 저장 (UPSERT — on_conflict 사용)
                synth_transcript = " ".join(t for _, t in ocr_items if t.strip())
                if synth_transcript:
                    import requests as _r
                    upsert_url = f"{supabase.SUPABASE_URL}/rest/v1/reels_transcripts?on_conflict=shortcode"
                    _r.post(upsert_url, headers={
                        **supabase.SUPABASE_HEADERS,
                        "Prefer": "resolution=merge-duplicates,return=minimal",
                    }, json={
                        "shortcode": shortcode,
                        "transcript": synth_transcript,
                        "language": "ko",
                        "segments": sentences,
                    }, timeout=15)
                    transcript_text = synth_transcript

            # 10b. Sentence-level section classification (Gemini Flash)
            # 시간 범위 기반 분류는 boundary 케이스에서 부정확 → sentence 단위 직접 분류로 보강
            if sentences and script_structure:
                try:
                    from . import script_gen as _sg
                    # ⭐ 다중 문장 segment를 문장 단위로 자동 분할 (granularity 일관성 보장)
                    pre_n = len(sentences)
                    sentences = _sg.resegment_to_sentences(sentences)
                    if len(sentences) != pre_n:
                        logger.info("[pipeline] resegment %d → %d sentences", pre_n, len(sentences))
                    classified = _sg.classify_sentence_sections(sentences, script_structure)
                    if classified and len(classified) == len(sentences):
                        sentences = classified
                        # transcripts.segments 갱신 (UPSERT)
                        import requests as _r
                        upsert_url = f"{supabase.SUPABASE_URL}/rest/v1/reels_transcripts?on_conflict=shortcode"
                        _r.post(upsert_url, headers={
                            **supabase.SUPABASE_HEADERS,
                            "Prefer": "resolution=merge-duplicates,return=minimal",
                        }, json={
                            "shortcode": shortcode,
                            "transcript": transcript_text,
                            "language": "ko",
                            "segments": sentences,
                        }, timeout=15)
                        # ⭐ pro_audio.tts_script도 sentences에 맞춰 동기화 (canonical 일관성)
                        try:
                            ref_for_sync = {"sentences": sentences, "tts_script": []}
                            # 기존 tts_script 가져와서 direction/delivery 유지
                            pa = supabase.sb_get(
                                "reels_pro_audio",
                                f"shortcode=eq.{shortcode}&select=pro_audio&limit=1",
                            )
                            if pa:
                                pro = (pa[0].get("pro_audio") or {})
                                ref_for_sync["tts_script"] = pro.get("tts_script") or []
                                canonical_tts = _sg.get_canonical_tts(ref_for_sync)
                                if len(canonical_tts) != len(ref_for_sync["tts_script"]):
                                    pro["tts_script"] = canonical_tts
                                    _r.patch(
                                        f"{supabase.SUPABASE_URL}/rest/v1/reels_pro_audio?shortcode=eq.{shortcode}",
                                        headers={**supabase.SUPABASE_HEADERS, "Prefer": "return=minimal"},
                                        json={"pro_audio": pro},
                                        timeout=15,
                                    )
                                    logger.info("[pipeline] pro_audio.tts_script synced %d entries",
                                                len(canonical_tts))
                        except Exception as e:
                            logger.warning("tts_script sync failed: %s", e)
                        # section chunks 분석 (USP layout은 제거됨 — chunks가 자체적으로 USP 식별)
                        try:
                            ss_rows = supabase.sb_get(
                                "reels_script_structure",
                                f"shortcode=eq.{shortcode}&select=overall&limit=1",
                            )
                            if ss_rows:
                                overall = ss_rows[0].get("overall") or {}
                                # section_chunks (섹션별 chunk 상세)
                                chunks = []
                                try:
                                    chunks = _sg.analyze_section_chunks({
                                        "sentences": sentences,
                                        "structure": {"overall": overall},
                                    }) or []
                                    if chunks:
                                        overall["section_chunks"] = chunks
                                        overall["body_chunks"] = [
                                            {**c, "body_n": c.get("section")}
                                            for c in chunks
                                            if (c.get("section") or "").startswith("body")
                                        ]
                                        # ⭐ chunks 정본화: sentence.section 동기화
                                        _sg.chunks_as_source_of_truth(chunks, sentences, None)
                                        # sentences DB 갱신 (transcripts.segments)
                                        try:
                                            _r.post(
                                                f"{supabase.SUPABASE_URL}/rest/v1/reels_transcripts?on_conflict=shortcode",
                                                headers={
                                                    **supabase.SUPABASE_HEADERS,
                                                    "Prefer": "resolution=merge-duplicates,return=minimal",
                                                },
                                                json={
                                                    "shortcode": shortcode,
                                                    "transcript": transcript_text,
                                                    "language": "ko",
                                                    "segments": sentences,
                                                }, timeout=15,
                                            )
                                            logger.info("[pipeline] chunks-as-truth: sentence.section 동기화")
                                        except Exception as e:
                                            logger.warning("[pipeline] sentences DB 재저장 실패: %s", e)
                                except Exception as e:
                                    logger.warning("section_chunks failed: %s", e)

                                # sp_sentences (사회적 증명) — 함수 제거됨, 옛 데이터 보존
                                sp_sents = overall.get("sp_sentences") or []

                                _r.patch(
                                    f"{supabase.SUPABASE_URL}/rest/v1/reels_script_structure?shortcode=eq.{shortcode}",
                                    headers={**supabase.SUPABASE_HEADERS, "Prefer": "return=minimal"},
                                    json={"overall": overall},
                                    timeout=15,
                                )
                                logger.info("[pipeline] saved: %d chunks, %d SP", len(chunks), len(sp_sents))
                        except Exception as e:
                            logger.warning("section_chunks/sp analysis failed: %s", e)
                except Exception as e:
                    logger.warning("Sentence section classification failed: %s", e)

            # 11. Comment trigger analysis (없으면 Playwright로 자동 수집)
            analysis_status[shortcode] = {"status": "running", "step": "댓글 반응 분석", "progress": 85}
            comment_triggers = None
            try:
                comments = supabase.sb_get("reels_comments", f"shortcode=eq.{shortcode}&limit=500")
                if not comments:
                    try:
                        fetched = comments_svc.fetch_playwright(shortcode)
                        if fetched:
                            supabase.sb_post("reels_comments", fetched)
                            comments = fetched
                    except Exception as e:
                        logger.warning("Auto comment fetch failed: %s", e)
                if comments and len(comments) >= 3:
                    comment_triggers = gemini.analyze_comment_triggers(
                        transcript_text, frame_analysis, caption, comments
                    )
                    if comment_triggers:
                        supabase.sb_post("reels_comment_analysis", {
                            "shortcode": shortcode,
                            "triggers": comment_triggers.get("triggers"),
                            "summary": comment_triggers.get("summary"),
                        })
            except Exception as e:
                logger.warning("Comment trigger analysis error: %s", e)

            # 12. Cache extra data (frame_analysis text saved to disk too)
            extra_cache[shortcode] = {
                "ocr_subtitles": ocr_subtitles,
                "audio_emotions": audio_emotions,
                "bgm_changes": bgm_changes,
                "pro_audio": pro_audio,
                "script_structure": script_structure,
                "script_by_sec": script_by_sec,
                "sentences": sentences,
                "frame_images": frame_images,
                "frame_analysis": frame_analysis,
                "category": category,
                "comment_triggers": comment_triggers,
            }

            # 12. Compose + save
            analysis_status[shortcode] = {"status": "running", "step": "결과 저장", "progress": 95}
            sections = []
            m = meta[0] if meta else {}
            bgm = m.get("music_title", "")
            if bgm:
                bgm_text = f"**{bgm}**"
                artist = m.get("music_artist", "")
                if artist:
                    bgm_text += f" - {artist}"
                sections.append(f"## BGM\n\n{bgm_text}")
            if frame_analysis:
                sections.append(f"## 영상 프레임 분석 (1초 단위)\n\n{frame_analysis}")
            if transcript_text:
                sections.append(f"## 대본\n\n{transcript_text}")

            result_text = "\n\n".join(sections) if sections else None
            analysis_row = {
                "shortcode": shortcode,
                "analysis": result_text or "(분석 결과 없음)",
                "analyzed_at": datetime.now().isoformat(),
            }
            supabase.sb_post("opus_analyses", analysis_row)
            analysis_cache[shortcode] = analysis_row

            analysis_status[shortcode] = {
                "status": "done", "step": "완료", "progress": 100,
                "frame_images": frame_images, "analysis": analysis_row,
            }

    except Exception as e:
        import traceback; traceback.print_exc()
        analysis_status[shortcode] = {"status": "error", "message": str(e)}
