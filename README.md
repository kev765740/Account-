# AI Code Assistant Backend

## Description

This project provides a backend service for AI-powered code generation and semantic code search. It leverages OpenAI for language model capabilities and Qdrant for vector database storage and search.

## Features

- Generate code snippets or text based on natural language prompts.
- Index code snippets, creating vector embeddings for semantic understanding.
- Perform semantic search on the indexed code snippets to find relevant examples.

## Prerequisites

To run this project, you will need:

- Node.js (v18.x or later recommended)
- Access to an OpenAI API key
- A running Qdrant instance (refer to [Qdrant documentation](https://qdrant.tech/documentation/guides/installation/) for setup)

## Setup & Installation

1.  **Clone the repository:**
    ```bash
    git clone <your-repository-url>
    cd <repository-name>
    ```

2.  **Navigate to the backend directory:**
    ```bash
    cd deep-fol-backend
    ```

3.  **Install dependencies:**
    ```bash
    npm install
    ```

4.  **Set up environment variables:**
    *   Create a `.env` file in the `deep-fol-backend` directory. You can copy the example file:
        ```bash
        cp .env.example .env
        ```
    *   Edit the `.env` file and add your OpenAI API key:
        ```
        OPENAI_API_KEY=your_api_key_here
        ```
    *   Currently, the Qdrant URL is hardcoded to `http://localhost:6333`. If you need to change this, you'll need to modify it directly in `deep-fol-backend/index.js`.

## Running the Application

1.  **Start the server:**
    From within the `deep-fol-backend` directory, run:
    ```bash
    npm start
    ```
    (Note: You might need to define a "start" script in your `package.json`, e.g., `"start": "node index.js"`. If you are using `nodemon` or a similar tool, adjust accordingly e.g. `npm run dev` if you have a dev script)

2.  The server will start on `http://localhost:3001` by default.

## Indexed Data Types

The Qdrant vector database stores different types of indexed code elements. When these elements are retrieved (e.g., via search or other endpoints), their payloads often include a `type` field to help identify what kind of code element it is. Common types include:

-   `"snippet"`: A generic code snippet, typically indexed via the `/index-snippet` endpoint. Its payload includes `code` and `comment`.
-   `"function"`: A standalone function. Payload includes `name`, `filePath`, `signature`, `summary`, `code_snippet`, `start_line`, `end_line`.
-   `"class"`: A class definition. Payload includes `name`, `filePath`, `signature` (simplified), `summary`, `code_snippet`, `start_line`, `end_line`.
-   `"method"`: A method within a class. Payload includes `name`, `filePath`, `signature`, `summary`, `code_snippet`, `className`, `start_line`, `end_line`.
-   `"file_metadata"`: Contains information about a file's module context, including parsed imports and exports. Its payload includes:
    -   `filePath: string` - The path of the indexed file.
    -   `imports: Array` - An array of import objects. Each import object typically contains:
        -   `raw: string` - The full import statement.
        -   `source: string` - The module path (e.g., 'module-name', './relative-path').
        -   `specifiers: Array` - Details of what is imported (e.g., `{ type: "default", local: "defaultName" }`, `{ type: "named", imported: "member1", local: "alias1" }`).
        -   `start_line`, `end_line`: Line numbers for the import statement.
    -   `exports: Array` - An array of export objects. Each export object typically contains:
        -   `raw: string` - The full export statement.
        -   `type: string` - Type of export (e.g., "default", "declaration", "named_list").
        -   `exported_items: Array` - Details of what is exported (e.g., `[{ name: "exportName", local: "localName" }]`).
        -   `source: string|null` - Module path for re-exports.
        -   `start_line`, `end_line`: Line numbers for the export statement.
    -   `summary: string|null` - Placeholder for a future file-level summary (currently `null`).
    -   `line_count: number` - Total lines in the file.
    -   `structure_count: number` - Number of functions, classes, and methods found in the file.
    -   `import_count: number` - Number of import statements found.
    -   `export_count: number` - Number of export statements found.

These types are automatically assigned during the indexing process by relevant endpoints (e.g., `/index-file-structures` for functions, classes, methods, and file_metadata; `/index-snippet` for snippets).

## API Endpoints

All endpoints expect JSON request bodies and return JSON responses.

### `POST /generate`

-   **Description**: Generates code or text based on a given prompt using OpenAI's chat completion. This endpoint internally attempts to retrieve relevant existing code snippets from the project to provide better context for code generation. It can return either plain text or a structured JSON object representing code edits.

    This endpoint's code generation capabilities are enhanced by a deeper contextual understanding of your project. It not only uses general semantically relevant code snippets but also attempts to identify references to specific functions, classes, or methods within your prompt (if those structures have been previously indexed via `/index-file-structures`). When such specific elements are identified, their details (signatures, summaries, code) are used to provide more accurate and contextually grounded responses. To further improve code integration, if the generation context relates to a specific file (because a specific entity from that file was identified as relevant), a summary of that file's existing module imports and exports is also provided to the AI, helping it utilize available modules correctly and declare new exports consistently. This process is internal and aims to improve the quality of generated code and structured edits.
-   **Request Body**:
    *   `prompt: string` (Required) - Your prompt describing the task or the code to generate.
    *   `output_format: string` (Optional) - Specifies the desired output format.
        *   If omitted or set to any value other than `"structured_edit"` (e.g., `"text"`), the endpoint returns a plain text response in the `result` field.
        *   If set to `"structured_edit"`, the endpoint attempts to return a JSON array representing one or more structured edit actions (currently, the AI is prompted for a single action).

-   **Response (Text Format - default)**:
    When `output_format` is omitted or not `"structured_edit"`:
    ```json
    {
      "result": "Generated text from AI"
    }
    ```

-   **Response (Structured Edit Format)**:
    When `output_format: "structured_edit"` is specified and successful:
    ```json
    [
      {
        "action": "replace", // Or "insert", "delete"
        "start_line": 5,     // Line numbers are 1-based
        "end_line": 7,
        "text": "function bar() { console.log('hello'); }"
      }
      // ... potentially more action objects in the future
    ]
    ```
    If the AI fails to produce valid structured JSON, or if there's an internal error, a standard error JSON object will be returned (see Error Responses).

#### Structured Edit Format Details

When `output_format: 'structured_edit'` is requested, the API aims to return a JSON array. Each element in the array is an **Action Object** that describes a specific change. Initially, the service is prompted to return an array containing a single action object.

An **Action Object** has the following structure:

-   `action: string`: The type of edit. Supported actions:
    -   `"insert"`: Inserts new text.
    -   `"replace"`: Replaces a range of lines with new text.
    -   `"delete"`: Deletes a range of lines.
-   `line: number`: (Required for `insert`) A 1-indexed line number. The `text` will be inserted *before* this line number. For example, `line: 1` inserts at the beginning of the file. `line: 10` inserts before the existing line 10.
-   `start_line: number`: (Required for `replace`, `delete`) A 1-indexed line number indicating the start of the range to modify.
-   `end_line: number`: (Required for `replace`, `delete`) A 1-indexed line number indicating the end of the range to modify (inclusive). Must be greater than or equal to `start_line`.
-   `text: string`: (Required for `insert`, `replace`) The new code/text to insert or that will replace the specified lines. Can contain newline characters (`\\n`) for multi-line text.

#### Examples for `/generate`

1.  **Request for Structured Edit**:
    ```json
    {
      "prompt": "Replace the function foo with: function bar() { console.log('hello'); }",
      "output_format": "structured_edit"
    }
    ```

2.  **Example JSON Response (Structured Edit)**:
    ```json
    [
      {
        "action": "replace",
        "start_line": 5,
        "end_line": 7,
        "text": "function bar() { console.log('hello'); }"
      }
    ]
    ```
    *(Assuming the original `foo` function was on lines 5-7)*

3.  **Request for Text Output (or `output_format` omitted)**:
    ```json
    {
      "prompt": "Replace the function foo with: function bar() { console.log('hello'); }"
    }
    ```

4.  **Example Text Response**:
    ```json
    {
      "result": "function bar() { console.log('hello'); }"
    }
    ```

-   **Error Responses**:
    -   `400 Bad Request`: If `prompt` is missing.
    -   `500 Server Error`: For issues with the OpenAI API, Qdrant, or if `output_format: "structured_edit"` is requested but the AI response cannot be parsed into valid structured edit JSON, or if the generated JSON does not meet the basic validation criteria. See response body for `error` and `details` (which may include the raw AI output or the malformed JSON).

### `POST /index-snippet`

-   **Description**: Indexes a code snippet for semantic search. An optional comment can be provided to enhance the contextual understanding of the code. Snippets indexed via this endpoint will automatically have `type: "snippet"` included in their stored Qdrant payload.
-   **Request Body**:
    *   `code: string` (Required) - The code snippet to index.
    *   `comment: string` (Optional) - An explanatory comment for the code. If provided, it will be combined with the code during the embedding process to create a richer contextual representation.
    ```json
    {
      "code": "Your code snippet here (e.g., function, class, block of code)",
      "comment": "Optional: explanation of the code snippet"
    }
    ```
-   **Response** (on success):
    ```json
    {
      "success": true
    }
    ```
-   **Error Responses**:
    -   `400 Bad Request`: If `code` is missing.
    -   `5xx Server Error`: For issues with OpenAI (embedding generation) or Qdrant (storage), or other internal errors. See response body for `error` and `details`.

### `POST /index-file-structures`

-   **Description**: Parses the content of a JavaScript file to identify and index its core structures (e.g., functions, classes, methods), its import statements, and its export statements. In addition to indexing individual functions, classes, and methods, this endpoint also creates a comprehensive `file_metadata` entry for the processed file. This entry includes all parsed import statements, export statements, line count, and counts of various structures, providing a holistic view of the file's module characteristics. This allows the AI to have a more detailed understanding of the codebase for context-aware code generation and analysis.
-   **Request Body**:
    ```json
    {
      "filePath": "path/to/your/file.js",
      "content": "const content = 'of your JavaScript file';"
    }
    ```
    - `filePath: string` (Required) - A unique identifier or path for the file.
    - `content: string` (Required) - The complete JavaScript source code of the file.
-   **Success Response**:
    ```json
    {
      "success": true,
      "message": "Successfully indexed 3 structures and file metadata for path/to/your/file.js.",
      "indexed_count": 4
    }
    ```
-   **Error Responses**: Standard error formats apply (e.g., `{ "error": "message", "details": "..." }`).
-   **Note**: Indexing file structures via this endpoint enhances the `/generate` command's ability to understand prompts referring to specific code elements within the indexed files.

### `POST /semantic-search`

-   **Description**: Searches for code snippets and indexed structures in the Qdrant database that are semantically similar to the given query. Allows for optional filtering.
-   **Request Body**:
    ```json
    {
      "query": "Your search query (e.g., 'function to sort an array in javascript')",
      "limit": 5, // Optional, default is 5
      "filters": { // Optional
        "filePath": "path/to/your/file.js",
        "type": "function", // e.g., 'function', 'class', 'method', 'snippet'
        "name": "myFunctionName"
      }
    }
    ```
    - `query: string` (Required) - The natural language query for semantic search.
    - `limit: number` (Optional) - Maximum number of results to return. Defaults to 5. Must be a positive integer.
    - `filters: object` (Optional) - An object containing filters to apply. All filter conditions are combined with an AND logic.
        - `filePath: string` (Optional) - Filter results by a specific file path.
        - `type: string` (Optional) - Filter results by a specific structure type (e.g., "function", "class", "snippet").
        - `name: string` (Optional) - Filter results by a specific structure name.
-   **Success Response (200 OK)**:
    Returns an array of matching items, where each item is the full payload object stored in Qdrant.
    ```json
    {
      "results": [
        {
          "filePath": "src/utils.js",
          "type": "function",
          "name": "sortArray",
          "signature": "function sortArray(arr)",
          "summary": "Sorts an array in ascending order.",
          "code_snippet": "function sortArray(arr) {\n  return arr.sort((a, b) => a - b);\n}",
          "className": null,
          "start_line": 10,
          "end_line": 12
        },
        // ... other matching payloads
      ]
    }
    ```
-   **Error Responses**:
    -   `400 Bad Request`: If `query` is missing or invalid, or if `limit` or `filters` are malformed.
    -   `5xx Server Error`: For issues with OpenAI (embedding generation) or Qdrant (search), or other internal errors. See response body for `error` and `details`.

### `GET /file-dependencies`

-   **Method & Path**: `GET /file-dependencies`
-   **Description**: Retrieves the detailed lists of parsed import and export statements for a specific JavaScript file that has been previously indexed via `/index-file-structures`.
-   **Query Parameters**:
    -   `filePath: string` (Required) - The path/identifier of the file.
-   **Success Response (200 OK)**:
    Returns a JSON object containing the file path and arrays of import/export objects.
    ```json
    {
      "filePath": "src/utils/helpers.js",
      "imports": [
        {
          "raw": "import path from 'path';",
          "source": "path",
          "specifiers": [{ "type": "default", "local": "path" }],
          "start_line": 1,
          "end_line": 1,
          "filePath": "src/utils/helpers.js"
        },
        {
          "raw": "import { readFileSync } from 'fs';",
          "source": "fs",
          "specifiers": [
            { "type": "named", "imported": "readFileSync", "local": "readFileSync" }
          ],
          "start_line": 2,
          "end_line": 2,
          "filePath": "src/utils/helpers.js"
        }
      ],
      "exports": [
        {
          "raw": "export function normalizePath(p) { return path.normalize(p); }",
          "type": "declaration",
          "exported_items": [{ "name": "normalizePath", "local": "normalizePath" }],
          "source": null,
          "start_line": 5,
          "end_line": 7,
          "filePath": "src/utils/helpers.js"
        },
        {
          "raw": "export const MAX_PATH_LENGTH = 255;",
          "type": "declaration",
          "exported_items": [
            { "name": "MAX_PATH_LENGTH", "local": "MAX_PATH_LENGTH" }
          ],
          "source": null,
          "start_line": 9,
          "end_line": 9,
          "filePath": "src/utils/helpers.js"
        }
      ]
    }
    ```
-   **Error Responses**:
    -   `400 Bad Request`: If `filePath` is missing or invalid.
    -   `404 Not Found`: If the `file_metadata` for the given `filePath` is not found. Body: `{ "error": "File metadata not found or does not contain dependency information." }`.
    -   `500 Server Error`: For Qdrant errors or other internal issues. Body: `{ "error": "message", "details": "..." }`.

### `GET /file-outline`

-   **Method & Path**: `GET /file-outline`
-   **Description**: Retrieves a structured outline of all indexed code elements (functions, classes, methods) for a specific file. The outline is sorted by the starting line number of each element.
-   **Query Parameters**:
    -   `filePath: string` (Required) - The path of the file for which to retrieve the outline (e.g., `path/to/your/file.js`).
-   **Success Response (200 OK)**:
    Returns a JSON array of summary objects, each representing a code structure.
    ```json
    [
      {
        "type": "function",
        "name": "parseInput",
        "signature": "function parseInput(data)",
        "summary": "Parses raw input data into a structured format...", // Summaries are truncated if long
        "start_line": 5,
        "end_line": 15,
        "className": null
      },
      {
        "type": "class",
        "name": "DataProcessor",
        "signature": "class DataProcessor { ... }",
        "summary": "Handles processing of structured data.",
        "start_line": 18,
        "end_line": 55,
        "className": null
      },
      // ... other structures like methods within DataProcessor
    ]
    ```
    If no structures are found for the file, an empty array `[]` is returned.
-   **Error Responses**:
    -   `400 Bad Request`: If `filePath` is missing.
    -   `500 Server Error`: For Qdrant errors or other internal issues. Body: `{ "error": "message", "details": "..." }`.

### `GET /structure-details`

-   **Method & Path**: `GET /structure-details`
-   **Description**: Fetches the complete indexed details for a specific code structure, identified by its file path, name, and optionally its type and class name.
-   **Query Parameters**:
    -   `filePath: string` (Required) - The file path of the structure.
    -   `name: string` (Required) - The name of the function, class, or method.
    -   `type: string` (Optional) - The type of the structure (e.g., "function", "class", "method"). Helps disambiguate if multiple structures share the same name in a file.
    -   `className: string` (Optional) - If the structure is a method, this is the name of its containing class.
-   **Success Response (200 OK)**:
    Returns the full payload object of the found structure.
    ```json
    {
      "filePath": "src/utils.js",
      "type": "method",
      "name": "processItem",
      "signature": "processItem(item, options)",
      "summary": "Processes a single item with given options.",
      "code_snippet": "processItem(item, options) {\n  // ... method body ...\n}",
      "className": "ItemProcessor",
      "start_line": 25,
      "end_line": 35
    }
    ```
-   **Error Responses**:
    -   `400 Bad Request`: If `filePath` or `name` is missing.
    -   `404 Not Found`: If no structure matches the provided criteria. Body: `{ "error": "Structure not found." }`.
    -   `500 Server Error`: For Qdrant errors or other internal issues. Body: `{ "error": "message", "details": "..." }`.

### `GET /find-symbols-by-name`

-   **Method & Path**: `GET /find-symbols-by-name`
-   **Description**: Performs a semantic search for code symbols (functions, classes, methods) based on their name and an optional type. This endpoint is useful for finding symbols when you know their name but not necessarily their exact location or full signature. The search uses a descriptive query generated from the name and type to find semantically similar matches.
-   **Query Parameters**:
    -   `name: string` (Required) - The name of the symbol to search for.
    -   `type: string` (Optional) - The type of symbol (e.g., "function", "class", "method"). If provided, the search will be filtered by this type, and the descriptive query for embedding will be more specific.
    -   `limit: number` (Optional) - Maximum number of results to return. Defaults to 10. Must be a positive integer.
-   **Success Response (200 OK)**:
    Returns a JSON object containing an array of matching symbol payloads.
    ```json
    {
      "results": [
        {
          "filePath": "src/api/auth.js",
          "type": "function",
          "name": "authenticateUser",
          "signature": "async function authenticateUser(username, password)",
          "summary": "Authenticates a user based on username and password.",
          "code_snippet": "async function authenticateUser(username, password) { /* ... */ }",
          "className": null,
          "start_line": 15,
          "end_line": 25
        }
        // ... other matching symbols
      ]
    }
    ```
-   **Error Responses**:
    -   `400 Bad Request`: If `name` is missing or `limit` is invalid.
    -   `500 Server Error`: For issues with OpenAI (embedding generation), Qdrant (search), or other internal errors. Body: `{ "error": "message", "details": "..." }`.
