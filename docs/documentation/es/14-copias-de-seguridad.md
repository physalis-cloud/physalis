---
title: Copias de seguridad
order: 14
icon: RiDatabase2Line
summary: Haz copias de seguridad automáticas de las bases de datos de tus proyectos, cifradas, en tu propio servidor — y restáuralas con un clic.
---

# Copias de seguridad

Physalis hace copias de seguridad automáticas de las **bases de datos** de tus
proyectos, **cifradas**, en un servidor de destino que tú eliges. El principio:
solo sale de tu VPS **contenido cifrado** — Physalis nunca ve tus datos ni posee
la clave de descifrado.

## Cómo funciona

Al desplegar un proyecto, Physalis añade un **agente** (contenedor acompañante)
junto a tu aplicación. Este agente:

1. se conecta a tu base de datos y hace un `dump`;
2. lo **comprime y cifra** localmente;
3. lo envía (`rsync`) a tu **VPS de destino**.

Todas las conexiones son **salientes**: el agente llama a Physalis y al destino,
nada entra. El dump en claro nunca sale del servidor de tu proyecto.

## Requisito: el destino

El destino se configura **una vez por cliente**, en **Ajustes → Seguridad**: un
**VPS de destino** (uno de tus servidores) + una **ruta** base. Todos los
proyectos del cliente escriben ahí, cada uno en su subcarpeta.

## Activar las copias de un proyecto

En la pestaña **Backup** del proyecto:

1. elige el **entorno** a respaldar (prod por defecto);
2. las **bases de datos** se detectan automáticamente (desde el
   `docker-compose` + los secretos) — revisa y ajusta la lista;
3. configura la **planificación** (hora UTC + intervalo en días) y la
   **retención** (número de copias conservadas);
4. guarda.

Las copias empiezan en el **siguiente despliegue** del proyecto (el agente se
inyecta en ese momento).

## Cifrado: GPG o Sobre KMS

Dos modos, elegidos por proyecto mediante el botón **«Activar el cifrado KMS»** /
**«Volver a GPG»**:

- **GPG (legacy)**: el agente genera un par de claves **en tu VPS**; la clave
  privada nunca sale de él. Sencillo, pero una clave por servidor (sin gestión
  centralizada, sin restauración orquestada).
- **Sobre KMS** (recomendado): cada archivo se cifra con una **clave de datos
  única**, a su vez sellada por una **clave maestra** que nunca abandona la
  bóveda criptográfica (OpenBao). Ventajas: rotación, revocación y **auditoría**
  centralizadas, robustez **poscuántica** (cifrado simétrico AES‑256) y, sobre
  todo, la **restauración con un clic** desde Physalis.

El cambio de modo surte efecto en el **siguiente despliegue**. **No afecta a los
accesos** de tu base (usuarios, contraseñas). Las copias ya hechas con GPG siguen
siendo restaurables.

## Forzar una copia

El botón **«Forzar ahora»** solicita una copia inmediata: el agente la ejecuta en
su siguiente sondeo (en menos de un minuto). El resultado aparece en el historial.

## Historial

La pestaña **Backup** lista las copias (estado, archivo, tamaño, fecha),
**paginadas de 10 en 10**. Una entrada con éxito es restaurable (modo sobre).

## Restaurar una copia

Desde el historial, sobre una copia con éxito: botón **«Restaurar»**. Dos modos:

- **Nueva BD** (seguro, por defecto): restaura en una base **nueva y vacía** que
  creas previamente. Ideal para **verificar** una copia o partir de un duplicado
  sin tocar producción.
- **Reemplazar en el sitio**: reemplaza el **contenido de la base actual** por la
  copia — la verdadera **recuperación ante incidentes**. ⚠️ Los datos actuales de
  esa base se **sobrescriben**; mejor con la aplicación detenida.

> **La restauración no afecta a los accesos** (roles, usuarios, contraseñas):
> solo se restaura el **contenido**. Tu aplicación se reconecta con normalidad,
> con las mismas credenciales.

La restauración es **orquestada**: Physalis pide al agente que descargue el
archivo, lo descifre (vía la bóveda, bajo demanda y auditado) y lo restaure
**localmente** en tu servidor. El contenido en claro nunca pasa por Physalis.

## Conviene saber

- La restauración **«nueva BD»** requiere una base destino **vacía** (si no, se
  rechaza, para evitar sobrescrituras accidentales).
- La restauración **«en el sitio»** se apoya en las copias del modo **sobre**:
  usa una copia **reciente** (fuerza una si hace falta).
- Si la bóveda criptográfica no está disponible momentáneamente, una copia se
  **omite** (se retoma en la siguiente) — **nunca** una copia sin cifrar.

## Seguridad

- Solo sale de tu servidor contenido **cifrado**; el VPS de destino solo almacena
  archivos inservibles sin la bóveda.
- En modo **Sobre KMS**, la **clave maestra nunca sale** de la bóveda, y cada
  cliente está **aislado**: la clave de un cliente no puede descifrar las copias
  de otro.
- Véase también: [Rotación de secretos](rotaciones) — que usa el mismo agente.
