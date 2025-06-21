FROM node:20-bullseye

RUN npm install -g @anthropic-ai/claude-code
RUN useradd -m -s /bin/bash vscode

# Install sudo and grant vscode user sudo privileges without password
RUN apt-get update && apt-get install -y sudo python3 python3-pip vim nano \
    && adduser vscode sudo \
    && echo "vscode ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/vscode-nopasswd

    # Do not clean up apt-get, we may want to install more packages later

RUN pip install llm

RUN mkdir -p /workspaces && chown -R vscode:vscode /workspaces
WORKDIR /workspaces