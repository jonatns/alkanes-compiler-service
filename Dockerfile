FROM rust:1.84 AS builder

# Install system dependencies
RUN apt-get update && apt-get install -y \
    clang \
    llvm \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs

# Install WASM target
RUN rustup target add wasm32-unknown-unknown

# Create and move to app directory
WORKDIR /app

# Copy server files
COPY package.json .
COPY server.js .
RUN npm install

# Copy templates
COPY templates ./templates

# Pre-compile dependencies using template Cargo.toml
RUN mkdir -p /opt/dependencies/src && \
    cp templates/Cargo.toml /opt/dependencies/ && \
    echo "fn main() {}" > /opt/dependencies/src/lib.rs && \
    cd /opt/dependencies && \
    cargo build --target wasm32-unknown-unknown --release && \
    rm -rf src target

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]