import express from 'express';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';
import { QdrantClient } from 'qdrant-client';

const app = express();
const port = 3001;

app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const qdrant = new QdrantClient({ url: 'http://localhost:6333' });
const COLLECTION_NAME = 'code-snippets';

app.post('/generate', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256
    });
    const result = completion.choices[0]?.message?.content || '';
    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate AI response.' });
  }
});

// Endpoint to add a code snippet to the vector database
app.post('/index-snippet', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Code is required.' });
  }
  try {
    // Generate embedding using OpenAI
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: code
    });
    const embedding = embeddingResponse.data[0].embedding;
    // Store in Qdrant
    await qdrant.upsert(COLLECTION_NAME, {
      points: [{
        id: Date.now(),
        vector: embedding,
        payload: { code }
      }]
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to index code snippet.' });
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
    res.status(500).json({ error: 'Semantic search failed.' });
  }
});

app.listen(port, () => {
  console.log(`AI backend listening at http://localhost:${port}`);
});
