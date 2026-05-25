import { transfer } from "./src/pipeline";

const youtubeUrl = process.argv[2];

if (!youtubeUrl) {
  console.error("Usage:   bun run index.ts <youtube-url>");
  console.error("Example: bun run index.ts https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  process.exit(1);
}

try {
  const result = await transfer(youtubeUrl);
  console.log("\nDone!");
  console.log(`YouTube:  ${result.youtube.title} (${result.youtube.id})`);
  console.log(`Rutube:   ${result.rutubeVideoId}`);
} catch (err) {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
}
