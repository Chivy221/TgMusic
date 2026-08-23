#!/bin/bash
#
# Пускает трафик до серверов ngrok мимо VPN, напрямую через Wi-Fi.
# Остальной трафик продолжает идти через VPN.
#
#   ./scripts/vpn-bypass.sh on    — добавить маршруты
#   ./scripts/vpn-bypass.sh off   — убрать
#   ./scripts/vpn-bypass.sh show  — что сейчас прописано
#
# Нужен sudo: правка таблицы маршрутов. Маршруты временные — исчезают после
# перезагрузки, а после переподключения VPN их обычно надо добавить заново.

set -u

HOSTS="connect.ngrok-agent.com tunnel.ngrok.com"

gateway() {
  ipconfig getoption en0 router 2>/dev/null
}

resolve() {
  for host in $HOSTS; do
    dig +short "$host" | grep -E '^[0-9.]+$'
  done | sort -u
}

case "${1:-}" in
  on)
    gw=$(gateway)
    if [ -z "$gw" ]; then
      echo "Не удалось определить шлюз Wi-Fi (en0). Подключён ли Wi-Fi?"
      exit 1
    fi
    echo "Шлюз Wi-Fi: $gw"
    for ip in $(resolve); do
      sudo route -n add -host "$ip" "$gw" >/dev/null 2>&1 \
        && echo "  + $ip" \
        || sudo route -n change -host "$ip" "$gw" >/dev/null 2>&1 \
        && echo "  ~ $ip (обновлён)"
    done
    echo "Готово. Запускай: ngrok http 5173"
    ;;

  off)
    for ip in $(resolve); do
      sudo route -n delete -host "$ip" >/dev/null 2>&1 && echo "  - $ip"
    done
    echo "Маршруты убраны."
    ;;

  show)
    for ip in $(resolve); do
      printf "  %-16s -> " "$ip"
      route -n get "$ip" 2>/dev/null | awk '/interface:/{print $2}'
    done
    ;;

  *)
    echo "Использование: $0 {on|off|show}"
    exit 1
    ;;
esac
