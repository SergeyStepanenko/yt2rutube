import path from "path";
import { downloadVideo, type VideoMeta } from "./youtube";
import { RutubeClient } from "./rutube";
import { startFileServer } from "./serve";

interface TransferResult {
  youtube: VideoMeta;
  rutubeVideoId: string;
  rutubeRaw: Record<string, any>;
}

/**
 * Полный пайплайн: YouTube → локальный диск → Rutube.
 *
 * 1. Скачивает видео с YouTube через yt-dlp
 * 2. Поднимает локальный HTTP-сервер для файла
 * 3. Авторизуется в Rutube
 * 4. Отправляет ссылку на файл в Rutube API
 * 5. Останавливает сервер (опционально, после таймаута)
 */
export async function transfer(
  youtubeUrl: string,
  options?: {
    rutubeEmail?: string;
    rutubePassword?: string;
    maxHeight?: number;
    categoryId?: number;
    isHidden?: boolean;
    /** Публичный URL, если файл уже доступен извне (напр. через ngrok) */
    publicBaseUrl?: string;
    /** Время ожидания (мс) перед остановкой сервера, чтобы Rutube успел скачать */
    serveTimeout?: number;
  }
): Promise<TransferResult> {
  const email = options?.rutubeEmail ?? process.env.RUTUBE_EMAIL;
  const password = options?.rutubePassword ?? process.env.RUTUBE_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Rutube credentials required. Set RUTUBE_EMAIL and RUTUBE_PASSWORD in .env"
    );
  }

  // 1. Скачиваем видео
  console.log(`\n[1/4] Скачиваем видео: ${youtubeUrl}`);
  const video = await downloadVideo(youtubeUrl, options?.maxHeight);
  console.log(`      Готово: ${video.title} (${video.id})`);

  // 2. Поднимаем файловый сервер
  console.log(`\n[2/4] Запускаем файловый сервер...`);
  const server = startFileServer();
  const filename = path.basename(video.filepath);
  const fileUrl = options?.publicBaseUrl
    ? `${options.publicBaseUrl}/${filename}`
    : `${server.url}/${filename}`;

  console.log(`      Файл доступен по: ${fileUrl}`);

  try {
    // 3. Авторизуемся в Rutube
    console.log(`\n[3/4] Авторизация в Rutube...`);
    const rutube = new RutubeClient();
    await rutube.login(email, password);

    // 4. Загружаем
    console.log(`\n[4/4] Отправляем видео в Rutube...`);
    const result = await rutube.uploadByUrl({
      url: fileUrl,
      title: video.title,
      description: video.description,
      isHidden: options?.isHidden,
      categoryId: options?.categoryId,
    });

    console.log(`\n  Видео отправлено в Rutube!`);
    console.log(`  Video ID: ${result.videoId}`);

    // Даём Rutube время скачать файл перед остановкой сервера
    const timeout = options?.serveTimeout ?? 5 * 60 * 1000;
    console.log(
      `\n  Сервер будет работать ещё ${timeout / 1000}с, чтобы Rutube скачал файл...`
    );
    console.log(`  (Нажми Ctrl+C для досрочной остановки)\n`);

    await Bun.sleep(timeout);
    server.stop();

    return { youtube: video, rutubeVideoId: result.videoId, rutubeRaw: result.raw };
  } catch (err) {
    server.stop();
    throw err;
  }
}
