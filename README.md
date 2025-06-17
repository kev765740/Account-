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

## API Endpoints

All endpoints expect JSON request bodies and return JSON responses.

### `POST /generate`

-   **Description**: Generates code or text based on a given prompt using OpenAI's chat completion. This endpoint internally attempts to retrieve relevant existing code snippets from the project to provide better context for code generation. It can return either plain text or a structured JSON object representing code edits.

    This endpoint's code generation capabilities are enhanced by a deeper contextual understanding of your project. It not only uses general semantically relevant code snippets but also attempts to identify references to specific functions, classes, or methods within your prompt (if those structures have been previously indexed via `/index-file-structures`). When such specific elements are identified, their details (signatures, summaries, code) are used to provide more accurate and contextually grounded responses. This process is internal and aims to improve the quality of generated code and structured edits.
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

-   **Description**: Indexes a code snippet for semantic search. An optional comment can be provided to enhance the contextual understanding of the code.
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

-   **Description**: Parses the content of a JavaScript file to identify and index its core structures (e.g., functions, classes, methods). This allows the AI to have a more detailed understanding of the codebase for context-aware code generation and analysis.
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
      "message": "Indexed 3 structures from path/to/your/file.js.",
      "indexed_count": 3
    }
    ```
-   **Error Responses**: Standard error formats apply (e.g., `{ "error": "message", "details": "..." }`).
-   **Note**: Indexing file structures via this endpoint enhances the `/generate` command's ability to understand prompts referring to specific code elements within the indexed files.

### `POST /semantic-search`

-   **Description**: Searches for code snippets in the Qdrant database that are semantically similar to the given query.
-   **Request Body**:
    ```json
    {
      "query": "Your search query here (e.g., 'function to sort an array in javascript')"
    }
    ```
-   **Response**:
    ```json
    {
      "results": [
        "matching_code_snippet_1",
        "matching_code_snippet_2",
        // ... up to 3 results
      ]
    }
    ```
-   **Error Responses**:
    -   `400 Bad Request`: If `query` is missing.
    -   `5xx Server Error`: For issues with OpenAI (query embedding) or Qdrant (search), or other internal errors. See response body for `error` and `details`.
