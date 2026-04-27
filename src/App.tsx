import { type DragEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { ExportScope, exportAsDocx, exportAsTxt, exportAsXlsx } from "./exporters";
import { matchesTraditionalSimplified } from "./search";
import type { Entry, WorkspaceData } from "./types";
import { createId, reorderById, summarize } from "./utils";

const STORAGE_KEY = "longform_history_workbench_v3";

const TAG_REGEX = /#([^\s#，。；、,.;:!?！？【】（）()<>《》]+)/g;
const CITATION_TITLE_REGEX = /《([^》\n\r]+)》/g;

type DragPayload =
  | { type: "project"; id: string }
  | { type: "chapter"; id: string; projectId: string }
  | { type: "entry"; id: string; projectId: string; chapterId: string | null };

interface SearchResult {
  projectId: string;
  chapterId: string | null;
  entryId: string;
  projectTitle: string;
  chapterTitle: string;
  timeText: string;
  snippet: string;
  citation: string;
  tags: string[];
}

interface EntryDraft {
  timeText: string;
  sourceText: string;
  note: string;
  citation: string;
}

interface ProjectSnapshot {
  title: string;
  directEntries: EntryDraft[];
  chapters: Array<{
    title: string;
    entries: EntryDraft[];
  }>;
}

type ClipboardState =
  | { kind: "project"; snapshot: ProjectSnapshot }
  | { kind: "entry"; draft: EntryDraft }
  | null;

type ModalState =
  | { kind: "project-create"; value: string }
  | { kind: "project-rename"; projectId: string; value: string }
  | { kind: "chapter-create"; projectId: string; value: string }
  | { kind: "chapter-rename"; chapterId: string; value: string }
  | { kind: "entry-edit"; entryId: string; draft: EntryDraft }
  | null;

interface ProjectMenuState {
  projectId: string;
  x: number;
  y: number;
}

interface MergeModalState {
  open: boolean;
  mode: "into-active" | "as-new";
  selectedProjectIds: string[];
  newProjectTitle: string;
}

type AdvancedTargetMode =
  | "new-project"
  | "new-chapter"
  | "existing-project"
  | "existing-chapter";

interface AdvancedSearchModalState {
  open: boolean;
  query: string;
  tag: string;
  citationTitle: string;
  targetMode: AdvancedTargetMode;
  newProjectTitle: string;
  newChapterTitle: string;
  existingProjectId: string;
  existingChapterId: string;
}

interface ChapterMergeModalState {
  open: boolean;
  selectedChapterIds: string[];
  targetProjectId: string;
  newChapterTitle: string;
}

interface EntryFilterCriteria {
  query: string;
  tag: string;
  citationTitle: string;
}

function entryToDraft(entry: Entry): EntryDraft {
  return {
    timeText: entry.timeText,
    sourceText: entry.sourceText,
    note: entry.note,
    citation: entry.citation,
  };
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TAG_REGEX)) {
    const token = `#${(match[1] ?? "").trim()}`;
    if (!token || token === "#") {
      continue;
    }
    const key = token.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(token);
  }
  return tags;
}

function extractCitationTitles(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CITATION_TITLE_REGEX)) {
    const title = (match[1] ?? "").trim();
    if (!title || seen.has(title)) {
      continue;
    }
    seen.add(title);
    tokens.push(title);
  }
  return tokens;
}

function firstEntryInProject(workspace: WorkspaceData, projectId: string | null): string | null {
  if (!projectId) {
    return null;
  }

  const project = workspace.projects[projectId];
  if (!project) {
    return null;
  }

  if (project.entryIds.length > 0) {
    return project.entryIds[0] ?? null;
  }

  for (const chapterId of project.chapterIds) {
    const chapter = workspace.chapters[chapterId];
    if (chapter && chapter.entryIds.length > 0) {
      return chapter.entryIds[0] ?? null;
    }
  }

  return null;
}

function activeEntryIds(workspace: WorkspaceData): string[] {
  const activeProjectId = workspace.activeProjectId;
  if (!activeProjectId) {
    return [];
  }

  const project = workspace.projects[activeProjectId];
  if (!project) {
    return [];
  }

  if (workspace.activeChapterId) {
    const chapter = workspace.chapters[workspace.activeChapterId];
    return chapter?.entryIds ?? [];
  }

  return project.entryIds;
}

function moveToEnd(list: string[], sourceId: string): string[] {
  const sourceIndex = list.indexOf(sourceId);
  if (sourceIndex < 0 || sourceIndex === list.length - 1) {
    return list;
  }

  const next = [...list];
  const [moved] = next.splice(sourceIndex, 1);
  next.push(moved);
  return next;
}

