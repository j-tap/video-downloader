ifneq ("$(wildcard .env)", "")
  include .env
  export
endif

# Дата сборки уезжает в build-arg и сбрасывает кеш слоя с yt-dlp.
# Без этого `make prod` пересобирает всё, кроме yt-dlp, и на сервере остаётся
# версия с самой первой сборки — экстракторы устаревают, видео не качаются.
YTDLP_REFRESH := $(shell date +%Y-%m-%d)
export YTDLP_REFRESH

COMPOSE_CMD = docker compose -p $(APP_NAME) --env-file .env -f docker-compose.prod.yml -f docker-compose.traefik.yml

VPN_EGRESS_NETWORK ?= vpn-egress

# Общая с другими проектами сеть выхода через VPN (см. README, «Выход для
# YouTube»). Создаёт её тот, кто деплоится первым; повторный вызов ничего не
# делает, а последний inspect прощает гонку, когда оба проекта деплоятся
# одновременно и сеть успел создать сосед. --internal: у сети нет шлюза,
# она не перехватит маршрут по умолчанию ни у VPN-контейнера, ни у приложений.
network:
	@docker network inspect $(VPN_EGRESS_NETWORK) >/dev/null 2>&1 \
		|| docker network create --internal $(VPN_EGRESS_NETWORK) \
		|| docker network inspect $(VPN_EGRESS_NETWORK) >/dev/null

generate_traefik:
	bash -c "set -a && source .env && envsubst < docker-compose.traefik.template.yml > docker-compose.traefik.yml"

# --pull: без него базовый образ (а с ним ffmpeg и python)
# навсегда остаётся тем, что скачался при первой сборке.
build: generate_traefik
	$(COMPOSE_CMD) build --pull

rebuild: generate_traefik
	$(COMPOSE_CMD) build --pull --no-cache

up: build
	docker run --rm --env-file .env -p $(PORT):$(PORT) -v $(PWD)/data:/app/data:ro -v $(PWD)/storage:/app/storage $(APP_NAME):latest

prod: network build
	$(COMPOSE_CMD) up -d

# Необязательная защита, по умолчанию выключена — см. README.
firewall:
	bash scripts/egress-firewall.sh

firewall-status:
	bash scripts/egress-firewall.sh --status

restart:
	$(COMPOSE_CMD) restart

logs:
	$(COMPOSE_CMD) logs -f --tail=100

clean:
	docker image prune -f
