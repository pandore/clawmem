/**
 * jsonl.js — JSONL file adapter for reading messages.
 *
 * Reads a file where each line is a JSON object:
 *   { "id": "1", "sender": "Alice", "content": "Hello!", "timestamp": "2026-01-01T10:00:00Z" }
 *
 * Configuration:
 *   {
 *     path: '/path/to/messages.jsonl',
 *     fields: {
 *       id: 'id',
 *       content: 'content',
 *       sender: 'sender',
 *       timestamp: 'timestamp',
 *     }
 *   }
 */

const fs = require('fs');

function create(config) {
  const {
    path: filePath,
    fields = {},
  } = config;

  const idField = fields.id || 'id';
  const contentField = fields.content || 'content';
  const senderField = fields.sender || 'sender';
  const timestampField = fields.timestamp || 'timestamp';
  const conversationField = fields.conversationId || fields.conversation || null;

  return {
    name: 'jsonl',

    validate() {
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `File not found: ${filePath}` };
      }
      return { ok: true };
    },

    getMessages(afterId) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim());
      const afterIdStr = String(afterId);

      let pastCursor = afterIdStr === '0';
      const messages = [];

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const id = String(obj[idField] || '');

          if (!pastCursor) {
            if (id === afterIdStr) pastCursor = true;
            continue;
          }

          messages.push({
            id,
            content: obj[contentField] || '',
            sender: obj[senderField] || 'unknown',
            timestamp: obj[timestampField] || '',
            conversationId: conversationField ? (obj[conversationField] || null) : null,
          });
        } catch {}
      }

      return messages.filter(m => m.content.length > 0);
    },

    describe() {
      return {
        path: filePath,
        format: 'jsonl',
        mapping: { id: idField, content: contentField, sender: senderField, timestamp: timestampField },
      };
    },
  };
}

module.exports = { create };
