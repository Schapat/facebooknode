# Facebook Automation – Deployment mit Coolify & n8n

Diese Anleitung beschreibt Schritt für Schritt, wie du den Facebook Automation Service über **Coolify** deployst und anschließend den **n8n Community Node** installierst, um alles miteinander zu verbinden.

---

## Inhaltsverzeichnis

1. [Voraussetzungen](#1-voraussetzungen)
2. [Repository vorbereiten](#2-repository-vorbereiten)
3. [Facebook Automation Service in Coolify deployen](#3-facebook-automation-service-in-coolify-deployen)
4. [n8n in Coolify deployen](#4-n8n-in-coolify-deployen)
5. [n8n Community Node installieren](#5-n8n-community-node-installieren)
6. [n8n Credentials einrichten](#6-n8n-credentials-einrichten)
7. [Facebook Cookies exportieren](#7-facebook-cookies-exportieren)
8. [Ersten Workflow erstellen](#8-ersten-workflow-erstellen)
9. [Netzwerk & Sicherheit](#9-netzwerk--sicherheit)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Voraussetzungen

- **Coolify** installiert und erreichbar (https://coolify.io)
- **Server** mit min. 2 GB RAM (Chromium braucht Speicher)
- **Git-Repository** (GitHub, GitLab o.ä.) mit dem Facebook Automation Code
- Ein **Facebook-Account** mit aktiver Session (Cookies)

---

## 2. Repository vorbereiten

Pushe das Projekt in ein Git-Repository. Stelle sicher, dass folgende Dateien im Root liegen:

```
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── shared-types/
├── docker-service/
└── n8n-node/
```

**Wichtig:** Erstelle eine `.env`-Datei (nicht committen!) mit sicheren Werten:

```bash
# API Authentication (kommasepariert für mehrere Keys)
API_KEYS=dein-sicherer-api-key-hier

# JWT Secret (mind. 32 Zeichen)
JWT_SECRET=dein-jwt-secret-mindestens-32-zeichen-lang!!

# AES Encryption Key (mind. 32 Zeichen)
ENCRYPTION_KEY=dein-encryption-key-mindestens-32-zeichen!!

# Browser Settings
MAX_CONCURRENCY=2
DEFAULT_TIMEOUT=60000

# Logging
LOG_LEVEL=info
```

> **Tipp:** Generiere sichere Keys z.B. mit `openssl rand -hex 32`.

---

## 3. Facebook Automation Service in Coolify deployen

### Option A: Docker Compose (empfohlen)

Diese Methode deployt den Service inkl. Redis mit einer einzigen Konfiguration.

1. **Neues Projekt erstellen**
   - Coolify Dashboard → **Projects** → **+ Add**
   - Name: `Facebook Automation`

2. **Neue Ressource hinzufügen**
   - Klicke auf das Projekt → **+ New Resource**
   - Wähle **Docker Compose**

3. **Git-Repository verbinden**
   - Wähle deinen Git-Provider (GitHub/GitLab)
   - Repository auswählen
   - Branch: `main` (oder dein Deployment-Branch)
   - Build-Pack: **Docker Compose**

4. **Environment Variables setzen**
   In Coolify unter **Environment Variables** folgende Variablen anlegen:

   | Variable | Wert | Hinweis |
   |----------|------|---------|
   | `API_KEYS` | `dein-sicherer-api-key` | Für API-Authentifizierung |
   | `JWT_SECRET` | `mindestens-32-zeichen-langer-string` | JWT Token Signierung |
   | `ENCRYPTION_KEY` | `mindestens-32-zeichen-langer-string` | AES-256 Session-Verschlüsselung |
   | `MAX_CONCURRENCY` | `2` | Max. gleichzeitige Browser-Jobs |
   | `LOG_LEVEL` | `info` | Log Level (`debug`, `info`, `warn`, `error`) |

5. **Docker Compose Konfiguration anpassen**
   - Entferne die `version: '3.8'` Zeile (wird von Docker Compose ignoriert)
   - Stelle sicher, dass Port `3000` exponiert wird

6. **Deploy starten**
   - Klicke **Deploy**
   - Warte bis der Build durchläuft (kann 2-5 Min. dauern wegen Chromium)

7. **Domain zuweisen** (optional)
   - Unter **Settings** → **Domains** eine Domain/Subdomain zuweisen
   - z.B. `fb-automation.deine-domain.de`
   - Coolify erstellt automatisch ein SSL-Zertifikat via Let's Encrypt

### Option B: Einzelnes Dockerfile

Falls du Redis separat betreiben willst:

1. **Redis deployen**
   - Neues Projekt → **+ New Resource** → **Database** → **Redis**
   - Notiere die interne Redis-URL (z.B. `redis://redis-xyz:6379`)

2. **Docker Service deployen**
   - **+ New Resource** → **Dockerfile**
   - Repository + Branch angeben
   - Build-Pack: **Dockerfile**
   - Zusätzliche Env-Variable: `REDIS_URL=redis://dein-redis-host:6379`

---

## 4. n8n in Coolify deployen

Falls du noch keine n8n-Instanz hast, deploye n8n ebenfalls über Coolify:

1. **Neue Ressource hinzufügen**
   - **+ New Resource** → **Docker Image**
   - Image: `docker.n8n.io/n8nio/n8n`
   - Tag: `latest`

2. **Volumes konfigurieren**
   ```
   n8n_data:/home/node/.n8n
   ```

3. **Port setzen**
   - Container Port: `5678`

4. **Environment Variables**

   | Variable | Wert |
   |----------|------|
   | `N8N_HOST` | `n8n.deine-domain.de` |
   | `N8N_PORT` | `5678` |
   | `N8N_PROTOCOL` | `https` |
   | `WEBHOOK_URL` | `https://n8n.deine-domain.de/` |
   | `N8N_SECURE_COOKIE` | `true` |
   | `GENERIC_TIMEZONE` | `Europe/Berlin` |
   | `NODE_EXTRA_CA_CERTS` | `/home/node/.n8n/custom-certs/` (optional) |

5. **Domain zuweisen**
   - z.B. `n8n.deine-domain.de`

6. **Deploy** → n8n ist erreichbar unter `https://n8n.deine-domain.de`

---

## 5. n8n Community Node installieren

### Methode 1: Über n8n UI (empfohlen)

1. Öffne n8n → **Settings** (Zahnrad) → **Community Nodes**
2. Klicke **Install a community node**
3. Falls das npm-Paket veröffentlicht ist, gib ein: `n8n-nodes-facebook-automation`
4. Klicke **Install**

### Methode 2: Manuell per npm-Link (für private/unveröffentlichte Nodes)

Da der Node vermutlich nicht auf npm veröffentlicht ist, musst du ihn manuell in den n8n-Container einbinden:

1. **Node bauen** (lokal)
   ```bash
   # Im Projekt-Root
   cd shared-types && npm install && npm run build && cd ..
   cd n8n-node && npm install && npm run build && cd ..
   ```

2. **Node in n8n einbinden**

   Erstelle ein eigenes n8n-Dockerfile:

   ```dockerfile
   FROM docker.n8n.io/n8nio/n8n:latest

   # Custom Nodes installieren
   USER root

   # n8n custom nodes Verzeichnis
   RUN mkdir -p /home/node/.n8n/custom

   # Kopiere den gebauten Node
   COPY n8n-node/dist /home/node/.n8n/nodes/n8n-nodes-facebook-automation/dist
   COPY n8n-node/package.json /home/node/.n8n/nodes/n8n-nodes-facebook-automation/

   # Kopiere shared-types
   COPY shared-types/dist /home/node/.n8n/nodes/n8n-nodes-facebook-automation/node_modules/@facebook-automation/shared-types/dist
   COPY shared-types/package.json /home/node/.n8n/nodes/n8n-nodes-facebook-automation/node_modules/@facebook-automation/shared-types/

   # Installiere Abhängigkeiten
   WORKDIR /home/node/.n8n/nodes/n8n-nodes-facebook-automation
   RUN npm install --omit=dev

   USER node
   WORKDIR /home/node
   ```

3. **In Coolify deployen**
   - Nutze dieses Dockerfile für dein n8n-Deployment
   - Setze die Environment Variable:
     ```
     N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/nodes
     ```

4. **n8n neu starten** → Der Node erscheint in der Node-Palette

### Methode 3: Volume-Mount

1. Baue den Node lokal (wie bei Methode 2, Schritt 1)
2. Kopiere den gebauten `n8n-node/dist`-Ordner + `package.json` auf den Server
3. Mounte das Verzeichnis als Volume in Coolify:
   ```
   /pfad/auf/server/n8n-nodes-facebook-automation:/home/node/.n8n/nodes/n8n-nodes-facebook-automation
   ```
4. Setze `N8N_CUSTOM_EXTENSIONS=/home/node/.n8n/nodes`

---

## 6. n8n Credentials einrichten

1. Öffne n8n → **Credentials** → **+ Add Credential**
2. Suche nach **Facebook Automation API**
3. Fülle die Felder aus:

   | Feld | Wert | Beschreibung |
   |------|------|-------------|
   | **API URL** | `http://fb-automation-service:3000` | Interne Docker-Netzwerk-URL (siehe [Netzwerk](#9-netzwerk--sicherheit)) |
   | **API Key** | `dein-api-key` | Derselbe Key wie in `API_KEYS` konfiguriert |
   | **Session Name** | `mein-account` | Frei wählbarer Name für diesen FB-Account |
   | **Facebook Cookies (JSON)** | `[{"name":"c_user",...}]` | Exportierte Facebook-Cookies (siehe Schritt 7) |
   | **Proxy** *(optional)* | `http://user:pass@proxy:8080` | Proxy für den Browser |
   | **User Agent** *(optional)* | `Mozilla/5.0...` | Custom User-Agent |

4. Klicke **Save**

> **Wichtig zur API URL:** Wenn n8n und der Facebook Automation Service im selben Coolify-Projekt liegen, nutze die interne Docker-Netzwerk-URL (Container-Name + Port). Falls sie in verschiedenen Projekten sind, nutze die externe URL.

---

## 7. Facebook Cookies exportieren

### Mit EditThisCookie (Chrome)

1. Installiere die [EditThisCookie](https://www.editthiscookie.com/) Extension
2. Logge dich auf **facebook.com** ein
3. Klicke auf das EditThisCookie-Icon → **Export** (Clipboard-Icon)
4. Füge die Cookies in das Credentials-Feld ein

### Mit Browser DevTools

1. Logge dich auf **facebook.com** ein
2. Öffne DevTools (F12) → **Application** → **Cookies** → `https://www.facebook.com`
3. Kopiere die wichtigsten Cookies als JSON-Array:

```json
[
  {
    "name": "c_user",
    "value": "DEIN_WERT",
    "domain": ".facebook.com",
    "path": "/",
    "expires": -1,
    "httpOnly": false,
    "secure": true
  },
  {
    "name": "xs",
    "value": "DEIN_WERT",
    "domain": ".facebook.com",
    "path": "/",
    "expires": -1,
    "httpOnly": true,
    "secure": true
  },
  {
    "name": "datr",
    "value": "DEIN_WERT",
    "domain": ".facebook.com",
    "path": "/",
    "expires": -1,
    "httpOnly": true,
    "secure": true
  }
]
```

> **Mindestens erforderlich:** `c_user`, `xs`, `datr`

---

## 8. Ersten Workflow erstellen

### Group Post Scraper

1. Erstelle einen neuen Workflow in n8n
2. Füge den **Facebook Automation** Node hinzu
3. Konfiguriere:
   - **Credential**: Wähle deine Facebook Automation API Credentials
   - **Operation**: `Group Post Scraper`
   - **Group URLs**: Eine URL pro Zeile, z.B.:
     ```
     https://www.facebook.com/groups/123456789
     https://www.facebook.com/groups/987654321
     ```
   - **Max Posts**: `20` (optional)
   - **Options**:
     - **Wait for Completion**: `true` (empfohlen)
     - **Poll Interval**: `5000` (5 Sekunden)

4. Klicke **Test Step** → der Node sendet den Job, wartet auf Ergebnisse und gibt die Posts zurück

### Group Member Scraper

- **Operation**: `Group Member Scraper`
- **Group URLs**: Facebook-Gruppen-URLs
- **Max Members**: z.B. `100`

### Auto Message

- **Operation**: `Auto Message`
- **Username**: Facebook-Benutzername oder Profil-URL
- **Message**: Nachrichtentext

### Beispiel-Workflow: Automatisches Scraping

```
[Schedule Trigger] → [Facebook Automation: Group Post Scraper] → [IF: Neue Posts?] → [Google Sheets / Webhook / E-Mail]
```

Ein vollständiges Workflow-Beispiel findest du in `examples/n8n-workflow-example.json`. Importiere es in n8n über **Workflow** → **Import from File**.

---

## 9. Netzwerk & Sicherheit

### Internes Netzwerk in Coolify

Damit n8n mit dem Facebook Automation Service kommunizieren kann, müssen beide im selben Docker-Netzwerk sein.

**Option 1: Selbes Coolify-Projekt** (empfohlen)
- Deploye beide Services im selben Projekt
- Coolify erstellt automatisch ein gemeinsames Netzwerk
- API URL in n8n: `http://<container-name>:3000`
- Den Container-Namen findest du in Coolify unter dem Service → **Settings**

**Option 2: Verschiedene Projekte**
- Nutze die externe (öffentliche) URL des Facebook Automation Services
- API URL in n8n: `https://fb-automation.deine-domain.de`
- Stelle sicher, dass der API-Key sicher ist (HTTPS!)

**Option 3: Shared Network**
- Erstelle ein gemeinsames Docker-Netzwerk in Coolify
- Weise beiden Services dieses Netzwerk zu
- Kommunikation über Container-Namen möglich

### Sicherheitshinweise

- **API Keys**: Verwende lange, zufällige Keys (`openssl rand -hex 32`)
- **HTTPS**: Aktiviere HTTPS für alle öffentlichen Endpunkte
- **Port 3000 NICHT öffentlich exponieren**: Wenn n8n intern kommuniziert, muss Port 3000 nicht nach außen offen sein → entferne die `ports`-Sektion in der Docker Compose oder nutze Coolify's internen Proxy
- **Cookies sicher aufbewahren**: Die Cookies werden AES-256-GCM-verschlüsselt in Redis gespeichert
- **Rate Limiting**: Der Service hat integriertes Rate Limiting (100 req/min)

---

## 10. Troubleshooting

### Build schlägt fehl: "Unable to connect to deb.debian.org"

Temporäres Netzwerkproblem beim Docker Build. Lösung:
```bash
# Erneut deployen / bauen
# Oder in der Dockerfile vor dem apt-get eine Retry-Logik einbauen
```
In Coolify einfach **Redeploy** klicken.

### TypeScript Build Error

Falls `npm run build` fehlschlägt, prüfe dass `shared-types` korrekt gebaut wird. Das Multi-Stage Dockerfile baut `shared-types` vor dem Docker Service.

### n8n findet den Community Node nicht

1. Prüfe ob `N8N_CUSTOM_EXTENSIONS` gesetzt ist
2. Prüfe ob die Dateien korrekt im Container liegen:
   ```bash
   docker exec -it <n8n-container> ls -la /home/node/.n8n/nodes/
   ```
3. n8n neu starten

### Verbindung zwischen n8n und Facebook Automation schlägt fehl

1. Prüfe ob beide Container im selben Netzwerk sind:
   ```bash
   docker network inspect <netzwerk-name>
   ```
2. Teste die Verbindung aus dem n8n-Container:
   ```bash
   docker exec -it <n8n-container> wget -qO- http://<fb-container>:3000/health
   ```
3. Prüfe die API URL in den n8n Credentials

### Chromium startet nicht / Out of Memory

- Erhöhe den RAM des Servers (min. 2 GB)
- Reduziere `MAX_CONCURRENCY` auf `1`
- Stelle sicher, dass `shm_size: '2gb'` in der Docker Compose gesetzt ist

### Session / Cookies ungültig

- Exportiere die Cookies erneut (Facebook-Session läuft ab)
- Prüfe ob die erforderlichen Cookies (`c_user`, `xs`, `datr`) vorhanden sind
- Nutze die Session-API zum Debuggen:
  ```
  GET /api/session/status?sessionName=mein-account
  GET /api/session/list
  ```

---

## Zusammenfassung der URLs

| Service | Interne URL | Externe URL (Beispiel) |
|---------|-------------|----------------------|
| Facebook Automation API | `http://<container>:3000` | `https://fb-automation.deine-domain.de` |
| Facebook Automation Docs | `http://<container>:3000/docs` | `https://fb-automation.deine-domain.de/docs` |
| n8n | `http://<container>:5678` | `https://n8n.deine-domain.de` |
| Redis | `redis://<container>:6379` | — (nur intern) |
