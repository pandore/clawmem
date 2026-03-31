'use strict';

const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const store = require('./store');
const { assembleContext } = require('./context');
const searchModule = require('./search');
const pkg = require('../package.json');

/**
 * Create tool handlers bound to a driver and config.
 * Exported for unit testing without MCP protocol overhead.
 *
 * @param {object} driver - BetterSqliteDriver instance
 * @param {object} config - Lizardbrain config
 * @returns {object} handler functions keyed by tool name
 */
function createHandlers(driver, config) {
  return {
    async get_context(args) {
      try {
        const data = assembleContext(driver, {
          participants: args.participants || [],
          topics: args.topics || [],
          recencyDays: args.recencyDays,
          tokenBudget: args.tokenBudget,
        });
        return { isError: false, data };
      } catch (e) {
        return { isError: true, error: e.message };
      }
    },

    async search(args) {
      try {
        if (!args.query) {
          return { isError: false, data: { mode: 'fts5', results: [] } };
        }
        const raw = await searchModule.search(driver, args.query, {
          limit: (args.types ? (args.limit || 10) * 3 : args.limit) || 10,
          ftsOnly: args.ftsOnly || false,
          embeddingConfig: config?.embedding?.enabled ? config.embedding : null,
        });
        let results = raw.results.map(r => ({
          type: r.source,
          id: r.id,
          text: r.text,
          score: r.score,
        }));
        if (args.types && args.types.length > 0) {
          results = results.filter(r => args.types.includes(r.type));
        }
        results = results.slice(0, args.limit || 10);
        return { isError: false, data: { mode: raw.mode, results } };
      } catch (e) {
        return { isError: true, error: e.message };
      }
    },

    async who_knows(args) {
      try {
        const members = store.whoKnows(driver, args.topic);
        return {
          isError: false,
          data: {
            members: members.map(m => ({
              name: m.display_name,
              expertise: m.expertise,
              projects: m.projects,
            })),
          },
        };
      } catch (e) {
        return { isError: true, error: e.message };
      }
    },

    async get_stats(args) {
      try {
        const stats = store.getStats(driver);
        return {
          isError: false,
          data: {
            members: stats.members,
            facts: stats.facts,
            topics: stats.topics,
            decisions: stats.decisions,
            tasks: stats.tasks,
            questions: stats.questions,
            events: stats.events,
          },
        };
      } catch (e) {
        return { isError: true, error: e.message };
      }
    },

    async add_knowledge(args) {
      try {
        const extracted = {};
        for (const key of ['facts', 'decisions', 'tasks', 'members', 'topics', 'questions', 'events']) {
          if (args[key]) extracted[key] = args[key];
        }
        const messageDate = new Date().toISOString();
        const counts = store.processExtraction(driver, extracted, messageDate, {
          sourceAgent: args.sourceAgent || null,
        });
        return {
          isError: false,
          data: {
            inserted: {
              facts: counts.totalFacts,
              decisions: counts.totalDecisions,
              tasks: counts.totalTasks,
              members: counts.totalMembers,
              topics: counts.totalTopics,
              questions: counts.totalQuestions,
              events: counts.totalEvents,
            },
          },
        };
      } catch (e) {
        return { isError: true, error: e.message };
      }
    },

    async ingest(args) {
      try {
        if (!config?.llm?.baseUrl || !config?.llm?.apiKey || !config?.llm?.model) {
          return { isError: true, error: 'LLM not configured. Set llm.baseUrl, llm.apiKey, and llm.model in lizardbrain.json.' };
        }
        const { extractFromText } = require('./llm');
        const { getProfile } = require('./profiles');
        const profileConfig = getProfile(args.profile || config.profile || 'knowledge');
        const extracted = await extractFromText(args.text, config, profileConfig);
        const messageDate = new Date().toISOString();
        const counts = store.processExtraction(driver, extracted, messageDate, {
          sourceAgent: args.sourceAgent || null,
        });
        return {
          isError: false,
          data: {
            extracted: {
              facts: counts.totalFacts,
              decisions: counts.totalDecisions,
              tasks: counts.totalTasks,
              members: counts.totalMembers,
              topics: counts.totalTopics,
              questions: counts.totalQuestions,
              events: counts.totalEvents,
            },
          },
        };
      } catch (e) {
        return { isError: true, error: e.message };
      }
    },

    async update_entity(args) {
      try {
        const { type, id } = args;

        if (type === 'decision') {
          if (!args.status) {
            return { isError: true, error: 'decision requires status field (proposed, agreed, revisited)' };
          }
          const ok = store.updateDecisionStatus(driver, id, args.status, args.context || null);
          if (!ok) return { isError: true, error: `Failed to update decision ${id}. Check id and status value.` };
          return { isError: false, data: { updated: true } };
        }

        if (type === 'task') {
          if (!args.status) {
            return { isError: true, error: 'task requires status field (open, done, blocked)' };
          }
          const ok = store.updateTaskStatus(driver, id, args.status);
          if (!ok) return { isError: true, error: `Failed to update task ${id}. Check id and status value.` };
          return { isError: false, data: { updated: true } };
        }

        if (type === 'question') {
          if (!args.answer) {
            return { isError: true, error: 'question requires answer field' };
          }
          if (!args.answeredBy) {
            return { isError: true, error: 'question requires answeredBy field' };
          }
          const ok = store.updateQuestionAnswer(driver, id, args.answer, args.answeredBy || '');
          if (!ok) return { isError: true, error: `Failed to update question ${id}. Check id exists.` };
          return { isError: false, data: { updated: true } };
        }

        return { isError: true, error: 'Unknown type. Must be decision, task, or question.' };
      } catch (e) {
        return { isError: true, error: e.message };
      }
    },
  };
}

