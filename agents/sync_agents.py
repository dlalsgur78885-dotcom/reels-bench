"""
Agent Role Sync Script
agent_registry.json 변경 시 각 에이전트의 .md 파일을 자동으로 동기화합니다.

사용법:
  python agents/sync_agents.py                    # registry → md 동기화
  python agents/sync_agents.py --watch             # 파일 변경 감지 자동 동기화
  python agents/sync_agents.py --update collector "새로운 역할 설명"  # 역할 변경 + 동기화
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

AGENTS_DIR = Path(__file__).parent
REGISTRY_PATH = AGENTS_DIR / "agent_registry.json"


def load_registry():
    with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_registry(registry):
    registry["updated"] = datetime.now().strftime("%Y-%m-%d")
    with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
        json.dump(registry, f, ensure_ascii=False, indent=2)


def generate_md(agent_id, agent_info, registry):
    """에이전트 정보로부터 .md 파일 내용을 생성"""
    lines = [
        f"# {agent_info['name']}",
        "",
        "## 역할",
        agent_info["role"],
        "",
        "## 상태",
        f"- active: {str(agent_info['active']).lower()}",
        f"- version: {registry['version']}",
        f"- updated: {datetime.now().strftime('%Y-%m-%d')}",
    ]

    upstream = agent_info.get("upstream")
    downstream = agent_info.get("downstream", [])

    if upstream:
        lines += ["", "## 입력", f"- {upstream} 에이전트로부터 데이터 수신"]

    if downstream:
        lines += ["", "## 출력"]
        for d in downstream:
            lines.append(f"- {d} 에이전트로 데이터 전달")

    lines.append("")
    return "\n".join(lines)


def sync_all():
    """registry.json → 각 에이전트 .md 파일 동기화"""
    registry = load_registry()
    for agent_id, agent_info in registry["agents"].items():
        agent_dir = AGENTS_DIR / agent_id
        agent_dir.mkdir(exist_ok=True)
        md_path = agent_dir / f"{agent_id}.md"
        content = generate_md(agent_id, agent_info, registry)
        md_path.write_text(content, encoding="utf-8")
        print(f"[SYNC] {agent_id}.md 업데이트 완료")
    print(f"\n전체 {len(registry['agents'])}개 에이전트 동기화 완료")


def update_role(agent_id, new_role):
    """특정 에이전트의 역할을 변경하고 .md 파일을 동기화"""
    registry = load_registry()
    if agent_id not in registry["agents"]:
        print(f"[ERROR] '{agent_id}' 에이전트를 찾을 수 없습니다.")
        print(f"사용 가능: {', '.join(registry['agents'].keys())}")
        return
    registry["agents"][agent_id]["role"] = new_role
    save_registry(registry)
    print(f"[UPDATE] {agent_id} 역할 변경: {new_role}")
    sync_all()


def watch():
    """registry.json 변경 감지 시 자동 동기화"""
    try:
        from watchdog.observers import Observer
        from watchdog.events import FileSystemEventHandler
    except ImportError:
        print("watchdog 패키지가 필요합니다: pip install watchdog")
        print("대신 polling 모드로 실행합니다...")
        watch_polling()
        return

    handler = FileSystemEventHandler()
    original_on_modified = handler.on_modified

    def on_registry_modified(event):
        if event.src_path.endswith("agent_registry.json"):
            print(f"\n[WATCH] registry 변경 감지 ({datetime.now().strftime('%H:%M:%S')})")
            sync_all()

    handler.on_modified = on_registry_modified

    observer = Observer()
    observer.schedule(handler, str(AGENTS_DIR), recursive=False)
    observer.start()
    print("[WATCH] agent_registry.json 감시 중... (Ctrl+C로 종료)")
    try:
        import time
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


def watch_polling():
    """watchdog 없이 polling으로 변경 감지"""
    import time
    last_mtime = os.path.getmtime(REGISTRY_PATH)
    print("[WATCH-POLL] agent_registry.json 감시 중... (Ctrl+C로 종료)")
    try:
        while True:
            time.sleep(2)
            current_mtime = os.path.getmtime(REGISTRY_PATH)
            if current_mtime != last_mtime:
                last_mtime = current_mtime
                print(f"\n[WATCH] registry 변경 감지 ({datetime.now().strftime('%H:%M:%S')})")
                sync_all()
    except KeyboardInterrupt:
        print("\n감시 종료")


if __name__ == "__main__":
    if len(sys.argv) == 1:
        sync_all()
    elif sys.argv[1] == "--watch":
        watch()
    elif sys.argv[1] == "--update" and len(sys.argv) >= 4:
        update_role(sys.argv[2], " ".join(sys.argv[3:]))
    else:
        print(__doc__)
