/// <reference types="vite/client" />

interface DesktopMeta {
  isDesktop: boolean;
  platform: string;
}

interface WorkspaceBridge {
  loadSharedWorkspace: () => Promise<unknown>;
  saveSharedWorkspace: (workspace: unknown) => Promise<boolean>;
  getSharedWorkspacePath: () => Promise<string>;
  getWorkspaceStorageInfo: () => Promise<{
    path: string;
    defaultPath: string;
    envLocked: boolean;
    envPath: string | null;
  }>;
  setSharedWorkspacePath: (
    nextPath: string,
    workspace?: unknown,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
  resetSharedWorkspacePath: (
    workspace?: unknown,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
  pickSharedWorkspacePath: () => Promise<string | null>;
}

interface AppearanceBridge {
  getAppearance: () => Promise<{
    theme: "changbian" | "obsidian" | "ocean" | "graphite" | "dusk" | "vaporwave";
    cardStyle: "changbian" | "outline" | "frosted";
  }>;
  setAppearance: (appearance: {
    theme: "changbian" | "obsidian" | "ocean" | "graphite" | "dusk" | "vaporwave";
    cardStyle: "changbian" | "outline" | "frosted";
  }) => Promise<{
    theme: "changbian" | "obsidian" | "ocean" | "graphite" | "dusk" | "vaporwave";
    cardStyle: "changbian" | "outline" | "frosted";
  }>;
  onAppearanceChanged?: (
    handler: (appearance: {
      theme: "changbian" | "obsidian" | "ocean" | "graphite" | "dusk" | "vaporwave";
      cardStyle: "changbian" | "outline" | "frosted";
    }) => void,
  ) => () => void;
}

interface Window {
  desktopMeta?: DesktopMeta;
  workspaceBridge?: WorkspaceBridge;
  appearanceBridge?: AppearanceBridge;
}
