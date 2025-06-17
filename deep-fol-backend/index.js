import express from 'express';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';
import { QdrantClient } from 'qdrant-client';

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

app.post('/generate', async (req, res) => {
  const { prompt, output_format } = req.body; // 1a. Extract output_format
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  let systemMessageContent;
  let userMessagesContent = ""; // Initialize userMessagesContent

  // Context retrieval logic (remains the same for both output formats)
  try {
    // 1a. Generate embedding for the prompt
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: prompt
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 1b. Perform search in Qdrant
    const searchResult = await qdrant.search(COLLECTION_NAME, {
      vector: queryEmbedding,
      limit: 2 // Fetch 2 relevant snippets
    });

    // 1e. If Qdrant search returns snippets
    if (searchResult && searchResult.length > 0) {
      userMessagesContent += "Relevant existing code from the project:\n";
      searchResult.forEach(r => {
        userMessagesContent += "```\n" + r.payload.code + "\n```\n---\n";
      });
    }
  } catch (contextError) {
    // Error handling for context retrieval
    console.warn('Failed to retrieve contextual snippets:', contextError);
    // userMessagesContent will remain empty if context retrieval fails, which is fine.
    // System message will be set based on output_format later.
  }

  // Append the original user task to userMessagesContent
  userMessagesContent += `Task: ${prompt}`;

  // Conditional logic based on output_format
  if (output_format === 'structured_edit') {
    // 2.a.i. System message for structured edit
    systemMessageContent = `You are an AI assistant that provides code modifications in a structured JSON format.
Respond with a JSON array containing a single action object.
The action object must have one of the following structures:
1. For insertions: [{"action": "insert", "line": <line_number>, "text": "<code_to_insert>"}]
2. For replacements: [{"action": "replace", "start_line": <start_line_number>, "end_line": <end_line_number>, "text": "<replacement_code>"}]
3. For deletions: [{"action": "delete", "start_line": <start_line_number>, "end_line": <end_line_number>}]
Ensure the line numbers are 1-based. Provide only the JSON array as your response.`;
  } else {
    // 2.b.i. System message for plain text generation (existing logic)
    systemMessageContent = "You are a helpful coding assistant. The user will provide a task, possibly preceded by relevant code snippets from their current project. Use this context to generate accurate and relevant code. If snippets are provided, pay close attention to their style and patterns.";
    // If context retrieval failed earlier and userMessagesContent is empty, the above system message might be less effective.
    // However, the prompt itself is still in userMessagesContent.
    // Alternatively, if context failed AND userMessagesContent is JUST the prompt, a simpler system message could be used:
    if (userMessagesContent === `Task: ${prompt}`) { // Check if only task is present (context failed)
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
