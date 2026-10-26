#!/usr/bin/env bash
#
# Alta de una instalación de WhatsFlow para un cliente (un proyecto de Railway por cliente, mismo repositorio).
#
#   scripts/provision-client.sh --slug acme --name "Acme Chat" --tz America/Argentina/Buenos_Aires [opciones]
#
# Opciones:
#   --slug      identificador corto (letras, números y guiones). Proyecto: whatsflow-<slug>
#   --name      nombre de marca que se muestra en el panel (APP_NAME)
#   --tz        zona horaria IANA del cliente (APP_TZ)
#   --repo      repositorio de GitHub (por defecto johelp/whatsapp-crm)
#   --branch    rama a desplegar (por defecto main; ideal: una rama "stable")
#   --admin-pass  contraseña inicial del admin (si no, se genera una y se muestra UNA vez)
#   --out       archivo (permisos 600) donde guardar las credenciales generadas
#   --no-smoke  no correr la prueba de humo al final
#   --dry-run   solo muestra los comandos, no ejecuta nada
#
# Requisitos: Railway CLI con sesión iniciada (railway login), openssl, curl y Node 18+.
# ⚠ Crea recursos facturables en tu cuenta de Railway (app + Postgres + 2 volúmenes).
# ⚠ Verificado solo en modo --dry-run: la primera ejecución real conviene hacerla con un cliente de prueba.
set -euo pipefail

SLUG=""; NAME=""; TZ_ARG=""; REPO="johelp/whatsapp-crm"; BRANCH="main"
ADMIN_PASS=""; OUT=""; SMOKE=1; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2;; --name) NAME="$2"; shift 2;; --tz) TZ_ARG="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;; --branch) BRANCH="$2"; shift 2;;
    --admin-pass) ADMIN_PASS="$2"; shift 2;; --out) OUT="$2"; shift 2;;
    --no-smoke) SMOKE=0; shift;; --dry-run) DRY=1; shift;;
    -h|--help) sed -n '2,26p' "$0"; exit 0;;
    *) echo "Opción desconocida: $1" >&2; exit 2;;
  esac
done
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || { echo "--slug inválido (minúsculas, números y guiones, 2-31 caracteres)" >&2; exit 2; }
[ -n "$NAME" ] || { echo "Falta --name" >&2; exit 2; }
[ -n "$TZ_ARG" ] || { echo "Falta --tz (ej. America/Argentina/Buenos_Aires, Europe/Madrid)" >&2; exit 2; }
node -e "new Intl.DateTimeFormat('en',{timeZone:process.argv[1]})" "$TZ_ARG" 2>/dev/null || { echo "Zona horaria inválida: $TZ_ARG" >&2; exit 2; }

PROJECT="whatsflow-$SLUG"
SESSION_SECRET="$(openssl rand -hex 32)"
GENERATED=0; [ -n "$ADMIN_PASS" ] || { ADMIN_PASS="$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-14)"; GENERATED=1; }

run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*" | sed -E "s/(SESSION_SECRET=|ADMIN_PASSWORD=)[^ ]+/\1***/g"; else "$@"; fi; }

echo "▶ Cliente: $NAME  ·  proyecto: $PROJECT  ·  zona: $TZ_ARG  ·  repo: $REPO@$BRANCH"
if [ "$DRY" = 0 ]; then
  command -v railway >/dev/null || { echo "Falta el CLI de Railway" >&2; exit 1; }
  railway whoami >/dev/null 2>&1 || { echo "Iniciá sesión: railway login" >&2; exit 1; }
  WORK="$(mktemp -d)"; cd "$WORK"       # el vínculo del proyecto queda en un directorio temporal, no en este repo
fi

echo "1/6 Proyecto";        run railway init --name "$PROJECT"
echo "2/6 Base de datos";   run railway add --database postgres
echo "3/6 Servicio y variables"
run railway add --service app --repo "$REPO" --branch "$BRANCH" \
  --variables "NODE_ENV=production" \
  --variables "APP_NAME=$NAME" \
  --variables "APP_TZ=$TZ_ARG" \
  --variables "PUBLIC_LANDING=false" \
  --variables "WA_AUTH_PATH=/data/auth" \
  --variables "SESSION_SECRET=$SESSION_SECRET" \
  --variables "ADMIN_PASSWORD=$ADMIN_PASS" \
  --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
echo "4/6 Volumen de la sesión de WhatsApp (/data)"; run railway volume add --service app --mount-path /data
echo "5/6 Dominio";         run railway domain --service app

URL=""
if [ "$DRY" = 0 ]; then
  echo "6/6 Esperando el despliegue (máx. 10 min)…"
  for _ in $(seq 1 40); do
    ST="$(railway deployment list --service app 2>/dev/null | grep -Eo 'SUCCESS|FAILED|CRASHED' | head -1 || true)"
    [ "$ST" = "SUCCESS" ] && break
    [ "$ST" = "FAILED" ] || [ "$ST" = "CRASHED" ] && { echo "El despliegue falló: revisá 'railway logs --service app'" >&2; exit 1; }
    sleep 15
  done
  URL="https://$(railway domain --service app --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.domains?.[0]?.domain)||(j[0]?.domain)||j.domain||'')}catch(e){console.log('')}})")"
  [ "$URL" != "https://" ] || URL=""
else
  echo "6/6 [dry-run] esperar despliegue, leer el dominio y correr scripts/smoke.js"
fi

if [ "$SMOKE" = 1 ] && [ -n "$URL" ]; then
  echo "▶ Prueba de humo"; sleep 20
  SMOKE_URL="$URL" SMOKE_USER=admin SMOKE_PASS="$ADMIN_PASS" node "$(dirname "$0")/smoke.js" || echo "⚠ La prueba de humo reportó fallas: revisá antes de entregar."
fi

echo
echo "════════════════════════════════════════"
echo " Cliente:    $NAME"
echo " Proyecto:   $PROJECT"
echo " URL:        ${URL:-<ver 'railway domain --service app'>}"
echo " Usuario:    admin"
[ "$GENERATED" = 1 ] && echo " Contraseña: $ADMIN_PASS   (se muestra una sola vez: guardala y pedile que la cambie)"
echo "════════════════════════════════════════"
if [ -n "$OUT" ] && [ "$DRY" = 0 ]; then
  umask 177; printf 'cliente=%s\nproyecto=%s\nurl=%s\nusuario=admin\npassword=%s\nsession_secret=%s\n' "$NAME" "$PROJECT" "$URL" "$ADMIN_PASS" "$SESSION_SECRET" > "$OUT"; echo " Credenciales guardadas en $OUT (permisos 600)"
fi
[ "$DRY" = 1 ] && echo "(dry-run: no se creó nada; la contraseña mostrada es un ejemplo)"
echo "Siguientes pasos: docs/PILOTO_RUNBOOK.md (vincular el QR, cargar usuarios, monitor de /health)."
