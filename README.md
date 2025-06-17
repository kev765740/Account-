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

-   **Description**: Generates code or text based on a given prompt using OpenAI's chat completion.
-   **Request Body**:
    ```json
    {
      "prompt": "Your prompt here"
    }
    ```
-   **Response**:
    ```json
    {
      "result": "Generated text from AI"
    }
    ```
-   **Error Responses**:
    -   `400 Bad Request`: If `prompt` is missing.
    -   `5xx Server Error`: For issues with the OpenAI API or other internal errors. See response body for `error` and `details`.

### `POST /index-snippet`

-   **Description**: Generates a vector embedding for the provided code snippet using OpenAI and stores it in the Qdrant vector database.
-   **Request Body**:
    ```json
    {
      "code": "Your code snippet here (e.g., function, class, block of code)"
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
