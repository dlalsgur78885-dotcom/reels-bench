"""Claude Code CLI helper — runs one-shot prompts via `claude -p -` (stdin)"""

import json
import os
import logging
import subprocess

logger = logging.getLogger(__name__)

_CLAUDE_CMD = os.path.expandvars(r"%APPDATA%\npm\claude.cmd")
if not os.path.exists(_CLAUDE_CMD):
    _CLAUDE_CMD = "claude"


def ask(prompt: str, model: str = "sonnet", timeout: int = 120) -> str | None:
    """Run a one-shot prompt through Claude Code CLI via stdin pipe.
    model: 'sonnet', 'haiku', 'opus'
    """
    try:
        result = subprocess.run(
            [_CLAUDE_CMD, "-p", "-", "--output-format", "text", "--model", model],
            input=prompt.encode("utf-8"),
            capture_output=True, timeout=timeout,
        )
        stdout = result.stdout.decode("utf-8", errors="replace")
        if result.returncode == 0 and stdout.strip():
            return stdout.strip()
        stderr = result.stderr.decode("utf-8", errors="replace")
        if stderr:
            logger.warning("[claude-cli:%s] stderr: %s", model, stderr[:200])
    except subprocess.TimeoutExpired:
        logger.warning("[claude-cli:%s] timeout after %ds", model, timeout)
    except FileNotFoundError:
        logger.error("[claude-cli] 'claude' not found at %s", _CLAUDE_CMD)
    except Exception as e:
        logger.warning("[claude-cli:%s] error: %s", model, e)
    return None


def ask_json(prompt: str, model: str = "sonnet", timeout: int = 120) -> dict | None:
    """Run prompt, parse JSON from response."""
    text = ask(prompt, model=model, timeout=timeout)
    if not text:
        return None
    try:
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            text = text.split("```")[1].split("```")[0].strip()
        return json.loads(text)
    except (json.JSONDecodeError, IndexError) as e:
        logger.warning("[claude-cli:%s] JSON parse error: %s | text: %.200s", model, e, text)
        return None