function appendEntryDraft(
  workspace: WorkspaceData,
  projectId: string,
  chapterId: string | null,
  draft: EntryDraft,
): string {
  const entryId = createId("entry");
  workspace.entries[entryId] = {
    id: entryId,
    projectId,
    chapterId,
    timeText: draft.timeText,
    sourceText: draft.sourceText,
    note: draft.note,
    citation: draft.citation,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (chapterId) {
    workspace.chapters[chapterId]?.entryIds.push(entryId);
  } else {
    workspace.projects[projectId]?.entryIds.push(entryId);
  }

  return entryId;
}

function appendChapterWithEntries(
  workspace: WorkspaceData,
  projectId: string,
  chapterTitle: string,
  drafts: EntryDraft[],
): string | null {
  if (!workspace.projects[projectId] || drafts.length === 0) {
    return null;
  }

  const chapterId = createId("chapter");
  workspace.chapters[chapterId] = {
    id: chapterId,
    projectId,
    title: chapterTitle,
    entryIds: [],
    createdAt: Date.now(),
  };
  workspace.projects[projectId].chapterIds.push(chapterId);

  for (const draft of drafts) {
    appendEntryDraft(workspace, projectId, chapterId, draft);
  }

  return chapterId;
}

function ensureUniqueProjectTitle(
  workspace: WorkspaceData,
  base: string,
  ignoreProjectId?: string,
): string {
  const normalized = base.trim() || "新建專案";
  const existing = new Set(
    Object.values(workspace.projects)
      .filter((project) => project.id !== ignoreProjectId)
      .map((project) => project.title),
  );
  if (!existing.has(normalized)) {
    return normalized;
  }

  let counter = 2;
  while (existing.has(`${normalized} (${counter})`)) {
    counter += 1;
  }
  return `${normalized} (${counter})`;
}

function collectProjectSnapshot(workspace: WorkspaceData, projectId: string): ProjectSnapshot | null {
  const project = workspace.projects[projectId];
  if (!project) {
    return null;
  }

  const directEntries = project.entryIds
    .map((entryId) => workspace.entries[entryId])
    .filter((entry): entry is Entry => Boolean(entry))
    .map(entryToDraft);

  const chapters = project.chapterIds
    .map((chapterId) => workspace.chapters[chapterId])
    .filter(Boolean)
    .map((chapter) => ({
      title: chapter.title,
      entries: chapter.entryIds
        .map((entryId) => workspace.entries[entryId])
        .filter((entry): entry is Entry => Boolean(entry))
        .map(entryToDraft),
    }));

  return {
    title: project.title,
    directEntries,
    chapters,
  };
}

function appendSnapshotToProject(
  workspace: WorkspaceData,
  targetProjectId: string,
  snapshot: ProjectSnapshot,
  prefixSourceTitle: boolean,
): string | null {
  if (!workspace.projects[targetProjectId]) {
    return null;
  }

  let firstEntryId: string | null = null;

  if (snapshot.directEntries.length > 0) {
    const title = prefixSourceTitle ? `${snapshot.title}｜未分章` : "未分章";
    const chapterId = appendChapterWithEntries(workspace, targetProjectId, title, snapshot.directEntries);
    if (chapterId) {
      const first = workspace.chapters[chapterId]?.entryIds[0] ?? null;
      if (!firstEntryId && first) {
        firstEntryId = first;
      }
    }
  }

  for (const chapter of snapshot.chapters) {
    if (chapter.entries.length === 0) {
      continue;
    }

    const title = prefixSourceTitle ? `${snapshot.title}｜${chapter.title}` : chapter.title;
    const chapterId = appendChapterWithEntries(workspace, targetProjectId, title, chapter.entries);
    if (chapterId) {
      const first = workspace.chapters[chapterId]?.entryIds[0] ?? null;
      if (!firstEntryId && first) {
        firstEntryId = first;
      }
    }
  }

  return firstEntryId;
}

function cleanupWorkspace(workspace: WorkspaceData): WorkspaceData {
  const next = structuredClone(workspace);

  next.projectOrder = next.projectOrder.filter((projectId) => Boolean(next.projects[projectId]));

  for (const chapterId of Object.keys(next.chapters)) {
    const chapter = next.chapters[chapterId];
    if (!next.projects[chapter.projectId]) {
      delete next.chapters[chapterId];
    }
  }

  for (const entryId of Object.keys(next.entries)) {
    const entry = next.entries[entryId];
    const project = next.projects[entry.projectId];
    if (!project) {
      delete next.entries[entryId];
      continue;
    }

    if (entry.chapterId && !next.chapters[entry.chapterId]) {
      entry.chapterId = null;
      if (!project.entryIds.includes(entry.id)) {
        project.entryIds.push(entry.id);
      }
    }
  }

  for (const projectId of Object.keys(next.projects)) {
    const project = next.projects[projectId];
    project.chapterIds = project.chapterIds.filter((chapterId) => {
      const chapter = next.chapters[chapterId];
      return Boolean(chapter && chapter.projectId === project.id);
    });

    const missingChapters = Object.values(next.chapters)
      .filter((chapter) => chapter.projectId === project.id && !project.chapterIds.includes(chapter.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((chapter) => chapter.id);
    project.chapterIds.push(...missingChapters);

    project.entryIds = project.entryIds.filter((entryId) => {
      const entry = next.entries[entryId];
      return Boolean(entry && entry.projectId === project.id && entry.chapterId === null);
    });

    const missingProjectEntries = Object.values(next.entries)
      .filter(
        (entry) =>
          entry.projectId === project.id &&
          entry.chapterId === null &&
          !project.entryIds.includes(entry.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => entry.id);
    project.entryIds.push(...missingProjectEntries);
  }

  for (const chapterId of Object.keys(next.chapters)) {
    const chapter = next.chapters[chapterId];
    chapter.entryIds = chapter.entryIds.filter((entryId) => {
      const entry = next.entries[entryId];
      return Boolean(entry && entry.projectId === chapter.projectId && entry.chapterId === chapter.id);
    });

    const missingChapterEntries = Object.values(next.entries)
      .filter(
        (entry) =>
          entry.projectId === chapter.projectId &&
          entry.chapterId === chapter.id &&
          !chapter.entryIds.includes(entry.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => entry.id);
    chapter.entryIds.push(...missingChapterEntries);
  }

  if (next.projectOrder.length === 0) {
    const projectId = createId("project");
    next.projects[projectId] = {
      id: projectId,
      title: "新建專案",
      chapterIds: [],
      entryIds: [],
      createdAt: Date.now(),
    };
    next.projectOrder.push(projectId);
    next.activeProjectId = projectId;
    next.activeChapterId = null;
    next.selectedEntryId = null;
    return next;
  }

  if (!next.activeProjectId || !next.projects[next.activeProjectId]) {
    next.activeProjectId = next.projectOrder[0] ?? null;
    next.activeChapterId = null;
  }

  if (next.activeChapterId) {
    const chapter = next.chapters[next.activeChapterId];
    if (!chapter || chapter.projectId !== next.activeProjectId) {
      next.activeChapterId = null;
    }
  }

  if (next.selectedEntryId && !next.entries[next.selectedEntryId]) {
    next.selectedEntryId = null;
  }

  const visibleIds = activeEntryIds(next);
  if (!next.selectedEntryId || !visibleIds.includes(next.selectedEntryId)) {
    next.selectedEntryId = visibleIds[0] ?? firstEntryInProject(next, next.activeProjectId);
  }

  return next;
}

function createInitialWorkspace(): WorkspaceData {
  const projectId = createId("project");
  return {
    projectOrder: [projectId],
    projects: {
      [projectId]: {
        id: projectId,
        title: "我的長編專案",
        chapterIds: [],
        entryIds: [],
        createdAt: Date.now(),
      },
    },
    chapters: {},
    entries: {},
    activeProjectId: projectId,
    activeChapterId: null,
    selectedEntryId: null,
  };
}

function loadWorkspace(): WorkspaceData {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return createInitialWorkspace();
  }

  try {
    const parsed = JSON.parse(raw) as WorkspaceData;
    return cleanupWorkspace(parsed);
  } catch {
    return createInitialWorkspace();
  }
}

function iterateAllEntries(workspace: WorkspaceData): SearchResult[] {
  const output: SearchResult[] = [];

  for (const projectId of workspace.projectOrder) {
    const project = workspace.projects[projectId];
    if (!project) {
      continue;
    }

    for (const entryId of project.entryIds) {
      const entry = workspace.entries[entryId];
      if (!entry) {
        continue;
      }
      output.push({
        projectId: project.id,
        chapterId: null,
        entryId: entry.id,
        projectTitle: project.title,
        chapterTitle: "未分章",
        timeText: entry.timeText,
        snippet: summarize(entry.sourceText, 120),
        citation: summarize(entry.citation, 80),
        tags: extractTags(entry.note),
      });
    }

    for (const chapterId of project.chapterIds) {
      const chapter = workspace.chapters[chapterId];
      if (!chapter) {
        continue;
      }

      for (const entryId of chapter.entryIds) {
        const entry = workspace.entries[entryId];
        if (!entry) {
          continue;
        }
        output.push({
          projectId: project.id,
          chapterId: chapter.id,
          entryId: entry.id,
          projectTitle: project.title,
          chapterTitle: chapter.title,
          timeText: entry.timeText,
          snippet: summarize(entry.sourceText, 120),
          citation: summarize(entry.citation, 80),
          tags: extractTags(entry.note),
        });
      }
    }
  }

  return output;
}

function normalizeTagInput(tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function filterEntriesByCriteria(workspace: WorkspaceData, criteria: EntryFilterCriteria): SearchResult[] {
  const query = criteria.query.trim();
  const normalizedTag = normalizeTagInput(criteria.tag).toLocaleLowerCase();
  const citationTitle = criteria.citationTitle.trim();

  if (!query && !normalizedTag && !citationTitle) {
    return [];
  }

  return iterateAllEntries(workspace).filter((result) => {
    const entry = workspace.entries[result.entryId];
    if (!entry) {
      return false;
    }

    const queryPass = query
      ? matchesTraditionalSimplified(
          [
            result.projectTitle,
            result.chapterTitle,
            entry.timeText,
            entry.sourceText,
            entry.note,
            entry.citation,
          ]
            .join("\n")
            .trim(),
          query,
        )
      : true;

    const tagPass = normalizedTag
      ? extractTags(entry.note).some((tag) => tag.toLocaleLowerCase() === normalizedTag)
      : true;

    const citationPass = citationTitle
      ? extractCitationTitles(entry.citation).some((title) =>
          matchesTraditionalSimplified(title, citationTitle),
        ) || matchesTraditionalSimplified(entry.citation, citationTitle)
      : true;

    return queryPass && tagPass && citationPass;
  });
}

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceData>(() => loadWorkspace());
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string>("");
  const [exportScope, setExportScope] = useState<ExportScope>("active");
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const [clipboard, setClipboard] = useState<ClipboardState>(null);
  const [modalState, setModalState] = useState<ModalState>(null);
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
  const [sharedSyncReady, setSharedSyncReady] = useState<boolean>(
    () => !window.workspaceBridge?.loadSharedWorkspace,
  );
  const [mergeModal, setMergeModal] = useState<MergeModalState>({
    open: false,
    mode: "as-new",
    selectedProjectIds: [],
    newProjectTitle: "合併專案",
  });
  const [advancedModal, setAdvancedModal] = useState<AdvancedSearchModalState>({
    open: false,
    query: "",
    tag: "",
    citationTitle: "",
    targetMode: "new-project",
    newProjectTitle: "按檢索結果分類",
    newChapterTitle: "檢索結果",
    existingProjectId: workspace.activeProjectId ?? workspace.projectOrder[0] ?? "",
    existingChapterId: "",
  });
  const [chapterMergeModal, setChapterMergeModal] = useState<ChapterMergeModalState>({
    open: false,
    selectedChapterIds: [],
    targetProjectId: workspace.activeProjectId ?? workspace.projectOrder[0] ?? "",
    newChapterTitle: "合併章節",
  });

  const projectMenuRef = useRef<HTMLDivElement | null>(null);

  const activeProject = workspace.activeProjectId
    ? workspace.projects[workspace.activeProjectId] ?? null
    : null;
  const activeChapter = workspace.activeChapterId
    ? workspace.chapters[workspace.activeChapterId] ?? null
    : null;

  const currentEntryIds = useMemo(() => activeEntryIds(workspace), [workspace]);
  const currentEntries = useMemo(
    () => currentEntryIds.map((entryId) => workspace.entries[entryId]).filter(Boolean) as Entry[],
    [currentEntryIds, workspace.entries],
  );

  const selectedEntry = workspace.selectedEntryId
    ? workspace.entries[workspace.selectedEntryId] ?? null
    : null;

  const allTags = useMemo(() => {
    const seen = new Set<string>();
    const tags: string[] = [];

    for (const entry of Object.values(workspace.entries)) {
      for (const tag of extractTags(entry.note)) {
        const key = tag.toLocaleLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        tags.push(tag);
      }
    }

    return tags.sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }, [workspace.entries]);

  useEffect(() => {
    if (selectedTag && !allTags.some((tag) => tag.toLocaleLowerCase() === selectedTag.toLocaleLowerCase())) {
      setSelectedTag("");
    }
  }, [selectedTag, allTags]);

  useEffect(() => {
    const fallbackProjectId = workspace.activeProjectId ?? workspace.projectOrder[0] ?? "";
    setAdvancedModal((state) => {
      if (!state.open) {
        return state;
      }

      const projectId =
        state.existingProjectId && workspace.projects[state.existingProjectId]
          ? state.existingProjectId
          : fallbackProjectId;
      const chapterId =
        state.existingChapterId &&
        workspace.chapters[state.existingChapterId] &&
        workspace.chapters[state.existingChapterId].projectId === projectId
          ? state.existingChapterId
          : workspace.projects[projectId]?.chapterIds[0] ?? "";

      if (projectId === state.existingProjectId && chapterId === state.existingChapterId) {
        return state;
      }

      return {
        ...state,
        existingProjectId: projectId,
        existingChapterId: chapterId,
      };
    });

    setChapterMergeModal((state) => {
      if (!state.open) {
        return state;
      }

      const projectId =
        state.targetProjectId && workspace.projects[state.targetProjectId]
          ? state.targetProjectId
          : fallbackProjectId;
      const selectedChapterIds = state.selectedChapterIds.filter((chapterId) =>
        Boolean(workspace.chapters[chapterId]),
      );

      if (
        projectId === state.targetProjectId &&
        selectedChapterIds.length === state.selectedChapterIds.length
      ) {
        return state;
      }

      return {
        ...state,
        targetProjectId: projectId,
        selectedChapterIds,
      };
    });
  }, [workspace]);

  const hasSearch = Boolean(globalQuery.trim() || normalizeTagInput(selectedTag));

  const searchResults = useMemo(() => {
    return filterEntriesByCriteria(workspace, {
      query: globalQuery,
      tag: selectedTag,
      citationTitle: "",
    });
  }, [globalQuery, selectedTag, workspace]);

  const hasAdvancedSearch = Boolean(
    advancedModal.query.trim() ||
      normalizeTagInput(advancedModal.tag) ||
      advancedModal.citationTitle.trim(),
  );
  const advancedResults = useMemo(
    () =>
      filterEntriesByCriteria(workspace, {
        query: advancedModal.query,
        tag: advancedModal.tag,
        citationTitle: advancedModal.citationTitle,
      }),
    [advancedModal.citationTitle, advancedModal.query, advancedModal.tag, workspace],
  );

  useEffect(() => {
    if (!window.workspaceBridge?.loadSharedWorkspace) {
      setSharedSyncReady(true);
      return;
    }

    let cancelled = false;
    void window.workspaceBridge
      .loadSharedWorkspace()
      .then((raw) => {
        if (cancelled || !raw || typeof raw !== "object") {
          return;
        }
        setWorkspace(cleanupWorkspace(raw as WorkspaceData));
      })
      .catch(() => {
        // Ignore bridge errors and keep local storage data.
      })
      .finally(() => {
        if (!cancelled) {
          setSharedSyncReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    if (!sharedSyncReady || !window.workspaceBridge?.saveSharedWorkspace) {
      return;
    }
    void window.workspaceBridge.saveSharedWorkspace(workspace).catch(() => {
      // Ignore bridge errors and keep local storage data.
    });
  }, [sharedSyncReady, workspace]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (
        projectMenuRef.current &&
        event.target instanceof Node &&
        projectMenuRef.current.contains(event.target)
      ) {
        return;
      }
      setProjectMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setModalState(null);
        setProjectMenu(null);
        setMergeModal((state) => ({ ...state, open: false }));
        setAdvancedModal((state) => ({ ...state, open: false }));
        setChapterMergeModal((state) => ({ ...state, open: false }));
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  function mutateWorkspace(mutator: (draft: WorkspaceData) => void): void {
    setWorkspace((previous) => {
      const next = structuredClone(previous);
      mutator(next);
      return cleanupWorkspace(next);
    });
  }

  function configureMoveDrag(event: DragEvent): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.dropEffect = "move";
    event.dataTransfer.setData("text/plain", "move");
  }

  function clearDragState(): void {
    setDragPayload(null);
    setDraggingKey(null);
    setDropTargetKey(null);
  }

  function selectProject(projectId: string): void {
    mutateWorkspace((draft) => {
      draft.activeProjectId = projectId;
      draft.activeChapterId = null;
      const project = draft.projects[projectId];
      draft.selectedEntryId = project?.entryIds[0] ?? firstEntryInProject(draft, projectId);
    });
  }

  function selectChapter(projectId: string, chapterId: string): void {
    mutateWorkspace((draft) => {
      draft.activeProjectId = projectId;
      draft.activeChapterId = chapterId;
      const chapter = draft.chapters[chapterId];
      draft.selectedEntryId = chapter?.entryIds[0] ?? null;
    });
  }

  function jumpToSearchResult(result: SearchResult): void {
    mutateWorkspace((draft) => {
      draft.activeProjectId = result.projectId;
      draft.activeChapterId = result.chapterId;
      draft.selectedEntryId = result.entryId;
    });
  }

  function beginCreateProject(): void {
    setModalState({ kind: "project-create", value: "新建專案" });
  }

  function beginRenameProject(projectId: string): void {
    const project = workspace.projects[projectId];
    if (!project) {
      return;
    }
    setModalState({ kind: "project-rename", projectId, value: project.title });
  }

  function beginCreateChapter(projectId: string): void {
    const project = workspace.projects[projectId];
    if (!project) {
      return;
    }
    setModalState({
      kind: "chapter-create",
      projectId,
      value: `第${project.chapterIds.length + 1}章`,
    });
  }

  function beginRenameChapter(chapterId: string): void {
    const chapter = workspace.chapters[chapterId];
    if (!chapter) {
      return;
    }
    setModalState({ kind: "chapter-rename", chapterId, value: chapter.title });
  }

  function beginEditEntry(entryId: string): void {
    const entry = workspace.entries[entryId];
    if (!entry) {
      return;
    }

    setModalState({
      kind: "entry-edit",
      entryId,
      draft: entryToDraft(entry),
    });
  }

  function copyCurrentProject(projectId: string): void {
    const snapshot = collectProjectSnapshot(workspace, projectId);
    if (!snapshot) {
      return;
    }
    setClipboard({ kind: "project", snapshot });
  }

  function pasteProjectFromClipboard(): void {
    if (!clipboard || clipboard.kind !== "project") {
      return;
    }

    mutateWorkspace((draft) => {
      const projectId = createId("project");
      const projectTitle = ensureUniqueProjectTitle(draft, `${clipboard.snapshot.title}（副本）`);
      draft.projects[projectId] = {
        id: projectId,
        title: projectTitle,
        chapterIds: [],
        entryIds: [],
        createdAt: Date.now(),
      };
      draft.projectOrder.push(projectId);

      let firstEntryId: string | null = null;
      for (const item of clipboard.snapshot.directEntries) {
        const entryId = appendEntryDraft(draft, projectId, null, item);
        if (!firstEntryId) {
          firstEntryId = entryId;
        }
      }

      for (const chapter of clipboard.snapshot.chapters) {
        const chapterId = appendChapterWithEntries(draft, projectId, chapter.title, chapter.entries);
        const first = chapterId ? draft.chapters[chapterId]?.entryIds[0] ?? null : null;
        if (!firstEntryId && first) {
          firstEntryId = first;
        }
      }

      draft.activeProjectId = projectId;
      draft.activeChapterId = null;
      draft.selectedEntryId = firstEntryId;
    });
  }

  function copyEntryToClipboard(entryId: string): void {
    const entry = workspace.entries[entryId];
    if (!entry) {
      return;
    }
    setClipboard({ kind: "entry", draft: entryToDraft(entry) });
  }

  function pasteEntryFromClipboard(): void {
    if (!clipboard || clipboard.kind !== "entry" || !activeProject) {
      return;
    }

    mutateWorkspace((draft) => {
      const targetProject = draft.projects[activeProject.id];
      if (!targetProject) {
        return;
      }

      const entryId = appendEntryDraft(draft, targetProject.id, draft.activeChapterId, clipboard.draft);
      draft.selectedEntryId = entryId;
    });
  }

  function openProjectContextMenu(event: MouseEvent, projectId: string): void {
    event.preventDefault();
    const menuWidth = 180;
    const menuHeight = 104;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 10);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 10);
    setProjectMenu({ projectId, x, y });
  }

  function applyFormModal(): void {
    if (!modalState || modalState.kind === "entry-edit") {
      return;
    }

    if (modalState.kind === "project-create") {
      const title = modalState.value.trim() || "新建專案";
      mutateWorkspace((draft) => {
        const projectId = createId("project");
        draft.projects[projectId] = {
          id: projectId,
          title: ensureUniqueProjectTitle(draft, title),
          chapterIds: [],
          entryIds: [],
          createdAt: Date.now(),
        };
        draft.projectOrder.push(projectId);
        draft.activeProjectId = projectId;
        draft.activeChapterId = null;
        draft.selectedEntryId = null;
      });
      setModalState(null);
      return;
    }

    if (modalState.kind === "project-rename") {
      const title = modalState.value.trim();
      if (!title) {
        return;
      }

      mutateWorkspace((draft) => {
        const project = draft.projects[modalState.projectId];
        if (!project) {
          return;
        }
        project.title = ensureUniqueProjectTitle(draft, title, project.id);
      });
      setModalState(null);
      return;
    }

    if (modalState.kind === "chapter-create") {
      const title = modalState.value.trim() || "新章節";
      mutateWorkspace((draft) => {
        const project = draft.projects[modalState.projectId];
        if (!project) {
          return;
        }

        const chapterId = createId("chapter");
        draft.chapters[chapterId] = {
          id: chapterId,
          projectId: modalState.projectId,
          title,
          entryIds: [],
          createdAt: Date.now(),
        };
        project.chapterIds.push(chapterId);
        draft.activeProjectId = modalState.projectId;
        draft.activeChapterId = chapterId;
        draft.selectedEntryId = null;
      });
      setModalState(null);
      return;
    }

    const title = modalState.value.trim();
    if (!title) {
      return;
    }

    mutateWorkspace((draft) => {
      const chapter = draft.chapters[modalState.chapterId];
      if (chapter) {
        chapter.title = title;
      }
    });
    setModalState(null);
  }

  function applyEntryEditor(): void {
    if (!modalState || modalState.kind !== "entry-edit") {
      return;
    }

    const { entryId, draft } = modalState;
    mutateWorkspace((workspaceDraft) => {
      const entry = workspaceDraft.entries[entryId];
      if (!entry) {
        return;
      }
      entry.timeText = draft.timeText;
      entry.sourceText = draft.sourceText;
      entry.note = draft.note;
      entry.citation = draft.citation;
      entry.updatedAt = Date.now();
    });

    setModalState(null);
  }

  function deleteProject(projectId: string): void {
    const project = workspace.projects[projectId];
    if (!project) {
      return;
    }

    const confirmed = window.confirm(`刪除專案「${project.title}」？此操作會移除其全部章節與史料。`);
    if (!confirmed) {
      return;
    }

    mutateWorkspace((draft) => {
      const target = draft.projects[projectId];
      if (!target) {
        return;
      }

      for (const entryId of target.entryIds) {
        delete draft.entries[entryId];
      }

      for (const chapterId of target.chapterIds) {
        const chapter = draft.chapters[chapterId];
        if (!chapter) {
          continue;
        }
        for (const entryId of chapter.entryIds) {
          delete draft.entries[entryId];
        }
        delete draft.chapters[chapterId];
      }

      delete draft.projects[projectId];
      draft.projectOrder = draft.projectOrder.filter((id) => id !== projectId);

      if (draft.activeProjectId === projectId) {
        draft.activeProjectId = draft.projectOrder[0] ?? null;
        draft.activeChapterId = null;
      }
    });
  }

  function deleteChapter(chapterId: string): void {
    const chapter = workspace.chapters[chapterId];
    if (!chapter) {
      return;
    }

    const confirmed = window.confirm(`刪除章節「${chapter.title}」？此章節下史料會一併刪除。`);
    if (!confirmed) {
      return;
    }

    mutateWorkspace((draft) => {
      const target = draft.chapters[chapterId];
      if (!target) {
        return;
      }

      for (const entryId of target.entryIds) {
        delete draft.entries[entryId];
      }

      const project = draft.projects[target.projectId];
      if (project) {
        project.chapterIds = project.chapterIds.filter((id) => id !== chapterId);
      }

      delete draft.chapters[chapterId];
      if (draft.activeChapterId === chapterId) {
        draft.activeChapterId = null;
      }
    });
  }

  function createEntry(): void {
    if (!activeProject) {
      return;
    }

    const entryId = createId("entry");
    mutateWorkspace((draft) => {
      const project = draft.projects[activeProject.id];
      if (!project) {
        return;
      }

      draft.entries[entryId] = {
        id: entryId,
        projectId: project.id,
        chapterId: draft.activeChapterId,
        timeText: "",
        sourceText: "",
        note: "",
        citation: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      if (draft.activeChapterId) {
        draft.chapters[draft.activeChapterId]?.entryIds.push(entryId);
      } else {
        project.entryIds.push(entryId);
      }

      draft.selectedEntryId = entryId;
    });

    setModalState({
      kind: "entry-edit",
      entryId,
      draft: { timeText: "", sourceText: "", note: "", citation: "" },
    });
  }

  function deleteEntry(entryId: string): void {
    const entry = workspace.entries[entryId];
    if (!entry) {
      return;
    }

    const confirmed = window.confirm("刪除此條史料？");
    if (!confirmed) {
      return;
    }

    mutateWorkspace((draft) => {
      const target = draft.entries[entryId];
      if (!target) {
        return;
      }

      if (target.chapterId) {
        const chapter = draft.chapters[target.chapterId];
        if (chapter) {
          chapter.entryIds = chapter.entryIds.filter((id) => id !== entryId);
        }
      } else {
        const project = draft.projects[target.projectId];
        if (project) {
          project.entryIds = project.entryIds.filter((id) => id !== entryId);
        }
      }

      delete draft.entries[entryId];
      if (draft.selectedEntryId === entryId) {
        draft.selectedEntryId = null;
      }
    });
  }

  function onProjectDrop(targetProjectId: string): void {
    if (!dragPayload || dragPayload.type !== "project") {
      return;
    }

    mutateWorkspace((draft) => {
      draft.projectOrder = reorderById(draft.projectOrder, dragPayload.id, targetProjectId);
    });

    clearDragState();
  }

  function onChapterDrop(targetProjectId: string, targetChapterId: string): void {
    if (!dragPayload || dragPayload.type !== "chapter") {
      return;
    }
    if (dragPayload.projectId !== targetProjectId) {
      return;
    }

    mutateWorkspace((draft) => {
      const project = draft.projects[targetProjectId];
      if (!project) {
        return;
      }
      project.chapterIds = reorderById(project.chapterIds, dragPayload.id, targetChapterId);
    });

    clearDragState();
  }

  function onEntryDrop(targetEntryId: string): void {
    if (!dragPayload || dragPayload.type !== "entry" || !activeProject) {
      return;
    }

    const sameScope =
      dragPayload.projectId === activeProject.id && dragPayload.chapterId === (activeChapter?.id ?? null);
    if (!sameScope) {
      return;
    }

    mutateWorkspace((draft) => {
      if (activeChapter) {
        const chapter = draft.chapters[activeChapter.id];
        if (!chapter) {
          return;
        }
        chapter.entryIds = reorderById(chapter.entryIds, dragPayload.id, targetEntryId);
      } else {
        const project = draft.projects[activeProject.id];
        if (!project) {
          return;
        }
        project.entryIds = reorderById(project.entryIds, dragPayload.id, targetEntryId);
      }
    });

    clearDragState();
  }

  function onEntryDropToEnd(): void {
    if (!dragPayload || dragPayload.type !== "entry" || !activeProject) {
      return;
    }

    const sameScope =
      dragPayload.projectId === activeProject.id && dragPayload.chapterId === (activeChapter?.id ?? null);
    if (!sameScope) {
      return;
    }

    mutateWorkspace((draft) => {
      if (activeChapter) {
        const chapter = draft.chapters[activeChapter.id];
        if (!chapter) {
          return;
        }
        chapter.entryIds = moveToEnd(chapter.entryIds, dragPayload.id);
      } else {
        const project = draft.projects[activeProject.id];
        if (!project) {
          return;
        }
        project.entryIds = moveToEnd(project.entryIds, dragPayload.id);
      }
    });

    clearDragState();
  }

  function openAdvancedSearchModal(): void {
    const fallbackProjectId = activeProject?.id ?? workspace.projectOrder[0] ?? "";
    const fallbackChapterId =
      activeChapter?.id && workspace.chapters[activeChapter.id]?.projectId === fallbackProjectId
        ? activeChapter.id
        : workspace.projects[fallbackProjectId]?.chapterIds[0] ?? "";

    setAdvancedModal({
      open: true,
      query: globalQuery,
      tag: selectedTag,
      citationTitle: "",
      targetMode: "new-project",
      newProjectTitle: "按檢索結果分類",
      newChapterTitle: "檢索結果",
      existingProjectId: fallbackProjectId,
      existingChapterId: fallbackChapterId,
    });
  }

  function collectEntryDraftsByResults(results: SearchResult[]): EntryDraft[] {
    return results
      .map((result) => workspace.entries[result.entryId])
      .filter((entry): entry is Entry => Boolean(entry))
      .map(entryToDraft);
  }

  function importAdvancedResults(): void {
    if (!hasAdvancedSearch) {
      window.alert("請至少輸入一個檢索條件。");
      return;
    }

    const drafts = collectEntryDraftsByResults(advancedResults);
    if (drafts.length === 0) {
      window.alert("沒有可導入的檢索結果。");
      return;
    }

    if (advancedModal.targetMode === "new-project") {
      mutateWorkspace((draft) => {
        const projectId = createId("project");
        const title = ensureUniqueProjectTitle(draft, advancedModal.newProjectTitle.trim() || "按檢索結果分類");
        draft.projects[projectId] = {
          id: projectId,
          title,
          chapterIds: [],
          entryIds: [],
          createdAt: Date.now(),
        };
        draft.projectOrder.push(projectId);

        let firstEntryId: string | null = null;
        for (const item of drafts) {
          const entryId = appendEntryDraft(draft, projectId, null, item);
          if (!firstEntryId) {
            firstEntryId = entryId;
          }
        }

        draft.activeProjectId = projectId;
        draft.activeChapterId = null;
        draft.selectedEntryId = firstEntryId;
      });

      setAdvancedModal((state) => ({ ...state, open: false }));
      return;
    }

    if (advancedModal.targetMode === "new-chapter") {
      const targetProjectId = advancedModal.existingProjectId;
      if (!workspace.projects[targetProjectId]) {
        window.alert("請先選擇要建立新章節的目標專案。");
        return;
      }

      mutateWorkspace((draft) => {
        const project = draft.projects[targetProjectId];
        if (!project) {
          return;
        }

        const chapterId = createId("chapter");
        draft.chapters[chapterId] = {
          id: chapterId,
          projectId: targetProjectId,
          title: advancedModal.newChapterTitle.trim() || "檢索結果",
          entryIds: [],
          createdAt: Date.now(),
        };
        project.chapterIds.push(chapterId);

        let firstEntryId: string | null = null;
        for (const item of drafts) {
          const entryId = appendEntryDraft(draft, targetProjectId, chapterId, item);
          if (!firstEntryId) {
            firstEntryId = entryId;
          }
        }

        draft.activeProjectId = targetProjectId;
        draft.activeChapterId = chapterId;
        draft.selectedEntryId = firstEntryId;
      });

      setAdvancedModal((state) => ({ ...state, open: false }));
      return;
    }

    if (advancedModal.targetMode === "existing-project") {
      const targetProjectId = advancedModal.existingProjectId;
      if (!workspace.projects[targetProjectId]) {
        window.alert("請先選擇目標專案。");
        return;
      }

      mutateWorkspace((draft) => {
        let firstEntryId: string | null = null;
        for (const item of drafts) {
          const entryId = appendEntryDraft(draft, targetProjectId, null, item);
          if (!firstEntryId) {
            firstEntryId = entryId;
          }
        }

        draft.activeProjectId = targetProjectId;
        draft.activeChapterId = null;
        draft.selectedEntryId = firstEntryId;
      });

      setAdvancedModal((state) => ({ ...state, open: false }));
      return;
    }

    const targetChapter = workspace.chapters[advancedModal.existingChapterId];
    if (!targetChapter) {
      window.alert("請先選擇目標章節。");
      return;
    }

    mutateWorkspace((draft) => {
      const chapter = draft.chapters[targetChapter.id];
      if (!chapter) {
        return;
      }

      let firstEntryId: string | null = null;
      for (const item of drafts) {
        const entryId = appendEntryDraft(draft, chapter.projectId, chapter.id, item);
        if (!firstEntryId) {
          firstEntryId = entryId;
        }
      }

      draft.activeProjectId = chapter.projectId;
      draft.activeChapterId = chapter.id;
      draft.selectedEntryId = firstEntryId;
    });

    setAdvancedModal((state) => ({ ...state, open: false }));
  }

  function openMergeModal(): void {
    setMergeModal({
      open: true,
      mode: "as-new",
      selectedProjectIds: workspace.projectOrder.slice(0, Math.min(2, workspace.projectOrder.length)),
      newProjectTitle: "合併專案",
    });
  }

  function executeMerge(): void {
    const selectedIds = mergeModal.selectedProjectIds.filter((id) => Boolean(workspace.projects[id]));
    if (selectedIds.length === 0) {
      window.alert("請先選擇至少一個專案。");
      return;
    }

    if (mergeModal.mode === "into-active") {
      if (!activeProject) {
        window.alert("目前沒有可合併到的當前專案。");
        return;
      }

      const sourceIds = selectedIds.filter((id) => id !== activeProject.id);
      if (sourceIds.length === 0) {
        window.alert("請至少選擇一個非當前專案作為合併來源。");
        return;
      }

      const snapshots = sourceIds
        .map((projectId) => collectProjectSnapshot(workspace, projectId))
        .filter((snapshot): snapshot is ProjectSnapshot => Boolean(snapshot));

      mutateWorkspace((draft) => {
        let firstEntryId: string | null = null;
        for (const snapshot of snapshots) {
          const candidate = appendSnapshotToProject(draft, activeProject.id, snapshot, true);
          if (!firstEntryId && candidate) {
            firstEntryId = candidate;
          }
        }

        draft.activeProjectId = activeProject.id;
        draft.activeChapterId = null;
        if (firstEntryId) {
          draft.selectedEntryId = firstEntryId;
        }
      });

      setMergeModal((state) => ({ ...state, open: false }));
      return;
    }

    const snapshots = selectedIds
      .map((projectId) => collectProjectSnapshot(workspace, projectId))
      .filter((snapshot): snapshot is ProjectSnapshot => Boolean(snapshot));

    mutateWorkspace((draft) => {
      const projectId = createId("project");
      const title = ensureUniqueProjectTitle(draft, mergeModal.newProjectTitle.trim() || "合併專案");
      draft.projects[projectId] = {
        id: projectId,
        title,
        chapterIds: [],
        entryIds: [],
        createdAt: Date.now(),
      };
      draft.projectOrder.push(projectId);

      let firstEntryId: string | null = null;
      for (const snapshot of snapshots) {
        const candidate = appendSnapshotToProject(draft, projectId, snapshot, true);
        if (!firstEntryId && candidate) {
          firstEntryId = candidate;
        }
      }

      draft.activeProjectId = projectId;
      draft.activeChapterId = null;
      draft.selectedEntryId = firstEntryId;
    });

    setMergeModal((state) => ({ ...state, open: false }));
  }

  function openChapterMergeModal(): void {
    const allChapterIds = workspace.projectOrder.flatMap(
      (projectId) => workspace.projects[projectId]?.chapterIds ?? [],
    );
    const initialChapterIds =
      activeProject && activeProject.chapterIds.length > 0
        ? activeProject.chapterIds.slice(0, Math.min(2, activeProject.chapterIds.length))
        : allChapterIds.slice(0, Math.min(2, allChapterIds.length));

    setChapterMergeModal({
      open: true,
      selectedChapterIds: initialChapterIds,
      targetProjectId: activeProject?.id ?? workspace.projectOrder[0] ?? "",
      newChapterTitle: "合併章節",
    });
  }

  function executeChapterMerge(): void {
    if (!workspace.projects[chapterMergeModal.targetProjectId]) {
      window.alert("請先選擇目標專案。");
      return;
    }

    const selectedChapterIds = chapterMergeModal.selectedChapterIds.filter((chapterId) =>
      Boolean(workspace.chapters[chapterId]),
    );
    if (selectedChapterIds.length < 2) {
      window.alert("請至少選擇兩個章節。");
      return;
    }

    const drafts = selectedChapterIds.flatMap((chapterId) => {
      const chapter = workspace.chapters[chapterId];
      if (!chapter) {
        return [];
      }
      return chapter.entryIds
        .map((entryId) => workspace.entries[entryId])
        .filter((entry): entry is Entry => Boolean(entry))
        .map(entryToDraft);
    });

    if (drafts.length === 0) {
      window.alert("所選章節沒有可合併的史料。");
      return;
    }

    mutateWorkspace((draft) => {
      const chapterId = createId("chapter");
      const project = draft.projects[chapterMergeModal.targetProjectId];
      if (!project) {
        return;
      }

      draft.chapters[chapterId] = {
        id: chapterId,
        projectId: chapterMergeModal.targetProjectId,
        title: chapterMergeModal.newChapterTitle.trim() || "合併章節",
        entryIds: [],
        createdAt: Date.now(),
      };
      project.chapterIds.push(chapterId);

      let firstEntryId: string | null = null;
      for (const item of drafts) {
        const entryId = appendEntryDraft(draft, project.id, chapterId, item);
        if (!firstEntryId) {
          firstEntryId = entryId;
        }
      }

      draft.activeProjectId = project.id;
      draft.activeChapterId = chapterId;
      draft.selectedEntryId = firstEntryId;
    });

    setChapterMergeModal((state) => ({ ...state, open: false }));
  }

  async function exportWord(): Promise<void> {
    setIsExportingDocx(true);
    try {
      await exportAsDocx(workspace, exportScope);
    } finally {
      setIsExportingDocx(false);
    }
  }

  const desktopMeta = window.desktopMeta;
  const formModal = modalState && modalState.kind !== "entry-edit" ? modalState : null;
  const entryModal = modalState?.kind === "entry-edit" ? modalState : null;

  return (
    <>
      <div className="app-shell">
        <div className="ambient ambient-a" />
        <div className="ambient ambient-b" />

        <aside className="left-pane panel">
          <div className="pane-head">
            <h1>長編工作臺</h1>
            <p className="meta-text">
              {desktopMeta?.isDesktop ? `桌面模式 · ${desktopMeta.platform}` : "瀏覽器模式"}
            </p>
          </div>

          <button className="primary-btn" onClick={beginCreateProject}>
            + 新增專案
          </button>

          <div className="tool-row">
            <button
              className="ghost-btn"
              disabled={!activeProject}
              onClick={() => activeProject && copyCurrentProject(activeProject.id)}
            >
              複製當前專案
            </button>
            <button
              className="ghost-btn"
              disabled={clipboard?.kind !== "project"}
              onClick={pasteProjectFromClipboard}
            >
              粘貼專案
            </button>
          </div>

          <div className="tool-row">
            <button className="ghost-btn" onClick={openMergeModal}>
              合併專案
            </button>
            <button
              className="ghost-btn"
              disabled={Object.keys(workspace.chapters).length < 2}
              onClick={openChapterMergeModal}
            >
              合併章節
            </button>
          </div>

          <div className="sidebar-scroll">
            {workspace.projectOrder.map((projectId) => {
              const project = workspace.projects[projectId];
              if (!project) {
                return null;
              }

              const entryCount =
                project.entryIds.length +
                project.chapterIds.reduce((sum, chapterId) => {
                  const chapter = workspace.chapters[chapterId];
                  return sum + (chapter?.entryIds.length ?? 0);
                }, 0);

              const isProjectActive = activeProject?.id === project.id;
              const projectDropKey = `project:${project.id}`;
              const projectDragKey = `project:${project.id}`;

              return (
                <section
                  key={project.id}
                  className={`project-block ${isProjectActive ? "active" : ""} ${dropTargetKey === projectDropKey ? "drop-target" : ""}`}
                >
                  <div
                    className="project-row"
                    onDragOver={(event) => {
                      if (dragPayload?.type === "project") {
                        event.preventDefault();
                        configureMoveDrag(event);
                        setDropTargetKey(projectDropKey);
                      }
                    }}
                    onDrop={() => onProjectDrop(project.id)}
                  >
                    <span
                      className={`drag-handle ${draggingKey === projectDragKey ? "dragging" : ""}`}
                      draggable
                      onDragStart={(event) => {
                        configureMoveDrag(event);
                        setDragPayload({ type: "project", id: project.id });
                        setDraggingKey(projectDragKey);
                      }}
                      onDragEnd={clearDragState}
                    >
                      ⋮⋮
                    </span>

                    <button
                      className="project-main"
                      onClick={() => selectProject(project.id)}
                      onContextMenu={(event) => openProjectContextMenu(event, project.id)}
                      title="右鍵可編輯專案名"
                    >
                      <span className="project-title">{project.title}</span>
                      <span className="badge">{entryCount}</span>
                    </button>

                    <div className="row-actions">
                      <button
                        className="icon-btn danger"
                        title="刪除專案"
                        onClick={() => deleteProject(project.id)}
                      >
                        刪
                      </button>
                    </div>
                  </div>

                  <div className="chapter-stack">
                    {project.chapterIds.map((chapterId) => {
                      const chapter = workspace.chapters[chapterId];
                      if (!chapter) {
                        return null;
                      }

                      const isChapterActive = activeChapter?.id === chapter.id;
                      const chapterDropKey = `chapter:${chapter.id}`;
                      const chapterDragKey = `chapter:${chapter.id}`;

                      return (
                        <div
                          key={chapter.id}
                          className={`chapter-row ${isChapterActive ? "active" : ""} ${dropTargetKey === chapterDropKey ? "drop-target" : ""}`}
                          onDragOver={(event) => {
                            if (
                              dragPayload?.type === "chapter" &&
                              dragPayload.projectId === project.id
                            ) {
                              event.preventDefault();
                              configureMoveDrag(event);
                              setDropTargetKey(chapterDropKey);
                            }
                          }}
                          onDrop={() => onChapterDrop(project.id, chapter.id)}
                        >
                          <span
                            className={`drag-handle ${draggingKey === chapterDragKey ? "dragging" : ""}`}
                            draggable
                            onDragStart={(event) => {
                              configureMoveDrag(event);
                              setDragPayload({ type: "chapter", id: chapter.id, projectId: project.id });
                              setDraggingKey(chapterDragKey);
                            }}
                            onDragEnd={clearDragState}
                          >
                            ⋮
                          </span>

                          <button
                            className="chapter-main"
                            onClick={() => selectChapter(project.id, chapter.id)}
                          >
                            <span>{chapter.title}</span>
                            <span className="badge">{chapter.entryIds.length}</span>
                          </button>

                          <div className="row-actions">
                            <button
                              className="icon-btn"
                              title="改名"
                              onClick={() => beginRenameChapter(chapter.id)}
                            >
                              改
                            </button>
                            <button
                              className="icon-btn danger"
                              title="刪除"
                              onClick={() => deleteChapter(chapter.id)}
                            >
                              刪
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    <button className="ghost-btn" onClick={() => beginCreateChapter(project.id)}>
                      + 新增章節
                    </button>
                  </div>
                </section>
              );
            })}
          </div>
        </aside>

        <main className="center-pane panel">
          <header className="center-head">
            <div>
              <p className="eyebrow">當前專案</p>
              <h2>{activeProject?.title ?? "未選擇專案"}</h2>
              <p className="meta-text">
                {activeChapter ? `章節：${activeChapter.title}` : "未分章史料區"}
              </p>
            </div>
            <div className="head-actions">
              <button className="secondary-btn" onClick={createEntry} disabled={!activeProject}>
                + 新增史料
              </button>
              <button
                className="ghost-btn"
                onClick={pasteEntryFromClipboard}
                disabled={!activeProject || clipboard?.kind !== "entry"}
              >
                粘貼史料
              </button>
              <button
                className="ghost-btn"
                onClick={() => activeProject && beginCreateChapter(activeProject.id)}
                disabled={!activeProject}
              >
                + 新增章節
              </button>
            </div>
          </header>

          <section className="entry-list">
            {currentEntries.length === 0 ? (
              <div className="empty-state">
                <h3>尚無史料</h3>
                <p>可先建立章節或直接在當前層級新增史料。</p>
                <button className="secondary-btn" onClick={createEntry} disabled={!activeProject}>
                  立即新增
                </button>
              </div>
            ) : (
              currentEntries.map((entry) => {
                const isSelected = selectedEntry?.id === entry.id;
                const entryDragKey = `entry:${entry.id}`;
                const entryDropKey = `entry:${entry.id}`;
                const tags = extractTags(entry.note);

                return (
                  <article
                    key={entry.id}
                    className={`entry-card ${isSelected ? "selected" : ""} ${dropTargetKey === entryDropKey ? "drop-target" : ""}`}
                    onClick={() => {
                      mutateWorkspace((draft) => {
                        draft.selectedEntryId = entry.id;
                      });
                    }}
                    onDragOver={(event) => {
                      if (dragPayload?.type !== "entry") {
                        return;
                      }

                      const sameScope =
                        dragPayload.projectId === entry.projectId &&
                        dragPayload.chapterId === entry.chapterId;
                      if (!sameScope) {
                        return;
                      }

                      event.preventDefault();
                      configureMoveDrag(event);
                      setDropTargetKey(entryDropKey);
                    }}
                    onDrop={() => onEntryDrop(entry.id)}
                  >
                    <div className="entry-top">
                      <span
                        className={`drag-handle ${draggingKey === entryDragKey ? "dragging" : ""}`}
                        draggable
                        onDragStart={(event) => {
                          configureMoveDrag(event);
                          setDragPayload({
                            type: "entry",
                            id: entry.id,
                            projectId: entry.projectId,
                            chapterId: entry.chapterId,
                          });
                          setDraggingKey(entryDragKey);
                        }}
                        onDragEnd={clearDragState}
                        onClick={(event) => event.stopPropagation()}
                      >
                        ⋮⋮
                      </span>

                      <h3>{entry.timeText.trim() || "未著錄時間"}</h3>

                      <div className="entry-actions">
                        <button
                          className="icon-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            copyEntryToClipboard(entry.id);
                          }}
                        >
                          複製
                        </button>
                        <button
                          className="icon-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            beginEditEntry(entry.id);
                          }}
                        >
                          編輯
                        </button>
                        <button
                          className="icon-btn danger"
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteEntry(entry.id);
                          }}
                        >
                          刪除
                        </button>
                      </div>
                    </div>

                    <p className="entry-snippet">{summarize(entry.sourceText, 160) || "（尚未輸入史料文本）"}</p>
                    <p className="entry-citation">{summarize(entry.citation, 90) || "（尚未輸入引文註釋）"}</p>
                    {tags.length > 0 && (
                      <div className="tag-row">
                        {tags.map((tag) => (
                          <span key={`${entry.id}-${tag}`} className="tag-chip">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })
            )}

            <div
              className={`entry-drop-end ${dropTargetKey === "entry:end" ? "active" : ""}`}
              onDragOver={(event) => {
                if (!dragPayload || dragPayload.type !== "entry" || !activeProject) {
                  return;
                }

                const sameScope =
                  dragPayload.projectId === activeProject.id &&
                  dragPayload.chapterId === (activeChapter?.id ?? null);
                if (!sameScope) {
                  return;
                }

                event.preventDefault();
                configureMoveDrag(event);
                setDropTargetKey("entry:end");
              }}
              onDrop={onEntryDropToEnd}
            >
              拖到這裡可放到末尾
            </div>
          </section>
        </main>

        <aside className="right-pane panel">
          <section className="search-panel">
            <div className="search-head">
              <p className="eyebrow">全局檢索</p>
              <p className="meta-text">支持繁簡檢索 + #標籤過濾</p>
            </div>

            <input
              className="search-input"
              placeholder="檢索時間、史料文本、備註、引文註釋..."
              value={globalQuery}
              onChange={(event) => setGlobalQuery(event.target.value)}
            />

            <select
              className="search-input"
              value={selectedTag}
              onChange={(event) => setSelectedTag(event.target.value)}
            >
              <option value="">全部標籤（{allTags.length}）</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>

            <button className="ghost-btn advanced-launch" onClick={openAdvancedSearchModal}>
              高級檢索
            </button>

            <div className="search-results">
              <p className="result-meta">
                {hasSearch ? `共 ${searchResults.length} 條結果` : "請輸入關鍵詞或選擇標籤開始檢索"}
              </p>
              {hasSearch ? (
                searchResults.length === 0 ? (
                  <p className="empty-inline">未檢索到符合內容。</p>
                ) : (
                  searchResults.map((result) => (
                    <button
                      key={result.entryId}
                      className="search-item"
                      onClick={() => jumpToSearchResult(result)}
                    >
                      <div className="search-path">
                        {result.projectTitle} / {result.chapterTitle}
                      </div>
                      <div className="search-time">{result.timeText || "未著錄時間"}</div>
                      <div className="search-snippet">{result.snippet || "（無文本）"}</div>
                      <div className="search-citation">{result.citation || "（無引文註釋）"}</div>
                      {result.tags.length > 0 && (
                        <div className="tag-row">
                          {result.tags.map((tag) => (
                            <span key={`${result.entryId}-${tag}`} className="tag-chip">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))
                )
              ) : (
                <p className="empty-inline">檢索後可點結果跳轉到對應史料。</p>
              )}
            </div>
          </section>

          <section className="export-panel">
            <p className="eyebrow">匯出</p>

            <div className="scope-switch">
              <button
                className={exportScope === "active" ? "scope active" : "scope"}
                onClick={() => setExportScope("active")}
              >
                當前專案
              </button>
              <button
                className={exportScope === "all" ? "scope active" : "scope"}
                onClick={() => setExportScope("all")}
              >
                全部專案
              </button>
            </div>

            <div className="export-actions">
              <button className="secondary-btn" onClick={() => exportAsTxt(workspace, exportScope)}>
                匯出 TXT
              </button>
              <button className="secondary-btn" onClick={exportWord} disabled={isExportingDocx}>
                {isExportingDocx ? "匯出中..." : "匯出 Word"}
              </button>
              <button className="secondary-btn" onClick={() => exportAsXlsx(workspace, exportScope)}>
                匯出 Excel
              </button>
            </div>
          </section>
        </aside>
      </div>

      {projectMenu && (
        <div
          ref={projectMenuRef}
          className="context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
        >
          <button
            className="context-item"
            onClick={() => {
              beginRenameProject(projectMenu.projectId);
              setProjectMenu(null);
            }}
          >
            編輯專案名
          </button>
          <button
            className="context-item"
            onClick={() => {
              copyCurrentProject(projectMenu.projectId);
              setProjectMenu(null);
            }}
          >
            複製專案
          </button>
        </div>
      )}

      {formModal && (
        <div className="modal-backdrop" onMouseDown={() => setModalState(null)}>
          <div className="modal-card" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>
                {formModal.kind === "project-create" && "新增專案"}
                {formModal.kind === "project-rename" && "編輯專案名"}
                {formModal.kind === "chapter-create" && "新增章節"}
                {formModal.kind === "chapter-rename" && "編輯章節名"}
              </h3>
            </div>

            <label className="modal-label">
              名稱
              <input
                autoFocus
                value={formModal.value}
                onChange={(event) => {
                  const value = event.target.value;
                  setModalState((current) => {
                    if (!current || current.kind === "entry-edit") {
                      return current;
                    }
                    return { ...current, value };
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    applyFormModal();
                  }
                }}
              />
            </label>

            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => setModalState(null)}>
                取消
              </button>
              <button className="secondary-btn" onClick={applyFormModal}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {entryModal && (
        <div className="modal-backdrop" onMouseDown={() => setModalState(null)}>
          <div className="modal-card modal-large" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>編輯史料</h3>
              <p className="meta-text">四元素：時間 / 史料文本 / 備註 / 引文註釋；備註支持 `#標籤`。</p>
            </div>

            <div className="modal-grid">
              <label className="modal-label">
                時間（文本）
                <input
                  value={entryModal.draft.timeText}
                  onChange={(event) => {
                    const timeText = event.target.value;
                    setModalState((current) => {
                      if (!current || current.kind !== "entry-edit") {
                        return current;
                      }
                      return { ...current, draft: { ...current.draft, timeText } };
                    });
                  }}
                  placeholder="如：萬曆二十年春 / 1644年 / 未詳"
                />
              </label>

              <label className="modal-label">
                史料文本
                <textarea
                  rows={8}
                  value={entryModal.draft.sourceText}
                  onChange={(event) => {
                    const sourceText = event.target.value;
                    setModalState((current) => {
                      if (!current || current.kind !== "entry-edit") {
                        return current;
                      }
                      return { ...current, draft: { ...current.draft, sourceText } };
                    });
                  }}
                  placeholder="輸入原始史料文本..."
                />
              </label>

              <label className="modal-label">
                備註（支持 #標籤）
                <textarea
                  rows={5}
                  value={entryModal.draft.note}
                  onChange={(event) => {
                    const note = event.target.value;
                    setModalState((current) => {
                      if (!current || current.kind !== "entry-edit") {
                        return current;
                      }
                      return { ...current, draft: { ...current.draft, note } };
                    });
                  }}
                  placeholder="例如：#政治 #人物關係 #萬曆朝 ..."
                />
              </label>

              <label className="modal-label">
                引文註釋
                <textarea
                  rows={4}
                  value={entryModal.draft.citation}
                  onChange={(event) => {
                    const citation = event.target.value;
                    setModalState((current) => {
                      if (!current || current.kind !== "entry-edit") {
                        return current;
                      }
                      return { ...current, draft: { ...current.draft, citation } };
                    });
                  }}
                  placeholder="例如：某書卷X，頁Y；《明史》《資治通鑑》..."
                />
              </label>
            </div>

            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => setModalState(null)}>
                取消
              </button>
              <button className="secondary-btn" onClick={applyEntryEditor}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {advancedModal.open && (
        <div className="modal-backdrop" onMouseDown={() => setAdvancedModal((state) => ({ ...state, open: false }))}>
          <div className="modal-card modal-xl" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>高級檢索</h3>
              <p className="meta-text">按關鍵詞、標籤、引文檢索，並將結果導入到專案或章節。</p>
            </div>

            <div className="advanced-filter-grid">
              <label className="modal-label">
                關鍵詞
                <input
                  value={advancedModal.query}
                  onChange={(event) =>
                    setAdvancedModal((state) => ({ ...state, query: event.target.value }))
                  }
                  placeholder="檢索時間、史料文本、備註、引文註釋..."
                />
              </label>

              <label className="modal-label">
                標籤（可選）
                <input
                  list="advanced-tag-list"
                  value={advancedModal.tag}
                  onChange={(event) =>
                    setAdvancedModal((state) => ({ ...state, tag: event.target.value }))
                  }
                  placeholder="如：#人物、#政治"
                />
                <datalist id="advanced-tag-list">
                  {allTags.map((tag) => (
                    <option key={`advanced-${tag}`} value={tag} />
                  ))}
                </datalist>
              </label>

              <label className="modal-label">
                引文《》書名（可選）
                <input
                  value={advancedModal.citationTitle}
                  onChange={(event) =>
                    setAdvancedModal((state) => ({ ...state, citationTitle: event.target.value }))
                  }
                  placeholder="如：明史 / 資治通鑑"
                />
              </label>
            </div>

            <div className="advanced-results-head">
              <p className="result-meta">
                {hasAdvancedSearch
                  ? `共 ${advancedResults.length} 條結果`
                  : "請至少填一個檢索條件。"}
              </p>
              <button
                className="ghost-btn"
                onClick={() =>
                  setAdvancedModal((state) => ({
                    ...state,
                    query: "",
                    tag: "",
                    citationTitle: "",
                  }))
                }
              >
                清空條件
              </button>
            </div>

            <div className="advanced-results">
              {hasAdvancedSearch ? (
                advancedResults.length === 0 ? (
                  <p className="empty-inline">未檢索到符合內容。</p>
                ) : (
                  advancedResults.map((result) => {
                    const entry = workspace.entries[result.entryId];
                    return (
                      <button
                        key={`advanced-${result.entryId}`}
                        className="advanced-result"
                        onClick={() => jumpToSearchResult(result)}
                      >
                        <div className="search-path">
                          {result.projectTitle} / {result.chapterTitle}
                        </div>
                        <div className="search-time">{result.timeText || "未著錄時間"}</div>
                        <div className="advanced-source">
                          {entry?.sourceText.trim() || "（尚未輸入史料文本）"}
                        </div>
                        <div className="search-citation">
                          {entry?.citation.trim() || "（尚未輸入引文註釋）"}
                        </div>
                        {result.tags.length > 0 && (
                          <div className="tag-row">
                            {result.tags.map((tag) => (
                              <span key={`${result.entryId}-advanced-${tag}`} className="tag-chip">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })
                )
              ) : (
                <p className="empty-inline">輸入檢索條件後，結果會顯示在這裡。</p>
              )}
            </div>

            <section className="advanced-destination">
              <p className="eyebrow">結果導入</p>
              <div className="advanced-mode-grid">
                <button
                  className={advancedModal.targetMode === "new-project" ? "scope active" : "scope"}
                  onClick={() => setAdvancedModal((state) => ({ ...state, targetMode: "new-project" }))}
                >
                  新專案
                </button>
                <button
                  className={advancedModal.targetMode === "new-chapter" ? "scope active" : "scope"}
                  onClick={() => setAdvancedModal((state) => ({ ...state, targetMode: "new-chapter" }))}
                >
                  新章節
                </button>
                <button
                  className={advancedModal.targetMode === "existing-project" ? "scope active" : "scope"}
                  onClick={() => setAdvancedModal((state) => ({ ...state, targetMode: "existing-project" }))}
                >
                  既有專案
                </button>
                <button
                  className={advancedModal.targetMode === "existing-chapter" ? "scope active" : "scope"}
                  onClick={() =>
                    setAdvancedModal((state) => ({
                      ...state,
                      targetMode: "existing-chapter",
                      existingChapterId:
                        state.existingChapterId &&
                        workspace.chapters[state.existingChapterId]?.projectId === state.existingProjectId
                          ? state.existingChapterId
                          : workspace.projects[state.existingProjectId]?.chapterIds[0] ?? "",
                    }))
                  }
                >
                  既有章節
                </button>
              </div>

              {advancedModal.targetMode === "new-project" && (
                <label className="modal-label">
                  新專案名稱
                  <input
                    value={advancedModal.newProjectTitle}
                    onChange={(event) =>
                      setAdvancedModal((state) => ({ ...state, newProjectTitle: event.target.value }))
                    }
                  />
                </label>
              )}

              {advancedModal.targetMode !== "new-project" && (
                <label className="modal-label">
                  目標專案
                  <select
                    value={advancedModal.existingProjectId}
                    onChange={(event) => {
                      const projectId = event.target.value;
                      setAdvancedModal((state) => ({
                        ...state,
                        existingProjectId: projectId,
                        existingChapterId: workspace.projects[projectId]?.chapterIds[0] ?? "",
                      }));
                    }}
                  >
                    <option value="">請選擇專案</option>
                    {workspace.projectOrder.map((projectId) => {
                      const project = workspace.projects[projectId];
                      if (!project) {
                        return null;
                      }
                      return (
                        <option key={`advanced-project-${projectId}`} value={projectId}>
                          {project.title}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}

              {advancedModal.targetMode === "new-chapter" && (
                <label className="modal-label">
                  新章節名稱
                  <input
                    value={advancedModal.newChapterTitle}
                    onChange={(event) =>
                      setAdvancedModal((state) => ({ ...state, newChapterTitle: event.target.value }))
                    }
                  />
                </label>
              )}

              {advancedModal.targetMode === "existing-chapter" && (
                <label className="modal-label">
                  目標章節
                  <select
                    value={advancedModal.existingChapterId}
                    onChange={(event) =>
                      setAdvancedModal((state) => ({ ...state, existingChapterId: event.target.value }))
                    }
                  >
                    <option value="">請選擇章節</option>
                    {(workspace.projects[advancedModal.existingProjectId]?.chapterIds ?? []).map((chapterId) => {
                      const chapter = workspace.chapters[chapterId];
                      if (!chapter) {
                        return null;
                      }
                      return (
                        <option key={`advanced-chapter-${chapterId}`} value={chapterId}>
                          {chapter.title}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}
            </section>

            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => setAdvancedModal((state) => ({ ...state, open: false }))}>
                取消
              </button>
              <button
                className="secondary-btn"
                onClick={importAdvancedResults}
                disabled={!hasAdvancedSearch || advancedResults.length === 0}
              >
                導入檢索結果
              </button>
            </div>
          </div>
        </div>
      )}

      {mergeModal.open && (
        <div className="modal-backdrop" onMouseDown={() => setMergeModal((state) => ({ ...state, open: false }))}>
          <div className="modal-card modal-large" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>合併專案</h3>
              <p className="meta-text">可合併到當前專案，或合併並生成新的專案。</p>
            </div>

            <div className="merge-mode-row">
              <button
                className={mergeModal.mode === "as-new" ? "scope active" : "scope"}
                onClick={() => setMergeModal((state) => ({ ...state, mode: "as-new" }))}
              >
                合併為新專案
              </button>
              <button
                className={mergeModal.mode === "into-active" ? "scope active" : "scope"}
                onClick={() => setMergeModal((state) => ({ ...state, mode: "into-active" }))}
              >
                合併到當前專案
              </button>
            </div>

            {mergeModal.mode === "as-new" && (
              <label className="modal-label">
                新專案名稱
                <input
                  value={mergeModal.newProjectTitle}
                  onChange={(event) =>
                    setMergeModal((state) => ({ ...state, newProjectTitle: event.target.value }))
                  }
                />
              </label>
            )}

            <div className="merge-list">
              {workspace.projectOrder.map((projectId) => {
                const project = workspace.projects[projectId];
                if (!project) {
                  return null;
                }

                const checked = mergeModal.selectedProjectIds.includes(projectId);
                const disabled = mergeModal.mode === "into-active" && projectId === activeProject?.id;

                return (
                  <label key={projectId} className={`merge-item ${disabled ? "disabled" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={(event) => {
                        const next = new Set(mergeModal.selectedProjectIds);
                        if (event.target.checked) {
                          next.add(projectId);
                        } else {
                          next.delete(projectId);
                        }
                        setMergeModal((state) => ({ ...state, selectedProjectIds: [...next] }));
                      }}
                    />
                    <span>{project.title}</span>
                  </label>
                );
              })}
            </div>

            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => setMergeModal((state) => ({ ...state, open: false }))}>
                取消
              </button>
              <button className="secondary-btn" onClick={executeMerge}>
                執行合併
              </button>
            </div>
          </div>
        </div>
      )}

      {chapterMergeModal.open && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setChapterMergeModal((state) => ({ ...state, open: false }))}
        >
          <div className="modal-card modal-large" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>合併章節</h3>
              <p className="meta-text">選擇多個章節，合併為目標專案中的新章節（不刪除來源章節）。</p>
            </div>

            <label className="modal-label">
              目標專案
              <select
                value={chapterMergeModal.targetProjectId}
                onChange={(event) =>
                  setChapterMergeModal((state) => ({ ...state, targetProjectId: event.target.value }))
                }
              >
                <option value="">請選擇專案</option>
                {workspace.projectOrder.map((projectId) => {
                  const project = workspace.projects[projectId];
                  if (!project) {
                    return null;
                  }
                  return (
                    <option key={`chapter-merge-${projectId}`} value={projectId}>
                      {project.title}
                    </option>
                  );
                })}
              </select>
            </label>

            <label className="modal-label">
              新章節名稱
              <input
                value={chapterMergeModal.newChapterTitle}
                onChange={(event) =>
                  setChapterMergeModal((state) => ({ ...state, newChapterTitle: event.target.value }))
                }
              />
            </label>

            <div className="merge-list">
              {workspace.projectOrder.map((projectId) => {
                const project = workspace.projects[projectId];
                if (!project || project.chapterIds.length === 0) {
                  return null;
                }

                return (
                  <div key={`chapter-group-${projectId}`} className="merge-group">
                    <p className="merge-group-title">{project.title}</p>
                    {project.chapterIds.map((chapterId) => {
                      const chapter = workspace.chapters[chapterId];
                      if (!chapter) {
                        return null;
                      }
                      const checked = chapterMergeModal.selectedChapterIds.includes(chapterId);
                      return (
                        <label key={`chapter-select-${chapterId}`} className="merge-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              const next = new Set(chapterMergeModal.selectedChapterIds);
                              if (event.target.checked) {
                                next.add(chapterId);
                              } else {
                                next.delete(chapterId);
                              }
                              setChapterMergeModal((state) => ({ ...state, selectedChapterIds: [...next] }));
                            }}
                          />
                          <span>
                            {chapter.title}（{chapter.entryIds.length}）
                          </span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <div className="modal-actions">
              <button
                className="ghost-btn"
                onClick={() => setChapterMergeModal((state) => ({ ...state, open: false }))}
              >
                取消
              </button>
              <button className="secondary-btn" onClick={executeChapterMerge}>
                執行合併
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
