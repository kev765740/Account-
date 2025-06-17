import express from 'express';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';
import { QdrantClient } from 'qdrant-client';
import { parseJavaScriptCode } from './codeParser.js';

const app = express();
const port = 3001;

app.use(bodyParser.json());

if (!process.env.OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY environment variable is not set.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const qdrant = new QdrantClient({ url: 'http://localhost:6333' });
const COLLECTION_NAME = 'code-snippets';

// Helper function for entity extraction (basic heuristic)
function extractPotentialEntities(prompt) {
  const entities = [];
  // Normalize prompt for easier regex matching.
  const lowerPrompt = prompt.toLowerCase();

  // Order of regex matters: more specific first, or handle overlaps.
  // Method: "<className>.<methodName>"
  const classDotMethodRegex = /([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/g;
  let match;
  while ((match = classDotMethodRegex.exec(lowerPrompt)) !== null) {
    entities.push({ type: 'method', name: match[2], className: match[1] });
  }

  // Method: "method <methodName> in class <className>" or "method <methodName> on <className>"
  const methodInClassRegex = /method\s+([a-z_][a-z0-9_]*)\s+(?:in\s+class|on)\s+([a-z_][a-z0-9_]*)/g;
  while ((match = methodInClassRegex.exec(lowerPrompt)) !== null) {
    entities.push({ type: 'method', name: match[1], className: match[2] });
  }

  // Class: "class <className>"
  const classRegex = /class\s+([a-z_][a-z0-9_]*)/g;
  while ((match = classRegex.exec(lowerPrompt)) !== null) {
    entities.push({ type: 'class', name: match[1] });
  }

  // Function: "function <functionName>"
  const funcRegex = /function\s+([a-z_][a-z0-9_]*)/g;
  while ((match = funcRegex.exec(lowerPrompt)) !== null) {
    entities.push({ type: 'function', name: match[1] });
  }

  const uniqueEntitiesMap = new Map();
  entities.forEach(entity => {
    const key = `${entity.type}-${entity.name}` + (entity.className ? `-${entity.className}` : '');
    // Prioritize more specific entities (like methods over functions if name clashes implicitly by order of addition and check)
    if (!uniqueEntitiesMap.has(key)) {
      uniqueEntitiesMap.set(key, entity);
    }
  });

  const finalEntities = [];
  for (const entity of uniqueEntitiesMap.values()) {
    if (entity.type === 'method') {
      finalEntities.push(entity);
    } else if (entity.type === 'class') {
      finalEntities.push(entity);
    } else if (entity.type === 'function') {
      if (!finalEntities.some(e => e.name === entity.name && e.type === 'method')) {
        finalEntities.push(entity);
      }
    }
  }
  return finalEntities.slice(0, 2); // Limit to max 2 most prominent entities
}


app.post('/generate', async (req, res) => {
  const { prompt, output_format } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  let systemMessageContent;
  let entitySpecificContextString = "";
  let generalSnippetsContextString = "";
  let queryEmbedding; // Will hold the prompt embedding

  try {
    // Generate embedding for the prompt
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small', input: prompt
    });
    queryEmbedding = embeddingResponse.data[0].embedding;

    // --- New: Targeted Entity Context Retrieval ---
    const potentialEntities = extractPotentialEntities(prompt);
    if (potentialEntities.length > 0 && queryEmbedding) {
      for (const entity of potentialEntities) {
        try {
          const filterConditions = [{ key: 'type', match: { value: entity.type } }];
          // Ensure name is treated as keyword/exact match if possible by Qdrant client
          // For this example, using 'match: { value: ... }' which implies keyword-like for strings.
          if (entity.name) {
            filterConditions.push({ key: 'payload.name', match: { value: entity.name } });
          }
          if (entity.className) {
            filterConditions.push({ key: 'payload.className', match: { value: entity.className } });
          }

          const targetedSearchResult = await qdrant.search(COLLECTION_NAME, {
            vector: queryEmbedding,
            filter: { must: filterConditions },
            limit: 1
          });

          if (targetedSearchResult && targetedSearchResult.length > 0) {
            const foundElement = targetedSearchResult[0].payload;
            entitySpecificContextString += `Specific context for ${foundElement.type} '${foundElement.name}' ${foundElement.className ? `in class '${foundElement.className}'` : ''} from your project:\n`;
            entitySpecificContextString += `File: ${foundElement.filePath}\n`;
            if (foundElement.signature) entitySpecificContextString += `Signature: ${foundElement.signature}\n`;
            if (foundElement.summary) entitySpecificContextString += `Summary: ${foundElement.summary}\n`;
            const snippetLines = foundElement.code_snippet.split('\n');
            const conciseSnippet = snippetLines.slice(0, 10).join('\n') + (snippetLines.length > 10 ? "\n..." : "");
            entitySpecificContextString += `Code (first 10 lines):\n\`\`\`\n${conciseSnippet}\n\`\`\`\n---\n`;
          }
        } catch (entitySearchError) {
          console.warn(`Failed to retrieve targeted context for entity ${JSON.stringify(entity)}:`, entitySearchError.message);
        }
      }
    }
    // --- End of New: Targeted Entity Context Retrieval ---

    // Perform general semantic search (existing logic)
    if (queryEmbedding) { // Ensure we have an embedding
        const generalSearchResult = await qdrant.search(COLLECTION_NAME, {
        vector: queryEmbedding,
        limit: 2
        });

        if (generalSearchResult && generalSearchResult.length > 0) {
        generalSnippetsContextString += "General relevant code snippets from the project (semantic search):\n";
        generalSearchResult.forEach(r => {
            // Handle both old (/index-snippet) and new (/index-file-structures) payload structures
            const codePayload = r.payload.code_snippet ? r.payload.code_snippet : r.payload.code;
            const commentPayload = r.payload.comment || r.payload.summary;
            let itemContext = "";
            if(r.payload.filePath) itemContext += `File: ${r.payload.filePath}\n`;
            if(r.payload.type) itemContext += `Type: ${r.payload.type} ${r.payload.name || ''}\n`;
            if(commentPayload) itemContext += `Comment/Summary: ${commentPayload}\n`;

            itemContext += "```\n" + (codePayload || JSON.stringify(r.payload)) + "\n```\n---\n";
            generalSnippetsContextString += itemContext;
        });
        }
    }
  } catch (contextError) {
    console.warn('Error during context retrieval phase:', contextError.message);
    // Errors in context retrieval are logged as warnings, generation proceeds.
  }

  // Construct userMessagesContent
  let userMessagesContent = "";
  if (entitySpecificContextString) {
    userMessagesContent += entitySpecificContextString;
  }
  if (generalSnippetsContextString) {
    userMessagesContent += generalSnippetsContextString;
  }
  userMessagesContent += `Task: ${prompt}`;

  // Conditional logic based on output_format
  // System message update to hint about structured context
  if (output_format === 'structured_edit') {
    systemMessageContent = `You are an AI assistant that provides code modifications in a structured JSON format.
Context about specific functions, classes, or methods from the user's project, along with general relevant code snippets, may be provided. Use all available context.
Respond with a JSON array containing a single action object.
The action object must have one of the following structures:
1. For insertions: [{"action": "insert", "line": <line_number>, "text": "<code_to_insert>"}]
2. For replacements: [{"action": "replace", "start_line": <start_line_number>, "end_line": <end_line_number>, "text": "<replacement_code>"}]
3. For deletions: [{"action": "delete", "start_line": <start_line_number>, "end_line": <end_line_number>}]
Ensure the line numbers are 1-based. Provide only the JSON array as your response.`;
  } else {
    systemMessageContent = "You are a helpful coding assistant. The user will provide a task. Context about specific functions, classes, or methods from their project, along with general relevant code snippets, may be provided. Use all available context to generate accurate and relevant code. If snippets or specific structures are provided, pay close attention to their style and patterns.";
    if (!entitySpecificContextString && !generalSnippetsContextString && userMessagesContent === `Task: ${prompt}`) { // If no context at all was found
        systemMessageContent = "You are a helpful coding assistant.";
    }
  }

  const messages = [
    { role: 'system', content: systemMessageContent },
    { role: 'user', content: userMessagesContent }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: messages,
      max_tokens: 256 // Consider adjusting for structured JSON output
    });

    const rawResult = completion.choices[0]?.message?.content || '';

    if (output_format === 'structured_edit') {
      try {
        const parsedResult = JSON.parse(rawResult);
        // 2.a.iii.2. Basic validation
        if (Array.isArray(parsedResult) && parsedResult.length > 0 && parsedResult[0].action) {
          res.json(parsedResult); // 2.a.iii.3. Send parsed JSON
        } else {
          const errorDetails = `Expected an array with at least one action object, e.g., [{"action": "insert", ...}], but got: ${JSON.stringify(parsedResult)}`;
          console.error('Generated structured edit is not valid:', parsedResult);
          res.status(500).json({
            error: 'Failed to generate valid structured edit JSON. Output was not a valid action array.',
            details: errorDetails
          });
        }
      } catch (parseError) {
        console.error('Failed to parse structured edit JSON:', parseError, 'Raw result:', rawResult);
        res.status(500).json({ error: 'Failed to parse structured edit JSON from AI response.', details: rawResult });
      }
    } else {
      // 2.b.ii. Return plain text
      res.json({ result: rawResult });
    }
  } catch (error) {
    console.error('Error in /generate endpoint during OpenAI completion or processing:', error);
    if (error instanceof OpenAI.APIError) {
      // Handle OpenAI API errors
      const status = error.status || 500;
      res.status(status).json({
        error: 'OpenAI API error.',
        details: error.message || 'No additional details provided.'
      });
    } else {
      // Handle other errors
      res.status(500).json({
        error: 'Failed to generate AI response due to an internal server error.',
        details: error.message || 'No additional details provided.'
      });
    }
  }
});

