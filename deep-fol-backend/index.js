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
  let dependencyContextString = ""; // For imports/exports
  let generalSnippetsContextString = "";
  let queryEmbedding;
  let relevantFilePath = null; // To store filePath of the primary found entity

  try {
    // Generate embedding for the prompt
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small', input: prompt
    });
    queryEmbedding = embeddingResponse.data[0].embedding;

    // --- Targeted Entity Context Retrieval ---
    const potentialEntities = extractPotentialEntities(prompt);
    if (potentialEntities.length > 0 && queryEmbedding) {
      // For simplicity, focus on the first relevant entity for fetching file dependencies
      const primaryEntity = potentialEntities[0];
      try {
        const filterConditions = [{ key: 'payload.type', match: { value: primaryEntity.type } }];
        if (primaryEntity.name) {
          filterConditions.push({ key: 'payload.name', match: { value: primaryEntity.name } });
        }
        if (primaryEntity.className) {
          filterConditions.push({ key: 'payload.className', match: { value: primaryEntity.className } });
        }

        const targetedSearchResult = await qdrant.search(COLLECTION_NAME, {
          vector: queryEmbedding, // Use prompt's embedding for semantic relevance of the entity itself
          filter: { must: filterConditions },
          limit: 1
        });

        if (targetedSearchResult && targetedSearchResult.length > 0) {
          const foundElement = targetedSearchResult[0].payload;
          relevantFilePath = foundElement.filePath; // Capture filePath for dependency fetching

          entitySpecificContextString += `Specific context for ${foundElement.type} '${foundElement.name}' ${foundElement.className ? `in class '${foundElement.className}'` : ''} from your project:\n`;
          entitySpecificContextString += `File: ${foundElement.filePath}\n`;
          if (foundElement.signature) entitySpecificContextString += `Signature: ${foundElement.signature}\n`;
          if (foundElement.summary) entitySpecificContextString += `Summary: ${foundElement.summary}\n`;
          const snippetLines = foundElement.code_snippet.split('\n');
          const conciseSnippet = snippetLines.slice(0, 10).join('\n') + (snippetLines.length > 10 ? "\n..." : "");
          entitySpecificContextString += `Code (first 10 lines):\n\`\`\`\n${conciseSnippet}\n\`\`\`\n`;
        }
      } catch (entitySearchError) {
        console.warn(`Failed to retrieve targeted context for entity ${JSON.stringify(primaryEntity)}:`, entitySearchError.message);
      }
    }
    // --- End of Targeted Entity Context Retrieval ---

    // --- Fetch and Format Dependency Context ---
    if (relevantFilePath) {
      try {
        const fileMetaFilter = {
          must: [
            { key: 'payload.type', match: { value: 'file_metadata' } },
            { key: 'payload.filePath', match: { value: relevantFilePath } }
          ]
        };
        const fileMetaScroll = await qdrant.scroll(COLLECTION_NAME, {
          filter: fileMetaFilter,
          limit: 1,
          with_payload: true
        });

        if (fileMetaScroll.points && fileMetaScroll.points.length > 0) {
          const fileMetaPayload = fileMetaScroll.points[0].payload;
          let contextParts = [`\n--- File Context for: ${relevantFilePath} ---`];

          if (fileMetaPayload.imports && fileMetaPayload.imports.length > 0) {
            const importSources = [...new Set(fileMetaPayload.imports.map(imp => imp.source))].join(', ');
            contextParts.push(`Imports sources: ${importSources || 'None'}`);
          } else {
            contextParts.push("Imports: None specified in metadata.");
          }

          if (fileMetaPayload.exports && fileMetaPayload.exports.length > 0) {
            const exportNames = fileMetaPayload.exports.flatMap(exp => exp.exported_items.map(item => item.name)).join(', ');
            contextParts.push(`Exports names: ${exportNames || 'None'}`);
          } else {
            contextParts.push("Exports: None specified in metadata.");
          }
          dependencyContextString = contextParts.join('\n') + '\n';
        }
      } catch (dependencyFetchError) {
        console.warn(`Failed to retrieve dependency context for file ${relevantFilePath}:`, dependencyFetchError.message);
      }
    }
    // --- End of Fetch and Format Dependency Context ---

    // Perform general semantic search (existing logic)
    if (queryEmbedding) {
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
    userMessagesContent += entitySpecificContextString + "\n---\n";
  }
  if (dependencyContextString) {
    userMessagesContent += dependencyContextString + "\n---\n";
  }
  if (generalSnippetsContextString) {
    // Check if generalSnippetsContextString is not just the header
    if (generalSnippetsContextString.trim() !== "General relevant code snippets from the project (semantic search):") {
        userMessagesContent += generalSnippetsContextString; // Already includes "---" at the end of each snippet
    } else if (!entitySpecificContextString && !dependencyContextString) {
        // Avoid adding an empty general snippets section if no other context is present
        generalSnippetsContextString = ""; // Clear it so it's not added
    }
    // If other contexts are present but general search is empty (just header), it's fine, don't add it.
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
    if (!entitySpecificContextString && !dependencyContextString && !generalSnippetsContextString.trim().replace("General relevant code snippets from the project (semantic search):","").trim() && userMessagesContent === `Task: ${prompt}`) {
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

app.get('/file-dependencies', async (req, res) => {
  const { filePath } = req.query;

  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    return res.status(400).json({ error: 'filePath query parameter is required and must be a non-empty string.' });
  }

  try {
    const conditions = [
      { key: 'payload.type', match: { value: 'file_metadata' } },
      { key: 'payload.filePath', match: { value: filePath } },
    ];

    const scrollResult = await qdrant.scroll(COLLECTION_NAME, {
      filter: { must: conditions },
      limit: 1,
      with_payload: true,
      with_vector: false,
    });

    if (scrollResult.points && scrollResult.points.length > 0) {
      const payload = scrollResult.points[0].payload;
      res.json({
        filePath: payload.filePath,
        imports: payload.imports || [], // Default to empty array if not present
        exports: payload.exports || [],  // Default to empty array if not present
      });
    } else {
      res.status(404).json({ error: 'File metadata not found or does not contain dependency information.' });
    }
  } catch (error) {
    console.error(`Error in /file-dependencies for ${filePath}:`, error);
    if (error.message && error.message.toLowerCase().includes('qdrant')) {
      res.status(500).json({
        error: 'Qdrant client error while fetching file dependencies.',
        details: error.message,
      });
    } else {
      res.status(500).json({
        error: 'Failed to fetch file dependencies due to an internal server error.',
        details: error.message || 'An unexpected error occurred.',
      });
    }
  }
});

app.get('/find-symbols-by-name', async (req, res) => {
  const { name, type, limit } = req.query;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name query parameter is required and must be a non-empty string.' });
  }

  let validatedLimit = 10; // Default limit
  if (limit !== undefined) {
    const parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      // Optional: return 400 for invalid limit, or just use default. For now, using default.
      console.warn(`Invalid limit value '${limit}' provided. Using default ${validatedLimit}.`);
    } else {
      validatedLimit = parsedLimit;
    }
  }

  try {
    let descriptiveQuery = `A code element (function, class, or method) named "${name}"`;
    if (type && typeof type === 'string' && type.trim() !== '') {
      descriptiveQuery = `A code ${type.trim()} named "${name}"`;
    }

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: descriptiveQuery,
    });
    const embedding = embeddingResponse.data[0].embedding;

    const qdrant_filter_conditions = [];
    if (type && typeof type === 'string' && type.trim() !== '') {
      qdrant_filter_conditions.push({ key: 'payload.type', match: { value: type.trim() } });
    }
    // Note: We are not filtering by name directly here, as the semantic search + name in query should handle it.
    // If direct name filtering is also desired, it could be added:
    // qdrant_filter_conditions.push({ key: 'payload.name', match: { value: name } });


    const search_params = {
      vector: embedding,
      limit: validatedLimit,
      with_payload: true,
    };

    if (qdrant_filter_conditions.length > 0) {
      search_params.filter = { must: qdrant_filter_conditions };
    }

    const searchResult = await qdrant.search(COLLECTION_NAME, search_params);
    const results = searchResult.map(hit => hit.payload);
    res.json({ results });

  } catch (error) {
    console.error(`Error in /find-symbols-by-name for name "${name}":`, error);
    if (error instanceof OpenAI.APIError) {
      res.status(error.status || 500).json({
        error: 'OpenAI API error during symbol search.',
        details: error.message || 'No additional details provided.',
      });
    } else if (error.message && error.message.toLowerCase().includes('qdrant')) {
      res.status(500).json({
        error: 'Qdrant client error during symbol search.',
        details: error.message,
      });
    } else {
      res.status(500).json({
        error: 'Failed to find symbols due to an internal server error.',
        details: error.message || 'An unexpected error occurred.',
      });
    }
  }
});

