#!/usr/bin/env bash
# Requires the host administrator. Does not use Docker to bypass host permissions.
set -euo pipefail
if [ "${EUID}" -ne 0 ]; then echo 'Run with sudo; do not send your password in chat.' >&2; exit 1; fi
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target=/etc/nginx/sites-available/cayi-ai.top
test -f "$target"
test -f "$source_dir/nginx-cayi-ai.top.conf"
test "$(readlink -f /etc/nginx/sites-enabled/cayi-ai.top)" = "$target"
nginx -t
backup_dir="$(mktemp -d /etc/nginx/ai-english-backup.XXXXXXXX)"
cp -p -- "$target" "$backup_dir/cayi-ai.top"
restore() {
    cp -p -- "$backup_dir/cayi-ai.top" "$target"
    nginx -t && systemctl reload nginx
    echo "Previous configuration restored; backup: $backup_dir" >&2
}
trap restore ERR
install -o root -g root -m 644 "$source_dir/nginx-cayi-ai.top.conf" "$target"
nginx -t
systemctl reload nginx
trap - ERR
echo "AIEnglish proxy configured. Previous configuration: $backup_dir/cayi-ai.top"
