FROM rust:1.90.0-slim-bookworm

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential clang llvm pkg-config protobuf-compiler && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown

RUN cargo new --lib dummy && \
    cd dummy && \
    cargo build --target wasm32-unknown-unknown --release || true && \
    cd .. && rm -rf dummy

ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup
ENV PATH="${CARGO_HOME}/bin:${PATH}"
ENV CARGO_TARGET_DIR=/mnt/cache/target

WORKDIR /app

COPY package*.json ./
RUN npm i

COPY . .
RUN npm run build

RUN chmod +x ./entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]
