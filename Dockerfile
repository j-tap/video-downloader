FROM oven/bun:latest

RUN apt update && \
    apt install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

ENV DENO_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"

# Makefile подставляет сюда дату сборки. Без этого docker compose build
# переиспользует закешированный слой, и yt-dlp на сервере навсегда остаётся
# тем, что был при первой сборке, — а устаревшие экстракторы и есть самая
# частая причина «часть видео перестала скачиваться».
ARG YTDLP_REFRESH=latest

# bgutil-ytdlp-pot-provider — плагин-клиент к провайдеру PO Token.
# Сам провайдер поднимается отдельным сервисом (см. docker-compose.prod.yml);
# если его нет, плагин просто ничего не делает.
# Значение ARG обязано встречаться внутри RUN: docker сбрасывает кеш
# в момент первого использования переменной, а не в момент её объявления.
RUN echo "yt-dlp build refresh: ${YTDLP_REFRESH}" && \
    pip3 install --break-system-packages --no-cache-dir --upgrade \
    "yt-dlp[default,curl-cffi]" \
    bgutil-ytdlp-pot-provider && \
    yt-dlp --version

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 3000

CMD bun server/index.ts
