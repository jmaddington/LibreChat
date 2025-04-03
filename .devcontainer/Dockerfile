FROM node:18-bullseye

RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m -s /bin/bash vscode
RUN mkdir -p /workspaces && chown -R vscode:vscode /workspaces
WORKDIR /workspaces
