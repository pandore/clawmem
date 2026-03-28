/**
 * llm.js — Model-agnostic LLM client using OpenAI-compatible API.
 * Works with: OpenAI, Gemini, Groq, Ollama, LM Studio, vLLM, any OpenAI-compatible endpoint.
 */

const { ENTITY_DEFS } = require('./profiles');

const EXTRACTION_PROMPT = `Analyze these chat messages and extract structured knowledge.

MESSAGES:
{messages}

Extract and return JSON with exactly this structure:
{
  "members": [
    {
      "username": "string or null",
      "display_name": "string",
      "expertise": "comma-separated skills/knowledge areas demonstrated",
      "projects": "comma-separated projects/tools they actively use or build"
    }
  ],
  "facts": [
    {
      "category": "one of: tool, technique, opinion, experience, resource, announcement",
      "content": "the factual claim or insight, 1-2 sentences",
      "source_member": "display_name of who said it",
      "tags": "comma-separated relevant tags",
      "confidence": 0.0 to 1.0
    }
  ],
  "topics": [
    {
      "name": "short topic title",
      "summary": "1-2 sentence summary of the discussion",
      "participants": "comma-separated display_names",
      "tags": "comma-separated relevant tags"
    }
  ]
}

Rules:
- Only extract information explicitly stated in messages, don't infer
- Skip greetings, small talk, and messages with no informational content
- Extract durable knowledge useful months later, not ephemeral news

Member rules:
- "expertise": only list skills where the person shows SUBSTANTIVE knowledge, not casual mentions
- "projects": only list tools/products a person ACTIVELY USES or BUILDS. Recommending, reviewing, or sharing news about a tool does NOT make it their project
- Only include members who shared genuine expertise or project info

Fact rules:
- Category must match content meaning: "tool" for tool-specific info, "technique" for methods/workflows, "opinion" for personal views, "experience" for firsthand accounts, "resource" for links/courses/repos, "announcement" for releases/launches
- Confidence: 0.9+ for verified specifics (pricing, versions, benchmarks). 0.75-0.85 for opinions and personal experiences. 0.5-0.7 for secondhand claims or speculation
- Tags should be lowercase, useful for search

If no meaningful content found, return empty arrays`;

function buildUpdateSchema(entities) {
  const updateFragments = [];
  if (entities.includes('decisions')) {
    updateFragments.push('    "decisions": [{ "id": "number (from EXISTING KNOWLEDGE)", "status": "proposed|agreed|revisited", "context": "optional new context" }]');
  }
  if (entities.includes('tasks')) {
    updateFragments.push('    "tasks": [{ "id": "number (from EXISTING KNOWLEDGE)", "status": "open|done|blocked" }]');
  }
  if (entities.includes('questions')) {
    updateFragments.push('    "questions": [{ "id": "number (from EXISTING KNOWLEDGE)", "answer": "the answer", "answered_by": "display_name", "status": "answered" }]');
  }
  if (updateFragments.length === 0) return '';
  return `  "updates": {\n${updateFragments.join(',\n')}\n  }`;
}

function buildPrompt(formattedMessages, profileConfig, options = {}) {
  const { entities, factCategories, memberLabels } = profileConfig;
  const { overlapMessages, contextSection } = options;

  // Build JSON schema with only enabled entities
  const schemaFragments = [];
  for (const entity of entities) {
    const def = ENTITY_DEFS[entity];
    if (!def) continue;
    if (entity === 'members') {
      schemaFragments.push(def.promptFragment(memberLabels));
    } else if (entity === 'facts') {
      schemaFragments.push(def.promptFragment(memberLabels, factCategories));
    } else {
      schemaFragments.push(def.promptFragment());
    }
  }

  // Add update schema if context is present
  if (contextSection) {
    const updateSchema = buildUpdateSchema(entities);
    if (updateSchema) schemaFragments.push(updateSchema);
  }

  // Build rules with only enabled entities
  const rulesFragments = [];
  for (const entity of entities) {
    const def = ENTITY_DEFS[entity];
    if (!def) continue;
    if (entity === 'members') {
      rulesFragments.push(def.rules(memberLabels));
    } else if (entity === 'facts') {
      rulesFragments.push(def.rules(memberLabels, factCategories));
    } else {
      rulesFragments.push(def.rules());
    }
  }

  // Add update rules if context is present
  if (contextSection) {
    rulesFragments.push(`Update rules:
- ONLY reference IDs from the EXISTING KNOWLEDGE section above
- Only update status when the conversation EXPLICITLY confirms a change (e.g., "we agreed on X", "task Y is done", "the answer to Z is...")
- Do not update entities that are not mentioned in the current messages
- If unsure whether something is an update or a new entity, create a new entity`);
  }

  // Build context blocks
  let contextBlock = '';
  if (overlapMessages) {
    contextBlock += `\nPREVIOUS MESSAGES (context only — do NOT extract from these, they were already processed):\n${overlapMessages}\n`;
  }
  if (contextSection) {
    contextBlock += `\nEXISTING KNOWLEDGE (from previous extractions — update these if the conversation references changes):\n${contextSection}\n`;
  }

  return `Analyze these chat messages and extract structured knowledge.
${contextBlock}
MESSAGES:
${formattedMessages}

Extract and return JSON with exactly this structure:
{
${schemaFragments.join(',\n')}
}

Rules:
- Only extract information explicitly stated in messages, don't infer
- Skip greetings, small talk, and messages with no informational content
- Extract durable knowledge useful months later, not ephemeral news

${rulesFragments.join('\n\n')}

If no meaningful content found, return empty arrays`;
}

function formatMessages(messages) {
  return messages.map(m => {
    const sender = m.sender || m.senderName || 'unknown';
    const time = m.timestamp || '';
    return `[${time}] ${sender}: ${m.content}`;
  }).join('\n');
}

async function extract(messages, config) {
  const {
    apiKey,
    baseUrl,
    model,
    promptTemplate,
    profileConfig,
    overlapMessages,
    contextSection,
  } = config;

  if (!apiKey) throw new Error('LLM API key not configured');
  if (!baseUrl) throw new Error('LLM base URL not configured');
  if (!model) throw new Error('LLM model not configured');

  const formatted = formatMessages(messages);
  let prompt;
  if (promptTemplate) {
    prompt = promptTemplate.replace('{messages}', formatted);
  } else if (profileConfig) {
    prompt = buildPrompt(formatted, profileConfig, {
      overlapMessages: overlapMessages || null,
      contextSection: contextSection || null,
    });
  } else {
    prompt = EXTRACTION_PROMPT.replace('{messages}', formatted);
  }

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: 'You extract structured knowledge from chat messages. Always respond with valid JSON only.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  };

  // Add response_format if supported (OpenAI, Gemini)
  // Some providers don't support it, so we don't fail if absent
  body.response_format = { type: 'json_object' };

  const headers = {
    'Content-Type': 'application/json',
  };

  // Support both Bearer token and API key in URL (some providers use query params)
  if (apiKey.startsWith('sk-') || apiKey.startsWith('AIza')) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from LLM');

  return JSON.parse(content);
}

module.exports = { extract, buildPrompt, formatMessages, EXTRACTION_PROMPT };
