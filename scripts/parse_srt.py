"""Parse, merge, dedup SRT — output clean segments for review."""
import re, sys

def parse_srt(path):
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    blocks = re.split(r"\n\s*\n", content.strip())
    entries = []
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 2: continue
        m = re.match(r"(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})", lines[1])
        if not m: continue
        start, end = ts_to_ms(m.group(1)), ts_to_ms(m.group(2))
        text = " ".join(lines[2:]).strip()
        if text: entries.append({"start": start, "end": end, "text": text})
    return entries

def ts_to_ms(ts):
    ts = ts.replace(",", "."); h, m, rest = ts.split(":"); s, ms = rest.split(".")
    return int(h)*3600000 + int(m)*60000 + int(s)*1000 + int(ms)

def ms_to_ts(ms):
    h = ms // 3600000; ms %= 3600000; m = ms // 60000; ms %= 60000; s = ms // 1000; ms %= 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def dedup_text(text):
    words = text.split()
    if len(words) < 6: return text
    result = list(words)
    for plen in range(len(words) // 2, 2, -1):
        i, cleaned = 0, []
        while i < len(result):
            phrase = result[i:i+plen]
            nxt = result[i+plen:i+plen*2]
            if phrase == nxt: i += plen
            else: cleaned.append(result[i]); i += 1
        result = cleaned
    return " ".join(result)

def merge(entries, max_dur=8000):
    cleaned = []
    for e in entries:
        t = re.sub(r">>\s*", "", e["text"]); t = re.sub(r"\[.*?\]", "", t).strip()
        if t: cleaned.append({**e, "text": t})
    deduped = []; seen = set()
    for e in cleaned:
        if e["text"] in seen: continue
        seen.add(e["text"]); deduped.append(e)
    merged, cur = [], {**deduped[0]}
    for e in deduped[1:]:
        gap, dur = e["start"] - cur["end"], e["end"] - cur["start"]
        if gap < 1500 and dur <= max_dur:
            cur["end"] = max(cur["end"], e["end"]); cur["text"] += " " + e["text"]
        else: merged.append(cur); cur = {**e}
    merged.append(cur)
    return [{**s, "text": re.sub(r"\s+", " ", dedup_text(s["text"])).strip()} for s in merged if len(re.sub(r"\s+", " ", dedup_text(s["text"])).strip()) > 2]

segments = merge(parse_srt(sys.argv[1]))
for i, s in enumerate(segments):
    print(f"{i+1:3d}. [{ms_to_ts(s['start'])} → {ms_to_ts(s['end'])}] {s['text']}")
print(f"\nTotal: {len(segments)} segments")