// Endpoint to add a code snippet to the vector database
app.post('/index-snippet', async (req, res) => {
  const { code, comment } = req.body; // 1a. Extract code and optional comment

  // 1b. Code is mandatory
  if (!code) {
    return res.status(400).json({ error: 'Code is required.' });
  }

  // 1c. Determine text for embedding
  let text_for_embedding;
  if (comment && typeof comment === 'string' && comment.trim() !== '') {
    text_for_embedding = comment.trim() + "\n\n" + code;
  } else {
    text_for_embedding = code;
  }

  try {
    // 1d. Generate embedding using OpenAI
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text_for_embedding
    });
    const embedding = embeddingResponse.data[0].embedding;

    // 1e. Determine payload for Qdrant
    const qdrantPayload = {
      code: code,
      comment: (comment && typeof comment === 'string' && comment.trim() !== '') ? comment.trim() : null
    };

    // Store in Qdrant
    await qdrant.upsert(COLLECTION_NAME, {
      points: [{
        id: Date.now(), // Consider a more robust ID generation strategy for production
        vector: embedding,
        payload: qdrantPayload
      }]
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error in /index-snippet endpoint:', error);
    if (error instanceof OpenAI.APIError) {
      // Handle OpenAI API errors (e.g., for embeddings)
      const status = error.status || 500;
      res.status(status).json({
        error: 'OpenAI API error during embedding generation for snippet.',
        details: error.message || 'No additional details provided.'
      });
    } else if (error.message && error.message.toLowerCase().includes('qdrant')) {
      // Basic check for Qdrant related errors
      res.status(500).json({
        error: 'Qdrant client error during snippet indexing.',
        details: error.message
      });
    } else {
      // Handle other errors
      res.status(500).json({
        error: 'Failed to index code snippet (and optional comment) due to an internal server error.',
        details: error.message || 'No additional details provided.'
      });
    }
  }
});

