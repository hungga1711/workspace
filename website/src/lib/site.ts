// One place for the links the landing page and the docs share.
export const SITE = {
  name: "workspace",
  url: "https://workspace.hungga1711.dev",
  demo: "https://workspace.hungga1711.dev/live-demo",
  repo: "https://github.com/hungga1711/workspace",
  image: "ghcr.io/hungga1711/workspace",
  version: "1.1.0",
  license: "MIT",
  install: "curl -fsSL https://raw.githubusercontent.com/hungga1711/workspace/main/infra/production/install.sh | sh",
};

export const repoFile = (path: string) => `${SITE.repo}/blob/main/${path}`;
