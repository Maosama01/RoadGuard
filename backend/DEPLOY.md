# Deploying the RoadGuard backend with HTTPS

There are two supported setups:

* **From a Mac, free (current setup).** `ops/go_live_mac.sh` runs the server as a background service and
  publishes it with Tailscale Funnel at a stable `https://<mac-name>.<tailnet>.ts.net/` address with a real
  certificate. Good for testing and a small pilot. The catch: when the Mac sleeps or is off, the server is
  offline (reports wait on the phones and send later). See "From a Mac" below.
* **A small Linux server (VPS), always on.** Docker plus Caddy, described in the rest of this file. Moving
  later is easy: copy `backend/data-live/` to the server's data volume and point the app at the new address.
  Students can run this free for 12 months on an Azure for Students B1s VM (no credit card; see the end).

## From a Mac with Tailscale Funnel

1. Install Tailscale from https://tailscale.com/download/mac, open it and sign in (free Personal plan).
2. Run `bash ops/go_live_mac.sh`. The first time, it asks for your dashboard email, prints a generated
   password, and may print a link to switch Funnel on for your Tailscale account (approve, run it again).
3. It writes the public address into `gradle.properties` as `roadguard.serverUrl`, so the next app build
   talks to it. Build with `bash ops/build_release.sh`.

`bash ops/go_live_mac.sh status` checks it, `... stop` takes it offline. The live database is
`backend/data-live/` (separate from the demo data in `backend/data/`); back that folder up.

---

The rest of this file covers the VPS setup.


The backend is one Node.js process with an SQLite file and a folder of photos. The simplest
production setup is a small Linux server (a VPS) running two containers:

* `api`: the RoadGuard API, the RoadGuard Control dashboard and the public hazard pages (`/h/<id>`).
* `caddy`: a web server in front that gets and renews a free Let's Encrypt certificate for your domain.

What was checked before shipping these files: `docker compose config` renders the compose file
correctly. The images were not built or run here (no Docker daemon was available), so do the first
build on your server and watch the logs, as described below.

## What you need

* A VPS with a public IP address (1 vCPU and 1 GB RAM is plenty to start), running Ubuntu 22.04 or 24.04.
* A domain or subdomain, for example `roadguard.example.in`.
* Ports 80 and 443 open to the internet (Caddy needs port 80 to prove you own the domain).

## 1. Point the domain at the server

At your DNS provider, add an **A record** for the domain with the server's IP address
(and an AAAA record if the server has IPv6). Wait until `ping roadguard.example.in` shows that IP.

## 2. Install Docker on the server

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER    # then log out and back in
docker compose version           # should print a version
```

## 3. Copy the backend to the server

Either clone the repository or copy the `backend/` folder (without `node_modules/` and `data/`):

```bash
git clone <your repository URL> roadguard
cd roadguard/backend
```

## 4. Create `.env`

```bash
cp .env.example .env
nano .env
```

Set at least these values:

```
DOMAIN=roadguard.example.in
JWT_SECRET=<a long random string: run  openssl rand -hex 32>
ADMIN_EMAIL=you@city.gov.in
ADMIN_PASSWORD=<a strong password>
ADMIN_NAME=City Roads Admin
```

You do not need to set `PORT`, `DATA_DIR` or `PUBLIC_BASE_URL`: the compose file sets them
(`PUBLIC_BASE_URL` becomes `https://$DOMAIN`, which is what the public hazard links and photo URLs use).
The server refuses to start in production with the default `JWT_SECRET`.

## 5. Start it

```bash
docker compose up -d --build
docker compose logs -f
```

The first start builds the image (a few minutes) and Caddy requests the certificate (a few seconds once
DNS is right). Then open:

* `https://roadguard.example.in/admin/` for the dashboard (sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`)
* `https://roadguard.example.in/api/health` should answer `{"success":true,...}`

Optional demo data (only on an empty database, never on a live city server):

```bash
docker compose exec api node src/seed.js
```

More staff accounts:

```bash
docker compose exec api node src/createAdmin.js crew@city.gov.in "password" "Ward 12 Supervisor" authority
```

## 6. Point the app at it

In the Android app's Settings, set the server to `https://roadguard.example.in/`. With HTTPS in place,
cleartext traffic can be switched off in `app/src/main/res/xml/network_security_config.xml`.

## Updating

```bash
git pull
docker compose up -d --build
```

The database upgrades itself on start (it records its schema version and migrates older files in place).
Take a backup first anyway.

## Backups

Everything lives in the `roadguard-data` volume: `roadguard.db` and the `uploads/` folder.

```bash
# Consistent copy of the database while the server runs, plus the photos:
docker compose exec api node -e "require('better-sqlite3')('/data/roadguard.db').backup('/data/backup.db').then(()=>console.log('ok'))"
docker compose cp api:/data/backup.db ./roadguard-$(date +%F).db
docker compose cp api:/data/uploads ./uploads-$(date +%F)
```

Copy those files off the server (for example with `rsync` or to object storage) on a schedule.

## Troubleshooting

* **Caddy logs say it cannot get a certificate:** DNS does not point at this server yet, or ports 80/443
  are blocked by a firewall (`sudo ufw allow 80,443/tcp`, and check your cloud provider's firewall).
* **`api` keeps restarting:** run `docker compose logs api`. The usual cause is a missing `JWT_SECRET`.
* **Photos fail to upload:** reports and repair photos are limited to 8 MB, JPEG or PNG.

## Render, Railway and similar platforms

These platforms terminate HTTPS for you, so you only need the `api` container (the `Dockerfile`),
not Caddy or `docker-compose.yml`.

* Create a service from the `backend/` folder using its `Dockerfile`.
* Set environment variables: `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PUBLIC_BASE_URL`
  (the service's https URL), and `DATA_DIR=/data`.
* **Attach a persistent disk or volume mounted at `/data`.** Without one, the SQLite database and all
  photos are lost on every deploy or restart. On Render this needs a paid instance with a disk; on Railway,
  add a volume to the service.
* Run a single instance only. SQLite is a file on one disk, so the service cannot scale to several
  replicas. When you outgrow one server, move to Postgres + PostGIS.

## Azure for Students (free VPS for a year)

Full-time students get USD 100 credit and 750 hours a month of a B1s Linux VM for 12 months, without a
credit card, by signing up with their college email at https://azure.microsoft.com/free/students/.

1. Create an Ubuntu 24.04 VM, size **B1s**, region **Central India**, with a public IP. Open inbound ports 80
   and 443 (and 22 for SSH) in its network security group.
2. Use the free address `<public-ip-with-dashes>.sslip.io` as `DOMAIN` (for example `20-204-10-7.sslip.io`),
   or your own domain.
3. Follow steps 2 to 6 above. To keep existing data, copy the Mac's `backend/data-live/` into the server's
   data volume before the first start.

The public IP is billed against the credit (a few dollars a month); stop and delete the VM when the
credit or student status ends, or move to a paid plan.