app.get('/file-outline', async (req, res) => {
  const { filePath } = req.query;

  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'filePath query parameter is required.' });
  }

  try {
    const conditions = [{ key: 'payload.filePath', match: { value: filePath } }];
    const all_points = [];
    let next_offset = null;

    do {
      const scrollResult = await qdrant.scroll(COLLECTION_NAME, {
        filter: { must: conditions },
        limit: 50, // Batch size for scrolling
        offset: next_offset,
        with_payload: true,
        with_vector: false,
      });

      if (scrollResult.points && scrollResult.points.length > 0) {
        all_points.push(...scrollResult.points);
      }
      next_offset = scrollResult.next_page_offset;
    } while (next_offset);

    if (all_points.length === 0) {
      return res.json([]); // Return empty array if no structures found for the file
    }

    const outline = all_points.map(point => {
      const payload = point.payload;
      let summaryText = payload.summary || '';
      if (summaryText.length > 75) {
        summaryText = summaryText.substring(0, 75) + '...';
      }
      return {
        type: payload.type,
        name: payload.name,
        signature: payload.signature, // May be undefined for some types like 'class' itself
        summary: summaryText,
        start_line: payload.start_line,
        end_line: payload.end_line,
        className: payload.className, // Will be undefined if not applicable
      };
    });

    outline.sort((a, b) => (a.start_line || 0) - (b.start_line || 0));

    res.json(outline);

  } catch (error) {
    console.error(`Error in /file-outline for ${filePath}:`, error);
    if (error.message && error.message.toLowerCase().includes('qdrant')) {
      res.status(500).json({
        error: 'Qdrant client error while fetching file outline.',
        details: error.message,
      });
    } else {
      res.status(500).json({
        error: 'Failed to fetch file outline due to an internal server error.',
        details: error.message || 'An unexpected error occurred.',
      });
    }
  }
});

