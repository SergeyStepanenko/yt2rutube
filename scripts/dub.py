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
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

DEEPSEEK_API_KEY = os.environ.get("DEEP_SEEK_API_KEY", "")
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

def _find_bin(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    for prefix in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"):
        p = os.path.join(prefix, name)
        if os.path.isfile(p):
            return p
    return name

FFMPEG = _find_bin("ffmpeg")
FFPROBE = _find_bin("ffprobe")


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


# ── Subtitle preprocessing ────────────────────────────────────


def _dedup_overlap(prev_words: list[str], next_words: list[str]) -> list[str]:
    """Find overlapping suffix of prev_words with prefix of next_words.
    Return only the unique (non-overlapping) tail of next_words."""
    best = 0
    for olen in range(1, min(len(prev_words), len(next_words)) + 1):
        if prev_words[-olen:] == next_words[:olen]:
            best = olen
    return next_words[best:]


def flatten_srt(entries: list[dict]) -> list[dict]:
    """Flatten raw SRT entries into a continuous word stream with per-word timing.

    YouTube auto-captions overlap: tail of segment N = head of segment N+1.
    We deduplicate and build a list of {word, start_ms, end_ms} for every unique word.
    """
    if not entries:
        return []

    # Clean
    cleaned = []
    for e in entries:
        text = re.sub(r">>\s*", "", e["text"])
        text = re.sub(r"\[.*?\]", "", text).strip()
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            cleaned.append({**e, "text": text})

    if not cleaned:
        return []

    # Build continuous word list by deduplicating overlapping tails/heads.
    all_words: list[str] = cleaned[0]["text"].split()
    # Per-word timing: interpolate within each segment
    word_times: list[dict] = []

    def _add_word_times(words: list[str], start_ms: int, end_ms: int):
        n = len(words)
        if n == 0:
            return
        dur = end_ms - start_ms
        for j, w in enumerate(words):
            ws = start_ms + int(dur * j / n)
            we = start_ms + int(dur * (j + 1) / n)
            word_times.append({"word": w, "start": ws, "end": we})

    _add_word_times(all_words, cleaned[0]["start"], cleaned[0]["end"])

    for e in cleaned[1:]:
        next_words = e["text"].split()
        unique = _dedup_overlap(all_words[-20:], next_words)
        if unique:
            all_words.extend(unique)
            n_total = len(next_words)
            n_unique = len(unique)
            overlap_count = n_total - n_unique
            dur = e["end"] - e["start"]
            unique_start = e["start"] + int(dur * overlap_count / n_total) if n_total > 0 else e["start"]
            _add_word_times(unique, unique_start, e["end"])

    return word_times


def _call_deepseek(system: str, user: str, temperature: float = 0.3, model: str = "deepseek-chat") -> str:
    """Generic DeepSeek API call with retry."""
    import time

    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
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
                emit("api_retry", code=e.code, wait=wait, attempt=attempt + 1)
                time.sleep(wait)
            else:
                raise

    raw = data["choices"][0]["message"]["content"].strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```\w*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    return raw


def _call_claude(system: str, user: str, temperature: float = 0.3) -> str:
    """Generic Claude Sonnet 4.6 API call with retry."""
    import time
    import anthropic

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    for attempt in range(5):
        try:
            msg = client.messages.create(
                model="deepseek-v4-flash",
                max_tokens=4096,
                temperature=temperature,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            raw = msg.content[0].text.strip()
            if raw.startswith("```"):
                raw = re.sub(r"^```\w*\n?", "", raw)
                raw = re.sub(r"\n?```$", "", raw)
            return raw
        except (anthropic.RateLimitError, anthropic.InternalServerError) as e:
            if attempt < 4:
                wait = (attempt + 1) * 5
                code = getattr(e, "status_code", "?")
                emit("api_retry", code=code, wait=wait, attempt=attempt + 1)
                time.sleep(wait)
            else:
                raise
        except Exception:
            if attempt < 4:
                time.sleep((attempt + 1) * 5)
            else:
                raise


def add_punctuation(text: str, batch_size: int = 800) -> str:
    """Send raw text to DeepSeek to add punctuation. Process in batches by word count."""
    words = text.split()
    if not words:
        return text

    system = (
        "You are a punctuation restoration model. "
        "The user gives you English text from auto-generated speech-to-text captions "
        "with NO punctuation. Your task:\n"
        "1. Add proper punctuation: periods, commas, question marks, exclamation marks.\n"
        "2. Fix obvious capitalization (start of sentences).\n"
        "3. DO NOT change, remove, add, or reorder any words. "
        "The word count and order must remain EXACTLY the same.\n"
        "4. Return ONLY the punctuated text, nothing else.\n"
    )
    if _video_context:
        system += f"\nContext (for understanding domain terms):\n{_video_context}\n"

    result_parts = []
    for i in range(0, len(words), batch_size):
        batch = " ".join(words[i : i + batch_size])
        batch_num = i // batch_size + 1
        total_batches = (len(words) + batch_size - 1) // batch_size
        emit("punctuate_batch", batch=batch_num, total=total_batches)
        punctuated = _call_deepseek(system, batch)
        result_parts.append(punctuated.strip())

    return " ".join(result_parts)


def split_into_segments(punctuated_text: str, word_times: list[dict]) -> list[dict]:
    """Split punctuated text into sentence-based segments with timings from word_times."""
    # Split on sentence boundaries
    raw_sentences = re.split(r'(?<=[.!?])\s+', punctuated_text.strip())

    # Merge very short fragments (< 3 words) into the previous sentence,
    # and split overly long sentences at commas.
    MAX_WORDS = 25
    sentences: list[str] = []
    for s in raw_sentences:
        s = s.strip()
        if not s:
            continue
        if sentences and len(s.split()) < 3:
            sentences[-1] += " " + s
        else:
            sentences.append(s)

    # Split long sentences at commas
    final: list[str] = []
    for s in sentences:
        words = s.split()
        if len(words) <= MAX_WORDS:
            final.append(s)
            continue
        # Split on commas
        parts = re.split(r',\s*', s)
        buf = ""
        for p in parts:
            candidate = (buf + ", " + p).strip(", ") if buf else p
            if len(candidate.split()) > MAX_WORDS and buf:
                final.append(buf.rstrip(",") + ",")
                buf = p
            else:
                buf = candidate
        if buf:
            final.append(buf)
    sentences = [s for s in final if len(s.split()) >= 2]

    if not sentences:
        return []

    # Map sentences to word_times (use real timings).
    segments = []
    wi = 0
    MIN_GAP_MS = 200
    MIN_SEGMENT_MS = 2000

    for sent in sentences:
        sent_words = sent.split()
        n = len(sent_words)
        if n == 0:
            continue

        if wi >= len(word_times):
            break

        start_idx = wi
        end_idx = min(wi + n - 1, len(word_times) - 1)

        seg_start = word_times[start_idx]["start"]
        seg_end = word_times[end_idx]["end"]

        if seg_end - seg_start < 300:
            seg_end = seg_start + max(300, n * 150)

        segments.append({
            "start": seg_start,
            "end": seg_end,
            "text": sent,
        })

        wi += n

    if not segments:
        return []

    # Enforce non-overlapping with minimum gap
    for i in range(1, len(segments)):
        if segments[i]["start"] < segments[i - 1]["end"] + MIN_GAP_MS:
            segments[i]["start"] = segments[i - 1]["end"] + MIN_GAP_MS
        if segments[i]["start"] >= segments[i]["end"]:
            segments[i]["end"] = segments[i]["start"] + 500

    # Merge only truly short segments (< MIN_SEGMENT_MS) into neighbors.
    # Single pass, non-cascading: merge short seg into previous if combined
    # duration stays reasonable, otherwise into next.
    merged = [segments[0]]
    for seg in segments[1:]:
        prev = merged[-1]
        prev_dur = prev["end"] - prev["start"]
        seg_dur = seg["end"] - seg["start"]

        if seg_dur < MIN_SEGMENT_MS and prev_dur < 15000:
            prev["end"] = seg["end"]
            prev["text"] += " " + seg["text"]
        elif prev_dur < MIN_SEGMENT_MS and seg_dur < 15000:
            seg["start"] = prev["start"]
            seg["text"] = prev["text"] + " " + seg["text"]
            merged[-1] = seg
        else:
            merged.append(dict(seg))
    segments = merged

    # Extend each segment into the gap before next (use silence for TTS breathing room)
    for i in range(len(segments) - 1):
        gap = segments[i + 1]["start"] - segments[i]["end"]
        if gap > MIN_GAP_MS:
            segments[i]["end"] += gap - MIN_GAP_MS

    return segments


# ── Translation (Claude) ──────────────────────────────────────

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


def translate_segments(segments: list[dict], batch_size: int = 25) -> list[dict]:
    """Translate punctuated English sentences to Russian via Claude."""
    import time

    system_prompt = (
        "You are a professional Russian-language sports/entertainment commentator. "
        "Translate English live commentary into natural, energetic Russian — "
        "as if you are commentating live on TV.\n\n"
        "Rules:\n"
        "- Translate naturally, not literally. Adapt to Russian conversational style.\n"
        "- CRITICAL: Keep translations compact. Each Russian phrase will be spoken by TTS "
        "in the SAME time slot as the English original. Russian words are longer than English, "
        "so aim for ~85-90% of original word count. Cut only filler words, keep full natural phrases.\n"
        "- HUMANIZE the text: use colloquial expressions, interjections (ого, ну, вот это да, "
        "э-э, ах), contractions, and natural speech patterns that a real person would use. "
        "Avoid robotic/bookish phrasing. Write as people SPEAK, not as they write. "
        "Never cut a phrase so short it sounds like a telegram.\n"
        "- Vary sentence rhythm — mix short punchy exclamations with longer phrases. "
        "Don't make every sentence the same structure.\n"
        "- Keep proper names (people, places, brands) in original.\n"
        "- Use correct sport terminology.\n"
        "- Keep the energy and excitement of live commentary.\n"
        "- Return ONLY a JSON array of translated strings, same order, same count.\n"
        "- No markdown, no explanation.\n"
    )
    if _video_context:
        system_prompt += f"\nVideo context:\n{_video_context}\n"

    all_translated = []
    total = len(segments)

    for i in range(0, total, batch_size):
        batch = segments[i : i + batch_size]
        texts = [s["text"] for s in batch]
        batch_num = i // batch_size + 1
        total_batches = (total + batch_size - 1) // batch_size
        emit("translate_batch", batch=batch_num, total=total_batches, segments=len(texts))

        raw = _call_deepseek(system_prompt, json.dumps(texts, ensure_ascii=False), model="deepseek-v4-flash")
        translated = json.loads(raw)

        if len(translated) != len(texts):
            emit("translate_warn", expected=len(texts), got=len(translated))
            translated = (translated + [""] * len(texts))[: len(texts)]

        for seg, tr in zip(batch, translated):
            all_translated.append({**seg, "text_ru": tr})

        if i + batch_size < total:
            time.sleep(1)

    return all_translated


def critique_translations(segments: list[dict], batch_size: int = 15) -> list[dict]:
    """Two-pass critic: rewrite translations that don't fit or flow poorly."""
    system = (
        "Ты — редактор дублированного спортивного комментария. "
        "Для каждого сегмента дай улучшенный перевод на русский. "
        "Требования:\n"
        "1. ДЛИНА: Перевод должен укладываться в available_ms миллисекунд при скорости ~2.2 слова/сек. "
        "   Целевое количество слов = target_words. Не превышай его.\n"
        "2. СВЯЗНОСТЬ: Учитывай prev_ru и next_ru — избегай неловких повторов "
        "   и лишних союзов на стыках.\n"
        "3. ЭНЕРГИЯ: Сохраняй живой разговорный стиль комментатора.\n"
        "Верни JSON-массив объектов {\"text_ru\": \"...\"} в том же порядке и количестве. "
        "Без markdown, без пояснений."
    )

    result = list(segments)

    for i in range(0, len(segments), batch_size):
        batch = segments[i : i + batch_size]
        batch_num = i // batch_size + 1
        total_batches = (len(segments) + batch_size - 1) // batch_size
        emit("critique_batch", batch=batch_num, total=total_batches)

        items = []
        for j, seg in enumerate(batch):
            available_ms = seg["end"] - seg["start"]
            target_words = round(available_ms / 1000 * 2.2)
            prev_ru = result[i + j - 1].get("text_ru", "") if i + j > 0 else ""
            next_ru = segments[i + j + 1].get("text_ru", "") if i + j + 1 < len(segments) else ""
            items.append({
                "en": seg.get("text", ""),
                "ru": seg.get("text_ru", ""),
                "available_ms": available_ms,
                "target_words": target_words,
                "prev_ru": prev_ru,
                "next_ru": next_ru,
            })

        raw = _call_deepseek(system, json.dumps(items, ensure_ascii=False), model="deepseek-v4-flash")
        critiqued = json.loads(raw)

        if len(critiqued) != len(batch):
            emit("critique_warn", expected=len(batch), got=len(critiqued))
            critiqued = (critiqued + [{}] * len(batch))[: len(batch)]

        for j, item in enumerate(critiqued):
            if item.get("text_ru"):
                result[i + j]["text_ru"] = item["text_ru"]

    return result


# ── TTS (Coqui XTTS v2) ──────────────────────────────────────

XTTS_SPEAKERS = ["Viktor Eka", "Damien Black"]

_xtts_model = None
_xtts_speaker = None
_accentizer = None


def _load_accentizer():
    global _accentizer
    if _accentizer is not None:
        return
    from ruaccent import RUAccent
    emit("ruaccent_load", msg="loading RuAccent...")
    _accentizer = RUAccent()
    _accentizer.load(omograph_model_size="turbo3.1", use_dictionary=True)
    emit("ruaccent_ready")


def _apply_yo(text: str) -> str:
    """Restore ё letters via RuAccent, strip + stress markers (XTTS doesn't need them)."""
    try:
        _load_accentizer()
        return _accentizer.process_all(text).replace("+", "")
    except Exception:
        return text


def _load_xtts():
    global _xtts_model
    if _xtts_model is not None:
        return
    import torch
    os.environ["COQUI_TOS_AGREED"] = "1"
    from TTS.api import TTS
    emit("xtts_load", msg="loading XTTS v2 model...")
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    _xtts_model = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
    emit("xtts_ready", device=device)


def _tts_one(text: str, out_path: Path):
    """Synthesize one TTS segment with XTTS v2."""
    _load_xtts()
    text_yo = _apply_yo(text)
    _xtts_model.tts_to_file(
        text=text_yo,
        speaker=_xtts_speaker,
        language="ru",
        file_path=str(out_path),
    )


def _shorten_text(text_ru: str, target_words: int, original_en: str) -> str:
    """Ask Claude to rephrase Russian text to be shorter."""
    system = (
        "Ты — редактор русских субтитров для спортивного комментатора. Тебе дан перевод фразы, "
        "который слишком длинный для озвучки. Перефразируй его КОРОЧЕ — "
        f"максимум {target_words} слов. Сохрани смысл, энергию и живую разговорную интонацию. "
        "Используй разговорный стиль, как настоящий комментатор. "
        "Не добавляй ничего нового. Верни ТОЛЬКО сокращённый текст, без кавычек."
    )
    user = f"Английский оригинал: {original_en}\nТекущий перевод: {text_ru}"
    return _call_deepseek(system, user, temperature=0.4, model="deepseek-v4-flash").strip().strip('"')


def synthesize_segments(segments: list[dict], output_dir: Path) -> list[dict]:
    import random
    global _xtts_speaker
    _xtts_speaker = random.choice(XTTS_SPEAKERS)
    emit("tts_speaker", speaker=_xtts_speaker)

    output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    shortened = 0
    skipped = 0
    SHORTEN_RETRIES = 5
    FIT_TOLERANCE = 1.05  # TTS can be up to 5% longer than slot (trimmed at assembly)

    for i, seg in enumerate(segments):
        text_ru = seg.get("text_ru", "").strip()
        if not text_ru:
            continue

        available = seg["end"] - seg["start"]
        if available <= 0:
            continue

        out_path = output_dir / f"seg_{i:04d}.wav"
        current_text = text_ru

        # Skip synthesis if cached segment already exists
        if out_path.exists() and out_path.stat().st_size > 1000:
            tts_dur = get_duration_ms(str(out_path))
            results.append({**seg, "text_ru": current_text, "audio_path": str(out_path)})
            sys.stdout.write(f"\r  TTS: {i + 1}/{len(segments)} (cached)")
            sys.stdout.flush()
            continue

        try:
            _tts_one(current_text, out_path)
        except Exception as e:
            emit("tts_error", index=i, error=str(e)[:120])
            continue

        tts_dur = get_duration_ms(str(out_path))

        for _ in range(SHORTEN_RETRIES):
            if tts_dur <= available * FIT_TOLERANCE:
                break
            ratio = tts_dur / available
            current_words = len(current_text.split())
            target_words = max(2, int(current_words / ratio * 0.8))
            if target_words >= current_words:
                target_words = current_words - 1
            if target_words < 2:
                break
            try:
                new_text = _shorten_text(
                    current_text, target_words, seg.get("text", "")
                )
                if new_text and len(new_text.split()) < current_words:
                    current_text = new_text
                    shortened += 1
                    _tts_one(current_text, out_path)
                    tts_dur = get_duration_ms(str(out_path))
                else:
                    break
            except Exception:
                break

        if tts_dur > available * 1.3:
            skipped += 1
            emit("tts_skip", index=i, tts_ms=tts_dur, available_ms=available,
                 ratio=round(tts_dur / available, 2), text=current_text[:60])
            continue

        results.append({**seg, "text_ru": current_text, "audio_path": str(out_path)})

        sys.stdout.write(f"\r  TTS: {i + 1}/{len(segments)}")
        sys.stdout.flush()

    print()
    if shortened:
        emit("tts_shortened", count=shortened, total=len(segments))
    if skipped:
        emit("tts_skipped", count=skipped, total=len(segments))
    return results


# ── Audio Assembly ───────────────────────────────────────────

def get_duration_ms(path: str) -> int:
    r = subprocess.run(
        [FFPROBE, "-v", "quiet", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True,
    )
    return int(float(r.stdout.strip()) * 1000)


def build_final_audio(segments: list[dict], bg_path: str, out_path: str):
    bg_dur = get_duration_ms(bg_path)
    print(f"  Background: {bg_dur / 1000:.1f}s, segments: {len(segments)}")

    TAIL_PAD_MS = 80

    filter_parts = []
    inputs = ["-i", bg_path]

    placed = []
    for i, seg in enumerate(segments):
        seg_dur = get_duration_ms(seg["audio_path"])
        available = seg["end"] - seg["start"]
        if available <= 0:
            continue

        trim_limit = max(available - TAIL_PAD_MS, available * 0.9)
        trim_s = min(seg_dur, trim_limit) / 1000

        offset = seg["start"]
        filters = [
            f"aresample=44100",
            f"atrim=0:{trim_s:.3f}",
            "afade=t=out:st={:.3f}:d=0.05".format(max(0, trim_s - 0.05)),
            f"adelay={offset}|{offset}",
        ]

        filter_str = f"[{i+1}:a]" + ",".join(filters) + f"[s{i}]"
        filter_parts.append(filter_str)
        inputs.extend(["-i", seg["audio_path"]])
        placed.append(i)

    mix_inputs = "[0:a]" + "".join(f"[s{i}]" for i in placed)
    # normalize=0: no auto-attenuation; limiter prevents clipping
    filter_parts.append(
        f"{mix_inputs}amix=inputs={len(placed)+1}:duration=first:dropout_transition=0:normalize=0,"
        f"alimiter=level_in=1:level_out=1:limit=0.95:attack=5:release=50[out]"
    )

    cmd = [
        FFMPEG, "-y", *inputs,
        "-filter_complex", ";\n".join(filter_parts),
        "-map", "[out]", "-ac", "2", "-ar", "44100", out_path,
    ]
    print("  Mixing...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FFmpeg error:", r.stderr[-1000:])
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
        [FFMPEG, "-y", *inputs,
         "-filter_complex", f"amix=inputs={len(bg_stems)}:duration=longest",
         bg_out],
        capture_output=True, text=True, check=True,
    )
    print(f"  Background: {bg_out}")


# ── Main ─────────────────────────────────────────────────────

def main():
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
    emit("start", video=video_name, steps=6)

    # Step 1: Extract audio
    audio_path = folder / "original_audio.wav"
    emit("step", step=1, name="extract_audio")
    if not audio_path.exists():
        subprocess.run(
            [FFMPEG, "-y", "-i", str(video_path), "-vn",
             "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", str(audio_path)],
            capture_output=True, text=True, check=True,
        )
    dur = get_duration_ms(str(audio_path))
    emit("step_done", step=1, duration_s=round(dur / 1000, 1))

    # Step 2: Demucs separation
    bg_path = folder / "background.wav"
    emit("step", step=2, name="demucs_separate")
    if not bg_path.exists():
        separate_audio(str(audio_path), folder)
    emit("step_done", step=2)

    # Step 3: Flatten subtitles + add punctuation + segment by sentences
    cache_path = folder / "translation_cache.json"
    punctuated_cache = folder / "punctuated_text.txt"

    if cache_path.exists():
        emit("step", step=3, name="punctuate")
        emit("step_done", step=3, cached=True)
        emit("step", step=4, name="translate")
        with open(cache_path, "r", encoding="utf-8") as f:
            segments = json.load(f)
        emit("translate_cached", segments=len(segments))
        emit("step_done", step=4, segments=len(segments))
    else:
        # Step 3a: Flatten SRT into word stream
        emit("step", step=3, name="punctuate")
        raw_entries = parse_srt(str(srt_path))
        word_times = flatten_srt(raw_entries)
        flat_text = " ".join(w["word"] for w in word_times)
        emit("flatten_done", raw_entries=len(raw_entries), unique_words=len(word_times))

        # Step 3b: Add punctuation via DeepSeek
        if punctuated_cache.exists():
            with open(punctuated_cache, "r", encoding="utf-8") as f:
                punctuated = f.read().strip()
            emit("punctuate_cached", chars=len(punctuated))
        else:
            punctuated = add_punctuation(flat_text)
            with open(punctuated_cache, "w", encoding="utf-8") as f:
                f.write(punctuated)

        # Step 3c: Split into sentence-based segments
        segments = split_into_segments(punctuated, word_times)
        emit("step_done", step=3, sentences=len(segments))

        # Step 4: Translate sentences to Russian (Claude), then two-pass critic
        emit("step", step=4, name="translate")
        emit("translate_start", sentences=len(segments))
        segments = translate_segments(segments)
        emit("critique_start", segments=len(segments))
        segments = critique_translations(segments)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(segments, f, ensure_ascii=False, indent=2)
        emit("step_done", step=4, segments=len(segments))

    # Write Russian SRT
    srt_out = folder / "subtitles_ru.srt"
    with open(srt_out, "w", encoding="utf-8") as f:
        for i, s in enumerate(segments, 1):
            f.write(f"{i}\n{ms_to_ts(s['start'])} --> {ms_to_ts(s['end'])}\n{s.get('text_ru', '')}\n\n")

    # Step 5: TTS synthesis (Silero + RuAccent, with auto-shortening of overlong translations)
    tts_dir = folder / "tts_segments"
    dubbed_path = folder / "dubbed_audio.wav"
    emit("step", step=5, name="tts_synthesize")
    segments = synthesize_segments(segments, tts_dir)
    emit("step_done", step=5, audio_segments=len(segments))

    # Update text_ru in full cache for any segments that were shortened during TTS.
    # Load full cache (all translated segments) and patch only the shortened ones.
    if segments:
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                full_cache = json.load(f)
            shortened_map = {s["start"]: s["text_ru"] for s in segments if "text_ru" in s}
            for seg in full_cache:
                if seg["start"] in shortened_map:
                    seg["text_ru"] = shortened_map[seg["start"]]
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(full_cache, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    # Step 6: Mix audio + encode final video
    emit("step", step=6, name="mix_and_encode")
    build_final_audio(segments, str(bg_path), str(dubbed_path))

    out_video = folder / f"{video_name} [RU].mp4"
    subprocess.run(
        [FFMPEG, "-y",
         "-i", str(video_path), "-i", str(dubbed_path),
         "-c:v", "copy", "-map", "0:v:0", "-map", "1:a:0",
         "-c:a", "aac", "-b:a", "320k",
         "-shortest", str(out_video)],
        capture_output=True, text=True, check=True,
    )

    size_mb = out_video.stat().st_size / 1024 / 1024
    emit("done", file=str(out_video), size_mb=round(size_mb, 1))


if __name__ == "__main__":
    main()
