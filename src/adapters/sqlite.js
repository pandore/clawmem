/**
 * sqlite.js — Generic SQLite adapter for reading messages from any SQLite database.
 *
 * Configuration:
 *   {
 *     path: '/path/to/chat.db',
 *     table: 'messages',
 *     columns: {
 *       id: 'message_id',        // unique message identifier (used for cursor)
 *       content: 'content',      // message text
 *       sender: 'sender_name',   // who sent it (optional if embedded in content)
 *       timestamp: 'created_at', // when (optional)
 *       role: 'role',            // filter column (optional)
 *     },
 *     filter: "role = 'user'",   // optional WHERE clause to filter messages
 *     contentParser: null,       // optional function(rawContent) => { sender, content, timestamp }
 *   }
 */

const { createDriver, dbExists, esc } = require('../driver');

function create(config) {
  const {
    path: dbPath,
    table = 'messages',
    columns = {},
    filter = null,
    contentParser = null,
    conversationFilter = null,
  } = config;

  const idCol = columns.id || 'id';
  const contentCol = columns.content || 'content';
  const senderCol = columns.sender || null;
  const timestampCol = columns.timestamp || null;

  // Lazily-created driver for this source DB
  let _driver = null;
  function getDriver() {
    if (!_driver) _driver = createDriver(dbPath);
    return _driver;
  }

  // Cache detected group conversation IDs
  let _groupConvIds = null;

  function detectGroupConversations() {
    if (_groupConvIds !== null) return _groupConvIds;
    if (!conversationFilter?.detectGroup) {
      _groupConvIds = null;
      return null;
    }

    const { contentColumn, marker } = conversationFilter.detectGroup;
    const convCol = conversationFilter.column || 'conversation_id';
    const col = contentColumn || contentCol;

    const stats = getDriver().read(
      `SELECT ${convCol}, COUNT(*) as total, SUM(CASE WHEN ${col} LIKE '%${esc(marker)}%true%' THEN 1 ELSE 0 END) as group_msgs FROM ${table} GROUP BY ${convCol}`
    );

    _groupConvIds = stats
      .filter(c => parseInt(c.group_msgs) > parseInt(c.total) * 0.5)
      .map(c => c[convCol]);

    return _groupConvIds;
  }

  return {
    name: 'sqlite',

    validate() {
      if (!dbExists(dbPath)) {
        return { ok: false, error: `Database not found: ${dbPath}` };
      }

      const tables = getDriver().read("SELECT name FROM sqlite_master WHERE type='table'");
      const tableNames = tables.map(t => t.name);

      if (!tableNames.includes(table)) {
        return { ok: false, error: `Table '${table}' not found. Available: ${tableNames.join(', ')}` };
      }

      // Detect group conversations if configured
      const groupIds = detectGroupConversations();
      if (conversationFilter?.detectGroup && (!groupIds || groupIds.length === 0)) {
        return { ok: false, error: 'No group conversations detected in source database' };
      }

      return { ok: true, groupConversations: groupIds };
    },

    getMessages(afterId) {
      let where = `${idCol} > '${esc(String(afterId))}'`;
      if (filter) where += ` AND (${filter})`;

      // Apply conversation filter
      const groupIds = detectGroupConversations();
      if (groupIds && groupIds.length > 0) {
        const convCol = conversationFilter.column || 'conversation_id';
        const idList = groupIds.map(id => `${convCol} = '${esc(String(id))}'`).join(' OR ');
        where += ` AND (${idList})`;
      }

      const selectCols = [idCol, contentCol];
      if (senderCol) selectCols.push(senderCol);
      if (timestampCol) selectCols.push(timestampCol);

      const query = `SELECT ${selectCols.join(', ')} FROM ${table} WHERE ${where} ORDER BY ${idCol} ASC`;
      const rows = getDriver().read(query);

      return rows.map(row => {
        if (contentParser) {
          const parsed = contentParser(row[contentCol] || '');
          return {
            id: row[idCol],
            content: parsed.content || row[contentCol],
            sender: parsed.sender || (senderCol ? row[senderCol] : 'unknown'),
            timestamp: parsed.timestamp || (timestampCol ? row[timestampCol] : ''),
          };
        }

        return {
          id: row[idCol],
          content: row[contentCol] || '',
          sender: senderCol ? (row[senderCol] || 'unknown') : 'unknown',
          timestamp: timestampCol ? (row[timestampCol] || '') : '',
        };
      }).filter(m => m.content && m.content.length > 0);
    },

    describe() {
      const cols = getDriver().read(`PRAGMA table_info(${table})`);
      return {
        path: dbPath,
        table,
        columns: cols.map(c => c.name),
        mapping: { id: idCol, content: contentCol, sender: senderCol, timestamp: timestampCol },
      };
    },
  };
}

module.exports = { create };
