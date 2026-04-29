const path = require("path");
const OpenCC = require("opencc-js");

const TAG_REGEX = /#([^\s#，。；、,.;:!?！？【】（）()<>《》]+)/g;
const CITATION_TITLE_REGEX = /《([^》\n\r]+)》/g;
const SEARCH_REBUILD_DEBOUNCE_MS = 900;
const SEARCH_LIMIT_DEFAULT = 600;

const ALL_SCOPES = ["project", "chapter", "time", "summary", "source", "note", "citation"];

const SCOPE_COLUMN_MAP = Object.freeze({
  project: "project_variants",
  chapter: "chapter_variants",
  time: "time_variants",
  summary: "summary_variants",
  source: "source_variants",
  note: "note_variants",
  citation: "citation_variants",
});

let BetterSqlite3 = null;
try {
  BetterSqlite3 = require("better-sqlite3");
} catch {
  BetterSqlite3 = null;
}

let twToCnConverter = null;
let cnToTwConverter = null;
try {
  twToCnConverter = OpenCC.Converter({ from: "tw", to: "cn" });
  cnToTwConverter = OpenCC.Converter({ from: "cn", to: "tw" });
} catch {
  twToCnConverter = null;
  cnToTwConverter = null;
}

function cleanText(input) {
  const text = typeof input === "string" ? input : input == null ? "" : String(input);
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function buildVariants(input) {
  const base = cleanText(input);
  if (!base) {
    return [];
  }

  const variants = new Set([base]);
  if (twToCnConverter) {
    variants.add(cleanText(twToCnConverter(input)));
  }
  if (cnToTwConverter) {
    variants.add(cleanText(cnToTwConverter(input)));
  }
  return [...variants].filter(Boolean);
}

function joinVariants(input) {
  const variants = Array.isArray(input) ? input : buildVariants(input);
  if (!variants.length) {
    return "";
  }
  return variants.join("\n");
}

function summarizeText(input, maxChars) {
  const text = typeof input === "string" ? input : "";
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function extractTags(input) {
  const text = typeof input === "string" ? input : "";
  const tags = [];
  const seen = new Set();
  for (const match of text.matchAll(TAG_REGEX)) {
    const token = `#${(match[1] || "").trim()}`;
    if (!token || token === "#") {
      continue;
    }
    const lowered = token.toLocaleLowerCase();
    if (seen.has(lowered)) {
      continue;
    }
    seen.add(lowered);
    tags.push(token);
  }
  return tags;
}

function extractCitationTitles(input) {
  const text = typeof input === "string" ? input : "";
  const titles = [];
  const seen = new Set();
  for (const match of text.matchAll(CITATION_TITLE_REGEX)) {
    const title = (match[1] || "").trim();
    if (!title) {
      continue;
    }
    const key = title.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

function normalizeTagInput(input) {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function parseTagsToken(tokenText) {
  if (!tokenText || typeof tokenText !== "string") {
    return [];
  }
  return tokenText
    .split("|")
    .map((segment) => segment.trim())
    .filter((segment) => segment.startsWith("#"));
}

function buildTagsToken(tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return "";
  }
  const values = [];
  for (const tag of tags) {
    const text = typeof tag === "string" ? tag.trim().toLocaleLowerCase() : "";
    if (!text || !text.startsWith("#")) {
      continue;
    }
    values.push(text);
  }
  if (values.length === 0) {
    return "";
  }
  return `|${values.join("|")}|`;
}

function resolveSearchDbPath(workspaceFilePath) {
  const parsed = path.parse(workspaceFilePath);
  return path.join(parsed.dir, `${parsed.name}.fts5.sqlite`);
}

function iterateWorkspaceEntries(workspace) {
  const rows = [];
  if (!workspace || typeof workspace !== "object") {
    return rows;
  }
  const projectOrder = Array.isArray(workspace.projectOrder) ? workspace.projectOrder : [];
  const projects = workspace.projects && typeof workspace.projects === "object" ? workspace.projects : {};
  const chapters = workspace.chapters && typeof workspace.chapters === "object" ? workspace.chapters : {};
  const entries = workspace.entries && typeof workspace.entries === "object" ? workspace.entries : {};

  for (const projectId of projectOrder) {
    const project = projects[projectId];
    if (!project || typeof project !== "object") {
      continue;
    }

    const projectTitle = typeof project.title === "string" ? project.title : "";
    const directEntryIds = Array.isArray(project.entryIds) ? project.entryIds : [];
    for (const entryId of directEntryIds) {
      const entry = entries[entryId];
      if (!entry || typeof entry !== "object") {
        continue;
      }
      rows.push({
        entry,
        project,
        projectTitle,
        chapterId: null,
        chapterTitle: "未分章",
      });
    }

    const chapterIds = Array.isArray(project.chapterIds) ? project.chapterIds : [];
    for (const chapterId of chapterIds) {
      const chapter = chapters[chapterId];
      if (!chapter || typeof chapter !== "object") {
        continue;
      }
      const chapterTitle = typeof chapter.title === "string" ? chapter.title : "";
      const chapterEntryIds = Array.isArray(chapter.entryIds) ? chapter.entryIds : [];
      for (const entryId of chapterEntryIds) {
        const entry = entries[entryId];
        if (!entry || typeof entry !== "object") {
          continue;
        }
        rows.push({
          entry,
          project,
          projectTitle,
          chapterId,
          chapterTitle,
        });
      }
    }
  }

  return rows;
}

class SearchIndexService {
  constructor(options) {
    this.getWorkspaceFilePath = options.getWorkspaceFilePath;
    this.db = null;
    this.dbPath = "";
    this.enabled = Boolean(BetterSqlite3);
    this.ready = false;
    this.lastError = this.enabled ? "" : "better-sqlite3 未安裝或載入失敗";
    this.lastIndexedAt = 0;
    this.rowCount = 0;
    this.rebuildTimer = null;
    this.pendingWorkspace = null;
    this.schemaInitialized = false;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      ready: this.ready,
      dbPath: this.dbPath,
      rowCount: this.rowCount,
      lastIndexedAt: this.lastIndexedAt,
      message: this.lastError,
      backend: this.enabled ? "sqlite-fts5" : "memory-fallback",
    };
  }

  ensureDb() {
    if (!this.enabled) {
      return false;
    }

    const workspacePath = this.getWorkspaceFilePath();
    const nextDbPath = resolveSearchDbPath(workspacePath);

    if (this.db && this.dbPath !== nextDbPath) {
      this.close();
    }

    if (this.db) {
      return true;
    }

    try {
      this.dbPath = nextDbPath;
      this.db = new BetterSqlite3(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.initSchema();
      this.ready = true;
      this.lastError = "";
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "初始化 SQLite 失敗";
      this.ready = false;
      this.close();
      return false;
    }
  }

  close() {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close errors
      }
    }
    this.db = null;
    this.ready = false;
    this.schemaInitialized = false;
  }

  initSchema() {
    if (!this.db || this.schemaInitialized) {
      return;
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        entry_id UNINDEXED,
        project_id UNINDEXED,
        chapter_id UNINDEXED,
        project_title UNINDEXED,
        chapter_title UNINDEXED,
        time_text UNINDEXED,
        summary_text UNINDEXED,
        snippet UNINDEXED,
        citation_preview UNINDEXED,
        tags_token UNINDEXED,
        citation_titles_variants UNINDEXED,
        project_variants,
        chapter_variants,
        time_variants,
        summary_variants,
        source_variants,
        note_variants,
        citation_variants,
        tokenize='trigram',
        detail='none',
        columnsize=0
      );
    `);

    this.schemaInitialized = true;
  }

  invalidate() {
    this.ready = false;
  }

  scheduleRebuild(workspace) {
    if (!this.enabled) {
      return;
    }

    this.pendingWorkspace = workspace;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }

    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      const nextWorkspace = this.pendingWorkspace;
      this.pendingWorkspace = null;
      this.rebuild(nextWorkspace);
    }, SEARCH_REBUILD_DEBOUNCE_MS);
  }

  flushPendingRebuild() {
    if (!this.pendingWorkspace) {
      return;
    }
    const nextWorkspace = this.pendingWorkspace;
    this.pendingWorkspace = null;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.rebuild(nextWorkspace);
  }

  rebuild(workspace) {
    if (!this.enabled) {
      return false;
    }
    if (!this.ensureDb()) {
      return false;
    }

    try {
      const rows = iterateWorkspaceEntries(workspace);
      const insert = this.db.prepare(`
        INSERT INTO entries_fts (
          entry_id,
          project_id,
          chapter_id,
          project_title,
          chapter_title,
          time_text,
          summary_text,
          snippet,
          citation_preview,
          tags_token,
          citation_titles_variants,
          project_variants,
          chapter_variants,
          time_variants,
          summary_variants,
          source_variants,
          note_variants,
          citation_variants
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const transaction = this.db.transaction(() => {
        this.db.exec("DELETE FROM entries_fts;");
        for (const row of rows) {
          const entry = row.entry;
          const projectTitle = row.projectTitle || "";
          const chapterTitle = row.chapterTitle || "";
          const timeText = typeof entry.timeText === "string" ? entry.timeText : "";
          const summaryText = typeof entry.summary === "string" ? entry.summary : "";
          const sourceText = typeof entry.sourceText === "string" ? entry.sourceText : "";
          const noteText = typeof entry.note === "string" ? entry.note : "";
          const citationText = typeof entry.citation === "string" ? entry.citation : "";
          const tags = extractTags(noteText);
          const citationTitles = extractCitationTitles(citationText);
          const citationTitleVariants = citationTitles.flatMap((title) => buildVariants(title));

          insert.run(
            entry.id,
            row.project.id,
            row.chapterId || "",
            projectTitle,
            chapterTitle,
            timeText,
            summaryText,
            summarizeText(sourceText, 120),
            summarizeText(citationText, 80),
            buildTagsToken(tags),
            joinVariants(citationTitleVariants),
            joinVariants(projectTitle),
            joinVariants(chapterTitle),
            joinVariants(timeText),
            joinVariants(summaryText),
            joinVariants(sourceText),
            joinVariants(noteText),
            joinVariants(citationText),
          );
        }
      });

      transaction();
      this.lastIndexedAt = Date.now();
      this.rowCount = rows.length;
      this.ready = true;
      this.lastError = "";
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "重建索引失敗";
      this.ready = false;
      return false;
    }
  }

  buildQueryScopeColumns(queryScopes) {
    const scopes = Array.isArray(queryScopes) && queryScopes.length > 0 ? queryScopes : ALL_SCOPES;
    const columns = [];
    for (const scope of scopes) {
      if (typeof scope !== "string") {
        continue;
      }
      const column = SCOPE_COLUMN_MAP[scope];
      if (column) {
        columns.push(column);
      }
    }
    return columns.length > 0 ? columns : ALL_SCOPES.map((scope) => SCOPE_COLUMN_MAP[scope]);
  }

  search(criteria) {
    this.flushPendingRebuild();
    if (!this.enabled || !this.ensureDb() || !this.db) {
      return null;
    }

    const query = typeof criteria?.query === "string" ? criteria.query.trim() : "";
    const rawTag = typeof criteria?.tag === "string" ? criteria.tag : "";
    const normalizedTag = normalizeTagInput(rawTag).toLocaleLowerCase();
    const citationTitle = typeof criteria?.citationTitle === "string" ? criteria.citationTitle.trim() : "";

    if (!query && !normalizedTag && !citationTitle) {
      return [];
    }

    const limitRaw = Number(criteria?.limit ?? SEARCH_LIMIT_DEFAULT);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.floor(limitRaw))) : SEARCH_LIMIT_DEFAULT;

    const whereClauses = [];
    const params = [];

    if (query) {
      const queryVariants = buildVariants(query);
      if (queryVariants.length === 0) {
        return [];
      }
      const scopeColumns = this.buildQueryScopeColumns(criteria?.queryScopes);

      const variantGroups = [];
      for (const variant of queryVariants) {
        const columnChecks = [];
        for (const column of scopeColumns) {
          columnChecks.push(`${column} LIKE ?`);
          params.push(`%${variant}%`);
        }
        if (columnChecks.length > 0) {
          variantGroups.push(`(${columnChecks.join(" OR ")})`);
        }
      }

      if (variantGroups.length === 0) {
        return [];
      }
      whereClauses.push(`(${variantGroups.join(" OR ")})`);
    }

    if (normalizedTag) {
      whereClauses.push("instr(tags_token, ?) > 0");
      params.push(`|${normalizedTag}|`);
    }

    if (citationTitle) {
      const citationVariants = buildVariants(citationTitle);
      if (citationVariants.length === 0) {
        return [];
      }

      const checks = [];
      for (const variant of citationVariants) {
        checks.push("instr(citation_titles_variants, ?) > 0");
        params.push(variant);
        checks.push("citation_variants LIKE ?");
        params.push(`%${variant}%`);
      }
      whereClauses.push(`(${checks.join(" OR ")})`);
    }

    if (whereClauses.length === 0) {
      return [];
    }

    const sql = `
      SELECT
        entry_id,
        project_id,
        chapter_id,
        project_title,
        chapter_title,
        time_text,
        summary_text,
        snippet,
        citation_preview,
        tags_token
      FROM entries_fts
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY rowid ASC
      LIMIT ?
    `;

    params.push(limit);

    try {
      const statement = this.db.prepare(sql);
      const rows = statement.all(...params);
      return rows.map((row) => ({
        projectId: row.project_id,
        chapterId: row.chapter_id || null,
        entryId: row.entry_id,
        projectTitle: row.project_title,
        chapterTitle: row.chapter_title,
        timeText: row.time_text,
        summaryText: row.summary_text,
        snippet: row.snippet,
        citation: row.citation_preview,
        tags: parseTagsToken(row.tags_token),
      }));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "查詢失敗";
      return null;
    }
  }
}

module.exports = {
  SearchIndexService,
};
