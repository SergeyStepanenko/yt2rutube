"""
Test pipeline: translate EN video audio to RU
1. Parse SRT subtitles
2. Merge overlapping fragments into sentences
3. Translate EN→RU via Gemini API
4. Synthesize Russian speech via Edge-TTS
5. Mix with background audio from Demucs
"""

import asyncio
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
VOICE = "ru-RU-DmitryNeural"
WORK_DIR = Path(__file__).resolve().parent.parent / "test_dub"


# ── SRT Parsing ──────────────────────────────────────────────

def parse_srt(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    blocks = re.split(r"\n\s*\n", content.strip())
    entries = []
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 2:
            continue
        time_match = re.match(
            r"(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})",
            lines[1],
        )
        if not time_match:
            continue
        start = ts_to_ms(time_match.group(1))
        end = ts_to_ms(time_match.group(2))
        text = " ".join(lines[2:]).strip()
        if text:
            entries.append({"start": start, "end": end, "text": text})
    return entries


def ts_to_ms(ts: str) -> int:
    ts = ts.replace(",", ".")
    h, m, rest = ts.split(":")
    s, ms = rest.split(".")
    return int(h) * 3600000 + int(m) * 60000 + int(s) * 1000 + int(ms)


def ms_to_ts(ms: int) -> str:
    h = ms // 3600000
    ms %= 3600000
    m = ms // 60000
    ms %= 60000
    s = ms // 1000
    ms %= 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def merge_overlapping(entries: list[dict], max_duration_ms: int = 8000) -> list[dict]:
    """Merge overlapping subtitle fragments into sentence-sized segments (max ~8s)."""
    if not entries:
        return []

    # First pass: deduplicate overlapping text fragments
    # YouTube auto-subs repeat text across overlapping time windows
    deduped = []
    seen_text = set()
    for e in entries:
        clean = re.sub(r">>\s*", "", e["text"])
        clean = re.sub(r"\[.*?\]", "", clean).strip()
        if not clean or clean in seen_text:
            continue
        seen_text.add(clean)
        deduped.append({**e, "text": clean})

    if not deduped:
        return []

    # Second pass: merge adjacent entries, but split at sentence boundaries
    # and respect max_duration_ms
    merged = []
    cur = {
        "start": deduped[0]["start"],
        "end": deduped[0]["end"],
        "text": deduped[0]["text"],
    }

    for e in deduped[1:]:
        gap = e["start"] - cur["end"]
        combined_dur = e["end"] - cur["start"]

        if gap < 1500 and combined_dur <= max_duration_ms:
            cur["end"] = max(cur["end"], e["end"])
            cur["text"] += " " + e["text"]
        else:
            merged.append(cur)
            cur = {"start": e["start"], "end": e["end"], "text": e["text"]}

    merged.append(cur)

    # Clean up
    result = []
    for seg in merged:
        text = re.sub(r"\s+", " ", seg["text"]).strip()
        if text and len(text) > 2:
            seg["text"] = text
            result.append(seg)

    return result


# ── Translation via Gemini ───────────────────────────────────

def _call_translate(texts: list[str]) -> list[str]:
    """Call Anthropic API to translate a batch of texts, with retries."""
    import time

    prompt = (
        "Translate the following sports commentary texts from English to Russian. "
        "Keep the energetic, emotional sports commentary style. "
        "Return ONLY a JSON array of translated strings, same order, same count. "
        "No markdown formatting, no explanation, just the JSON array.\n\n"
        + json.dumps(texts, ensure_ascii=False)
    )

    payload = json.dumps({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()

    headers = {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
    }

    for attempt in range(5):
        try:
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=payload,
                headers=headers,
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read())
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 529) and attempt < 4:
                wait = (attempt + 1) * 5
                print(f"    API {e.code}, retrying in {wait}s...")
                time.sleep(wait)
            else:
                raise

    raw = data["content"][0]["text"].strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```\w*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)

    return json.loads(raw)


def translate_segments(segments: list[dict], batch_size: int = 15) -> list[dict]:
    """Translate segment texts EN→RU using Gemini API in batches."""
    import time

    all_translated = []
    total = len(segments)

    for i in range(0, total, batch_size):
        batch = segments[i : i + batch_size]
        texts = [s["text"] for s in batch]
        print(f"  Translating batch {i // batch_size + 1} ({len(texts)} segments)...")
        translated = _call_translate(texts)

        if len(translated) != len(texts):
            print(f"  WARNING: expected {len(texts)}, got {len(translated)}")
            translated = (translated + [""] * len(texts))[: len(texts)]

        for seg, tr in zip(batch, translated):
            all_translated.append({**seg, "text_ru": tr})

        if i + batch_size < total:
            time.sleep(2)

    return all_translated


# ── Edge-TTS Synthesis ───────────────────────────────────────

async def synthesize_segments(segments: list[dict], output_dir: Path) -> list[dict]:
    """Generate audio for each translated segment using Edge-TTS."""
    import edge_tts

    output_dir.mkdir(parents=True, exist_ok=True)
    results = []

    for i, seg in enumerate(segments):
        text_ru = seg.get("text_ru", "").strip()
        if not text_ru:
            continue
        out_path = output_dir / f"seg_{i:04d}.mp3"
        try:
            communicate = edge_tts.Communicate(text_ru, VOICE, rate="+10%")
            await communicate.save(str(out_path))
            results.append({**seg, "audio_path": str(out_path)})
        except Exception as e:
            print(f"\n  TTS error seg {i}: {e}")
        sys.stdout.write(f"\r  TTS: {i + 1}/{len(segments)}")
        sys.stdout.flush()

    print()
    return results


# ── Audio Assembly ───────────────────────────────────────────

def get_audio_duration_ms(path: str) -> int:
    """Get audio duration in ms using ffprobe."""
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True,
    )
    return int(float(result.stdout.strip()) * 1000)


def build_final_audio(
    segments: list[dict],
    background_path: str,
    output_path: str,
    total_duration_ms: int,
):
    """
    Overlay translated speech segments onto the background audio at correct timestamps.
    """
    bg_duration = get_audio_duration_ms(background_path)
    print(f"  Background duration: {bg_duration}ms, video duration: {total_duration_ms}ms")

    filter_parts = []
    inputs = ["-i", background_path]

    for i, seg in enumerate(segments):
        inputs.extend(["-i", seg["audio_path"]])
        seg_duration_ms = get_audio_duration_ms(seg["audio_path"])
        available_ms = seg["end"] - seg["start"]

        if seg_duration_ms > available_ms + 500:
            speed = min(seg_duration_ms / available_ms, 1.5)
            filter_parts.append(
                f"[{i + 1}:a]atempo={speed:.2f},adelay={seg['start']}|{seg['start']}[s{i}]"
            )
        else:
            filter_parts.append(
                f"[{i + 1}:a]adelay={seg['start']}|{seg['start']}[s{i}]"
            )

    mix_inputs = "[0:a]" + "".join(f"[s{i}]" for i in range(len(segments)))
    filter_parts.append(
        f"{mix_inputs}amix=inputs={len(segments) + 1}:duration=first:dropout_transition=0,"
        f"volume={len(segments) + 1}[out]"
    )

    filter_complex = ";\n".join(filter_parts)

    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-ac", "2",
        "-ar", "44100",
        output_path,
    ]

    print("  Mixing audio...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("FFmpeg error:", result.stderr[-500:])
        raise RuntimeError("FFmpeg mixing failed")


# ── Main ─────────────────────────────────────────────────────

async def main():
    srt_path = str(
        Path(__file__).resolve().parent.parent
        / "downloads"
        / "Best MotoGP™ Moments 🔥 2026 US GP"
        / "Best MotoGP™ Moments 🔥 2026 US GP.en.srt"
    )
    background_path = str(WORK_DIR / "background.wav")
    output_path = str(WORK_DIR / "dubbed_audio.wav")
    tts_dir = WORK_DIR / "tts_segments"

    print("=" * 60)
    print("Video Dubbing Pipeline: EN → RU")
    print("=" * 60)

    # 1. Parse subtitles
    print("\n[1/4] Parsing subtitles...")
    raw = parse_srt(srt_path)
    print(f"  Raw entries: {len(raw)}")

    segments = merge_overlapping(raw)
    print(f"  Merged segments: {len(segments)}")
    for s in segments[:3]:
        print(f"    {ms_to_ts(s['start'])} → {ms_to_ts(s['end'])}: {s['text'][:60]}...")

    total_duration_ms = max(s["end"] for s in segments)

    # 2. Translate (with cache)
    cache_path = WORK_DIR / "translation_cache.json"
    if cache_path.exists():
        print("\n[2/4] Loading cached translation...")
        with open(cache_path, "r", encoding="utf-8") as f:
            segments = json.load(f)
        print(f"  Loaded {len(segments)} cached segments")
    else:
        print("\n[2/4] Translating subtitles EN → RU...")
        segments = translate_segments(segments)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(segments, f, ensure_ascii=False, indent=2)
        print(f"  Translated {len(segments)} segments")
    for s in segments[:3]:
        print(f"    RU: {s['text_ru'][:60]}...")

    # Save translated SRT
    srt_out = WORK_DIR / "subtitles_ru.srt"
    with open(srt_out, "w", encoding="utf-8") as f:
        for i, s in enumerate(segments, 1):
            f.write(f"{i}\n{ms_to_ts(s['start'])} --> {ms_to_ts(s['end'])}\n{s['text_ru']}\n\n")
    print(f"  Saved: {srt_out}")

    # 3. TTS
    print("\n[3/4] Synthesizing Russian speech (Edge-TTS)...")
    segments = await synthesize_segments(segments, tts_dir)
    print(f"  Generated {len(segments)} audio segments")

    # 4. Mix
    print("\n[4/4] Mixing background + Russian speech...")
    build_final_audio(segments, background_path, output_path, total_duration_ms)

    print(f"\n{'=' * 60}")
    print(f"DONE! Output: {output_path}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    asyncio.run(main())
