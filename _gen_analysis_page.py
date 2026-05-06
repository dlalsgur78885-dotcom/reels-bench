"""analysis_<sc>.json 으로부터 단독 실행 HTML 생성."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SHORTCODE = sys.argv[1] if len(sys.argv) > 1 else "DXf3g2VjZyT"

DATA = json.loads((ROOT / f"analysis_{SHORTCODE}.json").read_text(encoding="utf-8"))
data_json = json.dumps(DATA, ensure_ascii=False, separators=(",", ":"))

HTML = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>전체 분석 · __SC__</title>
<style>
  :root {
    --bg: #0b0d12; --panel: #141821; --panel2: #1b2030; --border: #232a3b;
    --text: #e7ecf3; --muted: #8a94a8; --accent: #7c9cff;
    --happy: #ffb84d; --neutral: #7d8aa3; --excited: #ff6b9a;
    --sad: #4d8cff; --angry: #ff5a5a; --fearful: #9b7dff;
    --surprised: #4ddbff; --confident: #ff8a4d; --proud: #ffd24d; --curious: #4ddbb4;
    --crying: #6ea0ff; --nervous: #c79bff; --serious: #8a94a8;
    --tired: #6b7488; --calm: #7ed3c1; --frustrated: #ff7a6b;
    --cheerful: #ffd166; --sarcastic: #ce8bff; --mischievously: #ffa3d1;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text);
    font-family: 'Pretendard Variable', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 15px; line-height: 1.55; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 80px; }
  header h1 { margin: 0 0 6px; font-size: 24px; font-weight: 700; letter-spacing: -0.01em; }
  header .sub { color: var(--muted); font-size: 13px; }
  header .badges { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
  .badge { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); color: var(--muted); }
  .badge strong { color: var(--text); }
  .grid { display: grid; gap: 16px; margin-top: 16px; }
  .row2 { grid-template-columns: 1fr 1fr; }
  .row3 { grid-template-columns: 1.4fr 1fr 1fr; }
  @media (max-width: 760px) { .row2, .row3 { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; }
  .card h2 { margin: 0 0 14px; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; color: var(--muted); text-transform: uppercase; }
  .timeline { position: relative; padding: 8px 0 4px; }
  .tl-ruler { position: relative; height: 22px; margin-bottom: 6px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 11px; }
  .tl-ruler span { position: absolute; transform: translateX(-50%); top: 2px; }
  .tl-track { position: relative; height: 44px; border-radius: 8px; background: var(--panel2); margin-bottom: 8px; overflow: hidden; }
  .tl-label { position: absolute; left: 10px; top: 4px; font-size: 11px; color: var(--muted); letter-spacing: 0.04em; z-index: 3; pointer-events: none; }
  .tl-seg { position: absolute; top: 18px; bottom: 4px; border-radius: 4px; padding: 2px 6px;
    font-size: 11px; color: #0b0d12; font-weight: 700; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; }
  .tl-mark { position: absolute; top: 18px; bottom: 4px; width: 2px; background: var(--text); z-index: 2; }
  .tl-mark::after { content: attr(data-label); position: absolute; top: -14px; left: 4px; font-size: 10px; color: var(--text); background: var(--panel); padding: 1px 5px; border-radius: 3px; white-space: nowrap; border: 1px solid var(--border); }
  .tl-cut { top: 22px; bottom: 8px; width: 1px; background: rgba(255,255,255,0.35); }
  ul.clean { list-style: none; margin: 0; padding: 0; }
  ul.clean li { padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 13px; display: flex; gap: 12px; align-items: baseline; }
  ul.clean li:last-child { border-bottom: 0; }
  .ts { font-family: ui-monospace, "SF Mono", monospace; font-size: 12px; color: var(--accent); min-width: 70px; }
  .type { font-weight: 700; min-width: 110px; }
  .desc { color: var(--muted); }
  .tts-list li { display: grid; grid-template-columns: 70px 130px 130px 1fr; gap: 12px; }
  .tts-list .dir { font-size: 12px; font-weight: 700; }
  .tts-list .emo { font-size: 12px; font-weight: 700; }
  .kv { display: grid; grid-template-columns: 90px 1fr; gap: 6px 12px; font-size: 14px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; color: var(--text); }
  .viral div { padding: 8px 12px; background: var(--panel2); border-left: 3px solid var(--accent); border-radius: 4px; font-size: 13px; margin-top: 6px; }
  .score-big { font-size: 36px; font-weight: 700; letter-spacing: -0.02em; color: var(--accent); }
  .score-label { color: var(--muted); font-size: 13px; }
  .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px; }
  .stat { background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .stat .label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
  .stat .val { font-size: 16px; font-weight: 700; }
  .footnote { color: var(--muted); font-size: 12px; text-align: center; margin-top: 24px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>릴스 전체 분석 · TTS Direction + 감정 타임라인</h1>
    <div class="sub">Gemini 3 Pro 통합 분석 · <strong>형용사+동사 발화지시</strong>와 <strong>세분화 감정</strong>까지</div>
    <div class="badges">
      <span class="badge">shortcode · <strong id="b-sc"></strong></span>
      <span class="badge">model · <strong id="b-model"></strong></span>
      <span class="badge">duration · <strong id="b-dur"></strong></span>
      <span class="badge">cuts · <strong id="b-cuts"></strong></span>
      <span class="badge">total tokens · <strong id="b-tokens"></strong></span>
    </div>
  </header>

  <div class="card" style="margin-top:24px;">
    <h2>Timeline Visualizer</h2>
    <div class="timeline">
      <div class="tl-ruler" id="ruler"></div>
      <div class="tl-track"><span class="tl-label">발화 지시</span><div id="tl-tts"></div></div>
      <div class="tl-track"><span class="tl-label">감정</span><div id="tl-emotion"></div></div>
      <div class="tl-track"><span class="tl-label">BGM</span><div id="tl-bgm"></div></div>
      <div class="tl-track" style="height:36px;"><span class="tl-label">효과음 / 컷</span><div id="tl-sfx"></div></div>
      <div class="tl-track" style="height:36px;"><span class="tl-label">오디오 이벤트</span><div id="tl-events"></div></div>
    </div>
  </div>

  <div class="card">
    <h2>📝 TTS Direction × 감정 (문장별)</h2>
    <ul class="clean tts-list" id="list-tts"></ul>
  </div>

  <div class="grid row2">
    <div class="card"><h2>💫 감정 타임라인 (delivery 포함)</h2><ul class="clean" id="list-emotion"></ul></div>
    <div class="card"><h2>🎬 컷 전환</h2><ul class="clean" id="list-cuts"></ul></div>
  </div>

  <div class="grid row2">
    <div class="card"><h2>😂 오디오 이벤트 (웃음/한숨/멈춤 등)</h2><ul class="clean" id="list-events"></ul></div>
    <div class="card"></div>
  </div>

  <div class="grid row2">
    <div class="card"><h2>🔊 효과음</h2><ul class="clean" id="list-sfx"></ul></div>
    <div class="card"><h2>🎵 BGM</h2><ul class="clean" id="list-bgm"></ul></div>
  </div>

  <div class="grid row3">
    <div class="card"><h2>🎯 훅 & 나레이션</h2><dl class="kv" id="kv-meta"></dl></div>
    <div class="card">
      <h2>📊 오디오–비주얼 싱크</h2>
      <div class="score-big" id="score"></div>
      <div class="score-label" id="score-label"></div>
      <div class="desc" id="sync-analysis" style="margin-top:8px;font-size:13px;"></div>
    </div>
    <div class="card"><h2>🚀 바이럴 요인</h2><div class="viral" id="viral"></div></div>
  </div>

  <div class="card"><h2>토큰 사용량</h2><div class="meta" id="usage-meta"></div></div>

  <div class="footnote">
    원본 <a id="b-igurl" target="_blank" rel="noopener"></a>
    · 데이터 <a href="./analysis___SC__.json">analysis___SC__.json</a>
  </div>
</div>

<script id="data" type="application/json">__DATA__</script>
<script>
(function(){
  const doc = JSON.parse(document.getElementById("data").textContent);
  const a = doc.analysis;
  const dur = a.duration_sec || 10;
  const toSec = ts => {
    const str = String(ts);
    if (str.includes(":")) { const [m,s]=str.split(":").map(Number); return (m||0)*60+(s||0); }
    return parseFloat(str);
  };

  document.getElementById("b-sc").textContent = doc.shortcode;
  document.getElementById("b-model").textContent = doc.model;
  document.getElementById("b-dur").textContent = dur.toFixed(1) + "s";
  document.getElementById("b-cuts").textContent = (a.visual_cuts||[]).length;
  const totalIn = (doc.usage?.reel?.promptTokenCount||0)+(doc.usage?.tts?.promptTokenCount||0)+(doc.usage?.emotion_fine?.promptTokenCount||0);
  const totalOut = (doc.usage?.reel?.candidatesTokenCount||0)+(doc.usage?.tts?.candidatesTokenCount||0)+(doc.usage?.emotion_fine?.candidatesTokenCount||0);
  document.getElementById("b-tokens").textContent = `in ${totalIn.toLocaleString()} · out ${totalOut.toLocaleString()}`;
  const ig = document.getElementById("b-igurl");
  ig.href = `https://instagram.com/reel/${doc.shortcode}`;
  ig.textContent = `instagram.com/reel/${doc.shortcode}`;

  const ruler = document.getElementById("ruler");
  for (let i = 0; i <= 5; i++) {
    const t = dur * i / 5;
    const s = document.createElement("span");
    s.style.left = (i/5*100) + "%";
    s.textContent = t.toFixed(1) + "s";
    ruler.appendChild(s);
  }

  const ttsColors = ['#ff8a4d','#ffb84d','#4ddbff','#ff6b9a','#a8e066','#9b7dff','#4ddbb4','#ffd24d'];
  const emoColor = e => ({
    happy:'var(--happy)', neutral:'var(--neutral)', excited:'var(--excited)',
    sad:'var(--sad)', angry:'var(--angry)', fearful:'var(--fearful)',
    surprised:'var(--surprised)', confident:'var(--confident)',
    proud:'var(--proud)', curious:'var(--curious)',
    crying:'var(--crying)', nervous:'var(--nervous)', serious:'var(--serious)',
    tired:'var(--tired)', calm:'var(--calm)', frustrated:'var(--frustrated)',
    cheerful:'var(--cheerful)', sarcastic:'var(--sarcastic)', mischievously:'var(--mischievously)'
  })[e] || '#666';
  const deliveryIcon = d => ({
    whispers:'🤫', shouts:'📢', slowly:'🐢', very_fast:'⚡', normal:''
  })[d] || '';
  const eventIcon = ev => ({
    laughs:'😂', laughing:'🤣', sighs:'😮‍💨', clears_throat:'🗣️',
    gulps:'😬', gasps:'😱', pause:'⏸️', hesitates:'…'
  })[ev] || '•';

  const ttsTrack = document.getElementById("tl-tts");
  (a.tts_script||[]).forEach((s, i) => {
    const start = toSec(s.start), end = toSec(s.end);
    const d = document.createElement("div");
    d.className = "tl-seg";
    d.style.left = (start/dur*100)+"%";
    d.style.width = ((end-start)/dur*100)+"%";
    d.style.background = ttsColors[i % ttsColors.length];
    d.textContent = s.direction;
    d.title = s.text;
    ttsTrack.appendChild(d);
  });

  const emoTrack = document.getElementById("tl-emotion");
  (a.emotion_timeline||[]).forEach(e => {
    const start = toSec(e.start), end = toSec(e.end);
    const d = document.createElement("div");
    d.className = "tl-seg";
    d.style.left = (start/dur*100)+"%";
    d.style.width = ((end-start)/dur*100)+"%";
    d.style.background = emoColor(e.emotion);
    d.style.opacity = 0.55 + (e.intensity||0.5)*0.45;
    const di = deliveryIcon(e.delivery);
    d.textContent = `${di?di+' ':''}${e.emotion} · ${(e.intensity*100|0)}%`;
    d.title = `${e.delivery&&e.delivery!=='normal'?'['+e.delivery+'] ':''}${e.reason||''}`;
    emoTrack.appendChild(d);
  });

  const evTrack = document.getElementById("tl-events");
  (a.audio_events||[]).forEach(ev => {
    const t = toSec(ev.time);
    const d = document.createElement("div");
    d.className = "tl-mark";
    d.style.left = (t/dur*100)+"%";
    d.dataset.label = eventIcon(ev.event) + ' ' + ev.event;
    d.title = ev.reason || '';
    evTrack.appendChild(d);
  });

  const bgmTrack = document.getElementById("tl-bgm");
  (a.bgm||[]).forEach(b => {
    const s = toSec(b.start), en = toSec(b.end);
    const d = document.createElement("div");
    d.className = "tl-seg";
    d.style.left = (s/dur*100)+"%";
    d.style.width = ((en-s)/dur*100)+"%";
    d.style.background = "linear-gradient(90deg, #5a7dff, #9b7dff)";
    d.style.color = "#fff";
    d.textContent = b.mood || b.genre || "BGM";
    d.title = `${b.genre} · ${b.tempo} · ${b.identified||""}`;
    bgmTrack.appendChild(d);
  });

  const sfxTrack = document.getElementById("tl-sfx");
  (a.visual_cuts||[]).forEach(c => {
    const s = toSec(c.time);
    const d = document.createElement("div");
    d.className = "tl-mark tl-cut";
    d.style.left = (s/dur*100)+"%";
    d.title = `컷 · ${c.description}`;
    sfxTrack.appendChild(d);
  });
  (a.sound_effects||[]).forEach(e => {
    const s = toSec(e.time);
    const d = document.createElement("div");
    d.className = "tl-mark";
    d.style.left = (s/dur*100)+"%";
    d.dataset.label = e.type;
    d.title = e.description;
    sfxTrack.appendChild(d);
  });

  const ttsUl = document.getElementById("list-tts");
  const emos = a.emotion_timeline||[];
  (a.tts_script||[]).forEach((s, i) => {
    const e = emos[i] || {};
    const li = document.createElement("li");
    const di = deliveryIcon(e.delivery);
    li.innerHTML = `
      <span class="ts">${s.start}–${s.end}s</span>
      <span class="dir" style="color:${ttsColors[i%ttsColors.length]}">${s.direction}</span>
      <span class="emo" style="color:${emoColor(e.emotion)}">${di?di+' ':''}${e.emotion||'-'} ${e.intensity?`(${(e.intensity*100|0)}%)`:''}${e.delivery&&e.delivery!=='normal'?` · ${e.delivery}`:''}</span>
      <span class="desc">${s.text}</span>`;
    ttsUl.appendChild(li);
  });

  const fill = (id, arr, fn) => {
    const ul = document.getElementById(id);
    if (!arr.length) { ul.innerHTML = '<li><span class="desc">없음</span></li>'; return; }
    arr.forEach(x => { const li = document.createElement("li"); li.innerHTML = fn(x); ul.appendChild(li); });
  };
  fill("list-emotion", a.emotion_timeline||[],
    e => {
      const di = deliveryIcon(e.delivery);
      const dtag = e.delivery && e.delivery!=='normal' ? ` <span style="color:#ffd24d">[${e.delivery}]</span>` : '';
      return `<span class="ts">${e.start}–${e.end}s</span><span class="type" style="color:${emoColor(e.emotion)}">${di?di+' ':''}${e.emotion} ${e.intensity?`(${(e.intensity*100|0)}%)`:''}</span><span class="desc">${dtag}${e.reason||''}</span>`;
    });
  fill("list-events", a.audio_events||[],
    ev => `<span class="ts">@${ev.time}s</span><span class="type">${eventIcon(ev.event)} ${ev.event}</span><span class="desc">${ev.reason||''}</span>`);
  fill("list-cuts", a.visual_cuts||[],
    c => `<span class="ts">${c.time}</span><span class="desc">${c.description}</span>`);
  fill("list-sfx", a.sound_effects||[],
    e => `<span class="ts">${e.time}</span><span class="type">${e.type}</span><span class="desc">${e.description}</span>`);
  fill("list-bgm", a.bgm||[],
    b => `<span class="ts">${b.start}–${b.end}</span><span class="type">${b.mood}</span><span class="desc">${b.genre} · ${b.tempo} · ${b.identified||''}</span>`);

  const kv = document.getElementById("kv-meta");
  const rows = [
    ["훅 시점", a.hook?.time], ["훅 기법", a.hook?.technique], ["훅 이유", a.hook?.why],
    ["언어", a.narration?.language], ["톤", a.narration?.tone], ["빠르기", a.narration?.pace],
  ];
  rows.forEach(([k,v]) => {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v||"-";
    kv.append(dt, dd);
  });

  const score = a.audio_visual_sync_score || 0;
  document.getElementById("score").textContent = (score*100|0) + " / 100";
  document.getElementById("score-label").textContent =
    score >= 0.9 ? "거의 완벽한 동기화" : score >= 0.7 ? "양호함" : score >= 0.5 ? "보통" : "부조화";
  document.getElementById("sync-analysis").textContent = a.sync_analysis || "";

  const v = document.getElementById("viral");
  (a.viral_factors||[]).forEach(x => {
    const d = document.createElement("div"); d.textContent = x; v.appendChild(d);
  });

  const um = document.getElementById("usage-meta");
  const usages = [
    ["Reel (video)", doc.usage?.reel],
    ["TTS (audio)", doc.usage?.tts],
    ["Emotion fine", doc.usage?.emotion_fine],
  ];
  usages.forEach(([label, u]) => {
    if (!u) return;
    const div = document.createElement("div");
    div.className = "stat";
    div.innerHTML = `<div class="label">${label}</div><div class="val">${(u.totalTokenCount||0).toLocaleString()}</div>`;
    um.appendChild(div);
  });
  const totalAll = usages.reduce((s,[_,u]) => s + (u?.totalTokenCount||0), 0);
  const div = document.createElement("div");
  div.className = "stat";
  div.style.background = "var(--accent)"; div.style.color = "#0b0d12";
  div.innerHTML = `<div class="label" style="color:#0b0d12cc">합계</div><div class="val">${totalAll.toLocaleString()}</div>`;
  um.appendChild(div);
})();
</script>
</body>
</html>
"""

html = HTML.replace("__SC__", SHORTCODE).replace("__DATA__", data_json)
out = ROOT / f"analysis_{SHORTCODE}.html"
out.write_text(html, encoding="utf-8")
print(f"saved: {out}")
