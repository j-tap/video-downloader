ifneq ("$(wildcard .env)", "")
  include .env
  export
endif

COMPOSE_CMD = docker compose -p $(APP_NAME) --env-file .env -f docker-compose.prod.yml -f docker-compose.traefik.yml

generate_traefik:
	bash -c "set -a && source .env && envsubst < docker-compose.traefik.template.yml > docker-compose.traefik.yml"

build: generate_traefik
	$(COMPOSE_CMD) build

rebuild: generate_traefik
	$(COMPOSE_CMD) build --no-cache

up: build
	docker run --rm -p $(PORT):$(PORT) $(APP_NAME)

prod: build
	$(COMPOSE_CMD) up -d

restart:
	$(COMPOSE_CMD) restart

clean:
	docker image prune -f
