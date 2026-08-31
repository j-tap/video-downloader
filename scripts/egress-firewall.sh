#!/usr/bin/env bash
#
# Запрещает контейнерам сервиса ходить во внутреннюю сеть сервера.
#
# Зачем: yt-dlp и curl внутри контейнера сами идут по редиректам и по ссылкам,
# добытым со страницы источника. Проверки в приложении отсекают почти всё, но
# фаервол закрывает вопрос целиком — что бы ни попросили скачать, наружу
# внутренней сети запрос не уйдёт.
#
# Уживается с ufw: тот работает со своими цепочками ufw-*, а мы — только
# со своей внутри DOCKER-USER, которую ufw не трогает. Ровно по этой же
# причине сам ufw трафик контейнеров и не фильтрует.
#
# Защита необязательная и по умолчанию выключена: основную работу делает
# белый список площадок в приложении, а этот скрипт страхует на случай, если
# список когда-нибудь расширят (ALLOWED_HOSTS=*). Запускается вручную.
#
# Режимы:
#   (без аргументов)  применить заново, даже если правила уже стоят
#   --ensure          применить, только если их нет или они устарели
#   --status          показать текущее состояние
#   --remove          снять правила
#
# Правила iptables не переживают перезагрузку сервера. Чтобы возвращались
# сами, поставьте юнит:
#
#   sudo tee /etc/systemd/system/vd-egress-firewall.service >/dev/null <<'UNIT'
#   [Unit]
#   Description=Egress firewall for video-downloader containers
#   After=docker.service
#   Requires=docker.service
#
#   [Service]
#   Type=oneshot
#   RemainAfterExit=yes
#   WorkingDirectory=/var/www/downloader.vr9.pro
#   ExecStart=/bin/bash scripts/egress-firewall.sh --ensure
#   ExecStop=/bin/bash scripts/egress-firewall.sh --remove
#
#   [Install]
#   WantedBy=multi-user.target
#   UNIT
#   sudo systemctl daemon-reload && sudo systemctl enable --now vd-egress-firewall

set -euo pipefail

CHAIN=VD-EGRESS
STATE_FILE=/var/lib/video-downloader/egress-firewall.state
PRIVATE_NETS=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8 100.64.0.0/10)

MODE="${1:-apply}"

cd "$(dirname "$0")/.."

detach_chain() {
  while iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null; do
    iptables -D DOCKER-USER -j "$CHAIN"
  done
}

if [[ "$MODE" == "--remove" ]]; then
  detach_chain
  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
  rm -f "$STATE_FILE"
  echo "✅ Правила сняты, всё вернулось как было."
  exit 0
fi

if [[ ! -f .env ]]; then
  echo "Не найден .env рядом со скриптом — запустите его из каталога проекта." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

APP_NAME="${APP_NAME:-downloadervr9pro}"

INTERNAL_NET=$(docker network inspect "${APP_NAME}_internal" \
  -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)

if [[ -z "$INTERNAL_NET" ]]; then
  echo "Не нашёл сеть ${APP_NAME}_internal — сначала поднимите сервис: make prod" >&2
  exit 1
fi

# Состояние проверяем по самим правилам, а не по файлу-отметке: правила слетают
# при перезагрузке, а docker при пересоздании сети может выдать ей другую
# подсеть — и тогда отметка «применено» врала бы, прикрывая дыру.
# Поэтому сверяем и то, что цепочка подключена, и то, что в ней актуальная сеть.
is_current() {
  iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null || return 1
  iptables -C "$CHAIN" -s "$INTERNAL_NET" -d "$INTERNAL_NET" -j RETURN 2>/dev/null || return 1
  iptables -C "$CHAIN" -s "$INTERNAL_NET" -d "${PRIVATE_NETS[0]}" -j DROP 2>/dev/null || return 1
  return 0
}

if [[ "$MODE" == "--status" ]]; then
  if is_current; then
    echo "✅ Правила активны для сети $INTERNAL_NET"
    [[ -f "$STATE_FILE" ]] && echo "   $(cat "$STATE_FILE")"
    iptables -L "$CHAIN" -n --line-numbers
    exit 0
  fi
  echo "⛔ Правил нет или они устарели — примените: sudo bash scripts/egress-firewall.sh"
  exit 1
