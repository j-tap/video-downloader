ifneq ("$(wildcard .env)", "")
  include .env
  export
endif

build:
	docker build -t $(APP_NAME) .

run:
	docker run --rm -p $(PORT):$(PORT) $(APP_NAME)

up: build run

clean:
	docker image prune -f

prod: generate_traefik build
	docker compose -p $(APP_NAME) --env-file .env -f docker-compose.prod.yml -f docker-compose.traefik.yml up -d

generate_traefik:
	bash -c "set -a && source .env && envsubst < docker-compose.traefik.template.yml > docker-compose.traefik.yml"
