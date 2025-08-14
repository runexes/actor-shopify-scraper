SHELL := /bin/sh

IMAGE_NAME ?= actor-shopify-scraper

.PHONY: help init build run clean

help:
	@echo "Targets:"
	@echo "  init   - create template files (.env, INPUT.json, INPUT.local.json) if missing"
	@echo "  build  - docker build image"
	@echo "  run    - docker-compose up -d"
	@echo "  clean  - remove apify_storage output"

init:
	@mkdir -p apify_storage/key_value_stores/default
	@mkdir -p apify_storage/datasets/default
	@[ -f .env ] || cp templates/env.template .env
	@[ -f apify_storage/key_value_stores/default/INPUT.json ] || cp templates/INPUT.template.json apify_storage/key_value_stores/default/INPUT.json
	@echo "Initialized template files. Edit .env and INPUT.json as needed."

build:
	docker build --platform=linux/amd64 -t $(IMAGE_NAME) .

run:
	docker-compose up -d

clean:
	@rm -rf apify_storage/datasets/default
	@rm -rf apify_storage/request_queues/*
	@echo "Cleaned apify_storage outputs."