fi

if [[ "$MODE" == "--ensure" ]]; then
  # Вызывается из make prod, поэтому не имеет права ронять деплой.
  if [[ "$(id -u)" != "0" ]]; then
    echo "⚠️  Egress-фаервол пропущен: нужны права root."
    echo "   Примените вручную: sudo bash scripts/egress-firewall.sh"
    exit 0
  fi

  if is_current; then
    echo "🔒 Egress-фаервол уже применён для сети $INTERNAL_NET, пропускаю."
    exit 0
  fi

  echo "🔒 Egress-фаервол: правил нет или сменилась подсеть, применяю заново..."
fi

# Правила привязаны к адресам нашей сети, а контейнер подключён к двум
# (своя + traefik). Если исходящий трафик уходит через traefik, под правила
# он не попадёт и защиты не будет — молча. Поэтому сверяем шлюз по умолчанию
# внутри контейнера с нашим: /proc/net/route есть всегда, лишних утилит не надо.
check_egress_route() {
  local container gw_hex gw internal_gw
  container=$(docker ps -q \
    --filter "label=com.docker.compose.project=${APP_NAME}" \
    --filter "label=com.docker.compose.service=downloadervr9pro" | head -1)

  if [[ -z "$container" ]]; then
    echo "ℹ️  Контейнер не запущен — проверку маршрута пропускаю."
    return 0
  fi

  internal_gw=$(docker network inspect "${APP_NAME}_internal" \
    -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)

  gw_hex=$(docker exec "$container" cat /proc/net/route 2>/dev/null \
    | awk '$2 == "00000000" { print $3; exit }' || true)

  if [[ -z "$gw_hex" || -z "$internal_gw" ]]; then
    echo "ℹ️  Не удалось определить маршрут контейнера — проверьте вручную:"
    echo "   docker exec $container curl -sS -m 5 http://169.254.169.254/"
    return 0
  fi

  # /proc/net/route хранит адрес в hex и в обратном порядке байт.
  gw=$(printf '%d.%d.%d.%d' \
    "0x${gw_hex:6:2}" "0x${gw_hex:4:2}" "0x${gw_hex:2:2}" "0x${gw_hex:0:2}")

  if [[ "$gw" == "$internal_gw" ]]; then
    echo "✅ Исходящий трафик идёт через сеть сервиса ($gw) — правила действуют."
    return 0
  fi

  echo "⚠️  Внимание: исходящий трафик контейнера идёт через шлюз $gw,"
  echo "   а правила привязаны к сети сервиса ($internal_gw). Значит они"
  echo "   не действуют. Расширять их на общую сеть traefik нельзя —"
  echo "   заденет соседние проекты. Напишите об этом, нужен другой подход."
}

echo "Внутренняя сеть сервиса: $INTERNAL_NET"

# Своя цепочка вместо правки DOCKER-USER напрямую: её можно целиком
# пересобрать или удалить, не задев правила docker и других сервисов.
iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"

# 1. Ответы на уже установленные соединения пропускаем всегда,
#    иначе оборвётся и traefik → приложение.
iptables -A "$CHAIN" -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

# 2. Внутри своей сети общаться можно — там живёт provider PO Token.
iptables -A "$CHAIN" -s "$INTERNAL_NET" -d "$INTERNAL_NET" -j RETURN

# 3. Внутренняя адресация (включая 169.254.169.254 с ключами облака) —
#    строго с адресов нашей сети. Соседние проекты в общей сети traefik
#    под правила не попадают: у них другие адреса источника.
for net in "${PRIVATE_NETS[@]}"; do
  iptables -A "$CHAIN" -s "$INTERNAL_NET" -d "$net" -j DROP
done

# Подключаем цепочку первой в DOCKER-USER — её docker обходит раньше своих правил.
detach_chain
iptables -I DOCKER-USER 1 -j "$CHAIN"

mkdir -p "$(dirname "$STATE_FILE")"
printf 'применено %s для сети %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$INTERNAL_NET" > "$STATE_FILE"

echo "✅ Готово ($INTERNAL_NET). Правила:"
iptables -L "$CHAIN" -n --line-numbers

check_egress_route