/**
 * Create an MCP server instance.
 *
 * @param {object} options
 * @param {object} options.driver - BetterSqliteDriver instance
 * @param {object} [options.config] - Lizardbrain config
 * @returns {object} { server, connect, close }
 */
function createServer({ driver, config = {} }) {
  const server = new McpServer({
    name: 'lizardbrain',
    version: pkg.version,
  });

  const handlers = createHandlers(driver, config);

  // --- Read tools ---

  server.tool(
    'get_context',
    'Get assembled context for a conversation. Returns participant profiles, relevant facts, decisions, tasks, and questions — scored by relevance and recency, truncated to token budget.',
    {
      participants: z.array(z.string()).optional().describe('Member names/usernames to load profiles for'),
      topics: z.array(z.string()).optional().describe('Topic keywords to load relevant knowledge for'),
      recencyDays: z.number().optional().describe('How far back to look (default: 30)'),
      tokenBudget: z.number().optional().describe('Max output size in tokens (default: 1000, range: 100-10000)'),
    },
    async (args) => {
      const result = await handlers.get_context(args);
      if (result.isError) {
        return { content: [{ type: 'text', text: result.error }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    'search',
    'Search across all knowledge types (facts, decisions, tasks, questions, members, topics, events). Uses hybrid FTS5 + vector search when available.',
    {
      query: z.string().describe('Search query'),
      types: z.array(z.string()).optional().describe('Filter to entity types, e.g. ["fact", "decision"]'),
      limit: z.number().optional().describe('Max results (default: 10)'),
      ftsOnly: z.boolean().optional().describe('Skip vector search (default: false)'),
    },
    async (args) => {
      const result = await handlers.search(args);
      if (result.isError) {
        return { content: [{ type: 'text', text: result.error }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    'who_knows',
    'Find people by expertise or project involvement.',
    {
      topic: z.string().describe('Topic, skill, or keyword to find experts for'),
    },
    async (args) => {
      const result = await handlers.who_knows(args);
      if (result.isError) {
        return { content: [{ type: 'text', text: result.error }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    'get_stats',
    'Get knowledge base statistics — counts of each entity type.',
    {},
    async () => {
      const result = await handlers.get_stats({});
      if (result.isError) {
        return { content: [{ type: 'text', text: result.error }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // --- Write tools ---

  server.tool(
    'add_knowledge',
    'Add structured knowledge. Runs through dedup pipeline — duplicates are silently skipped.',
    {
      facts: z.array(z.object({
        content: z.string(),
        category: z.string().optional(),
        source_member: z.string().optional(),
        tags: z.string().optional(),
        confidence: z.number().optional(),
      })).optional().describe('Facts to add'),
      decisions: z.array(z.object({
        description: z.string(),
        participants: z.string().optional(),
        context: z.string().optional(),
        status: z.string().optional(),
        tags: z.string().optional(),
      })).optional().describe('Decisions to add'),
      tasks: z.array(z.object({
        description: z.string(),
        assignee: z.string().optional(),
        deadline: z.string().optional(),
        status: z.string().optional(),
        source_member: z.string().optional(),
        tags: z.string().optional(),
      })).optional().describe('Tasks to add'),
      members: z.array(z.object({
        display_name: z.string(),
        username: z.string().optional(),
        expertise: z.string().optional(),
        projects: z.string().optional(),
      })).optional().describe('Members to add/update'),
      topics: z.array(z.object({
        name: z.string(),
        summary: z.string().optional(),
        participants: z.string().optional(),
        tags: z.string().optional(),
      })).optional().describe('Topics to add'),
      questions: z.array(z.object({
        question: z.string(),
        asker: z.string().optional(),
        tags: z.string().optional(),
      })).optional().describe('Questions to add'),
      events: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        event_date: z.string().optional(),
        location: z.string().optional(),
        attendees: z.string().optional(),
        tags: z.string().optional(),
      })).optional().describe('Events to add'),
      sourceAgent: z.string().optional().describe('Name of the agent contributing this knowledge'),
    },
    async (args) => {
      const result = await handlers.add_knowledge(args);
      if (result.isError) {
        return { content: [{ type: 'text', text: result.error }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    'ingest',
    'Ingest raw text — runs LLM extraction pipeline to extract structured knowledge. More expensive than add_knowledge but handles unstructured input.',
    {
      text: z.string().describe('Raw text to extract knowledge from'),
      sourceAgent: z.string().optional().describe('Name of the agent contributing this knowledge'),
      profile: z.string().optional().describe('Extraction profile (knowledge, team, project, full)'),
    },
    async (args) => {
      const result = await handlers.ingest(args);
      if (result.isError) {
        return { content: [{ type: 'text', text: result.error }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    'update_entity',
    'Update status of a decision, task, or question.',
    {
      type: z.enum(['decision', 'task', 'question']).describe('Entity type'),
      id: z.number().describe('Entity ID'),
      status: z.string().optional().describe('New status (decision: proposed/agreed/revisited, task: open/done/blocked)'),
      answer: z.string().optional().describe('Answer text (questions only)'),
      answeredBy: z.string().optional().describe('Who answered (questions only)'),
      context: z.string().optional().describe('Additional context (decisions only)'),
    },
    async (args) => {
      const result = await handlers.update_entity(args);
      if (result.isError) {
        return { content: [{ type: 'text', text: result.error }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  return {
    server,
    async connect() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
    close() {
      driver.close();
    },
  };
}

module.exports = { createServer, createHandlers };
