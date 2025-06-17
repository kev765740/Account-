/**
 * Basic JavaScript Code Parser using Regular Expressions.
 * This parser is a best-effort approach for common, well-formatted JavaScript
 * and does not aim to be a full AST parser.
 */

/**
 * Finds the index of the matching closing brace for an opening brace.
 * @param {string} text The code text to search within.
 * @param {number} openBraceIndex The index of the opening brace '{'.
 * @returns {number} The index of the matching closing brace '}', or -1 if not found.
 */
function findClosingBrace(text, openBraceIndex) {
  let braceLevel = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === '{') {
      braceLevel++;
    } else if (text[i] === '}') {
      braceLevel--;
      if (braceLevel === 0) {
        return i;
      }
    }
  }
  return -1; // Should not happen in well-formed code
}

/**
 * Converts a character index in a file content string to a 1-based line number.
 * @param {string} fileContent The full content of the file.
 * @param {number} index The character index.
 * @returns {number} The 1-based line number.
 */
function getLineNumber(fileContent, index) {
  return (fileContent.substring(0, index).match(/\n/g) || []).length + 1;
}

/**
 * Extracts a summary from JSDoc or multi-line single comments.
 * @param {string | null} jsdocComment Full JSDoc comment block (e.g., "/** ... */").
 * @param {string | null} singleLineComments Concatenated single-line comments.
 * @returns {string | null} A summarized comment or null.
 */
function summarizeComment(jsdocComment, singleLineComments) {
  if (jsdocComment) {
    const lines = jsdocComment
      .replace(/^\s*\/\*\*!?/, '') // Remove "/**" or "/**!"
      .replace(/\*\/\s*$/, '')    // Remove "*/"
      .trim()
      .split('\n');
    let summary = '';
    for (const line of lines) {
      const cleanedLine = line.replace(/^\s*\*\s?/, '').trim(); // Remove leading "*"
      if (cleanedLine.startsWith('@')) break; // Stop at JSDoc tags
      if (cleanedLine) {
        summary += (summary ? ' ' : '') + cleanedLine;
        if (summary.length > 100 && summary.includes('.')) { // Heuristic: take first sentence if long
             summary = summary.substring(0, summary.indexOf('.') + 1);
             break;
        }
      } else if (summary) { // Empty line after some content might mean end of summary
          break;
      }
    }
    return summary.trim() || null;
  }
  if (singleLineComments) {
    const lines = singleLineComments.trim().split('\n');
    let summary = '';
    for (const line of lines) {
      const cleanedLine = line.replace(/^\s*\/\/\s?/, '').trim();
      if (cleanedLine) {
        summary += (summary ? ' ' : '') + cleanedLine;
         if (summary.length > 100 && summary.includes('.')) {
             summary = summary.substring(0, summary.indexOf('.') + 1);
             break;
        }
      } else if (summary) {
          break;
      }
    }
    return summary.trim() || null;
  }
  return null;
}


