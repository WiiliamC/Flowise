# Flowise Docker Hub Image

Starts Flowise from [DockerHub Image](https://hub.docker.com/r/flowiseai/flowise)

## Local source builds

Use `scripts/flowise_service.sh` with `docker/.env.local` configured. Run from the
repository root:

```bash
# Direct downloads, even when proxy environment variables are set
sudo bash scripts/flowise_service.sh build

# Opt in to the local proxy from the calling environment
sudo --preserve-env=http_proxy,https_proxy,HTTP_PROXY,HTTPS_PROXY \
  bash scripts/flowise_service.sh build --proxy

# Flags can be combined in either order
sudo --preserve-env=http_proxy,https_proxy,HTTP_PROXY,HTTPS_PROXY \
  bash scripts/flowise_service.sh build --proxy --no-cache
```

`--proxy` is a switch and takes no value. It reads the first non-empty variable in
this order: `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`, before loading
project configuration. For example, `http_proxy=http://127.0.0.1:7890` selects port
7890; no port is hardcoded. Configure the variables in your calling shell, not in
`docker/.env.local`. Missing or invalid settings cause an error rather than falling
back to a direct connection. SOCKS-only `ALL_PROXY` is not supported.

This option supports a local Docker daemon on Linux and an HTTP/HTTPS proxy at
`localhost`, `127.0.0.1`, or `[::1]`. It temporarily uses **host networking for the
build** so downloads can reach the host's loopback proxy. The override is removed
on exit and does not change the running service's network.

Without `--proxy`, the script explicitly clears upper- and lowercase HTTP, HTTPS,
ALL and NO proxy build arguments, overriding Docker client defaults. With the
switch, HTTP and HTTPS use the selected proxy, ALL is cleared, and NO_PROXY is
`localhost,127.0.0.1,::1`. Preserving environment variables with `sudo` does not
enable the proxy unless the switch is also present.

Proxy settings apply only to Dockerfile `RUN` steps such as dependency downloads;
they are not written into Dockerfile `ENV` or passed to the running service. Docker
daemon proxies for pulling base images and system transparent proxies are outside
this option's control. Cached steps do not download again; use `--no-cache` when
checking actual connectivity. Proxy access does not fix missing native compilation
tools if a dependency falls back to compiling from source.

After a successful build, recreate the service separately:

```bash
sudo bash scripts/flowise_service.sh restart
```

## Usage

1. Create `.env` file and specify the `PORT` (refer to `.env.example`)
2. `docker compose up -d`
3. Open [http://localhost:3000](http://localhost:3000)
4. You can bring the containers down by `docker compose stop`

## 🌱 Env Variables

If you like to persist your data (flows, logs, credentials, storage), set these variables in the `.env` file inside `docker` folder:

-   DATABASE_PATH=/home/node/.flowise
-   LOG_PATH=/home/node/.flowise/logs
-   SECRETKEY_PATH=/home/node/.flowise
-   BLOB_STORAGE_PATH=/home/node/.flowise/storage

Flowise also support different environment variables to configure your instance. Read [more](https://docs.flowiseai.com/configuration/environment-variables)

> The container runs as the non-root `node` user (uid 1000), whose home directory is `/home/node`. If you bind-mount a host directory (e.g. `~/.flowise`) for persistence, make sure it's writable by that user - on Linux hosts this may require `chown -R 1000:1000 ~/.flowise`.

## Queue Mode:

### Building from source:

You can build the images for worker and main from scratch with:

```
docker compose -f docker-compose-queue-source.yml up -d
```

Monitor Health:

```
docker compose -f docker-compose-queue-source.yml ps
```

### From pre-built images:

You can also use the pre-built images:

```
docker compose -f docker-compose-queue-prebuilt.yml up -d
```

Monitor Health:

```
docker compose -f docker-compose-queue-prebuilt.yml ps
```