app.get('/structure-details', async (req, res) => {
  const { filePath, name, type, className } = req.query;

  if (!filePath || !name) {
    return res.status(400).json({ error: 'filePath and name query parameters are required.' });
  }

  try {
    const conditions = [
      { key: 'payload.filePath', match: { value: filePath } },
      { key: 'payload.name', match: { value: name } },
    ];

    if (type) {
      conditions.push({ key: 'payload.type', match: { value: type } });
    }
    if (className) {
      conditions.push({ key: 'payload.className', match: { value: className } });
    }

    const scrollResult = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        must: conditions,
      },
      limit: 1,
      with_payload: true,
      with_vector: false, // Vector is not needed for this operation
    });

    if (scrollResult.points && scrollResult.points.length > 0) {
      res.json(scrollResult.points[0].payload);
    } else {
      res.status(404).json({ error: 'Structure not found.' });
    }
  } catch (error) {
    console.error('Error in /structure-details:', error);
    if (error.message && error.message.toLowerCase().includes('qdrant')) {
      res.status(500).json({
        error: 'Qdrant client error while fetching structure details.',
        details: error.message,
      });
    } else {
      res.status(500).json({
        error: 'Failed to fetch structure details due to an internal server error.',
        details: error.message || 'An unexpected error occurred.',
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
      comment: (comment && typeof comment === 'string' && comment.trim() !== '') ? comment.trim() : null,
      type: "snippet" // Add type field
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
  const { query, limit, filters } = req.body;

  if (!query || typeof query !== 'string' || query.trim() === '') {
    return res.status(400).json({ error: 'Query is required and must be a non-empty string.' });
  }

  let searchLimit = 5; // Default limit
  if (limit !== undefined) {
    const parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      return res.status(400).json({ error: 'Limit must be a positive integer.' });
    }
    searchLimit = parsedLimit;
  }

  if (filters !== undefined && (typeof filters !== 'object' || filters === null)) {
    return res.status(400).json({ error: 'Filters must be an object if provided.' });
  }

  try {
    // Generate embedding for the query
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });
    const embedding = embeddingResponse.data[0].embedding;

    const qdrant_filter_conditions = [];
    if (filters) {
      if (filters.filePath && typeof filters.filePath === 'string') {
        qdrant_filter_conditions.push({ key: 'payload.filePath', match: { value: filters.filePath } });
      }
      if (filters.type && typeof filters.type === 'string') {
        qdrant_filter_conditions.push({ key: 'payload.type', match: { value: filters.type } });
      }
      if (filters.name && typeof filters.name === 'string') {
        qdrant_filter_conditions.push({ key: 'payload.name', match: { value: filters.name } });
      }
    }

    const search_params = {
      vector: embedding,
      limit: searchLimit,
      with_payload: true, // Return full payloads
    };

    if (qdrant_filter_conditions.length > 0) {
      search_params.filter = { must: qdrant_filter_conditions };
    }

    const searchResult = await qdrant.search(COLLECTION_NAME, search_params);

    const results = searchResult.map(hit => hit.payload); // Return full payloads
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
    const { structures, imports, exports } = parseJavaScriptCode(content, filePath); // Destructure parser result
    const points_to_upsert = [];

    // Process and collect structure points (existing logic)
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

    // Create and collect file_metadata point
    let importSources = imports.map(imp => imp.source).join(', ');
    let exportNames = exports.flatMap(exp => exp.exported_items.map(item => item.name)).join(', ');

    let text_for_file_metadata_embedding = `File: ${filePath}\n`;
    if (imports.length > 0 && importSources) text_for_file_metadata_embedding += `Imports: ${importSources}\n`;
    if (exports.length > 0 && exportNames) text_for_file_metadata_embedding += `Exports: ${exportNames}\n`;
    // If the text is still just "File: filePath", add a placeholder to ensure embedding is meaningful
    if (text_for_file_metadata_embedding === `File: ${filePath}\n`) {
        text_for_file_metadata_embedding += "This file has no explicit imports or exports or other parsed content.";
    }

    const fileMetadataEmbeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text_for_file_metadata_embedding,
    });
    const fileMetadataEmbedding = fileMetadataEmbeddingResponse.data[0].embedding;

    const fileMetadataPayload = {
        type: "file_metadata",
        filePath: filePath,
        imports: imports, // Store full import objects
        exports: exports, // Store full export objects
        summary: null, // Placeholder for potential future file-level summary
        line_count: content.split('\n').length,
        structure_count: structures.length, // Count of functions, classes, methods
        import_count: imports.length,
        export_count: exports.length
    };

    const file_metadata_point_id = `filemeta:${filePath}`;
    points_to_upsert.push({
        id: file_metadata_point_id,
        vector: fileMetadataEmbedding,
        payload: fileMetadataPayload
    });

    // Batch Upsert (includes structures and the file_metadata point)
    if (points_to_upsert.length > 0) {
      await qdrant.upsert(COLLECTION_NAME, { points: points_to_upsert });
    }

    res.json({
      success: true,
      message: `Successfully indexed ${structures.length} structures and file metadata for ${filePath}.`,
      indexed_count: points_to_upsert.length, // Total points upserted
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