const CLASS_REGEX = /(?:\s*\/\*\*([\s\S]*?)\*\/\s*|\s*((?:\/\/[^\r\n]*\r?\n)+))?^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:extends\s+[A-Za-z_][A-Za-z0-9_.]+)?\s*\{/gm;
const FUNCTION_REGEX = /(?:\s*\/\*\*([\s\S]*?)\*\/\s*|\s*((?:\/\/[^\r\n]*\r?\n)+))?^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/gm;
// For methods, we apply this regex to the class body. Line numbers need to be offset.
const METHOD_REGEX = /(?:\s*\/\*\*([\s\S]*?)\*\/\s*|\s*((?:\/\/[^\r\n]*\r?\n)+))?^\s*(static\s+)?(async\s+|get\s+|set\s+)?(\*?\s*[A-Za-z_][A-Za-z0-9_]*|constructor)\s*\(([^)]*)\)\s*\{/gm;


export function parseJavaScriptCode(fileContent, filePath) {
  const elements = [];
  let match;

  // Reset regex state for each call
  CLASS_REGEX.lastIndex = 0;
  FUNCTION_REGEX.lastIndex = 0;
  METHOD_REGEX.lastIndex = 0;

  // Pass 1: Top-level classes and their methods
  while ((match = CLASS_REGEX.exec(fileContent)) !== null) {
    const jsdocComment = match[1];
    const singleLineComments = match[2];
    const className = match[3];
    const classStartIndex = match.index;
    const classHeaderEndIndex = match.index + match[0].length -1; // End of the matched header part "class Foo {"

    const startLine = getLineNumber(fileContent, classStartIndex);
    const classBodyStartIndex = classHeaderEndIndex + 1; // After the opening brace of class
    const classEndBraceIndex = findClosingBrace(fileContent, classHeaderEndIndex);

    if (classEndBraceIndex === -1) {
      console.warn(`[${filePath}] Could not find closing brace for class ${className} starting at line ${startLine}. Skipping.`);
      continue;
    }

    const endLine = getLineNumber(fileContent, classEndBraceIndex);
    const classCodeSnippet = fileContent.substring(classStartIndex, classEndBraceIndex + 1);
    const summary = summarizeComment(jsdocComment, singleLineComments);

    elements.push({
      type: 'class',
      name: className,
      filePath: filePath,
      signature: `class ${className} { ... }`, // Simplified signature
      summary: summary,
      code_snippet: classCodeSnippet,
      className: null,
      start_line: startLine,
      end_line: endLine,
    });

    const classBodyContent = fileContent.substring(classBodyStartIndex, classEndBraceIndex);
    let methodMatch;
    METHOD_REGEX.lastIndex = 0; // Reset for each class body

    while ((methodMatch = METHOD_REGEX.exec(classBodyContent)) !== null) {
      const methodJsdoc = methodMatch[1];
      const methodSingleLines = methodMatch[2];
      // methodMatch[3] is static, methodMatch[4] is async/get/set
      const methodFullName = (methodMatch[3] || "") + (methodMatch[4] || "") + methodMatch[5];
      const methodName = methodMatch[5].replace('*','').trim(); // Clean generator star
      const methodParams = methodMatch[6];

      const methodLocalStartIndex = methodMatch.index;
      const methodHeaderEndIndex = methodMatch.index + methodMatch[0].length -1;

      const methodActualStartIndex = classBodyStartIndex + methodLocalStartIndex;
      const methodActualHeaderEndIndex = classBodyStartIndex + methodHeaderEndIndex;

      const methodStartLine = getLineNumber(fileContent, methodActualStartIndex);
      const methodEndBraceIndex = findClosingBrace(fileContent, methodActualHeaderEndIndex);

      if (methodEndBraceIndex === -1) {
        console.warn(`[${filePath}] Could not find closing brace for method ${methodName} in class ${className} starting at line ${methodStartLine}. Skipping.`);
        continue;
      }

      const methodEndLine = getLineNumber(fileContent, methodEndBraceIndex);
      const methodCodeSnippet = fileContent.substring(methodActualStartIndex, methodEndBraceIndex + 1);
      const methodSummary = summarizeComment(methodJsdoc, methodSingleLines);

      elements.push({
        type: 'method',
        name: methodName,
        filePath: filePath,
        signature: `${methodFullName}(${methodParams})`,
        summary: methodSummary,
        code_snippet: methodCodeSnippet,
        className: className,
        start_line: methodStartLine,
        end_line: methodEndLine,
      });
    }
  }

  // Pass 2: Top-level functions (ensure they are not methods already processed by being inside a class snippet)
  // A more robust way would be to mark ranges covered by classes and skip functions within those.
  // For simplicity now, we assume regex won't pick up methods as top-level functions due to context.
  // This might need refinement if top-level functions can look very similar to methods structurally.
  while ((match = FUNCTION_REGEX.exec(fileContent)) !== null) {
    // Crude check: if this match is inside an already found class, skip it.
    const funcStartIndex = match.index;
    let isInsideClass = false;
    for (const el of elements) {
        if (el.type === 'class' && funcStartIndex > el.start_line && funcStartIndex < el.end_line) { // Approx check by line
            const classStartCharIndex = fileContent.indexOf(el.code_snippet); // Not perfectly accurate if snippet is repeated
            const classEndCharIndex = classStartCharIndex + el.code_snippet.length;
            if (funcStartIndex > classStartCharIndex && funcStartIndex < classEndCharIndex) {
                 isInsideClass = true;
                 break;
            }
        }
    }
    if(isInsideClass) continue;


    const jsdocComment = match[1];
    const singleLineComments = match[2];
    const functionName = match[3];
    const functionParams = match[4];
    const functionHeaderEndIndex = match.index + match[0].length -1;

    const startLine = getLineNumber(fileContent, funcStartIndex);
    const functionEndBraceIndex = findClosingBrace(fileContent, functionHeaderEndIndex);

    if (functionEndBraceIndex === -1) {
      console.warn(`[${filePath}] Could not find closing brace for function ${functionName} starting at line ${startLine}. Skipping.`);
      continue;
    }

    const endLine = getLineNumber(fileContent, functionEndBraceIndex);
    const functionCodeSnippet = fileContent.substring(funcStartIndex, functionEndBraceIndex + 1);
    const summary = summarizeComment(jsdocComment, singleLineComments);

    elements.push({
      type: 'function',
      name: functionName,
      filePath: filePath,
      signature: `function ${functionName}(${functionParams})`,
      summary: summary,
      code_snippet: functionCodeSnippet,
      className: null,
      start_line: startLine,
      end_line: endLine,
    });
  }

  return elements;
}
