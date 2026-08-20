#!/bin/sh
set -e

if [ -z "$PROXY_USER" ] || [ -z "$PROXY_PASS" ]; then
  echo "PROXY_USER and PROXY_PASS must be set (fly secrets set PROXY_USER=... PROXY_PASS=...)" >&2
  exit 1
fi

sed -e "s/__PROXY_USER__/$PROXY_USER/" -e "s/__PROXY_PASS__/$PROXY_PASS/" \
  /etc/tinyproxy/tinyproxy.conf.template > /etc/tinyproxy/tinyproxy.conf

exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
