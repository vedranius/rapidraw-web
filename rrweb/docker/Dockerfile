# RapidRAW Web in a container: the released .deb (RapidRAW + web UI + relay + Node.js) on Ubuntu, with a virtual
# screen for WebKitGTK. Rendering uses the GPU through Vulkan: NVIDIA with --gpus all, Intel/AMD with --device /dev/dri,
# otherwise Mesa's software Vulkan (lavapipe, slow but works).
#   docker run -d -p 8780:8780 -v /path/to/photos:/photos -v rapidraw-data:/data ghcr.io/vedranius/rapidraw-web
# Updates: pull the new image (docker compose pull && docker compose up -d); the in-app updater is off here.
FROM ubuntu:24.04
ARG TAG
ARG REPO=vedranius/rapidraw-web
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini xvfb xauth fuse3 mesa-vulkan-drivers libvulkan1 \
 && ARCH=$(dpkg --print-architecture | sed 's/amd64/x64/') \
 && curl -fsSL -o /tmp/rr.deb "https://github.com/${REPO}/releases/download/${TAG}/${TAG}_linux_${ARCH}.deb" \
 && apt-get install -y /tmp/rr.deb \
 && rm -rf /tmp/rr.deb /var/lib/apt/lists/*
ENV RR_PHOTOS=/photos \
    RR_NO_BROWSER=1 \
    RR_NO_UPDATE=1 \
    XDG_DATA_HOME=/data \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache \
    NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility \
    NVIDIA_VISIBLE_DEVICES=all
VOLUME ["/photos", "/data"]
EXPOSE 8780
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS -o /dev/null http://127.0.0.1:8780/ || exit 1
# xvfb-run must not be PID 1 (it waits for a signal from Xvfb that PID 1 does not get)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["xvfb-run", "-a", "-s", "-screen 0 1280x800x24", "/usr/bin/rapidraw-web-bridge"]
