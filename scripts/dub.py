"""
Video dubbing pipeline: EN → RU
Usage: python scripts/dub.py <video_folder> [--title "..."] [--description "..."]

Expects folder to contain:
  - *.mp4 (video file)
  - *.en.srt (English subtitles)

Produces inside the same folder:
  - original_audio.wav
  - vocals.wav, drums.wav, bass.wav, other.wav
  - background.wav
  - subtitles_ru.srt
  - dubbed_audio.wav
  - <name> [RU].mp4

Exit codes: 0=success, 1=error
Prints JSON status to stdout for progress tracking.
"""

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

DEEPSEEK_API_KEY = os.environ.get("DEEP_SEEK_API_KEY", "")
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
VOICE = "ru-RU-DmitryNeural"


def emit(event: str, **data):
    """Emit a JSON progress event to stdout."""
    print(json.dumps({"event": event, **data}), flush=True)


# ── SRT ──────────────────────────────────────────────────────

def parse_srt(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    blocks = re.split(r"\n\s*\n", content.strip())
    entries = []
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 2:
            continue
        m = re.match(
            r"(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})",
            lines[1],
        )
        if not m:
            continue
        start, end = ts_to_ms(m.group(1)), ts_to_ms(m.group(2))
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
    h = ms // 3600000; ms %= 3600000
    m = ms // 60000; ms %= 60000
    s = ms // 1000; ms %= 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _dedup_within_text(text: str) -> str:
    """Remove repeated phrases that YouTube auto-captions produce within a single block."""
    words = text.split()
    if len(words) < 6:
        return text
    # Try progressively shorter phrase lengths to find and remove repeats
    result_words = list(words)
    for phrase_len in range(len(words) // 2, 2, -1):
        i = 0
        cleaned = []
        while i < len(result_words):
            phrase = result_words[i : i + phrase_len]
            next_phrase = result_words[i + phrase_len : i + phrase_len * 2]
            if phrase == next_phrase:
                i += phrase_len  # skip the duplicate
            else:
                cleaned.append(result_words[i])
                i += 1
        result_words = cleaned
    return " ".join(result_words)


def merge_overlapping(entries: list[dict], max_duration_ms: int = 8000) -> list[dict]:
    if not entries:
        return []

    # Clean each entry
    cleaned = []
    for e in entries:
        text = re.sub(r">>\s*", "", e["text"])
        text = re.sub(r"\[.*?\]", "", text).strip()
        if text:
            cleaned.append({**e, "text": text})

    if not cleaned:
        return []

    # Deduplicate identical entries
    deduped = []
    seen_text = set()
    for e in cleaned:
        if e["text"] in seen_text:
            continue
        seen_text.add(e["text"])
        deduped.append(e)

    # Merge adjacent
    merged = []
    cur = {**deduped[0]}
    for e in deduped[1:]:
        gap = e["start"] - cur["end"]
        combined_dur = e["end"] - cur["start"]
        if gap < 1500 and combined_dur <= max_duration_ms:
            cur["end"] = max(cur["end"], e["end"])
            cur["text"] += " " + e["text"]
        else:
            merged.append(cur)
            cur = {**e}
    merged.append(cur)

    # Remove internal repetitions and clean up
    result = []
    for seg in merged:
        text = _dedup_within_text(seg["text"])
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) > 2:
            seg["text"] = text
            result.append(seg)
    return result


# ── Translation (DeepSeek) ────────────────────────────────────

_video_context = ""


def set_video_context(title: str = "", description: str = ""):
    global _video_context
    parts = []
    if title:
        parts.append(f"Video title: {title}")
    if description:
        desc_clean = description[:500].split("\n\n")[0]
        parts.append(f"Description: {desc_clean}")
    _video_context = "\n".join(parts)


def _call_translate(texts: list[str]) -> list[str]:
    import time

    system_prompt = (
        "You are a professional Russian-language sports/entertainment commentator. "
        "Translate English live commentary into natural, energetic Russian — "
        "as if you are commentating live on TV.\n\n"
        "Rules:\n"
        "- Translate naturally, not literally. Adapt to Russian style.\n"
        "- Keep proper names (people, places, brands) in original.\n"
        "- Use correct sport terminology.\n"
        '- "metal" in auto-captions means "medal" (медаль).\n'
        "- Keep the energy and excitement of live commentary.\n"
        "- Return ONLY a JSON array of translated strings, same order, same count.\n"
        "- No markdown, no explanation.\n"
    )
    if _video_context:
        system_prompt += f"\nVideo context:\n{_video_context}\n"

    payload = json.dumps({
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(texts, ensure_ascii=False)},
        ],
        "temperature": 0.3,
    }).encode()

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
    }

    for attempt in range(5):
        try:
            req = urllib.request.Request(DEEPSEEK_URL, data=payload, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 4:
                wait = (attempt + 1) * 5
                emit("translate_retry", code=e.code, wait=wait, attempt=attempt + 1)
                time.sleep(wait)
            else:
                raise

    raw = data["choices"][0]["message"]["content"].strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```\w*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    return json.loads(raw)


def translate_segments(segments: list[dict], batch_size: int = 20) -> list[dict]:
    import time
    all_translated = []
    total = len(segments)
    for i in range(0, total, batch_size):
        batch = segments[i : i + batch_size]
        texts = [s["text"] for s in batch]
        batch_num = i // batch_size + 1
        total_batches = (total + batch_size - 1) // batch_size
        emit("translate_batch", batch=batch_num, total=total_batches, segments=len(texts))
        translated = _call_translate(texts)
        if len(translated) != len(texts):
            emit("translate_warn", expected=len(texts), got=len(translated))
            translated = (translated + [""] * len(texts))[: len(texts)]
        for seg, tr in zip(batch, translated):
            all_translated.append({**seg, "text_ru": tr})
        if i + batch_size < total:
            time.sleep(1)
    return all_translated


# ── TTS ──────────────────────────────────────────────────────

async def synthesize_segments(segments: list[dict], output_dir: Path) -> list[dict]:
    import edge_tts
    output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for i, seg in enumerate(segments):
        text_ru = seg.get("text_ru", "").strip()
        if not text_ru:
            continue
        out_path = output_dir / f"seg_{i:04d}.mp3"
        try:
            comm = edge_tts.Communicate(text_ru, VOICE, rate="+10%")
            await comm.save(str(out_path))
            results.append({**seg, "audio_path": str(out_path)})
        except Exception as e:
            print(f"\n  TTS error seg {i}: {e}")
        sys.stdout.write(f"\r  TTS: {i + 1}/{len(segments)}")
        sys.stdout.flush()
    print()
    return results


# ── Audio Assembly ───────────────────────────────────────────

def get_duration_ms(path: str) -> int:
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True,
    )
    return int(float(r.stdout.strip()) * 1000)


def build_final_audio(segments: list[dict], bg_path: str, out_path: str):
    bg_dur = get_duration_ms(bg_path)
    print(f"  Background: {bg_dur / 1000:.1f}s, segments: {len(segments)}")

    filter_parts = []
    inputs = ["-i", bg_path]

    for i, seg in enumerate(segments):
        inputs.extend(["-i", seg["audio_path"]])
        seg_dur = get_duration_ms(seg["audio_path"])
        available = seg["end"] - seg["start"]
        if seg_dur > available + 500:
            speed = min(seg_dur / available, 1.5)
            filter_parts.append(
                f"[{i+1}:a]atempo={speed:.2f},adelay={seg['start']}|{seg['start']}[s{i}]"
            )
        else:
            filter_parts.append(
                f"[{i+1}:a]adelay={seg['start']}|{seg['start']}[s{i}]"
            )

    mix_inputs = "[0:a]" + "".join(f"[s{i}]" for i in range(len(segments)))
    filter_parts.append(
        f"{mix_inputs}amix=inputs={len(segments)+1}:duration=first:dropout_transition=0,"
        f"volume={len(segments)+1}[out]"
    )

    cmd = [
        "ffmpeg", "-y", *inputs,
        "-filter_complex", ";\n".join(filter_parts),
        "-map", "[out]", "-ac", "2", "-ar", "44100", out_path,
    ]
    print("  Mixing...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FFmpeg error:", r.stderr[-500:])
        raise RuntimeError("FFmpeg mixing failed")


# ── Demucs Separation ────────────────────────────────────────

def separate_audio(audio_path: str, folder: Path):
    import time
    from demucs_mlx import Separator, save_audio

    sep = Separator(model="htdemucs")
    print("  Separating with Demucs MLX...")
    start = time.time()
    _, result = sep.separate_audio_file(audio_path)
    elapsed = time.time() - start
    print(f"  Done in {elapsed:.1f}s — stems: {list(result.keys())}")

    sr = sep.samplerate
    for stem, audio in result.items():
        save_audio(audio, str(folder / f"{stem}.wav"), samplerate=sr)

    # Mix background (everything except vocals)
    bg_stems = [str(folder / f"{s}.wav") for s in result if s != "vocals"]
    bg_out = str(folder / "background.wav")
    inputs = []
    for s in bg_stems:
        inputs.extend(["-i", s])
    subprocess.run(
        ["ffmpeg", "-y", *inputs,
         "-filter_complex", f"amix=inputs={len(bg_stems)}:duration=longest",
         bg_out],
        capture_output=True, text=True, check=True,
    )
    print(f"  Background: {bg_out}")


# ── Main ─────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="Video dubbing EN→RU")
    parser.add_argument("folder", help="Video folder path")
    parser.add_argument("--title", default="", help="Video title for translation context")
    parser.add_argument("--description", default="", help="Video description for context")
    args = parser.parse_args()

    folder = Path(args.folder).resolve()
    if not folder.is_dir():
        emit("error", message=f"Not a directory: {folder}")
        sys.exit(1)

    mp4_files = [f for f in folder.glob("*.mp4") if "[RU]" not in f.name]
    srt_files = list(folder.glob("*.en.srt"))

    if not mp4_files:
        emit("error", message="No .mp4 file found")
        sys.exit(1)
    if not srt_files:
        emit("error", message="No .en.srt subtitle file found")
        sys.exit(1)

    video_path = mp4_files[0]
    srt_path = srt_files[0]
    video_name = video_path.stem

    set_video_context(args.title, args.description)
    emit("start", video=video_name, steps=5)

    # Step 1: Extract audio
    audio_path = folder / "original_audio.wav"
    emit("step", step=1, name="extract_audio")
    if not audio_path.exists():
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(video_path), "-vn",
             "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", str(audio_path)],
            capture_output=True, text=True, check=True,
        )
    dur = get_duration_ms(str(audio_path))
    emit("step_done", step=1, duration_s=round(dur / 1000, 1))

    # Step 2: Demucs
    bg_path = folder / "background.wav"
    emit("step", step=2, name="demucs_separate")
    if not bg_path.exists():
        separate_audio(str(audio_path), folder)
    emit("step_done", step=2)

    # Step 3: Translate
    cache_path = folder / "translation_cache.json"
    emit("step", step=3, name="translate")
    if cache_path.exists():
        with open(cache_path, "r", encoding="utf-8") as f:
            segments = json.load(f)
        emit("translate_cached", segments=len(segments))
    else:
        raw = parse_srt(str(srt_path))
        segments = merge_overlapping(raw)
        emit("translate_start", raw=len(raw), merged=len(segments))
        segments = translate_segments(segments)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(segments, f, ensure_ascii=False, indent=2)
    emit("step_done", step=3, segments=len(segments))

    srt_out = folder / "subtitles_ru.srt"
    with open(srt_out, "w", encoding="utf-8") as f:
        for i, s in enumerate(segments, 1):
            f.write(f"{i}\n{ms_to_ts(s['start'])} --> {ms_to_ts(s['end'])}\n{s.get('text_ru', '')}\n\n")

    # Step 4: TTS
    tts_dir = folder / "tts_segments"
    dubbed_path = folder / "dubbed_audio.wav"
    emit("step", step=4, name="tts_synthesize")
    segments = await synthesize_segments(segments, tts_dir)
    emit("step_done", step=4, audio_segments=len(segments))

    # Step 5: Mix + final video
    emit("step", step=5, name="mix_and_encode")
    build_final_audio(segments, str(bg_path), str(dubbed_path))

    out_video = folder / f"{video_name} [RU].mp4"
    subprocess.run(
        ["ffmpeg", "-y",
         "-i", str(video_path), "-i", str(dubbed_path),
         "-c:v", "copy", "-map", "0:v:0", "-map", "1:a:0",
         "-shortest", str(out_video)],
        capture_output=True, text=True, check=True,
    )

    size_mb = out_video.stat().st_size / 1024 / 1024
    emit("done", file=str(out_video), size_mb=round(size_mb, 1))


if __name__ == "__main__":
    asyncio.run(main())
