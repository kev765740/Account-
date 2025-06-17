#!/usr/bin/env node

import fetch from 'node-fetch';

const API_URL = 'http://localhost:3001/generate';

const sampleCode = `
function greet(name) {
  console.log(\`Hello, \${name}!\`);
}

function add(a, b) {
  return a + b;
}

class Calculator {
  constructor() {
    this.result = 0;
  }

  add(num) {
    this.result += num;
  }

  subtract(num) {
    this.result -= num; // A comment to make line numbers distinct
  }
}
`.trim();

/**
 * Applies a list of structured edits to a code string.
 * Note: This basic version applies edits sequentially. If multiple edits are present,
 * line numbers in subsequent edits might not align correctly if prior edits shifted lines.
 * For this simulation, we assume edits are independent or only one edit is processed.
 * @param {string} codeString The initial code string.
 * @param {Array<Object>} editsArray An array of edit action objects.
 * @returns {string} The modified code string.
 */
function applyEdits(codeString, editsArray) {
  let lines = codeString.split('\\n');

  if (!Array.isArray(editsArray)) {
    console.error("applyEdits: editsArray is not an array.", editsArray);
    return codeString; // Return original code if edits format is wrong
  }

  for (const actionObject of editsArray) {
    if (!actionObject || typeof actionObject.action !== 'string') {
        console.error("applyEdits: Invalid action object received.", actionObject);
        continue; // Skip this invalid action
    }
    switch (actionObject.action) {
      case 'insert': {
        const textToInsert = (actionObject.text || '').split('\\n');
        const line = parseInt(actionObject.line, 10); // 1-based
        if (isNaN(line)) {
            console.error("applyEdits 'insert': Invalid line number.", actionObject);
            continue;
        }
        // Adjust line for 0-based array, clamping to valid range
        const insertAt = Math.max(0, Math.min(lines.length, line - 1));
        lines.splice(insertAt, 0, ...textToInsert);
        break;
      }
      case 'delete': {
        const startLine = parseInt(actionObject.start_line, 10); // 1-based
        const endLine = parseInt(actionObject.end_line, 10); // 1-based
        if (isNaN(startLine) || isNaN(endLine)) {
            console.error("applyEdits 'delete': Invalid start_line or end_line.", actionObject);
            continue;
        }
        const deleteFrom = Math.max(0, startLine - 1);
        const count = Math.max(0, endLine - startLine + 1);
        if (count > 0) {
          lines.splice(deleteFrom, count);
        }
        break;
      }
      case 'replace': {
        const startLine = parseInt(actionObject.start_line, 10); // 1-based
        const endLine = parseInt(actionObject.end_line, 10); // 1-based
        if (isNaN(startLine) || isNaN(endLine)) {
            console.error("applyEdits 'replace': Invalid start_line or end_line.", actionObject);
            continue;
        }
        const textToInsert = (actionObject.text || '').split('\\n');
        const deleteFrom = Math.max(0, startLine - 1);
        const count = Math.max(0, endLine - startLine + 1);

        // Ensure deletion doesn't go past the array bounds for replacement
        const safeCount = Math.min(count, lines.length - deleteFrom);

        if (safeCount > 0) {
          lines.splice(deleteFrom, safeCount, ...textToInsert);
        } else { // If count is 0 (e.g. replace line 5 with line 4, or replace on empty line) treat as insert
          lines.splice(deleteFrom, 0, ...textToInsert);
        }
        break;
      }
      default:
        console.error(\`applyEdits: Unknown action '\${actionObject.action}'\`, actionObject);
    }
  }
  return lines.join('\\n');
}

/**
 * Tests a scenario by sending a prompt to the /generate endpoint
 * and applying the received structured edits.
 * @param {string} scenarioName A descriptive name for the test.
 * @param {string} prompt The prompt to send to the AI.
 * @param {string} initialCode The starting code for this scenario.
 */
async function testScenario(scenarioName, prompt, initialCode) {
  console.log(\`\n--- Test Scenario: \${scenarioName} ---\`);
  console.log("Original Code:");
  console.log(initialCode);
  console.log("\\nPrompt:", prompt);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, output_format: 'structured_edit' }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(\`API Error (\${response.status}):\`, errorBody);
      return;
    }

    const edits = await response.json();
    console.log("\\nReceived Structured Edits:");
    console.log(JSON.stringify(edits, null, 2));

    if (!edits || (Array.isArray(edits) && edits.length === 0)) {
        console.log("\\nNo edits received or empty edit array. Skipping application.");
        console.log("Final Code (no changes):");
        console.log(initialCode);
        return;
    }

    const modifiedCode = applyEdits(initialCode, edits);
    console.log("\\nModified Code:");
    console.log(modifiedCode);

  } catch (error) {
    console.error("Error during testScenario:", error);
  }
}

async function main() {
  // Test Scenario 1: Replace content of 'add' function
  await testScenario(
    "Replace Function Content",
    // Note: Line numbers in prompt are 1-based and refer to the sampleCode provided.
    // The LLM needs to be accurate with these.
    "Replace the content of the add function (lines 5-7 in the provided code) with: console.error('Addition is disabled');",
    sampleCode
  );

  // Test Scenario 2: Insert a comment
  await testScenario(
    "Insert Comment",
    "Insert the comment '// Main entry point' on a new line before the greet function (which is currently on line 1).",
    sampleCode
  );

  // Test Scenario 3: Delete a method
  await testScenario(
    "Delete Method",
    // The subtract method is lines 16-18 in the original sampleCode.
    // subtract(num) {
    //   this.result -= num; // A comment to make line numbers distinct
    // }
    "Delete the entire subtract method from the Calculator class. It starts around line 16 and ends around line 18.",
    sampleCode
  );

  // Test Scenario 4: An edit that might be more complex (e.g. wrapping code)
  // This is more to see what the LLM produces. applyEdits might struggle if it's not a simple insert/replace/delete.
  await testScenario(
    "Complex Edit - Add logging to greet function",
    "In the greet function, add console.log('Entering greet function') as the first line inside the function body and console.log('Exiting greet function') as the last line.",
    sampleCode
  );
}

main().catch(err => console.error("Unhandled error in main:", err));
