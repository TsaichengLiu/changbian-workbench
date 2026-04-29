const path = require("path");
const OpenCC = require("opencc-js");

const TAG_REGEX = /#([^\s#，。；、,.;:!?！？【】（）()<>《》]+)/g;
const CITATION_TITLE_REGEX = /《([^》\n\r]+)》/g;
const SEARCH_REBUILD_DEBOUNCE_MS = 900;
const SEARCH_LIMIT_DEFAULT = 600;
const INCREMENTAL_REBUILD_THRESHOLD = 2400;

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

function getWorkspaceBucket(workspace, key) {
  const bucket = workspace && typeof workspace === "object" ? workspace[key] : null;
  return bucket && typeof bucket === "object" ? bucket : {};
}

function buildEntrySignature(entry) {
  return JSON.stringify([
    typeof entry.id === "string" ? entry.id : "",
    typeof entry.projectId === "string" ? entry.projectId : "",
    typeof entry.chapterId === "string" ? entry.chapterId : "",
    typeof entry.timeText === "string" ? entry.timeText : "",
    typeof entry.summary === "string" ? entry.summary : "",
    typeof entry.sourceText === "string" ? entry.sourceText : "",
    typeof entry.note === "string" ? entry.note : "",
    typeof entry.citation === "string" ? entry.citation : "",
  ]);
}

function resolveEntryContext(workspace, entryId) {
  const entries = getWorkspaceBucket(workspace, "entries");
  const projects = getWorkspaceBucket(workspace, "projects");
  const chapters = getWorkspaceBucket(workspace, "chapters");

  const rawEntry = entries[entryId];
  if (!rawEntry || typeof rawEntry !== "object") {
    return null;
  }

  const projectId = typeof rawEntry.projectId === "string" ? rawEntry.projectId : "";
  const project = projects[projectId];
  if (!project || typeof project !== "object") {
    return null;
  }

  const rawChapterId = typeof rawEntry.chapterId === "string" ? rawEntry.chapterId : "";
  const chapter = rawChapterId ? chapters[rawChapterId] : null;
  const chapterValid = Boolean(chapter && chapter.projectId === projectId);

  return {
    entryId: typeof rawEntry.id === "string" ? rawEntry.id : entryId,
    projectId,
    chapterId: chapterValid ? rawChapterId : "",
    projectTitle: typeof project.title === "string" ? project.title : "",
    chapterTitle: chapterValid && typeof chapter.title === "string" ? chapter.title : "未分章",
    timeText: typeof rawEntry.timeText === "string" ? rawEntry.timeText : "",
    summaryText: typeof rawEntry.summary === "string" ? rawEntry.summary : "",
    sourceText: typeof rawEntry.sourceText === "string" ? rawEntry.sourceText : "",
    noteText: typeof rawEntry.note === "string" ? rawEntry.note : "",
    citationText: typeof rawEntry.citation === "string" ? rawEntry.citation : "",
  };
}

function buildEntryIndexPayload(context) {
  const tags = extractTags(context.noteText);
  const citationTitles = extractCitationTitles(context.citationText);
  const citationTitleVariants = citationTitles.flatMap((title) => buildVariants(title));

  return {
    entryId: context.entryId,
    projectId: context.projectId,
    chapterId: context.chapterId,
    projectTitle: context.projectTitle,
    chapterTitle: context.chapterTitle,
    timeText: context.timeText,
    summaryText: context.summaryText,
    snippet: summarizeText(context.sourceText, 120),
    citationPreview: summarizeText(context.citationText, 80),
    tagsToken: buildTagsToken(tags),
    citationTitlesVariants: joinVariants(citationTitleVariants),
    projectVariants: joinVariants(context.projectTitle),
    chapterVariants: joinVariants(context.chapterTitle),
    timeVariants: joinVariants(context.timeText),
    summaryVariants: joinVariants(context.summaryText),
    sourceVariants: joinVariants(context.sourceText),
    noteVariants: joinVariants(context.noteText),
    citationVariants: joinVariants(context.citationText),
  };
}

function iterateWorkspaceEntryIds(workspace) {
  const entries = getWorkspaceBucket(workspace, "entries");
  const ids = [];
  for (const key of Object.keys(entries)) {
    const entry = entries[key];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const entryId = typeof entry.id === "string" ? entry.id : key;
    if (!entryId) {
      continue;
    }
    ids.push(entryId);
  }
  return ids;
}

