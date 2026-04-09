const bundleUrl = "https://studio.rutube.ru/studio-prod-release-studio-345.1.0-50d55029/4356.22fc11dd42c0ff88.bundle.js";
const js = await (await fetch(bundleUrl)).text();
console.log("Bundle size:", js.length);

const apiRegex = /["'`]\/api\/[^"'`\s]{3,}["'`]/g;
const matches = js.match(apiRegex);
if (matches) {
  const unique = [...new Set(matches)];
  console.log("\nAll API paths (" + unique.length + "):");
  for (const m of unique) console.log("  ", m);
}

// Also search for avatar/cover/photo keywords near API calls
const keywords = ["avatar", "cover", "photo", "channel_settings", "channel-settings", "обложк"];
for (const kw of keywords) {
  const idx = js.indexOf(kw);
  if (idx !== -1) {
    console.log(`\n"${kw}" found at ${idx}:`);
    console.log("  context:", js.slice(Math.max(0, idx - 100), idx + 100));
  }
}
