include .env
export $(shell sed 's/=.*//' .env)

build:
	docker build -t $(APP_NAME) .

run:
	docker run --rm -p $(PORT):$(PORT) $(APP_NAME)

up: build run

clean:
	docker image prune -f
