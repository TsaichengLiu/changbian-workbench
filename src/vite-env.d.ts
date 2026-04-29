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

type SearchBridgeScope = "project" | "chapter" | "time" | "summary" | "source" | "note" | "citation";

interface SearchBridgeCriteria {
  query: string;
  queryScopes?: SearchBridgeScope[];
  tag: string;
  citationTitle: string;
  limit?: number;
}

interface SearchBridgeResult {
  projectId: string;
  chapterId: string | null;
  entryId: string;
  projectTitle: string;
  chapterTitle: string;
  timeText: string;
  summaryText: string;
  snippet: string;
  citation: string;
  tags: string[];
}

interface SearchBridgeStatus {
  enabled: boolean;
  ready: boolean;
  dbPath: string;
  rowCount: number;
  lastIndexedAt: number;
  message: string;
  backend: string;
}

interface SearchBridge {
  query: (criteria: SearchBridgeCriteria) => Promise<SearchBridgeResult[] | null>;
  getStatus: () => Promise<SearchBridgeStatus>;
}

interface Window {
  desktopMeta?: DesktopMeta;
  workspaceBridge?: WorkspaceBridge;
  appearanceBridge?: AppearanceBridge;
  searchBridge?: SearchBridge;
}
