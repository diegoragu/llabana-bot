#!/bin/bash
FECHA=$(date +%Y-%m-%d)
echo "Descargando logs de Railway — $FECHA"
railway logs --tail 2000 > "logs_$FECHA.log"
echo "✅ Guardado como logs_$FECHA.log"
