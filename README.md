# video-downloader

Веб-приложение для скачивания видео через `yt-dlp` с простым UI и API.

## Требования

- [Bun](https://bun.sh)
- `yt-dlp` в `PATH` (или переменная `YTDLP_PATH`)
- `ffmpeg` (для merge/remux в mp4)

## Установка

```bash
bun install
```

## Запуск

```bash
cp .env.template .env
bun run dev
```

По умолчанию сервер стартует на `http://localhost:3000`.

## Поддерживаемые источники

- YouTube
- Facebook
- Instagram
- kino.pub (обычно требует авторизацию через cookies)
- Прочие сайты, поддерживаемые `yt-dlp`

## Cookies и авторизация

Приложение умеет подбирать cookies по домену, чтобы не смешивать сессии разных сайтов.

### YouTube

- `YT_COOKIES_FILE` или `data/cookiesYoutube.txt`
- `YT_COOKIES_FROM_BROWSER` (например `chrome`)

### kino.pub

- `KINOPUB_COOKIES_FILE` или `data/cookiesKinoPub.txt`
- `KINOPUB_COOKIES_FROM_BROWSER` (например `chrome`)
- Если страница `item/view/...` отдает только трейлер, используй прямую `m3u8` ссылку full-видео из Network в браузере

### Общий fallback

- `COOKIES_FILE` или `data/cookies.txt`
- `COOKIES_FROM_BROWSER`

Все cookie-файлы должны быть в формате Netscape.

## Полезные переменные окружения

- `PORT` — порт сервера (по умолчанию `3000`)
- `PROXY` / `YT_PROXY` — прокси для `yt-dlp`
- `YTDLP_PATH` — путь к бинарнику `yt-dlp`
- `YT_PO_TOKEN` — опциональный токен для YouTube
- `YT_PLAYER_CLIENT` — ручной выбор `player_client` для YouTube

## API

- `POST /download` — старт загрузки (`{ "url": "..." }`)
- `GET /status/:id` — статус загрузки
- `POST /cancel/:id` — отмена загрузки
- `GET /file/:id` — скачать готовый файл

## Частые проблемы

- `yt-dlp not found` — установи `yt-dlp` или задай `YTDLP_PATH`
- Ошибки авторизации — обнови cookies-файл/сессию в браузере
- Ошибки сети — проверь `PROXY`/`YT_PROXY` и доступность сайта

## Важно

Используй только для контента, который тебе разрешено скачивать по закону и правилам источника.