function buildWorkspaceSnapshot(workspace) {
  const entries = getWorkspaceBucket(workspace, "entries");
  const projects = getWorkspaceBucket(workspace, "projects");
  const chapters = getWorkspaceBucket(workspace, "chapters");

  const entrySignatures = new Map();
  const entryProjectIds = new Map();
  const entryChapterIds = new Map();

  for (const key of Object.keys(entries)) {
    const entry = entries[key];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const entryId = typeof entry.id === "string" ? entry.id : key;
    if (!entryId) {
      continue;
    }
    entrySignatures.set(entryId, buildEntrySignature(entry));
    entryProjectIds.set(entryId, typeof entry.projectId === "string" ? entry.projectId : "");
    entryChapterIds.set(entryId, typeof entry.chapterId === "string" ? entry.chapterId : "");
  }

  const projectTitles = new Map();
  for (const projectId of Object.keys(projects)) {
    const project = projects[projectId];
    if (!project || typeof project !== "object") {
      continue;
    }
    projectTitles.set(projectId, typeof project.title === "string" ? project.title : "");
  }

  const chapterTitles = new Map();
  for (const chapterId of Object.keys(chapters)) {
    const chapter = chapters[chapterId];
    if (!chapter || typeof chapter !== "object") {
      continue;
    }
    chapterTitles.set(chapterId, typeof chapter.title === "string" ? chapter.title : "");
  }

  return {
    entrySignatures,
    entryProjectIds,
    entryChapterIds,
    projectTitles,
    chapterTitles,
  };
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
    this.statements = null;

    this.entrySignatures = new Map();
    this.entryProjectIds = new Map();
    this.entryChapterIds = new Map();
    this.projectTitles = new Map();
    this.chapterTitles = new Map();
    this.workspaceSnapshotReady = false;
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
      this.prepareStatements();
      this.rowCount = this.getMappedRowCount();
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
    this.statements = null;
    this.resetWorkspaceSnapshot();
  }

  resetWorkspaceSnapshot() {
    this.entrySignatures = new Map();
    this.entryProjectIds = new Map();
    this.entryChapterIds = new Map();
    this.projectTitles = new Map();
    this.chapterTitles = new Map();
    this.workspaceSnapshotReady = false;
  }

  applyWorkspaceSnapshot(snapshot) {
    this.entrySignatures = snapshot.entrySignatures;
    this.entryProjectIds = snapshot.entryProjectIds;
    this.entryChapterIds = snapshot.entryChapterIds;
    this.projectTitles = snapshot.projectTitles;
    this.chapterTitles = snapshot.chapterTitles;
    this.workspaceSnapshotReady = true;
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entry_row_map (
        entry_id TEXT PRIMARY KEY,
        rowid INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_row_map_rowid ON entry_row_map(rowid);
    `);

    this.schemaInitialized = true;
  }

  prepareStatements() {
    if (!this.db || this.statements) {
      return;
    }

    this.statements = {
      insertFts: this.db.prepare(`
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
      `),
      deleteFtsByRowid: this.db.prepare(`DELETE FROM entries_fts WHERE rowid = ?`),
      deleteFtsByEntryId: this.db.prepare(`DELETE FROM entries_fts WHERE entry_id = ?`),
      selectRowMap: this.db.prepare(`SELECT rowid FROM entry_row_map WHERE entry_id = ?`),
      upsertRowMap: this.db.prepare(`
        INSERT INTO entry_row_map (entry_id, rowid)
        VALUES (?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET rowid = excluded.rowid
      `),
      deleteRowMap: this.db.prepare(`DELETE FROM entry_row_map WHERE entry_id = ?`),
      clearRowMap: this.db.prepare(`DELETE FROM entry_row_map`),
      countRowMap: this.db.prepare(`SELECT COUNT(*) AS count FROM entry_row_map`),
    };
  }

  getMappedRowCount() {
    if (!this.statements) {
      return 0;
    }
    const row = this.statements.countRowMap.get();
    return Number(row?.count ?? 0);
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

  deleteEntryRow(entryId) {
    if (!this.statements) {
      return;
    }

    const existing = this.statements.selectRowMap.get(entryId);
    if (existing && Number.isFinite(existing.rowid)) {
      this.statements.deleteFtsByRowid.run(existing.rowid);
      this.statements.deleteRowMap.run(entryId);
      return;
    }

    this.statements.deleteFtsByEntryId.run(entryId);
    this.statements.deleteRowMap.run(entryId);
  }

  upsertEntryRowFromWorkspace(workspace, entryId) {
    if (!this.statements) {
      return;
    }

    this.deleteEntryRow(entryId);

    const context = resolveEntryContext(workspace, entryId);
    if (!context) {
      return;
    }

    const payload = buildEntryIndexPayload(context);
    const result = this.statements.insertFts.run(
      payload.entryId,
      payload.projectId,
      payload.chapterId,
      payload.projectTitle,
      payload.chapterTitle,
      payload.timeText,
      payload.summaryText,
      payload.snippet,
      payload.citationPreview,
      payload.tagsToken,
      payload.citationTitlesVariants,
      payload.projectVariants,
      payload.chapterVariants,
      payload.timeVariants,
      payload.summaryVariants,
      payload.sourceVariants,
      payload.noteVariants,
      payload.citationVariants,
    );

    const rowid = Number(result.lastInsertRowid);
    this.statements.upsertRowMap.run(payload.entryId, rowid);
  }

  rebuild(workspace) {
    if (!this.enabled) {
      return false;
    }
    if (!this.ensureDb() || !this.db || !this.statements) {
      return false;
    }

    try {
      const entryIds = iterateWorkspaceEntryIds(workspace);
      const transaction = this.db.transaction(() => {
        this.db.exec("DELETE FROM entries_fts;");
        this.statements.clearRowMap.run();

        for (const entryId of entryIds) {
          this.upsertEntryRowFromWorkspace(workspace, entryId);
        }
      });

      transaction();
      this.lastIndexedAt = Date.now();
      this.rowCount = this.getMappedRowCount();
      this.ready = true;
      this.lastError = "";
      this.applyWorkspaceSnapshot(buildWorkspaceSnapshot(workspace));
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "重建索引失敗";
      this.ready = false;
      return false;
    }
  }

  syncWorkspace(workspace) {
    if (!this.enabled) {
      return false;
    }
    if (!this.ensureDb() || !this.db || !this.statements) {
      return false;
    }

    if (!workspace || typeof workspace !== "object") {
      return false;
    }

    const nextSnapshot = buildWorkspaceSnapshot(workspace);

    if (!this.workspaceSnapshotReady) {
      return this.rebuild(workspace);
    }

    const removedEntryIds = [];
    for (const entryId of this.entrySignatures.keys()) {
      if (!nextSnapshot.entrySignatures.has(entryId)) {
        removedEntryIds.push(entryId);
      }
    }

    const renamedProjectIds = new Set();
    for (const [projectId, title] of nextSnapshot.projectTitles.entries()) {
      if (this.projectTitles.has(projectId) && this.projectTitles.get(projectId) !== title) {
        renamedProjectIds.add(projectId);
      }
    }

    const renamedChapterIds = new Set();
    for (const [chapterId, title] of nextSnapshot.chapterTitles.entries()) {
      if (this.chapterTitles.has(chapterId) && this.chapterTitles.get(chapterId) !== title) {
        renamedChapterIds.add(chapterId);
      }
    }

    const upsertEntrySet = new Set();
    for (const [entryId, signature] of nextSnapshot.entrySignatures.entries()) {
      const prevSignature = this.entrySignatures.get(entryId);
      if (!prevSignature || prevSignature !== signature) {
        upsertEntrySet.add(entryId);
        continue;
      }

      const projectId = nextSnapshot.entryProjectIds.get(entryId);
      const chapterId = nextSnapshot.entryChapterIds.get(entryId);
      if ((projectId && renamedProjectIds.has(projectId)) || (chapterId && renamedChapterIds.has(chapterId))) {
        upsertEntrySet.add(entryId);
      }
    }

    const changesCount = removedEntryIds.length + upsertEntrySet.size;
    if (changesCount === 0) {
      this.applyWorkspaceSnapshot(nextSnapshot);
      this.ready = true;
      this.lastError = "";
      return true;
    }

    if (changesCount >= INCREMENTAL_REBUILD_THRESHOLD) {
      return this.rebuild(workspace);
    }

    try {
      const upsertEntryIds = [...upsertEntrySet];
      const transaction = this.db.transaction(() => {
        for (const entryId of removedEntryIds) {
          this.deleteEntryRow(entryId);
        }
        for (const entryId of upsertEntryIds) {
          this.upsertEntryRowFromWorkspace(workspace, entryId);
        }
      });

      transaction();
      this.lastIndexedAt = Date.now();
      this.rowCount = this.getMappedRowCount();
      this.ready = true;
      this.lastError = "";
      this.applyWorkspaceSnapshot(nextSnapshot);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "增量索引更新失敗";
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
