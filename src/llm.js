/**
 * llm.js — Model-agnostic LLM client.
 * Supports: OpenAI-compatible (OpenAI, Gemini, Groq, Ollama, etc.) and Anthropic Messages API.
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
- NEVER extract API keys, tokens, passwords, secrets, or credentials — these are security-sensitive and must not be stored

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
  const { overlapMessages, contextSection, knownMembers } = options;

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

  // Add known-members dedup rule
  if (knownMembers?.length > 0 && entities.includes('members')) {
    rulesFragments.push(`Known member rules:
- Members listed in KNOWN MEMBERS are already stored. Only include a known member in "members" if these messages reveal NEW expertise or projects not yet captured
- For known members with no new info, omit them entirely from the output`);
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
  if (knownMembers?.length > 0) {
    contextBlock += `\nKNOWN MEMBERS (already in database): ${knownMembers.join(', ')}\n`;
  }
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
- NEVER extract API keys, tokens, passwords, secrets, or credentials — these are security-sensitive and must not be stored

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

/** Detect whether to use Anthropic Messages API. */
function isAnthropic(config) {
  if (config.provider === 'anthropic') return true;
  if (config.baseUrl?.includes('anthropic.com')) return true;
  return false;
}

/**
 * Attempt to repair truncated or malformed JSON from LLM output.
 * Handles: code fences, trailing commas, truncated arrays/objects.
 */
function repairJson(text) {
  // Strip code fences
  let s = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // Try clean parse first
  try { return JSON.parse(s); } catch {}

  // Remove trailing commas before } or ]
  let cleaned = s.replace(/,(\s*[\]}])/g, '$1');
  try { return JSON.parse(cleaned); } catch {}

  // Truncation repair: walk backward from end, try closing brackets at each '}'
  for (let i = cleaned.length - 1; i > 0; i--) {
    if (cleaned[i] !== '}') continue;
    const truncated = cleaned.substring(0, i + 1);
    const closers = getUnclosedBrackets(truncated);
    if (closers.length === 0) continue;
    try { return JSON.parse(truncated + closers); } catch { continue; }
  }

  throw new Error('JSON parse failed (repair unsuccessful)');
}

/** Count unclosed [ and { and return the closing sequence needed. */
function getUnclosedBrackets(text) {
  const stack = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '"' && text[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
    }
  }
  return stack.reverse().join('');
}

function buildRequest(prompt, config) {
  const { apiKey, baseUrl, model } = config;

  if (isAnthropic(config)) {
    return {
      url: baseUrl.replace(/\/+$/, '') + '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        system: 'You extract structured knowledge from chat messages. Always respond with valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 4096,
      },
    };
  }

  // OpenAI-compatible format
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You extract structured knowledge from chat messages. Always respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  };

  return {
    url: baseUrl.replace(/\/+$/, '') + '/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
  };
}

function parseResponse(data, config) {
  if (isAnthropic(config)) {
    return data.content?.[0]?.text || null;
  }
  return data.choices?.[0]?.message?.content || null;
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
    knownMembers,
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
      knownMembers: knownMembers || null,
    });
  } else {
    prompt = EXTRACTION_PROMPT.replace('{messages}', formatted);
  }

  const req = buildRequest(prompt, config);

  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = parseResponse(data, config);
  if (!content) throw new Error('Empty response from LLM');

  return repairJson(content);
}

/**
 * Retries extract() on transient errors with exponential backoff + jitter.
 * Retries on: HTTP 429 (rate limit), 5xx (502, 503, 504), network errors.
 */
async function extractWithRetry(messages, config, maxRetries = 3) {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await extract(messages, config);
    } catch (err) {
      const status = err.status || (err.message.match(/error (\d+):/)?.[1] && parseInt(err.message.match(/error (\d+):/)[1]));
      const errCode = err.code || err.cause?.code;
      const isRetryable = status === 429 || (status >= 500 && status <= 504)
        || ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(errCode);
      if (isRetryable && attempt < maxRetries) {
        const jitter = delay * (0.5 + Math.random());
        await new Promise(resolve => setTimeout(resolve, jitter));
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
}

module.exports = { extract, extractWithRetry, buildPrompt, formatMessages, repairJson, isAnthropic, EXTRACTION_PROMPT };
