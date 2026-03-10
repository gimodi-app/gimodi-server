# Gimodi Server

Self-hosted, decentralized voice and text chat server. No accounts, no central authority -- users connect with a nickname to independent servers.

## Quick Start

```bash
npm install        # Requires python3, make, g++ for mediasoup native build
npm start          # Starts the server
```

On first start, an admin token is printed to the console. Use it in the client to get admin rights.

## Requirements

- Node.js >= 18
- Build tools for native modules: `python3`, `make`, `g++` (or equivalent)

## Configuration

Settings are stored in the SQLite database (`data/gimodi.db` in the `server_config` table). If a key is not set in the database, the default value is used. All settings can be overridden by environment variables.

**Priority order** (highest wins):
1. Environment variables
2. Database values (set via the client's admin settings panel)
3. Defaults

### Environment Variables

| Environment Variable                    | Config Key                    | Type    | Default           | Description                                                              |
|-----------------------------------------|-------------------------------|---------|-------------------|--------------------------------------------------------------------------|
| `GIMODI_NAME`                           | `name`                        | string  | `Gimodi Server`   | Server display name                                                      |
| `GIMODI_PORT`                           | `port`                        | number  | `6833`            | HTTPS/WSS listen port                                                    |
| `GIMODI_PASSWORD`                       | `password`                    | string  | `null`            | Server password (null = no password)                                     |
| `GIMODI_MAX_CLIENTS`                    | `maxClients`                  | number  | `100`             | Maximum concurrent clients                                               |
| `GIMODI_MAX_CONNECTIONS_PER_IP`         | `maxConnectionsPerIp`         | number  | `5`               | Maximum WebSocket connections per IP                                     |
| `GIMODI_MEDIA_LISTEN_IP`                | `media.listenIp`              | string  | `0.0.0.0`         | IP for mediasoup WebRTC transports                                       |
| `GIMODI_MEDIA_ANNOUNCED_IP`             | `media.announcedIp`           | string  | `null`            | Public IP announced to clients (required for NAT/cloud)                  |
| `GIMODI_MEDIA_RTC_PORT`                 | `media.rtcPort`               | number  | `40000`           | Base port for WebRTC (one port per worker)                               |
| `GIMODI_MEDIA_WORKERS`                  | `media.workers`               | number  | `0`               | Number of mediasoup workers (0 = auto-detect CPU cores)                  |
| `GIMODI_MEDIA_LOG_LEVEL`                | `media.logLevel`              | string  | `warn`            | mediasoup log level (`debug`, `warn`, `error`, `none`)                   |
| `GIMODI_CHAT_PERSIST_MESSAGES`          | `chat.persistMessages`        | boolean | `true`            | Persist chat messages to database                                        |
| `GIMODI_CHAT_TEMP_CHANNEL_DELETE_DELAY` | `chat.tempChannelDeleteDelay` | number  | `180`             | Seconds before empty temporary channels are deleted                      |
| `GIMODI_FILES_MAX_FILE_SIZE`            | `files.maxFileSize`           | number  | `10737418240`     | Max file upload size in bytes (default 10 GB)                            |
| `GIMODI_FILES_STORAGE_PATH`             | `files.storagePath`           | string  | `./data/uploads`  | File upload storage directory                                            |
| `GIMODI_FILES_PUBLIC_URL`               | `files.publicUrl`             | string  | `null`            | Public base URL for file downloads (null = auto-detect from Host header) |
| `GIMODI_DEFAULT_CHANNEL_ID`             | `defaultChannelId`            | string  | `null`            | Override default channel (null = use DB is_default flag)                 |
| `GIMODI_GENERATE_ADMIN_TOKEN`           | `generateAdminToken`          | boolean | `false`           | Generate a temporary admin token on every startup (expires in 1 hour)    |
| `GIMODI_SSL_CERT_PATH`                  | `ssl.certPath`                | string  | `./data/cert.pem` | Path to SSL certificate (auto-generated if missing)                      |
| `GIMODI_SSL_KEY_PATH`                   | `ssl.keyPath`                 | string  | `./data/key.pem`  | Path to SSL private key (auto-generated if missing)                      |
| `GIMODI_ICON_HASH`                      | `icon.hash`                   | string  | `null`            | Server icon SHA-256 hash (managed automatically)                         |
| `GIMODI_ICON_FILENAME`                  | `icon.filename`               | string  | `null`            | Server icon filename (managed automatically)                             |
| `GIMODI_METRICS_ENABLED`                | `metrics.enabled`             | boolean | `false`           | Enable Prometheus metrics endpoint at `/metrics`                         |

Boolean values accept `true`/`1` for true, anything else for false. Set to `null` or empty string to clear a value.

### Docker

```bash
docker run -p 6833:6833 -p 40000:40000/udp \
  -e GIMODI_NAME="My Server" \
  -e GIMODI_MEDIA_ANNOUNCED_IP="YOUR_PUBLIC_IP" \
  -e GIMODI_MEDIA_WORKERS=1
  -v gimodi-data:/app/data \
  gimodi/gimodi
```

## Data

All persistent data is stored in `data/`:
- `gimodi.db` -- SQLite database (channels, messages, identities, roles, config)
- `uploads/` -- uploaded files
- `cert.pem` / `key.pem` -- SSL certificate (auto-generated if missing)