// Endpoint to search code snippets semantically
app.post('/semantic-search', async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Query is required.' });
  }
  try {
    // Generate embedding for the query
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query
    });
    const embedding = embeddingResponse.data[0].embedding;
    // Search in Qdrant
    const searchResult = await qdrant.search(COLLECTION_NAME, {
      vector: embedding,
      limit: 3
    });
    const results = searchResult.map(r => r.payload.code);
    res.json({ results });
  } catch (error) {
    console.error('Error in /semantic-search endpoint:', error);
    if (error instanceof OpenAI.APIError) {
      // Handle OpenAI API errors (e.g., for embeddings)
      const status = error.status || 500;
      res.status(status).json({
        error: 'OpenAI API error during query embedding generation.',
        details: error.message || 'No additional details provided.'
      });
    } else if (error.message && error.message.toLowerCase().includes('qdrant')) {
      // Basic check for Qdrant related errors
      res.status(500).json({
        error: 'Qdrant client error during semantic search.',
        details: error.message
      });
    } else {
      // Handle other errors
      res.status(500).json({
        error: 'Semantic search failed due to an internal server error.',
        details: error.message || 'No additional details provided.'
      });
    }
  }
});

app.listen(port, () => {
  console.log(`AI backend listening at http://localhost:${port}`);
});

