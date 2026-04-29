import { buildVariants } from "./search";
import type { WorkspaceData } from "./types";
import { summarize } from "./utils";

const TAG_REGEX = /#([^\s#，。；、,.;:!?！？【】（）()<>《》]+)/g;
const CITATION_TITLE_REGEX = /《([^》\n\r]+)》/g;

export type SearchScope =
  | "project"
  | "chapter"
  | "time"
  | "summary"
  | "source"
  | "note"
  | "citation";

export interface SearchResult {
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

export interface SearchCriteria {
  query: string;
  queryScopes?: SearchScope[];
  tag: string;
  citationTitle: string;
}

export interface IndexedEntry extends SearchResult {
  scopeVariants: Record<SearchScope, string[]>;
  tagLowerSet: string[];
  citationTitleVariants: string[];
  citationVariants: string[];
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

function normalizeTagInput(tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function matchesVariants(haystackVariants: string[], queryVariants: string[]): boolean {
  if (queryVariants.length === 0) {
    return true;
  }
  return queryVariants.some((queryVariant) =>
    haystackVariants.some((haystackVariant) => haystackVariant.includes(queryVariant)),
  );
}

function flattenUniqueVariants(values: string[]): string[] {
  const variants = new Set<string>();
  for (const value of values) {
    for (const variant of buildVariants(value)) {
      if (variant) {
        variants.add(variant);
      }
    }
  }
  return [...variants];
}

function toIndexedEntry(
  projectId: string,
  chapterId: string | null,
  entryId: string,
  projectTitle: string,
  chapterTitle: string,
  timeText: string,
  summaryText: string,
  sourceText: string,
  note: string,
  citationText: string,
): IndexedEntry {
  const tags = extractTags(note);
  return {
    projectId,
    chapterId,
    entryId,
    projectTitle,
    chapterTitle,
    timeText,
    summaryText,
    snippet: summarize(sourceText, 120),
    citation: summarize(citationText, 80),
    tags,
    scopeVariants: {
      project: buildVariants(projectTitle),
      chapter: buildVariants(chapterTitle),
      time: buildVariants(timeText),
      summary: buildVariants(summaryText),
      source: buildVariants(sourceText),
      note: buildVariants(note),
      citation: buildVariants(citationText),
    },
    tagLowerSet: tags.map((tag) => tag.toLocaleLowerCase()),
    citationTitleVariants: flattenUniqueVariants(extractCitationTitles(citationText)),
    citationVariants: buildVariants(citationText),
  };
}

export function buildSearchIndex(workspace: WorkspaceData): IndexedEntry[] {
  const output: IndexedEntry[] = [];

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
      output.push(
        toIndexedEntry(
          project.id,
          null,
          entry.id,
          project.title,
          "未分章",
          entry.timeText,
          entry.summary,
          entry.sourceText,
          entry.note,
          entry.citation,
        ),
      );
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
        output.push(
          toIndexedEntry(
            project.id,
            chapter.id,
            entry.id,
            project.title,
            chapter.title,
            entry.timeText,
            entry.summary,
            entry.sourceText,
            entry.note,
            entry.citation,
          ),
        );
      }
    }
  }

  return output;
}

export function searchInIndex(index: IndexedEntry[], criteria: SearchCriteria): SearchResult[] {
  const query = criteria.query.trim();
  const normalizedTag = normalizeTagInput(criteria.tag).toLocaleLowerCase();
  const citationTitle = criteria.citationTitle.trim();
  const queryScopes: SearchScope[] = criteria.queryScopes ?? [
    "project",
    "chapter",
    "time",
    "summary",
    "source",
    "note",
    "citation",
  ];

  if (!query && !normalizedTag && !citationTitle) {
    return [];
  }

  const queryVariants = buildVariants(query);
  const citationTitleVariants = buildVariants(citationTitle);
  const results: SearchResult[] = [];

  for (const item of index) {
    const queryPass = query
      ? queryScopes.some((scope) => matchesVariants(item.scopeVariants[scope], queryVariants))
      : true;
    if (!queryPass) {
      continue;
    }

    const tagPass = normalizedTag ? item.tagLowerSet.includes(normalizedTag) : true;
    if (!tagPass) {
      continue;
    }

    const citationPass = citationTitle
      ? matchesVariants(item.citationTitleVariants, citationTitleVariants) ||
        matchesVariants(item.citationVariants, citationTitleVariants)
      : true;
    if (!citationPass) {
      continue;
    }

    results.push({
      projectId: item.projectId,
      chapterId: item.chapterId,
      entryId: item.entryId,
      projectTitle: item.projectTitle,
      chapterTitle: item.chapterTitle,
      timeText: item.timeText,
      summaryText: item.summaryText,
      snippet: item.snippet,
      citation: item.citation,
      tags: item.tags,
    });
  }

  return results;
}
