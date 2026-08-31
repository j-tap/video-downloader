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

generate_traefik:
	bash -c "set -a && source .env && envsubst < docker-compose.traefik.template.yml > docker-compose.traefik.yml"

build: generate_traefik
	$(COMPOSE_CMD) build

rebuild: generate_traefik
	$(COMPOSE_CMD) build --no-cache

up: build
	docker run --rm --env-file .env -p $(PORT):$(PORT) -v $(PWD)/data:/app/data:ro $(APP_NAME):latest

prod: build
	$(COMPOSE_CMD) up -d
	@bash scripts/egress-firewall.sh --ensure \
		|| echo "⚠️  Egress-фаервол не применился — проверьте: sudo bash scripts/egress-firewall.sh --status"

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
