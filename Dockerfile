FROM oven/bun:1.3.14

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

# nightly — канал, который советуют сами авторы yt-dlp: починки экстракторов
# выходят там в тот же день, а в stable доезжают через недели (между релизами
# бывает по два месяца). YTDLP_CHANNEL=stable возвращает стабильные релизы.
ARG YTDLP_CHANNEL=nightly

# bgutil-ytdlp-pot-provider — плагин-клиент к провайдеру PO Token.
# Сам провайдер поднимается отдельным сервисом (см. docker-compose.prod.yml);
# если его нет, плагин просто ничего не делает.
# Значение ARG обязано встречаться внутри RUN: docker сбрасывает кеш
# в момент первого использования переменной, а не в момент её объявления.
#
# Nightly ставится вторым шагом и без зависимостей: глобальный --pre
# притянул бы заодно бета-версии curl-cffi, requests и остального.
RUN echo "yt-dlp build refresh: ${YTDLP_REFRESH} (${YTDLP_CHANNEL})" && \
    pip3 install --break-system-packages --no-cache-dir --upgrade \
    "yt-dlp[default,curl-cffi]" \
    bgutil-ytdlp-pot-provider && \
    if [ "${YTDLP_CHANNEL}" = "nightly" ]; then \
      pip3 install --break-system-packages --no-cache-dir --upgrade --pre --no-deps yt-dlp; \
    fi && \
    yt-dlp --version

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 3000

CMD bun server/index.ts
