import fetch from 'node-fetch';
import assert from 'assert';

const API_URL = 'http://localhost:3001';

async function testGenerate() {
  const res = await fetch(`${API_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Say hello!' })
  });
  assert(res.ok, '/generate endpoint failed');
  const data = await res.json();
  assert(data.result && typeof data.result === 'string', 'No result from /generate');
  console.log('✓ /generate passed');
}

async function testIndexSnippet() {
  const res = await fetch(`${API_URL}/index-snippet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'function test() { return 42; }' })
  });
  assert(res.ok, '/index-snippet endpoint failed');
  const data = await res.json();
  assert(data.success === true, 'Indexing failed');
  console.log('✓ /index-snippet passed');
}

async function testSemanticSearch() {
  const res = await fetch(`${API_URL}/semantic-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'function that returns a number' })
  });
  assert(res.ok, '/semantic-search endpoint failed');
  const data = await res.json();
  assert(Array.isArray(data.results), 'No results array from /semantic-search');
  console.log('✓ /semantic-search passed');
}

(async () => {
  try {
    await testGenerate();
    await testIndexSnippet();
    await testSemanticSearch();
    console.log('All backend API tests passed.');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
})();
