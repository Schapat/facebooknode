# Facebook Automation – Deployment mit Coolify & n8n

Diese Anleitung beschreibt Schritt für Schritt, wie du den Facebook Automation Service über **Coolify** deployst und anschließend den **n8n Community Node** installierst, um alles miteinander zu verbinden.

---

## Inhaltsverzeichnis

1. [Voraussetzungen](#1-voraussetzungen)
2. [Repository vorbereiten](#2-repository-vorbereiten)
3. [Facebook Automation Service in Coolify deployen](#3-facebook-automation-service-in-coolify-deployen)
4. [n8n mit Facebook Automation Node in Coolify deployen](#4-n8n-mit-facebook-automation-node-in-coolify-deployen)
5. [n8n Credentials einrichten](#5-n8n-credentials-einrichten)
6. [Facebook Cookies exportieren](#6-facebook-cookies-exportieren)
7. [Ersten Workflow erstellen](#7-ersten-workflow-erstellen)
8. [Netzwerk & Sicherheit](#8-netzwerk--sicherheit)
9. [Troubleshooting](#9-troubleshooting)

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

## 3. Facebook Automation Service in Coolify deployen (Git-basiert)

Coolify clont dein Git-Repository und baut das Image automatisch aus dem Dockerfile.

### Schritt 1: Git-Provider in Coolify verbinden

1. Coolify Dashboard → **Settings** → **Git Providers** (oder **Sources**)
2. Klicke **+ Add** → wähle **GitHub**, **GitLab** oder **Gitea**
3. Autorisiere Coolify für dein Repository (OAuth oder Deploy Key)

> **Tipp für private Repos:** Du kannst auch einen SSH Deploy Key oder Personal Access Token verwenden.

### Schritt 2: Projekt & Redis anlegen

1. **Neues Projekt erstellen**
   - Coolify Dashboard → **Projects** → **+ Add**
   - Name: `Facebook Automation`

2. **Redis erstellen**
   - Klicke auf das Projekt → **+ New Resource** → **Database** → **Redis**
   - Name: `fb-redis`
   - Coolify erstellt den Redis-Container automatisch
   - Notiere die **interne URL** – sie wird z.B. so aussehen: `redis://fb-redis:6379`
   - Unter **Settings** kannst du Persistenz (AOF/RDB) aktivieren

### Schritt 3: Facebook Automation Service deployen

1. **Neue Ressource hinzufügen**
   - Klicke auf dein Projekt → **+ New Resource** → **Application**
   - Wähle deinen verbundenen **Git-Provider**
   - Repository auswählen (z.B. `dein-user/facebooknode`)
   - Branch: `main` (oder dein Deployment-Branch)

2. **Build-Pack konfigurieren**
   - **Wichtig:** Coolify wählt standardmäßig **Nixpacks** – das funktioniert hier **nicht**!
   - Gehe zu **Settings** (oder **General**) → **Build Pack** → ändere auf **Dockerfile**
   - Dockerfile Location: `Dockerfile` (liegt im Root)
   - Speichern nicht vergessen

3. **Port konfigurieren**
   - Unter **Network** → **Ports Exposes**: `3000`
   - Coolify leitet den Traffic automatisch über seinen Reverse Proxy

4. **Environment Variables setzen**
   Unter **Environment Variables** folgende Variablen anlegen:

   | Variable | Wert | Hinweis |
   |----------|------|--------|
   | `PORT` | `3000` | Server-Port |
   | `HOST` | `0.0.0.0` | Server-Host |
   | `API_KEYS` | `dein-sicherer-api-key` | API-Authentifizierung |
   | `JWT_SECRET` | `mindestens-32-zeichen-langer-string` | JWT Token Signierung |
   | `ENCRYPTION_KEY` | `mindestens-32-zeichen-langer-string` | AES-256 Session-Verschlüsselung |
   | `REDIS_URL` | `redis://fb-redis:6379` | Interne Redis-URL (aus Schritt 2) |
   | `BROWSER_HEADLESS` | `true` | Chromium headless |
   | `MAX_CONCURRENCY` | `2` | Max. gleichzeitige Browser-Jobs |
   | `DEFAULT_TIMEOUT` | `60000` | Operation Timeout (ms) |
   | `SCREENSHOT_ON_ERROR` | `true` | Screenshots bei Fehlern |
   | `LOG_LEVEL` | `info` | Log Level |
   | `DATA_DIR` | `/data` | Daten-Verzeichnis |

   > **Tipp:** Markiere sensible Werte als **Secret** (Schloss-Icon), damit sie nicht in Logs erscheinen.

5. **Volumes / Persistent Storage**
   - Unter **Storages** → **+ Add**
   - Volume-Name: `automation-data`
   - Destination Path: `/data`
   - Mount Path: `/data`
   - So bleiben Sessions, Screenshots und Logs bei Redeployments erhalten

6. **Chromium-Kompatibilität**
   Keine zusätzliche Konfiguration nötig – Chromium wird bereits mit `--disable-dev-shm-usage` gestartet, sodass kein erhöhter Shared Memory (`shm_size`) benötigt wird.

7. **Domain zuweisen** (optional)
   - Unter **Settings** → **Domains** eine Domain/Subdomain zuweisen
   - z.B. `fb-automation.deine-domain.de`
   - Coolify erstellt automatisch ein SSL-Zertifikat via Let's Encrypt
   - Falls n8n nur intern zugreift, ist keine öffentliche Domain nötig

8. **Deploy starten**
   - Klicke **Deploy**
   - Coolify clont das Repo, baut das Docker-Image und startet den Container
   - Der Build dauert beim ersten Mal 3-5 Min. (Chromium-Download)
   - Logs sind live unter **Deployments** → letztes Deployment einsehbar

9. **Health Check prüfen**
   - Nach dem Deploy: Rufe `https://fb-automation.deine-domain.de/health` auf
   - Oder in Coolify: **Logs** → `Server running on 0.0.0.0:3000` sollte erscheinen

### Schritt 4: Auto-Deploy einrichten (optional)

Coolify kann bei jedem Git-Push automatisch redeployen:

1. Unter dem Service → **Webhooks**
2. Kopiere die Webhook-URL
3. Füge sie in deinem Git-Repository ein:
   - **GitHub**: Repository → Settings → Webhooks → Add webhook
   - **GitLab**: Repository → Settings → Webhooks → Add webhook
   - Event: `push`
4. Ab jetzt löst jeder Push auf den konfigurierten Branch ein Redeployment aus

---

## 4. n8n mit Facebook Automation Node in Coolify deployen

Das fertige Compose File liegt im Repository unter [`n8n-compose.yml`](n8n-compose.yml). Es enthält einen **Init-Container**, der den Facebook Automation Node automatisch aus dem GitHub-Repo baut und per Shared Volume in n8n einbindet.

### So funktioniert es

```
n8n-node-installer (init)          n8n / n8n-worker
─────────────────────────          ─────────────────
1. Klont github.com/Schapat/       3. Starten nach dem Installer
   facebooknode                    4. Laden den Node über
2. Baut shared-types + n8n-node       N8N_CUSTOM_EXTENSIONS
   → kopiert nach /output            aus dem Shared Volume
         │                                  ▲
         └──── n8n-custom-nodes Volume ─────┘
```

### Neuen n8n Service Stack anlegen

1. Coolify Dashboard → **Projects** → dein Projekt (oder neues Projekt erstellen)
2. **+ New Resource** → **Service** → wähle **n8n (with PostgreSQL and Workers)**
3. Coolify erstellt automatisch einen Service Stack mit n8n, Worker, PostgreSQL, Redis und Task Runners

### Compose File anpassen

1. Klicke auf den erstellten Service Stack → **Edit Compose File**
2. **Ersetze den gesamten Inhalt** mit dem Inhalt aus [`n8n-compose.yml`](n8n-compose.yml) im Repository
3. Klicke **Save**

### Domain zuweisen

1. Im Service Stack → Service **N8N** → **Settings**
2. Unter **Domains** deine Domain eintragen (z.B. `n8n.deine-domain.de`)
3. Coolify erstellt automatisch ein SSL-Zertifikat

### Deploy

1. Klicke **Deploy** (oder **Restart**)
2. Der `n8n-node-installer` startet zuerst (~1 Min.): klont das Repo, baut den Node
3. Danach starten n8n und der Worker – der Facebook Automation Node ist sofort verfügbar
4. PostgreSQL und Redis bleiben unverändert – **keine Daten gehen verloren**

### Bestehenden n8n Stack aktualisieren

Falls du bereits einen n8n Service Stack hast (wie in deinem Fall):

1. Gehe zu deinem bestehenden Stack → **Edit Compose File**
2. Ersetze den Inhalt mit [`n8n-compose.yml`](n8n-compose.yml)
3. **Save** → **Redeploy**
4. Alle Workflows, Credentials und Einstellungen bleiben erhalten (liegen in PostgreSQL)

### Facebook Automation Node aktualisieren

Bei Änderungen am Node einfach den Service Stack **Redeployen** – der Installer klont immer die neueste Version aus dem Repo.

---

## 5. n8n Credentials einrichten
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

## 6. Facebook Cookies exportieren

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

## 7. Ersten Workflow erstellen

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

## 8. Netzwerk & Sicherheit

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

## 9. Troubleshooting

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
