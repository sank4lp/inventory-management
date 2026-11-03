FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils python3 python3-serial libstdc++6 libusb-1.0-0 \
    systemd passwd util-linux coreutils tar && rm -rf /var/lib/apt/lists/*
WORKDIR /work
