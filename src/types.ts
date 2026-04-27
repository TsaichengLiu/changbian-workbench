export interface Entry {
  id: string;
  projectId: string;
  chapterId: string | null;
  timeText: string;
  sourceText: string;
  note: string;
  citation: string;
  createdAt: number;
  updatedAt: number;
}

export interface Chapter {
  id: string;
  projectId: string;
  title: string;
  entryIds: string[];
  createdAt: number;
}

export interface Project {
  id: string;
  title: string;
  chapterIds: string[];
  entryIds: string[];
  createdAt: number;
}

export interface WorkspaceData {
  projectOrder: string[];
  projects: Record<string, Project>;
  chapters: Record<string, Chapter>;
  entries: Record<string, Entry>;
  activeProjectId: string | null;
  activeChapterId: string | null;
  selectedEntryId: string | null;
}

export interface OrderedEntryRef {
  entry: Entry;
  project: Project;
  chapter: Chapter | null;
  order: number;
}
