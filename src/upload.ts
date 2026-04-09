import path from "path";
import { RutubeClient } from "./rutube";
import { startTunnel } from "./tunnel";

const videoPath = process.argv[2];

if (!videoPath) {
  console.error("Использование: bun run upload <путь-к-видео-или-папке>");
  console.error("Пример:        bun run upload 'downloads/Best MotoGP™ Moments 🔥 2026 US GP'");
  process.exit(1);
}

const email = process.env.RUTUBE_EMAIL;
const password = process.env.RUTUBE_PASSWORD;

if (!email || !password) {
  console.error("Заполни RUTUBE_EMAIL и RUTUBE_PASSWORD в .env");
  process.exit(1);
}

const resolvedPath = path.resolve(videoPath);

let mp4Path: string;
let title: string;

if (resolvedPath.endsWith(".mp4") && await Bun.file(resolvedPath).exists()) {
  mp4Path = resolvedPath;
  title = path.basename(resolvedPath, ".mp4");
} else {
  const glob = new Bun.Glob("*.mp4");
  let found = "";
  for await (const file of glob.scan(resolvedPath)) {
    found = path.join(resolvedPath, file);
    break;
  }
  if (!found) {
    console.error(`Не найден .mp4 файл: ${resolvedPath}`);
    process.exit(1);
  }
  mp4Path = found;
  title = path.basename(path.dirname(mp4Path));
}

const file = Bun.file(mp4Path);
const fileSize = file.size;
console.log(`\nФайл:     ${mp4Path}`);
console.log(`Размер:   ${(fileSize / 1024 / 1024).toFixed(1)} МБ`);
console.log(`Название: ${title}`);

const PORT = Number(process.env.SERVE_PORT) || 8333;

// 1. Сервер, который отдаёт один конкретный файл по /video.mp4
console.log(`\n[1/5] Запускаем файловый сервер...`);
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const urlPath = new URL(req.url).pathname;
    if (urlPath === "/video.mp4") {
      return new Response(Bun.file(mp4Path), {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(fileSize),
        },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`       Сервер: http://localhost:${PORT}/video.mp4`);

// 2. Tunnel
console.log(`[2/5] Поднимаем cloudflared tunnel...`);
const tunnel = await startTunnel(PORT);
const fileUrl = `${tunnel.publicUrl}/video.mp4`;
console.log(`       Публичный URL: ${fileUrl}`);

try {
  // 3. Авторизация
  console.log(`\n[3/5] Авторизация в Rutube...`);
  const rutube = new RutubeClient();
  await rutube.login(email, password);

  // 4. Загрузка
  console.log(`[4/5] Отправляем видео в Rutube...`);
  const result = await rutube.uploadByUrl({
    url: fileUrl,
    title: title.slice(0, 100),
    description: "",
    isHidden: false,
    categoryId: 13,
  });

  console.log(`\n       Видео отправлено!`);
  console.log(`       Video ID: ${result.videoId}`);

  // 5. Ждём пока Rutube скачает
  const waitMinutes = 10;
  console.log(`\n[5/5] Ждём до ${waitMinutes} минут, пока Rutube скачает файл...`);
  console.log(`       (Ctrl+C для досрочной остановки)\n`);

  for (let i = 0; i < waitMinutes * 6; i++) {
    await Bun.sleep(10_000);
    try {
      const video = await rutube.getVideo(result.videoId);
      const reason = video.action_reason?.name;
      const statusStr = reason ?? "processing";
      process.stdout.write(`\r       Статус: ${statusStr}          `);

      if (reason === "no_action" || reason === "moderation") {
        console.log(`\n\n       Rutube обработал файл! Статус: ${reason}`);
        console.log(`       URL: ${video.video_url}`);
        break;
      }
      if (reason === "error_upload_video") {
        console.log(`\n\n       Ошибка загрузки на стороне Rutube.`);
        console.log(`       Возможно Rutube не смог скачать файл.`);
        break;
      }
    } catch {
      process.stdout.write(`\r       Проверяем...                    `);
    }
  }
} finally {
  tunnel.stop();
  server.stop();
  console.log("\nСервер и tunnel остановлены.");
}