// Endpoint to parse and index code structures from a file
app.post('/index-file-structures', async (req, res) => {
  const { filePath, content } = req.body;

  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'filePath is required and must be a string.' });
  }
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required and must be a string.' });
  }

  try {
    const structures = parseJavaScriptCode(content, filePath);

    if (!structures || structures.length === 0) {
      return res.json({
        success: true,
        message: 'No structures found or parsed from the file.',
        indexed_count: 0
      });
    }

    let indexed_count = 0;
    const points_to_upsert = [];

    for (const element of structures) {
      let text_for_embedding = `File: ${element.filePath}\nType: ${element.type}\n`;
      if (element.type === 'method' && element.className) {
        text_for_embedding += `Class: ${element.className}\n`;
      }
      text_for_embedding += `Name: ${element.name}\n`;
      if (element.signature) {
        text_for_embedding += `Signature: ${element.signature}\n`;
      }
      if (element.summary) { // Add summary if available and concise
        text_for_embedding += `Summary: ${element.summary}\n`;
      }
      text_for_embedding += `Code:\n${element.code_snippet}`;

      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text_for_embedding,
      });
      const embedding = embeddingResponse.data[0].embedding;

      // Construct a unique and deterministic ID if possible
      const point_id = `${element.filePath}:${element.type}:${element.className || ''}:${element.name}:${element.start_line}`;

      points_to_upsert.push({
        id: point_id,
        vector: embedding,
        payload: element, // Store the full element object
      });
    }

    if (points_to_upsert.length > 0) {
      await qdrant.upsert(COLLECTION_NAME, { points: points_to_upsert });
      indexed_count = points_to_upsert.length;
    }

    res.json({
      success: true,
      message: `Indexed ${indexed_count} structures from ${filePath}.`,
      indexed_count: indexed_count,
    });

  } catch (error) {
    console.error(`Error in /index-file-structures for ${filePath}:`, error);
    if (error instanceof OpenAI.APIError) {
      res.status(error.status || 500).json({
        error: 'OpenAI API error during structure indexing.',
        details: error.message || 'No additional details provided.',
      });
    } else if (error.message && error.message.toLowerCase().includes('qdrant')) {
      res.status(500).json({
        error: 'Qdrant client error during structure indexing.',
        details: error.message,
      });
    } else {
      res.status(500).json({
        error: 'Failed to index file structures due to an internal server error.',
        details: error.message || 'An unexpected error occurred.',
      });
    }
  }
});
