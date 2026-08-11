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

### Instagram / Facebook

- `INSTAGRAM_COOKIES_FILE` / `INSTAGRAM_COOKIES_FROM_BROWSER`
- `FACEBOOK_COOKIES_FILE` / `FACEBOOK_COOKIES_FROM_BROWSER`
- Для ссылок Instagram/Facebook автоматически убираются трекинг-параметры (`utm_*`, `igsh` и т.п.)

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

Сервис публичный, но загрузка привязана к клиенту: `/status`, `/file` и `/cancel`
доступны только тому браузеру, который её запустил (cookie `vd_client`).

## Безопасность

Сервис принимает URL от анонимных пользователей, поэтому каждая ссылка проверяется
до запуска `yt-dlp`:

- хост должен быть в белом списке площадок: YouTube, Instagram, Facebook, kino.pub
  (и CDN `cdntogo.net`) — посторонние адреса отклоняются с `400` до запуска `yt-dlp`
- только `http`/`https`, только порты 80 и 443 (`ALLOWED_PORTS`)
- запрещены ссылки с логином/паролем (`user:pass@host`)
- блокируются IP внутренней сети: `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`,
  `169.254/16` (включая `169.254.169.254`), `100.64/10`, IPv6 ULA/link-local,
  а также обходы через десятичную/hex-нотацию и `::ffff:` маппинг
- имя хоста резолвится, и если хоть один адрес приватный — запрос отклоняется
- блокируются имена контейнеров (`mysql`) и внутренние зоны (`*.local`, `*.internal`)
- `ALLOWED_HOSTS` заменяет список площадок своим; `ALLOWED_HOSTS=*` снимает
  ограничение по хостам (проверки схемы, портов и приватных адресов остаются)
- CORS закрыт: API вызывается только со своего origin (`CORS_ORIGINS` — исключения)

Ограничения ресурсов (все настраиваются, см. `.env.template`):

| Что | Переменная | По умолчанию |
| --- | --- | --- |
| Стартов загрузки с IP | `RATE_LIMIT_DOWNLOAD_MAX` | 10 / 15 мин |
| Прочих запросов с IP | `RATE_LIMIT_API_MAX` | 240 / мин |
| Одновременных загрузок | `MAX_CONCURRENT_DOWNLOADS` | 3 |
| Одновременно с одного IP | `MAX_CONCURRENT_PER_CLIENT` | 1 |
| Размер одного файла | `MAX_DOWNLOAD_SIZE` | 4G |
| Всего временных файлов | `MAX_TOTAL_STORAGE` | 20G |
| Длительность видео | `MAX_DURATION_SECONDS` | 4 часа |
| Таймаут загрузки | `DOWNLOAD_TIMEOUT_MINUTES` | 30 мин |

Размер контролируется и «снаружи» yt-dlp: watchdog каждые 15 секунд считает объём
файлов загрузки и убивает процесс при превышении — это важно для HLS/m3u8,
где `--max-filesize` не работает, потому что размер заранее неизвестен.

За Traefik обязательно оставьте `TRUST_PROXY_HOPS=1`, иначе rate limit увидит
всех пользователей как один IP.

Cookies привязаны к площадке по имени хоста: ссылка на YouTube получает только
`cookiesYoutube.txt` (или общий `COOKIES_FILE`), kino.pub — только
`cookiesKinoPub.txt`, и так далее. Хост, не совпавший ни с одной площадкой,
не получает cookies вообще — включая общий файл и `--cookies-from-browser`.

Что осталось за пределами приложения: цепочку редиректов мы проверяем сами,
но `yt-dlp` ходит по ней повторно, поэтому полную изоляцию даёт только запрет
egress из контейнера во внутренние подсети на уровне docker/firewall.
И помните, что публичный сервис использует ваши cookies kino.pub/YouTube
от вашего имени — если это нежелательно, уберите cookie-файлы.

## Частые проблемы

- `yt-dlp not found` — установи `yt-dlp` или задай `YTDLP_PATH`
- Ошибки авторизации — обнови cookies-файл/сессию в браузере
- **Часть видео не скачивается / низкое качество** — чаще всего устарел `yt-dlp`
  внутри образа. Версия — это дата релиза; сервер при старте предупреждает, если
  сборке больше 45 дней. Лечится `make rebuild` (пересборка без кеша)
- `Requested format is not available` для YouTube — YouTube требует PO Token для
  части клиентов. Сервис сам повторяет попытку с другим `player_client`;
  при желании можно закрепить рабочий через `YT_PLAYER_CLIENT`
- Ошибки сети — проверь `PROXY`/`YT_PROXY` и доступность сайта

## Важно

Используй только для контента, который тебе разрешено скачивать по закону и правилам источника.
