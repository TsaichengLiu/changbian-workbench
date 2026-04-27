/// <reference types="vite/client" />

interface DesktopMeta {
  isDesktop: boolean;
  platform: string;
}

interface WorkspaceBridge {
  loadSharedWorkspace: () => Promise<unknown>;
  saveSharedWorkspace: (workspace: unknown) => Promise<boolean>;
  getSharedWorkspacePath: () => Promise<string>;
}

interface Window {
  desktopMeta?: DesktopMeta;
  workspaceBridge?: WorkspaceBridge;
}
